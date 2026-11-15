// node --test test/dia.test.mjs · el día: dedup por (estación, instante), día local, noche, lluvia, esperados y combinar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicar, armarDias, combinar, ultimas } from '../lib/dia.mjs';

const L = (id, iso, temp, extra = {}) => ({ id, instante: Date.parse(iso), temp_c: temp, hum_pct: null, viento_ms: null, presion_hpa: null, lluvia_dia_mm: null, marcas: [], ...extra });
const armar = (ls, fechas, mm = 60) => armarDias(deduplicar(ls).lecturas, { red: 'WEATHERLINK_PUB', fechas, muestreo_min: mm, fuente: 'weatherlink' });
const de = (filas, id, f) => filas.find((x) => x.estacion_id === id && x.fecha === f);

test('dedup: la misma estación e instante cuenta una vez (gana la más completa); otro instante suma', () => {
  const a = L('1', '2026-11-15T15:00:00Z', 5), b = L('1', '2026-11-15T15:00:00Z', 5, { hum_pct: 40 });
  const r = deduplicar([a, b, L('1', '2026-11-15T16:00:00Z', 6), L('2', '2026-11-15T15:00:00Z', 7)]);
  assert.equal(r.lecturas.length, 3); assert.equal(r.repetidas, 1);
  assert.equal(r.lecturas.find((x) => x.id === '1' && x.temp_c === 5).hum_pct, 40);
});

test('el día local: tmin/tmax muestreadas, registros, esperados = 1440 / muestreo, muestreo_min', () => {
  const f = armar([L('1', '2026-11-16T02:30:00Z', 0), L('1', '2026-11-15T18:00:00Z', 30), L('1', '2026-11-15T03:00:00Z', 12)], ['2026-11-15']);
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].tmin_c, f[0].tmax_c, f[0].registros_validos, f[0].registros_esperados, f[0].muestreo_min], [0, 30, 3, 24, 60]);
  assert.equal(armar([L('1', '2026-11-15T18:00:00Z', 30)], ['2026-11-15'], 20)[0].registros_esperados, 72);
  // 25 lecturas en el día con muestreo 60: esperados se estira (el CHECK no salta)
  const muchas = Array.from({ length: 25 }, (_, k) => L('1', new Date(Date.parse('2026-11-15T03:00:00Z') + k * 3500e3).toISOString(), 10));
  const g = armar(muchas, ['2026-11-15'])[0];
  assert.equal(g.registros_validos, 25); assert.equal(g.registros_esperados, 25);
});

test('la noche: (fecha−1 18:00, fecha 09:00] ART; las 23:40 cuentan para la mañana siguiente', () => {
  const f = armar([
    L('1', '2026-11-15T21:00:00Z', 60 - 60 + 15.5),  // 18:00 ART del 15: NO entra
    L('1', '2026-11-16T02:40:00Z', -1),              // 23:40 del 15 → noche del 16
    L('1', '2026-11-16T09:00:00Z', 1),               // 06:00 del 16
    L('1', '2026-11-16T12:00:00Z', 2),               // 09:00: entra
    L('1', '2026-11-16T12:20:00Z', -7),              // 09:20: NO entra a la noche
  ], ['2026-11-15', '2026-11-16']);
  const n = de(f, '1', '2026-11-16');
  assert.equal(n.tmin_noche_c, -1); assert.equal(n.tmin_noche_en, '2026-11-16T02:40:00.000Z');
  assert.equal(n.noche_registros, 3); assert.equal(n.noche_esperados, 15);
  assert.equal(n.tmin_c, -7);
  assert.equal(de(f, '1', '2026-11-15').noche_registros, 0); assert.equal(de(f, '1', '2026-11-15').tmin_noche_c, null);
});

test('sólo se arman los días objetivo (la noche puede venir del día anterior leído)', () => {
  const f = armar([L('1', '2026-11-14T23:00:00Z', 3), L('1', '2026-11-15T02:00:00Z', 1)], ['2026-11-15']);
  assert.equal(f.length, 1); assert.equal(f[0].fecha, '2026-11-15');
  assert.equal(f[0].noche_registros, 2); assert.equal(f[0].registros_validos, 0); assert.equal(f[0].tmin_c, null);
});

test('la lluvia: la de la última lectura del día con dato (sin dato no es 0)', () => {
  const f = armar([L('1', '2026-11-15T22:00:00Z', 5, { lluvia_dia_mm: 12.7 }), L('1', '2026-11-15T14:00:00Z', 5, { lluvia_dia_mm: 2.5 }),
    L('1', '2026-11-16T02:50:00Z', 5, { lluvia_dia_mm: 15.24 }), L('1', '2026-11-16T02:55:00Z', 5)], ['2026-11-15']);
  assert.equal(f[0].lluvia_mm, 15.24); assert.equal(f[0].lluvia_origen, 'acumulado_consola');
  assert.equal(armar([L('2', '2026-11-15T14:00:00Z', 5)], ['2026-11-15'])[0].lluvia_mm, null);
  // la más nueva llega PRIMERO (otro archivo, una importación): igual gana la del instante mayor
  const g = armar([L('3', '2026-11-16T02:50:00Z', 5, { lluvia_dia_mm: 15.24 }), L('3', '2026-11-15T22:00:00Z', 5, { lluvia_dia_mm: 12.7 })], ['2026-11-15']);
  assert.equal(g[0].lluvia_mm, 15.24);
});

test('idempotente: armar con lecturas repetidas o en otro orden da lo mismo', () => {
  const ls = [L('1', '2026-11-15T15:00:00Z', 5), L('1', '2026-11-15T16:00:00Z', 8, { lluvia_dia_mm: 1 }), L('2', '2026-11-16T01:00:00Z', 2)];
  const a = armar(ls, ['2026-11-15', '2026-11-16']);
  const b = armar([...ls].reverse().concat(ls), ['2026-11-15', '2026-11-16']);
  assert.deepEqual(b, a);
});

test('combinar: cada parte con la versión de MÁS registros; nunca pisa algo más completo', () => {
  const viejo = { registros_validos: 20, registros_esperados: 24, tmin_c: -2, tmax_c: 25, lluvia_mm: 3, noche_registros: 5, noche_esperados: 15, tmin_noche_c: -3, tmin_noche_en: 'x' };
  const nuevo = { red: 'R', estacion_id: '1', fecha: '2026-11-15', registros_validos: 10, registros_esperados: 24, tmin_c: 1, tmax_c: 20, lluvia_mm: 1, noche_registros: 9, noche_esperados: 15, tmin_noche_c: -1, tmin_noche_en: 'y' };
  const c = combinar(viejo, nuevo);
  assert.deepEqual([c.registros_validos, c.tmin_c, c.lluvia_mm, c.noche_registros, c.tmin_noche_c], [20, -2, 3, 9, -1]);
  assert.equal(combinar(null, nuevo), nuevo);
  assert.deepEqual(combinar(nuevo, nuevo), nuevo);
});

test('ultimas: la de instante mayor por estación', () => {
  const u = ultimas([L('1', '2026-11-15T15:00:00Z', 5), L('1', '2026-11-15T17:00:00Z', 9), L('2', '2026-11-15T10:00:00Z', 1)]);
  assert.deepEqual(u.map((x) => [x.id, x.temp_c]).sort(), [['1', 9], ['2', 1]]);
});
