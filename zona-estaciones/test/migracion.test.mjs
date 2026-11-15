// 257 · la 0153 (sección 1, las funciones) contra un PostgreSQL de verdad (PGlite). La sección 2 (el rol) es de psql
// (\gexec y :'clave') y se verifica a mano al aplicarla. PGlite va FUERA del repo:
//   HN_PGLITE=C:/HN-AGRO/herramientas-pglite/node_modules/@electric-sql/pglite node --test test/migracion.test.mjs
// Sin HN_PGLITE, se saltea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const det = (lat, lon) => ({ regla: 'r1', cita: 'Zanaga et al. 2022', lat, lon, pct: { 250: { 40: 90 } } });

test('0153: pendientes, fijar sólo zona y zona_wc, y la estación movida vuelve a pendiente', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  const pend = async (todas = false) => (await pg.query(`select red, estacion_id from estaciones_zona_pendientes('r1', $1)`, [todas])).rows.map((r) => r.estacion_id);
  assert.deepEqual(await pend(), ['3', '1'], 'sin coordenada no entra');
  await pg.query(`select estaciones_fijar_zona('SNIH', '1', 'agricola', $1::jsonb)`, [JSON.stringify(det(-34.5, -60.1))]);
  const m = (await pg.query(`select metadatos, actualizado_en from estaciones where estacion_id = '1'`)).rows[0];
  assert.equal(m.metadatos.zona, 'agricola');
  assert.equal(m.metadatos.tipo, 'M', 'el resto de metadatos queda');
  assert.equal(m.metadatos.zona_wc.regla, 'r1');
  assert.equal(new Date(m.actualizado_en).toISOString(), '2026-01-01T00:00:00.000Z', 'actualizado_en no se toca');
  assert.deepEqual(await pend(), ['3']);
  assert.deepEqual(await pend(true), ['3', '1'], '--todas trae todas');
  // la estación se mueve → pendiente otra vez
  await pg.query(`update estaciones set lat = -34.51 where estacion_id = '1'`);
  assert.deepEqual(await pend(), ['3', '1']);
  // otra regla → pendiente
  await pg.query(`update estaciones set lat = -34.5 where estacion_id = '1'`);
  assert.deepEqual((await pg.query(`select estacion_id from estaciones_zona_pendientes('r2')`)).rows.map((r) => r.estacion_id), ['3', '1']);
});

test('0153 control negativo: zona inválida, detalle sin cita o enorme, estación inexistente', { skip: !HAY && 'sin HN_PGLITE' }, async () => {
  const pg = await nueva();
  const fijar = (red, id, zona, d) => pg.query(`select estaciones_fijar_zona($1, $2, $3, $4::jsonb)`, [red, id, zona, JSON.stringify(d)]);
  await assert.rejects(fijar('SNIH', '1', 'selva', det(-34.5, -60.1)), /zona inválida/);
  await assert.rejects(fijar('SNIH', '1', 'agricola', { regla: 'r1', lat: 1, lon: 1 }), /detalle inválido/);
  await assert.rejects(fijar('SNIH', '1', 'agricola', { ...det(-34.5, -60.1), relleno: 'x'.repeat(5000) }), /detalle inválido/);
  await assert.rejects(fijar('SNIH', '99', 'agricola', det(-34.5, -60.1)), /estación inexistente/);
  const m = (await pg.query(`select metadatos from estaciones where estacion_id = '1'`)).rows[0].metadatos;
  assert.equal(m.zona, undefined, 'nada se escribió');
  // anon y authenticated no pueden ejecutarlas
  const priv = (await pg.query(`select has_function_privilege('anon', 'estaciones_fijar_zona(text,text,text,jsonb)', 'execute') a,
                                       has_function_privilege('authenticated', 'estaciones_zona_pendientes(text,boolean)', 'execute') b`)).rows[0];
  assert.deepEqual(priv, { a: false, b: false });
});
