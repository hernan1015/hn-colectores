// node --test · las métricas del sello (sesgo, MAE, % con |dif| ≥ umbral), los cortes por zona y región, y la
// propuesta de la estación al lote. Fixtures sintéticos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricas, resumen } from '../lib/metricas.mjs';
import { region, zonaDe } from '../lib/region.mjs';
import { estacionParaLote, distanciaKm } from '../lib/lote.mjs';
import { ZONAS, REGIONES } from '../lib/sello.mjs';

test('sesgo, MAE y % con |dif| ≥ 3 °C (el borde cuenta); con menos de 5, sólo n', () => {
  const m = metricas([1, -1, 3, -3, 0.5, 2.99], 3);
  assert.equal(m.n, 6);
  assert.equal(m.sesgo, 0.58);                  // 3,49 / 6
  assert.equal(m.mae, 1.92);                    // 11,49 / 6
  assert.equal(m.pct_umbral, 33.33, 'exactamente 3 cuenta; 2,99 no');
  assert.deepEqual(metricas([1, 2, 3, 4], 3), { n: 4, pocas: true });
  assert.deepEqual(metricas([1, null, 2, NaN, 3, 4], 3), { n: 4, pocas: true }, 'null y NaN no cuentan');
  const hr = metricas([-7, -12, 10, -9.99, -15], 10);
  assert.equal(hr.sesgo, -6.8);
  assert.equal(hr.mae, 10.8);
  assert.equal(hr.pct_umbral, 60, 'HR en puntos, con 10 pp');
});

test('el resumen: total, las 5 zonas y las 6 regiones siempre, cada variable sólo con sus filas válidas', () => {
  const f = (zona, reg, d, ok = true) => ({ zona, region: reg, noche_ok: ok, noche_dif_c: ok ? d : null, tmax_ok: false, tmax_dif_c: null, hr_ok: false, hr_dif_pp: null });
  const filas = [...Array(5)].map((_, i) => f('agricola', 'pampa_norte', i)).concat([f('urbana', 'nea', 9), f('natural', 'cuyo', 0, false)]);
  const r = resumen(filas);
  assert.deepEqual(Object.keys(r.por_zona), ZONAS);
  assert.deepEqual(Object.keys(r.por_region), REGIONES);
  assert.equal(r.total.noche.n, 6, 'la noche no válida no entra');
  assert.equal(r.por_zona.agricola.noche.sesgo, 2);
  assert.equal(r.por_zona.agricola.noche.pct_umbral, 40);
  assert.deepEqual(r.por_zona.urbana.noche, { n: 1, pocas: true });
  assert.deepEqual(r.por_zona.sin_dato.noche, { n: 0, pocas: true });
  assert.deepEqual(r.total.tmax, { n: 0, pocas: true });
});

test('las regiones del sello (cajas por coordenada) y la zona de la 257', () => {
  const casos = [
    ['Neuquén', -38.95, -68.06, 'patagonia'], ['Guerrico (Alto Valle)', -39.03, -67.7, 'patagonia'], ['Viedma', -40.8, -63.0, 'patagonia'],
    ['Malargüe', -35.47, -69.58, 'cuyo'], ['Mendoza', -32.89, -68.84, 'cuyo'], ['San Luis', -33.3, -66.34, 'cuyo'],
    ['Tucumán', -26.8, -65.2, 'noa'], ['La Rioja', -29.4, -66.85, 'noa'], ['Charata', -27.2, -61.2, 'nea'], ['Reconquista', -29.15, -59.65, 'nea'],
    ['Pergamino', -33.9, -60.6, 'pampa_norte'], ['Río Cuarto', -33.1, -64.3, 'pampa_norte'], ['Paraná', -31.7, -60.5, 'pampa_norte'],
    ['Bahía Blanca', -38.72, -62.27, 'pampa_sur'], ['Santa Rosa', -36.6, -64.3, 'pampa_sur'], ['Balcarce', -37.75, -58.3, 'pampa_sur'],
  ];
  for (const [n, lat, lon, r] of casos) assert.equal(region(lat, lon), r, n);
  assert.equal(region(null, -60), 'sin_dato');
  assert.equal(zonaDe('agricola'), 'agricola');
  assert.equal(zonaDe(undefined), 'sin_dato');
  assert.equal(zonaDe('selva'), 'sin_dato');
});

test('del lote a la estación (propuesta): misma zona y región dentro de 25 km; si no, la vecina; si no, ninguna', () => {
  const lote = { lat: -33.9, lon: -60.6 };
  const est = (id, dlat, zona, extra = {}) => ({ red: 'X', estacion_id: id, lat: -33.9 + dlat, lon: -60.6, zona, region: 'pampa_norte', noche_ok: true, noche_dif_c: 1.5, ...extra });
  assert.ok(Math.abs(distanciaKm(lote, { lat: -34.0, lon: -60.6 }) - 11.1) < 0.1);
  // la urbana más cerca pierde contra la agrícola más lejos
  const a = estacionParaLote(lote, [est('u', 0.02, 'urbana'), est('a', 0.15, 'agricola'), est('a2', 0.18, 'agricola')]);
  assert.equal(a.estacion.estacion_id, 'a'); assert.equal(a.marca, 'misma_zona'); assert.equal(a.dif_noche_c, 1.5);
  // sólo pastizal cerca: vecina
  const b = estacionParaLote(lote, [est('p', 0.1, 'pastizal'), est('n', 0.01, 'natural')]);
  assert.equal(b.estacion.estacion_id, 'p'); assert.equal(b.marca, 'zona_vecina');
  // a más de 25 km, con la noche inválida, en otra región o con 300 m de diferencia de altura: ninguna
  const c = estacionParaLote({ ...lote, altura_m: 50 }, [est('lejos', 0.3, 'agricola'), est('mala', 0.01, 'agricola', { noche_ok: false }),
    est('otra', 0.01, 'agricola', { region: 'nea' }), est('alta', 0.01, 'agricola', { altura_m: 350 })]);
  assert.equal(c.estacion, null); assert.equal(c.marca, 'sin_estacion');
});
