// node --test · el lado de la app: el armado de los lotes de Open-Meteo, la URL (la misma serie que la app), la cuota,
// las horas de cada ventana, la lectura de la respuesta y los pedidos con pausa y reintento. Sin pedidos reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { puntosUnicos, armarLotes, urlLote, pesoPunto, horasVentana, ladoApp, leerRespuesta, traerLotes, clavePunto } from '../lib/openmeteo.mjs';
import { OM } from '../lib/sello.mjs';
import { FECHA, SIG, serieOM, fetchFalso } from './fixtures.mjs';

const puntos = (n) => Array.from({ length: n }, (_, i) => ({ lat: -30 - i / 1000, lon: -60 - i / 1000 }));

test('los lotes: puntos únicos, 50 por pedido, el tope de 2.000 y la cuenta de 1.500 estaciones', () => {
  const u = puntosUnicos([{ lat: -33.12341, lon: -60.5 }, { lat: -33.12344, lon: -60.50001 }, { lat: -34, lon: -61 }, { lat: null, lon: -61 }]);
  assert.equal(u.length, 2, 'la misma coordenada (a 4 decimales) en dos redes se pide una vez; sin coordenada no se pide');
  const { lotes, fuera_de_tope } = armarLotes(puntosUnicos(puntos(1500)));
  assert.equal(lotes.length, 30);
  assert.ok(lotes.every((l) => l.length === 50));
  assert.equal(fuera_de_tope, 0);
  // la cuota: peso 1 por coordenada (2 variables, 2 días) → 1.500 de 10.000 por día, 100 por minuto con 30 s de pausa
  assert.equal(pesoPunto(OM.hourly.length, 2), 1);
  const porDia = 1500 * pesoPunto(2, 2);
  assert.ok(porDia <= 0.2 * 10000, 'muy por debajo del límite diario gratuito');
  assert.ok((60000 / OM.pausa_ms) * OM.por_pedido <= 0.2 * 600, 'muy por debajo del límite por minuto');
  const t = armarLotes(puntosUnicos(puntos(2100)));
  assert.equal(t.lotes.flat().length, 2000);
  assert.equal(t.fuera_de_tope, 100);
  assert.equal(Math.round(pesoPunto(23, 16) * 100) / 100, 2.63, 'la fórmula de Open-Meteo (el FIJO de la app pesa 2,63)');
});

test('la URL: /v1/forecast, sin models (best_match), las variables horarias de la app, la hora ARG y dos días', () => {
  const lote = puntosUnicos(puntos(3));
  const url = urlLote(lote, FECHA);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('hourly'), 'temperature_2m,relative_humidity_2m');
  assert.equal(u.searchParams.get('timezone'), 'America/Argentina/Buenos_Aires');
  assert.equal(u.searchParams.get('start_date'), FECHA);
  assert.equal(u.searchParams.get('end_date'), SIG);
  assert.equal(u.searchParams.get('latitude'), '-30.0000,-30.0010,-30.0020');
  assert.equal(u.searchParams.get('longitude').split(',').length, 3);
  for (const p of ['models', 'cell_selection', 'daily', 'current', 'apikey']) assert.equal(u.searchParams.has(p), false, p);
  assert.ok(url.length < 2000, 'un lote de 50 entra en una URL corta');
  assert.ok(urlLote(puntosUnicos(puntos(50)), FECHA).length < 2000);
});

test('las ventanas de la app: 15 horas de noche (19 a 09) y 24 de día (01 a 24)', () => {
  const { noche, dia } = horasVentana(FECHA);
  assert.equal(noche.length, 15);
  assert.equal(noche[0], `${FECHA}T19:00`);
  assert.equal(noche.at(-1), `${SIG}T09:00`);
  assert.ok(!noche.includes(`${FECHA}T18:00`));
  assert.equal(dia.length, 24);
  assert.equal(dia[0], `${FECHA}T01:00`);
  assert.equal(dia.at(-1), `${SIG}T00:00`);
});

