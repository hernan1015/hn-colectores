// HN AGRO · estaciones-parseo · CONTRA UN POSTGRES DE VERDAD, con postgres.js (el mismo driver y las mismas opciones que
// en Actions: prepare:false, sql.unsafe con parámetros). PGlite NO alcanza: el 19/11 la corrida real falló en todas las
// fuentes con base:22023 y en PGlite todo pasaba. La causa: con «$2::jsonb», postgres.js pregunta el tipo del parámetro,
// ve jsonb y le vuelve a aplicar JSON.stringify al texto que ya era JSON → la base recibe un string (un escalar) y
// jsonb_to_recordset responde 22023. El arreglo: «($2::text)::jsonb».
//
// Corre si HN_PG_REAL_URL apunta a un Postgres local con un superusuario (crea una base temporal y la borra), y postgres
// está instalado (npm ci en estaciones-parseo). Si no, se saltea. En pc-nanci:
//   HN_PG_REAL_URL=postgres://postgres@127.0.0.1:54329/postgres (embedded-postgres en C:/HN-AGRO/herramientas-postgres)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FIX, AHORA } from './ayuda.mjs';
import { ESQUEMA, MIGRACION_0161, conectarPg } from '../lib/base.mjs';
import { almacenDeCarpeta } from '../lib/almacen.mjs';
import { correr } from '../parsear.mjs';

const URL_ADMIN = process.env.HN_PG_REAL_URL;
let postgres = null;
if (URL_ADMIN) { try { postgres = (await import('postgres')).default; } catch { postgres = null; } }
const SALTEO = !URL_ADMIN ? 'sin HN_PG_REAL_URL (un Postgres local de prueba)' : !postgres ? 'falta postgres (npm ci en estaciones-parseo)' : false;

async function baseTemporal() {
  const admin = postgres(URL_ADMIN, { max: 1, onnotice: () => {} });
  const nombre = 'hn_parseo_' + process.pid + '_' + Date.now();
  await admin.unsafe(`create database ${nombre}`);
  const u = new URL(URL_ADMIN); u.pathname = '/' + nombre;
  const sup = postgres(u.toString(), { max: 1, onnotice: () => {} });
  // los roles son de todo el clúster: se crean una vez
  const roles = (await sup.unsafe("select count(*)::int as n from pg_roles where rolname = 'colector_estaciones'"))[0].n;
  for (const f of [...ESQUEMA, MIGRACION_0161]) {
    let t = fs.readFileSync(f, 'utf8');
    if (roles && f.endsWith('previo.sql')) t = t.replace(/^create role [^\n]*$/gm, '');
    await sup.unsafe(t);
  }
  await sup.unsafe("alter role colector_estaciones login");
  await sup.unsafe(`grant connect on database ${nombre} to colector_estaciones`);
  const uc = new URL(u.toString()); uc.username = 'colector_estaciones'; uc.password = '';
  const fin = async () => { await sup.end(); await admin.unsafe(`drop database if exists ${nombre} with (force)`); await admin.end(); };
  return { sup, urlColector: uc.toString(), fin };
}

test('CON POSTGRES DE VERDAD: el job escribe (antes del arreglo, 22023 en todas las fuentes) y la segunda corrida no', { skip: SALTEO }, async () => {
  const b = await baseTemporal();
  try {
    const db = await conectarPg({ url: b.urlColector, conectar: postgres, hostPermitido: () => true, ssl: false });
    try {
      const almacen = almacenDeCarpeta(FIX);
      const r1 = await correr({ almacen, db, ahora: AHORA });
      for (const [f, x] of Object.entries(r1.fuentes)) assert.equal(x.error, undefined, `${f}: ${x.error}`);
      assert.equal(r1.ok, true);
      assert.equal(r1.total.nuevas, 24);
      const r2 = await correr({ almacen, db, ahora: AHORA });
      assert.equal(r2.ok, true);
      assert.equal(r2.total.nuevas + r2.total.cambiadas + r2.total.estaciones, 0);
    } finally { await db.cerrar(); }
    const n = await b.sup.unsafe('select count(*)::int as n from estaciones_lecturas');
    assert.equal(n[0].n, 24);
    // el resumen de registro_procesos llega como OBJETO, no como un string JSON
    const t = await b.sup.unsafe("select jsonb_typeof(resumen) as t from registro_procesos where proceso = 'estaciones_parseo'");
    assert.deepEqual(t.map((x) => x.t), ['object', 'object']);
    const m = await b.sup.unsafe("select jsonb_typeof(marcas::text::jsonb) as t from (select to_jsonb(marcas) as marcas from estaciones_lecturas where estacion_id = '9002') s");
    assert.equal(m[0].t, 'array');
  } finally { await b.fin(); }
});

test('CONTROL NEGATIVO con Postgres de verdad: la forma de antes («$2::jsonb» con el texto) da 22023', { skip: SALTEO }, async () => {
  const sql = postgres(URL_ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const arr = JSON.stringify([{ a: 1 }, { a: 2 }]);
    await assert.rejects(sql.unsafe('select count(*) from jsonb_to_recordset($1::jsonb) as x(a int)', [arr]), (e) => e.code === '22023');
    const ok = await sql.unsafe('select count(*)::int as n from jsonb_to_recordset(($1::text)::jsonb) as x(a int)', [arr]);
    assert.equal(ok[0].n, 2);
  } finally { await sql.end(); }
});
