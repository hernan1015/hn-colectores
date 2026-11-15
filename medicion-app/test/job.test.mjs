// node --test · el job de punta a punta con una base en memoria y un Open-Meteo falso: qué se pide, qué se escribe,
// el seco, la víspera y el log público de UNA línea con cantidades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correr, vispera, lineaLog, mensajeError } from '../medir-app.mjs';
import { FECHA, SIG, fila, estacionCompleta, baseFalsa, fetchFalso, sinEspera } from './fixtures.mjs';

const OBS = [
  ...estacionCompleta({ id: '100', lat: -33.9, lon: -60.6, zona: 'agricola', tmin: 4.2, tmax: 27.5, hum: 60 }),
  ...estacionCompleta({ id: '200', lat: -38.95, lon: -68.06, zona: 'natural', tmin: -1.0, tmax: 30, hum: 40 }),
  // otra red en el MISMO punto que la 100: se pide una vez
  ...estacionCompleta({ red: 'SNIH', id: '300', lat: -33.9, lon: -60.6, zona: 'pastizal', tmin: 5, tmax: 26, hum: 70 }),
  // sin datos suficientes en nada: NO se le pide a Open-Meteo
  fila(FECHA, { red: 'EEAOC', estacion_id: '400', lat: -26.8, lon: -65.2, zona: null, registros_validos: 5 }),
  fila(SIG, { red: 'EEAOC', estacion_id: '400', lat: -26.8, lon: -65.2, zona: null, noche_registros: 3 }),
];

test('real: pide sólo las candidatas, una vez por punto, y escribe una fila por estación con app − estación', async () => {
  const base = baseFalsa(OBS);
  const f = fetchFalso((lat) => (lat < -38 ? { noche: 1.5, tmax: 28, hr: 50 } : { noche: 5, tmax: 28, hr: 55 }));
  const lineas = [];
  const r = await correr({ base, fecha: FECHA, real: true, fetchFn: f, esperar: sinEspera, log: (l) => lineas.push(l) });
  assert.equal(r.ok, true);
  assert.equal(f.urls.length, 1, 'un solo pedido: 2 puntos únicos en un lote');
  assert.equal(new URL(f.urls[0]).searchParams.get('latitude').split(',').length, 2);
  assert.ok(!f.urls[0].includes('-26.8'), 'la estación sin datos no se pide');
  assert.equal(base.escritas.length, 4, 'una fila por estación, también la que no vale');
  const e = Object.fromEntries(base.escritas.map((x) => [x.estacion_id, x]));
  assert.equal(e['100'].noche_dif_c, 0.8);      // 5 − 4,2
  assert.equal(e['100'].tmax_dif_c, 0.5);       // 28 − 27,5
  assert.equal(e['100'].hr_dif_pp, -5);         // 55 − 60
  assert.equal(e['200'].noche_dif_c, 2.5);      // 1,5 − (−1)
  assert.equal(e['200'].region, 'patagonia');
  assert.equal(e['300'].zona, 'pastizal');
  assert.equal(e['400'].noche_ok, false); assert.equal(e['400'].noche_dif_c, null);
  assert.equal(e['400'].zona, 'sin_dato');
  assert.ok(e['400'].motivos.includes('noche_pocas_lecturas'));
  assert.equal(e['100'].app.modelo, 'best_match');
  assert.equal(e['100'].regla, 'm1');
  // el resumen va a registro_procesos, con métricas por zona y región, sin ids ni coordenadas
  assert.equal(base.registros.length, 1);
  const res = base.registros[0].r;
  assert.equal(res.validas.noche, 3);
  assert.equal(res.total.noche.n, 3);
  assert.equal(res.por_zona.agricola.noche.n, 1);
  const txt = JSON.stringify(res);
  for (const x of ['"100"', '"200"', '-33.9', '-60.6', '-38.95', 'SIGA_RT', 'EEAOC']) assert.ok(!txt.includes(x), 'el resumen no lleva ' + x);
});

test('el log público: UNA línea, sólo cantidades (ni valores medidos, ni ids, ni coordenadas)', async () => {
  const lineas = [];
  await correr({ base: baseFalsa(OBS), fecha: FECHA, real: true, fetchFn: fetchFalso(), esperar: sinEspera, log: (l) => lineas.push(l) });
  assert.equal(lineas.length, 1);
  const l = lineas[0];
  assert.match(l, /^medicion-app real: fecha=2026-11-14 estaciones=4 candidatas=3 puntos=2 pedidos=1 noche=3 tmax=3 hr=3 escritas=4 errores=0$/);
  for (const x of ['-33', '-60', '4.2', '27.5', '100', 'SIGA', 'sesgo', 'mae']) assert.ok(!l.includes(x), x);
  assert.equal(lineaLog({ modo: 'seco', fecha: FECHA, estaciones: 1, candidatas: 1, puntos: 1, pedidos: 1, validas: { noche: 0, tmax: 0, hr: 0 }, escritas: 0, errores: 0, cortado: true, fuera_de_tope: 3 }),
    'medicion-app seco: fecha=2026-11-14 estaciones=1 candidatas=1 puntos=1 pedidos=1 noche=0 tmax=0 hr=0 escritas=0 errores=0 cortado=si fuera_de_tope=3');
  assert.equal(mensajeError(new Error('postgres://u:clave@host')), 'error Error', 'un error ajeno no sale con su texto');
});

test('seco: pide y cuenta, pero no escribe ni anota', async () => {
  const base = baseFalsa(OBS);
  const r = await correr({ base, fecha: FECHA, real: false, fetchFn: fetchFalso(), esperar: sinEspera, log: () => {} });
  assert.equal(base.escritas.length, 0);
  assert.equal(base.registros.length, 0);
  assert.equal(r.validas.noche, 3);
});

test('Open-Meteo cortado: la corrida queda ok = false y las variables sin app no valen (noche_sin_app)', async () => {
  const base = baseFalsa(OBS);
  const r = await correr({ base, fecha: FECHA, real: true, fetchFn: fetchFalso(() => ({}), { estados: [503, 503] }), esperar: sinEspera, log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.cortado, true);
  assert.equal(base.registros[0].ok, false);
  assert.equal(r.validas.noche, 0);
  assert.ok(base.escritas.find((x) => x.estacion_id === '100').motivos.includes('noche_sin_app'));
});

test('la víspera en hora argentina y la fecha validada', async () => {
  assert.equal(vispera(Date.parse('2026-11-15T13:00:00Z')), '2026-11-14', 'el cron de las 13:00 UTC = 10:00 ARG');
  assert.equal(vispera(Date.parse('2026-11-15T02:00:00Z')), '2026-11-13', 'a las 23 ARG del 14 todavía es el 14');
  await assert.rejects(correr({ base: baseFalsa([]), fecha: '14/11/2026', log: () => {} }), /fecha inválida/);
});
