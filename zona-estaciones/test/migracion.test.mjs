// 257 · la 0153 (sección 1, las funciones) contra un PostgreSQL de verdad (PGlite). La sección 2 (el rol) es de psql
// (\gexec y :'clave') y se verifica a mano al aplicarla. PGlite va FUERA del repo:
//   HN_PGLITE=C:/HN-AGRO/herramientas-pglite/node_modules/@electric-sql/pglite node --test test/migracion.test.mjs
// Sin HN_PGLITE, se saltea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detalle } from '../clasificar-zona.mjs';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = process.env.HN_PGLITE || '';
const HAY = !!DIR && fs.existsSync(path.join(DIR, 'dist', 'index.js'));
const SQL = fs.readFileSync(path.join(RAIZ, 'migracion', '0153_estaciones_zona_PROPUESTA.sql'), 'utf8');
const FUNCIONES = SQL.split('-- 2. El rol')[0];

// La tabla tal como la deja la 0110 (copia de las columnas que importan).
const PREVIO = `
  create role anon; create role authenticated;
  create table estaciones (
    red text not null, estacion_id text not null, nombre text, lat numeric, lon numeric,
    activa boolean not null default true, metadatos jsonb not null default '{}'::jsonb,
    actualizado_en timestamptz not null default '2026-01-01', primary key (red, estacion_id));
  insert into estaciones (red, estacion_id, lat, lon, metadatos) values
    ('SNIH', '1', -34.5, -60.1, '{"tipo":"M"}'),
    ('SNIH', '2', null, null, '{}'),
    ('INTA_SIGA', '3', -38.7, -62.2, '{}');`;

