// node --test test/parseo.test.mjs · el job en SECO sobre una carpeta-R2: la ventana, sólo lectura, sin ids en la salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correr, diasVentana, clavesVentana, leerArgs, soloLectura, HORAS } from '../parseo.mjs';
import WL from '../fuentes/weatherlink.mjs';
import { carpeta, rondaWL, indiceWL, rondaWC, detalleWL, devWC } from './fixtures.mjs';

const AHORA = Date.parse('2026-11-15T18:30:00Z');            // 15:30 ART del 15
const nada = () => {};

test('la ventana: los días ARG que toca, y cruza la medianoche (la ronda de las 23:11 ART está en la carpeta del día anterior)', async () => {
  assert.deepEqual(diasVentana(AHORA, 6), ['2026-11-15']);
  assert.deepEqual(diasVentana(Date.parse('2026-11-16T03:30:00Z'), 6), ['2026-11-15', '2026-11-16']);   // 00:30 ART del 16
  assert.deepEqual(diasVentana(AHORA, 50), ['2026-11-13', '2026-11-14', '2026-11-15']);
  const { r2 } = carpeta();
  await rondaWL(r2, Date.parse('2026-11-16T02:11:00Z'), [{ id: '1', d: detalleWL({ t: '2026-11-16T02:05:00Z' }) }]);   // 23:11 ART del 15
  assert.deepEqual(await clavesVentana(soloLectura(r2), WL, Date.parse('2026-11-16T03:30:00Z'), 6), ['estaciones-internas/weatherlink/2026-11-15/0211.jsonl']);
});

test('argumentos: seco por defecto; --horas y --desde; opciones desconocidas afuera', () => {
  assert.deepEqual(leerArgs([]), { real: false, fuentes: null, horas: HORAS, ahora: null });
  assert.equal(HORAS, 6);
  assert.equal(leerArgs(['--real']).real, true);
  assert.deepEqual(leerArgs(['--fuentes', 'weatherlink, eeaoc']).fuentes, ['weatherlink', 'eeaoc']);
  assert.throws(() => leerArgs(['--proxy', 'x']), /desconocida/);
  assert.throws(() => leerArgs(['--horas', '300']), /de 1 a 72/);
  assert.equal(leerArgs(['--desde', '2026-11-15', '--ahora', '2026-11-17T03:00:00Z']).horas, 48);
  assert.throws(() => leerArgs(['--desde', '2026-01-01', '--ahora', '2026-11-17T03:00:00Z']), /31 días/);
});

test('R2 sólo de lectura: los módulos no pueden escribir ni borrar', () => {
  const { r2 } = carpeta();
  const ro = soloLectura(r2);
  assert.deepEqual(Object.keys(ro).sort(), ['leer', 'listar']);
  assert.equal(ro.escribir, undefined); assert.equal(ro.borrar, undefined);
  assert.throws(() => { ro.escribir = () => {}; });
});

test('seco: arma las filas, no escribe nada, y la salida no trae ids, nombres ni coordenadas', async () => {
  const { r2 } = carpeta();
  await indiceWL(r2, '2026-11-15', [{ id: 'est501', lat: -39.03, lng: -67.58, tb: 1 }]);
  await rondaWL(r2, Date.parse('2026-11-15T15:11:00Z'), [{ id: 'est501', d: detalleWL({ t: '2026-11-15T15:05:00Z', nombre: 'Chacra Secreta' }) }]);
  await rondaWL(r2, Date.parse('2026-11-15T16:11:00Z'), [{ id: 'est501', d: detalleWL({ t: '2026-11-15T16:05:00Z', nombre: 'Chacra Secreta' }) }]);
  await rondaWC(r2, Date.parse('2026-11-15T15:11:00Z'), [devWC('wc777')]);
  const antes = (await r2.listar('')).length;
  const lineas = [];
  const res = await correr({ r2, ahora: AHORA, log: (x) => lineas.push(x) });
  assert.equal((await r2.listar('')).length, antes);
  assert.equal(res.modo, 'seco'); assert.equal(res.ok, true);
  assert.equal(res.fuentes.weatherlink.lecturas, 2); assert.equal(res.fuentes.weatherlink.filas_escritas, 1);
  assert.equal(res.fuentes.weathercloud.lecturas, 0); assert.equal(res.fuentes.weathercloud.cuentas.devices, 1);
  assert.equal(lineas.length, 1, 'una sola línea en el registro público');
  for (const s of ['est501', 'wc777', 'Chacra', '-39.03', '-67.58', 'Córdoba']) assert.ok(!lineas[0].includes(s), s);
});

test('un módulo que falla no tira a los demás y la corrida sale no-ok (sin URLs en el error)', async () => {
  const { r2 } = carpeta();
  const malo = { id: 'mala', proceso: 'x', redes: {}, contexto: async () => { throw new Error('se cayó https://cuenta.r2.cloudflarestorage.com/x'); }, leer: () => [] };
  const bueno = { id: 'buena', proceso: 'x', redes: {}, leer: () => [] };
  const res = await correr({ r2, ahora: AHORA, fuentes: [malo, bueno], log: nada });
  assert.equal(res.ok, false); assert.match(res.fuentes.mala.error, /<url>/); assert.ok(!res.fuentes.mala.error.includes('cloudflarestorage'));
  assert.equal(res.fuentes.buena.rondas, 0); assert.equal(res.fuentes.buena.error, undefined);
});