test('el lado de la app: la mínima de la noche no ve las 18:00 ni las 10:00; si falta una hora, no hay valor', () => {
  const s = serieOM({ lat: -33.9, lon: -60.6, noche: 3.5, tmax: 29, hr: 57 });
  const a = ladoApp({ hourly: s.hourly, celda: { lat: -33.9 } }, FECHA);
  assert.equal(a.noche, 3.5, 'las 18:00 y las 10:00 valen −10 y quedan afuera');
  assert.equal(a.tmax, 29);
  assert.equal(a.hr, 57);
  assert.equal(ladoApp({ hourly: serieOM({ lat: 0, lon: 0, falta: `${SIG}T03:00` }).hourly }, FECHA).noche, null);
  assert.equal(ladoApp({ hourly: serieOM({ lat: 0, lon: 0, falta: `${FECHA}T12:00` }).hourly }, FECHA).tmax, null);
});

test('la respuesta: un objeto o un arreglo, en el orden del pedido; otra celda u otro huso se descartan', () => {
  const lote = puntosUnicos([{ lat: -33.9, lon: -60.6 }, { lat: -38.9, lon: -68.1 }]);
  const ok = leerRespuesta([serieOM(lote[0]), serieOM(lote[1])], lote);
  assert.equal(ok.series.size, 2);
  assert.equal(ok.series.get(clavePunto(-33.9, -60.6)).celda.elevacion, 30);
  const uno = leerRespuesta(serieOM(lote[0]), [lote[0]]);
  assert.equal(uno.series.size, 1);
  const cruzada = leerRespuesta([serieOM(lote[1]), serieOM(lote[0])], lote);
  assert.equal(cruzada.series.size, 0, 'el orden cambiado no se toma');
  assert.equal(cruzada.descartados, 2);
  assert.equal(leerRespuesta([serieOM({ ...lote[0], offset: 0 }), serieOM(lote[1])], lote).descartados, 1, 'UTC no es la hora ARG');
  assert.throws(() => leerRespuesta([serieOM(lote[0])], lote), /un punto por coordenada/);
});

test('los pedidos: de a uno, con 30 s de pausa entre lotes, un reintento a los 60 s y corte si vuelve a fallar', async () => {
  const lotes = armarLotes(puntosUnicos(puntos(120))).lotes;
  const esperas = [];
  const esperar = async (ms) => { esperas.push(ms); };
  const f = fetchFalso();
  const r = await traerLotes(lotes, FECHA, { fetchFn: f, esperar });
  assert.equal(f.urls.length, 3);
  assert.deepEqual(esperas, [30000, 30000], 'pausa entre pedidos, no antes del primero');
  assert.equal(r.series.size, 120);
  assert.equal(r.cuenta.cortado, false);
  // un 429 y después bien: un reintento
  const e2 = []; const f2 = fetchFalso(() => ({}), { estados: [429] });
  const r2 = await traerLotes(lotes.slice(0, 1), FECHA, { fetchFn: f2, esperar: async (ms) => e2.push(ms) });
  assert.equal(r2.cuenta.reintentos, 1);
  assert.deepEqual(e2, [60000]);
  assert.equal(r2.series.size, 50);
  // dos 503 seguidos: corta, y lo que falta no se pide
  const f3 = fetchFalso(() => ({}), { estados: [503, 503] });
  const r3 = await traerLotes(lotes, FECHA, { fetchFn: f3, esperar: async () => {} });
  assert.equal(r3.cuenta.cortado, true);
  assert.equal(f3.urls.length, 2);
  assert.equal(r3.series.size, 0);
  // un 400 no se reintenta
  const f4 = fetchFalso(() => ({}), { estados: [400] });
  const r4 = await traerLotes(lotes, FECHA, { fetchFn: f4, esperar: async () => {} });
  assert.equal(f4.urls.length, 1);
  assert.equal(r4.cuenta.cortado, true);
  // una falla de red, dos veces: corta
  let n = 0;
  const r5 = await traerLotes(lotes, FECHA, { fetchFn: async () => { n++; throw new Error('ECONNRESET 1.2.3.4'); }, esperar: async () => {} });
  assert.equal(n, 2); assert.equal(r5.cuenta.cortado, true); assert.equal(r5.cuenta.error, 'red');
});