async function nueva() {
  const { PGlite } = await import(pathToFileURL(path.join(DIR, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(PREVIO);
  await pg.exec(FUNCIONES);
  return pg;
}
/** Un detalle VERDADERO, armado por el mismo detalle() que usa el clasificador (así el JS y el SQL no se desfasan). */
const ventanaCultivo = { pixel: 40, conteos: { 100: { 40: 360 }, 250: { 40: 2500, 50: 250 }, 500: { 40: 9000, 30: 2000 } } };
const det = (lat, lon, ahora = new Date('2026-11-15T12:00:00Z'), v = ventanaCultivo) => detalle(v, lat, lon, ahora).detalle;
const fijar = (pg, red, id, zona, d) => pg.query(`select estaciones_fijar_zona($1, $2, $3, $4::jsonb) as cambio`, [red, id, zona, JSON.stringify(d)]);
const pend = async (pg, todas = false) => (await pg.query(`select red, estacion_id from estaciones_zona_pendientes('r1', $1)`, [todas])).rows.map((r) => r.estacion_id);

test('0153: pendientes, fijar sólo zona y zona_wc, y la estación movida vuelve a pendiente', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  assert.deepEqual(await pend(pg), ['3', '1'], 'sin coordenada no entra');
  const r = await fijar(pg, 'SNIH', '1', 'agricola', det(-34.5, -60.1));
  assert.equal(r.rows[0].cambio, true);
  const m = (await pg.query(`select metadatos, actualizado_en from estaciones where estacion_id = '1'`)).rows[0];
  assert.equal(m.metadatos.zona, 'agricola');
  assert.equal(m.metadatos.tipo, 'M', 'el resto de metadatos queda');
  assert.equal(m.metadatos.zona_wc.regla, 'r1');
  assert.equal(m.metadatos.zona_wc.dudosa, false);
  assert.equal(new Date(m.actualizado_en).toISOString(), '2026-01-01T00:00:00.000Z', 'actualizado_en no se toca');
  assert.deepEqual(await pend(pg), ['3']);
  assert.deepEqual(await pend(pg, true), ['3', '1'], '--todas trae todas');
  // la estación se mueve → pendiente otra vez
  await pg.query(`update estaciones set lat = -34.51 where estacion_id = '1'`);
  assert.deepEqual(await pend(pg), ['3', '1']);
  // otra regla → pendiente
  await pg.query(`update estaciones set lat = -34.5 where estacion_id = '1'`);
  assert.deepEqual((await pg.query(`select estacion_id from estaciones_zona_pendientes('r2')`)).rows.map((x) => x.estacion_id), ['3', '1']);
});

test('0153 control negativo: zona inválida, detalle sin cita o enorme, estación inexistente', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  await assert.rejects(fijar(pg, 'SNIH', '1', 'selva', det(-34.5, -60.1)), /zona inválida/);
  const { cita, ...sinCita } = det(-34.5, -60.1);
  assert.ok(cita);
  await assert.rejects(fijar(pg, 'SNIH', '1', 'agricola', sinCita), /detalle inválido/);
  await assert.rejects(fijar(pg, 'SNIH', '1', 'agricola', { ...det(-34.5, -60.1), fuente: 'x'.repeat(5000) }), /detalle inválido/);
  await assert.rejects(fijar(pg, 'SNIH', '99', 'agricola', det(-34.5, -60.1)), /estación inexistente/);
  const m = (await pg.query(`select metadatos from estaciones where estacion_id = '1'`)).rows[0].metadatos;
  assert.equal(m.zona, undefined, 'nada se escribió');
  // anon y authenticated no pueden ejecutarlas
  const priv = (await pg.query(`select has_function_privilege('anon', 'estaciones_fijar_zona(text,text,text,jsonb)', 'execute') a,
                                       has_function_privilege('authenticated', 'estaciones_zona_pendientes(text,boolean)', 'execute') b,
                                       has_function_privilege('anon', 'estaciones_zona_detalle_ok(text,jsonb)', 'execute') c`)).rows[0];
  assert.deepEqual(priv, { a: false, b: false, c: false });
});

// ── 2.ª vuelta (Codex 15/11, n3-257-1511) ───────────────────────────────────────────────────────────────────────
test('Codex 4: el JSON de Codex {regla, cita:null, lat:"INVALID", lon:-60} se rechaza y pendientes sigue andando', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  await assert.rejects(fijar(pg, 'SNIH', '1', 'agricola', { regla: 'r1', cita: null, lat: 'INVALID', lon: -60 }), /detalle inválido/);
  assert.equal((await pg.query(`select metadatos from estaciones where estacion_id = '1'`)).rows[0].metadatos.zona_wc, undefined);
  assert.deepEqual(await pend(pg), ['3', '1'], 'pendientes no se rompe');
  // aunque el valor malo llegue por otro lado (una edición a mano), pendientes NO falla: esa estación queda pendiente
  await pg.query(`update estaciones set metadatos = metadatos || '{"zona_wc":{"regla":"r1","lat":"INVALID","lon":-60}}' where estacion_id = '1'`);
  await pg.query(`update estaciones set metadatos = metadatos || '{"zona_wc":"no soy un objeto"}' where estacion_id = '3'`);
  assert.deepEqual(await pend(pg), ['3', '1']);
});

test('Codex 4 (control): un detalle bueno entra, incluido uno dudoso por cobertura y uno sin_dato', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  assert.equal((await fijar(pg, 'SNIH', '1', 'agricola', det(-34.5, -60.1))).rows[0].cambio, true);
  const medio = { pixel: 40, conteos: { 100: { 40: 360 }, 250: { 40: 2600, 255: 150 }, 500: { 40: 9000, 255: 2000 } } };
  const d = detalle(medio, -38.7, -62.2, new Date('2026-11-15T12:00:00Z'));
  assert.equal(d.zona, 'agricola');
  assert.deepEqual(d.detalle.dudosa_motivo, ['cobertura']);
  assert.equal((await fijar(pg, 'INTA_SIGA', '3', d.zona, d.detalle)).rows[0].cambio, true);
  const nada = detalle({ pixel: null, conteos: { 100: { 255: 360 }, 250: { 255: 2750 }, 500: { 255: 11000 } } }, -38.7, -62.2);
  assert.equal(nada.zona, 'sin_dato');
  assert.equal((await fijar(pg, 'INTA_SIGA', '3', nada.zona, nada.detalle)).rows[0].cambio, true);
});

