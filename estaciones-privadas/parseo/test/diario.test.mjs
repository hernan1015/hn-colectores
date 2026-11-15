// node --test test/diario.test.mjs · el día (lib/diario.mjs, el ÚNICO de las 9 fuentes): dedup por (estación, instante),
// día local, noche, lluvia, esperados, la unión con lo guardado (nunca pisa lo más completo) y la última lectura.
// (Son los 8 casos de la 138b sobre lib/dia.mjs, pasados a la capa unificada.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unir, filasEstacion, fechasALeer } from '../lib/diario.mjs';
import { ultimaFila } from '../parseo.mjs';
import { localDe } from '../lib/hora.mjs';

const CFG = { pasoMin: 60, extremos: 'muestreados', lluvia: 'acumulado_consola', eto: false, fuente: 'weatherlink', url: null, maxEdadH: 72 };
const L = (iso, temp, extra = {}) => ({ local: localDe(Date.parse(iso)), v: { temp, hum: null, lluvia_acum: null, ...extra } });
const AHORA = '2026-11-16T12:00';
const armar = (nuevas, viejas = [], cfg = CFG) => filasEstacion({ nuevas, viejas, cfg, ahoraLocal: AHORA }).filas;
const de = (filas, f) => filas.find((x) => x.fecha === f);

test('dedup: la misma estación e instante cuenta una vez (gana la más completa); otro instante suma', () => {
  const a = L('2026-11-15T15:00:00Z', 5), b = L('2026-11-15T15:00:00Z', 5, { hum: 40 });
  const r = unir([], [a, b, L('2026-11-15T16:00:00Z', 6)]);
  assert.equal(r.lecturas.length, 2); assert.equal(r.repetidas, 1);
  assert.equal(r.lecturas[0].v.hum, 40);
  assert.equal(unir([], [b, a]).lecturas[0].v.hum, 40, 'aunque la completa venga primero');
});

// (el registro de las 00:00 en punto es del día ANTERIOR: el día son los registros que terminan en (D 00:00, D+1 00:00])
test('el día local: tmin/tmax muestreadas, registros, esperados = 1440 / muestreo, muestreo_min', () => {
  const f = armar([L('2026-11-16T02:30:00Z', 0), L('2026-11-15T18:00:00Z', 30), L('2026-11-15T03:05:00Z', 12)]);
  const d = de(f, '2026-11-15');
  assert.deepEqual([d.tmin_c, d.tmax_c, d.registros_validos, d.registros_esperados, d.muestreo_min], [0, 30, 3, 24, 60]);
  assert.equal(de(armar([L('2026-11-15T18:00:00Z', 30)], [], { ...CFG, pasoMin: 20 }), '2026-11-15').registros_esperados, 72);
  // 25 lecturas en el día con muestreo 60: registros_validos no pasa a los esperados (el CHECK no salta)
  const muchas = Array.from({ length: 25 }, (_, k) => L(new Date(Date.parse('2026-11-15T03:01:00Z') + k * 3400e3).toISOString(), 10));
  const g = de(armar(muchas), '2026-11-15');
  assert.ok(g.registros_validos <= g.registros_esperados); assert.equal(g.registros_validos, 24);
});

test('la noche: (fecha−1 18:00, fecha 09:00] ART; las 23:40 cuentan para la mañana siguiente', () => {
  const f = armar([
    L('2026-11-15T21:00:00Z', 15.5),  // 18:00 ART del 15: NO entra
    L('2026-11-16T02:40:00Z', -1),    // 23:40 del 15 → noche del 16
    L('2026-11-16T09:00:00Z', 1),     // 06:00 del 16
    L('2026-11-16T12:00:00Z', 2),     // 09:00: entra
    L('2026-11-16T12:20:00Z', -7),    // 09:20: NO entra a la noche
  ]);
  const n = de(f, '2026-11-16');
  assert.equal(n.tmin_noche_c, -1); assert.equal(n.tmin_noche_en, '2026-11-16T02:40:00.000Z');
  assert.equal(n.noche_registros, 3); assert.equal(n.noche_esperados, 15);
  assert.equal(n.tmin_c, -7);
  assert.equal(de(f, '2026-11-15').noche_registros, 0); assert.equal(de(f, '2026-11-15').tmin_noche_c, null);
});

