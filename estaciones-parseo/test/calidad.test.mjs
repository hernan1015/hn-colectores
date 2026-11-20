// HN AGRO · estaciones-parseo · las reglas de calidad de la 139, con sus bordes (control negativo de cada una).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motivoEdad, controlar, limpiar, firmaLectura } from '../lib/calidad.mjs';
import { numero, instante, rumbo, desdeLocal } from '../lib/comun.mjs';
import { instanteDeClave, soloCantidades } from '../parsear.mjs';

const L = Date.parse('2026-01-10T15:00:00Z');
const H = 3600e3;

test('NULL nunca es 0: vacío, «---», «N/D», NaN, −999 y los centinelas → null; un 0 medido es 0', () => {
  for (const x of ['', '---', 'N/D', null, undefined, NaN, -999, '-9999', 'abc', true]) assert.equal(numero(x), null, String(x));
  assert.equal(numero('0'), 0);
  assert.equal(numero(0), 0);
  assert.equal(numero('12,5'), 12.5);
  assert.equal(numero(999.9, { centinelas: [999.9] }), null);
});

test('la regla de las 12 h (instantáneas): 11:59 entra, 12:01 no; 15 min al futuro es el tope', () => {
  const i = (t) => ({ instante: t, tipo: 'instantanea' });
  assert.equal(motivoEdad(i(L - 12 * H + 60e3), L), null);
  assert.equal(motivoEdad(i(L - 12 * H - 60e3), L), 'vieja_12h');
  assert.equal(motivoEdad(i(L + 14 * 60e3), L), null);
  assert.equal(motivoEdad(i(L + 16 * 60e3), L), 'futura');
  assert.equal(motivoEdad(i(NaN), L), 'sin_instante');
});

test('los registros (archivos de consola, totales diarios) entran hasta 8 días atrás, no más', () => {
  const r = (t) => ({ instante: t, tipo: 'registro' });
  assert.equal(motivoEdad(r(L - 7.9 * 24 * H), L), null);
  assert.equal(motivoEdad(r(L - 8.1 * 24 * H), L), 'vieja_8d');
  assert.equal(motivoEdad(r(L + 16 * 60e3), L), 'futura');
});

test('los imposibles: HR 0 o 255, 50 °C o más, −40 o menos → NULL con marca y el valor en crudo; los bordes posibles entran', () => {
  const { lectura: a, imposibles } = controlar({ temp_c: 50, hum_pct: 255, presion_hpa: 1013.04, viento_ms: 3, crudo: {} });
  assert.equal(a.temp_c, null);
  assert.equal(a.hum_pct, null);
  assert.equal(imposibles, 2);
  assert.deepEqual(a.marcas, ['hum_imposible', 'temp_imposible']);
  assert.deepEqual(a.crudo, { temp_c: 50, hum_pct: 255 });
  assert.equal(a.presion_hpa, 1013);
  assert.equal(controlar({ hum_pct: 0 }).lectura.hum_pct, null);
  assert.equal(controlar({ temp_c: -40 }).lectura.temp_c, null);
  assert.equal(controlar({ temp_c: 49.9 }).lectura.temp_c, 49.9);
  assert.equal(controlar({ temp_c: -39.9 }).lectura.temp_c, -39.9);
  assert.equal(controlar({ hum_pct: 100 }).lectura.hum_pct, 100);
  assert.equal(controlar({ hum_pct: 1 }).lectura.hum_pct, 1);
  assert.equal(controlar({ viento_ms: -1 }).lectura.viento_ms, null);
  assert.equal(controlar({ presion_hpa: 10000 }).lectura.presion_hpa, null);
});

test('una lluvia sin período no entra (no se sabe de cuánto tiempo es)', () => {
  const { lectura } = controlar({ lluvia_mm: 2 });
  assert.equal(lectura.lluvia_mm, null);
  assert.deepEqual(lectura.marcas, ['lluvia_sin_periodo']);
  assert.equal(controlar({ lluvia_mm: 2, lluvia_periodo_min: 10 }).lectura.lluvia_mm, 2);
});

test('limpiar: sin variables no entra; la repetida queda una (la más completa); firma estable', () => {
  const base = { estacion_id: '9001', instante: L - H, tipo: 'instantanea' };
  const r = limpiar([{ ...base, temp_c: 20 }, { ...base, temp_c: 20, hum_pct: 50 }, { ...base, instante: L - 2 * H, temp_c: null }], L);
  assert.equal(r.lecturas.length, 1);
  assert.equal(r.lecturas[0].hum_pct, 50);
  assert.deepEqual(r.descartadas, { repetida: 1, sin_variables: 1 });
  const f1 = firmaLectura(r.lecturas[0]);
  assert.equal(f1, r.lecturas[0].firma);
  assert.equal(firmaLectura({ ...r.lecturas[0], leido_en: 1 }), f1);          // cuándo se leyó no cambia la firma
  assert.notEqual(firmaLectura({ ...r.lecturas[0], temp_c: 20.1 }), f1);
});

test('instantes: ISO con zona sí, sin zona no (no se adivina); epoch s y ms', () => {
  assert.equal(instante('2026-01-10T15:00:00Z[UTC]'), L);
  assert.equal(instante('2026-01-10T12:00:00-03:00'), L);
  assert.equal(instante('2026-01-10T15:00:00'), null);
  assert.equal(instante(L / 1000), L);
  assert.equal(instante(L), L);
  assert.equal(desdeLocal('2026-01-10T12:00'), L);
  assert.equal(rumbo('OSO'), 247.5);
  assert.equal(rumbo('WSW'), 247.5);
});

test('la clave de una ronda: <día ARG>/<HHMM UTC>; de 00 a 02 UTC es del día ARG anterior', () => {
  assert.equal(instanteDeClave('estaciones-internas/eeaoc/2026-01-10/1511.json'), Date.parse('2026-01-10T15:11:00Z'));
  assert.equal(instanteDeClave('estaciones-internas/eeaoc/2026-01-10/0111.json'), Date.parse('2026-01-11T01:11:00Z'));
  assert.equal(instanteDeClave('estaciones-internas/weatherlink/indices/2026-01-10.json'), null);
});

test('el log público: sólo números y categorías; un nombre, una lista o un id en una clave lo frenan', () => {
  assert.doesNotThrow(() => soloCantidades({ horas: 1, fuentes: { eeaoc: { ok: true, error: 'base:23514' } } }));
  assert.throws(() => soloCantidades({ error: 'Prueba 1' }));
  assert.throws(() => soloCantidades({ horas: ['9001'] }));
  assert.throws(() => soloCantidades({ 'est_9001': 1 }));
  assert.throws(() => soloCantidades({ fuentes: { eeaoc: { error: '-34.5' } } }));
});