test('Codex 4: tipos y rangos, uno por uno sobre un detalle bueno (lat, lon, regla, %, cita, zona, claves)', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  const b = det(-34.5, -60.1);
  const malos = {
    'lat texto': { ...b, lat: '-34.5' }, 'lat 91': { ...b, lat: 91 }, 'lon −181': { ...b, lon: -181 }, 'lon null': { ...b, lon: null },
    'regla fuera de la lista': { ...b, regla: 'r9' }, 'regla número': { ...b, regla: 1 },
    'pct 101': { ...b, pct: { ...b.pct, 250: { 40: 101 } } }, 'pct negativo': { ...b, pct: { ...b.pct, 250: { 40: -1 } } },
    'pct texto': { ...b, pct: { ...b.pct, 250: { 40: '90' } } }, 'pct de una clase que no existe': { ...b, pct: { ...b.pct, 250: { 41: 9 } } },
    'pct de un radio que no existe': { ...b, pct: { ...b.pct, 999: {} } }, 'pct no objeto': { ...b, pct: [] },
    'cobertura 120': { ...b, cobertura: { ...b.cobertura, 250: 120 } }, 'cobertura texto': { ...b, cobertura: { ...b.cobertura, 250: 'x' } },
    'cita null': { ...b, cita: null }, 'cita vacía': { ...b, cita: '  ' }, 'cita número': { ...b, cita: 7 },
    'margen texto': { ...b, margen: '5' }, 'margen 300': { ...b, margen: 300 }, 'margen null en agricola': { ...b, margen: null },
    'dudosa sin motivo': { ...b, dudosa: true, dudosa_motivo: [] }, 'motivo sin dudosa': { ...b, dudosa_motivo: ['margen'] },
    'motivo desconocido': { ...b, dudosa: true, dudosa_motivo: ['otro'] }, 'dudosa texto': { ...b, dudosa: 'true' },
    'píxel 41': { ...b, pixel: 41 }, 'píxeles más que el círculo': { ...b, pixeles: b.pixeles_circulo + 1 }, 'píxeles con decimales': { ...b, pixeles: 10.5 },
    'clave de más': { ...b, otra: 1 }, 'fecha mala': { ...b, calculado_en: 'ayer' },
  };
  for (const [nombre, d] of Object.entries(malos)) {
    await assert.rejects(fijar(pg, 'SNIH', '1', 'agricola', d), /detalle inválido/, nombre);
  }
  // la zona: del enum; y sin_dato exige margen null
  await assert.rejects(fijar(pg, 'SNIH', '1', null, b), /zona inválida/);
  await assert.rejects(fijar(pg, 'SNIH', '1', 'sin_dato', b), /detalle inválido/, 'sin_dato con margen');
  // la coordenada tiene que ser la de la estación
  await assert.rejects(fijar(pg, 'SNIH', '1', 'agricola', det(-34.6, -60.1)), /coordenada/);
  assert.equal((await pg.query(`select metadatos from estaciones where estacion_id = '1'`)).rows[0].metadatos.zona, undefined, 'nada se escribió');
  // control: el mismo detalle sin tocar entra
  assert.equal((await fijar(pg, 'SNIH', '1', 'agricola', b)).rows[0].cambio, true);
});

test('--todas: lo que no cambió no se reescribe (ni la fecha), lo que cambió sí', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  const leer = async () => (await pg.query(`select metadatos from estaciones where estacion_id = '1'`)).rows[0].metadatos;
  assert.equal((await fijar(pg, 'SNIH', '1', 'agricola', det(-34.5, -60.1, new Date('2026-11-15T12:00:00Z')))).rows[0].cambio, true);
  // un día después, mismo resultado: no se escribe y queda la fecha original
  assert.equal((await fijar(pg, 'SNIH', '1', 'agricola', det(-34.5, -60.1, new Date('2026-11-16T12:00:00Z')))).rows[0].cambio, false);
  assert.equal((await leer()).zona_wc.calculado_en, '2026-11-15T12:00:00.000Z');
  // control: si cambia algo (otra ventana), se escribe
  const otra = { pixel: 30, conteos: { 100: { 30: 360 }, 250: { 30: 2500, 40: 250 }, 500: { 30: 9000 } } };
  const z = detalle(otra, -34.5, -60.1, new Date('2026-11-17T12:00:00Z'));
  assert.equal((await fijar(pg, 'SNIH', '1', z.zona, z.detalle)).rows[0].cambio, true);
  assert.equal((await leer()).zona, 'pastizal');
});