test('se arman sólo los días que tocan las lecturas nuevas; una de la noche rehace la mañana siguiente', () => {
  const ayer = armar([L('2026-11-15T12:00:00Z', 9)]);
  assert.deepEqual(ayer.map((x) => x.fecha), ['2026-11-15']);
  // el 16 ya está guardado con su mañana; llega tarde una lectura de las 23:40 del 15 (un archivo atrasado)
  const guardado16 = armar([L('2026-11-16T09:00:00Z', 4)]);
  const f = armar([L('2026-11-16T02:40:00Z', -3)], guardado16.map((x) => ({ fecha: x.fecha, crudo: x.crudo })));
  const n = de(f, '2026-11-16');
  assert.ok(n, 'la fila del 16 se rehace'); assert.equal(n.tmin_noche_c, -3); assert.equal(n.noche_registros, 2);
  assert.deepEqual(fechasALeer([L('2026-11-16T09:00:00Z', 1)]), ['2026-11-15', '2026-11-16', '2026-11-17'], 'el día anterior: la noche');
});

test('la lluvia: el acumulado de la consola del día (sin dato no es 0), aunque la más nueva llegue primero', () => {
  const f = armar([L('2026-11-15T22:00:00Z', 5, { lluvia_acum: 12.7 }), L('2026-11-15T14:00:00Z', 5, { lluvia_acum: 2.5 }),
    L('2026-11-16T02:50:00Z', 5, { lluvia_acum: 15.24 }), L('2026-11-16T02:55:00Z', 5)]);
  const d = de(f, '2026-11-15');
  assert.equal(d.lluvia_mm, 15.24); assert.equal(d.lluvia_origen, 'acumulado_consola');
  assert.equal(de(armar([L('2026-11-15T14:00:00Z', 5)]), '2026-11-15').lluvia_mm, null);
  const g = armar([L('2026-11-16T02:50:00Z', 5, { lluvia_acum: 15.24 }), L('2026-11-15T22:00:00Z', 5, { lluvia_acum: 12.7 })]);
  assert.equal(de(g, '2026-11-15').lluvia_mm, 15.24);
});

test('idempotente: armar con lecturas repetidas o en otro orden da lo mismo (la misma firma)', () => {
  const ls = [L('2026-11-15T15:00:00Z', 5), L('2026-11-15T16:00:00Z', 8, { lluvia_acum: 1 }), L('2026-11-16T01:00:00Z', 2)];
  const a = armar(ls);
  const b = armar([...ls].reverse().concat(ls));
  assert.deepEqual(b, a);
  /* y contra lo guardado con esa firma: nada que escribir */
  assert.deepEqual(armar(ls, a.map((x) => ({ fecha: x.fecha, crudo: x.crudo }))), []);
});

test('la unión con lo guardado: una corrida con MENOS crudo nunca pisa un día (ni una noche) más completo', () => {
  const todas = Array.from({ length: 20 }, (_, k) => L(new Date(Date.parse('2026-11-14T22:00:00Z') + k * 3600e3).toISOString(), k - 3));
  const viejas = armar(todas).map((x) => ({ fecha: x.fecha, crudo: x.crudo }));
  const f = armar([L('2026-11-15T20:00:00Z', 30)], viejas);
  const d = de(f, '2026-11-15');
  const completo = de(armar([...todas, L('2026-11-15T20:00:00Z', 30)]), '2026-11-15');
  assert.deepEqual(d, completo, 'lo mismo que si hubiera llegado todo junto');
  assert.equal(d.registros_validos, 15); assert.equal(d.tmax_c, 30); assert.equal(d.noche_registros, 15); assert.equal(d.tmin_noche_c, -3);
});

test('la última lectura: la de instante mayor por estación, con la misma regla de imposibles', () => {
  const u = ultimaFila([{ id: '1', ...L('2026-11-15T15:00:00Z', 5) }, { id: '1', ...L('2026-11-15T17:00:00Z', 9, { hum: 0, x: { viento_ms: 3 } }) },
    { id: '2', ...L('2026-11-15T10:00:00Z', 1) }]);
  assert.deepEqual(u.map((x) => [x.id, x.temp_c]).sort(), [['1', 9], ['2', 1]]);
  const uno = u.find((x) => x.id === '1');
  assert.equal(uno.hum_pct, null, 'HR 0 es imposible'); assert.equal(uno.viento_ms, 3); assert.equal(uno.instante, '2026-11-15T17:00:00.000Z');
});
