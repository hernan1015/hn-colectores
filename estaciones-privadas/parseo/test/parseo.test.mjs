// node --test test/parseo.test.mjs · el job en SECO sobre una carpeta-R2: los días, sólo lectura, sin ids en la salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correr, diasDe, leerArgs, soloLectura } from '../parseo.mjs';
import { carpeta, rondaWL, indiceWL, rondaWC, detalleWL, devWC } from './fixtures.mjs';

const AHORA = Date.parse('2026-11-15T18:30:00Z');            // 15:30 ART del 15

test('días: objetivo hoy y ayer (ARG); se lee uno más atrás por la noche', () => {
  assert.deepEqual(diasDe(AHORA, 2), { objetivo: ['2026-11-14', '2026-11-15'], leer: ['2026-11-13', '2026-11-14', '2026-11-15'] });
  assert.deepEqual(diasDe(Date.parse('2026-11-16T02:00:00Z'), 1).objetivo, ['2026-11-15']);   // 23:00 ART del 15
});

test('argumentos: seco por defecto; opciones desconocidas afuera', () => {
  assert.deepEqual(leerArgs([]), { real: false, fuentes: null, objetivo: 2, ahora: null });
  assert.equal(leerArgs(['--real']).real, true);
  assert.deepEqual(leerArgs(['--fuentes', 'weatherlink, weathercloud']).fuentes, ['weatherlink', 'weathercloud']);
  assert.throws(() => leerArgs(['--proxy', 'x']), /desconocida/);
  assert.throws(() => leerArgs(['--objetivo', '30']), /de 1 a 7/);
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
  const res = await correr({ r2: soloLectura(r2), ahora: AHORA });
  assert.equal((await r2.listar('')).length, antes);
  assert.equal(res.modo, 'seco'); assert.equal(res.ok, true);
  assert.equal(res.fuentes.weatherlink.lecturas, 2); assert.equal(res.fuentes.weatherlink.filas_obs, 1);
  assert.equal(res.fuentes.weathercloud.lecturas, 0); assert.equal(res.fuentes.weathercloud.devices, 1);
  const txt = JSON.stringify(res);
  for (const s of ['est501', 'wc777', 'Chacra', '-39.03', '-67.58', 'Córdoba']) assert.ok(!txt.includes(s), s);
});

test('un módulo que falla no tira a los demás y la corrida sale no-ok (sin URLs en el error)', async () => {
  const { r2 } = carpeta();
  const malo = { fuente: 'mala', red: 'WEATHERLINK_PUB', muestreo_min: 60, leer: async () => { throw new Error('se cayó https://cuenta.r2.cloudflarestorage.com/x'); } };
  const bueno = { fuente: 'buena', red: 'WEATHERLINK_PUB', muestreo_min: 60, leer: async () => ({ estaciones: [], lecturas: [], cuentas: { n: 0 } }) };
  const res = await correr({ r2, ahora: AHORA, modulos: [malo, bueno] });
  assert.equal(res.ok, false); assert.match(res.fuentes.mala.error, /<url>/); assert.ok(!res.fuentes.mala.error.includes('cloudflarestorage'));
  assert.equal(res.fuentes.buena.n, 0);
});
