// El upsert y el rol firmador_r2 contra un Postgres de verdad pero portátil: PGlite (Postgres 16 en WASM, sin red,
// instalado por usuario como devDependency). Se aplican 0129 (la tabla, copia literal de hn-agro) y 0141 (el rol
// propuesto) de test/fixtures/, y el upsert corre con SET ROLE firmador_r2 (RLS y GRANT de verdad).
// Control negativo contado: el upsert mutado (sin la guarda de vence, sin coalesce, borrando, con DO NOTHING) tiene que
// dar rojo en al menos una aserción cada uno.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { SQL_UPSERT, upsertEnlaces } from '../lib/base.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const SQL_0129 = fs.readFileSync(new URL('0129_r2_enlaces.sql', FIX), 'utf8');
const SQL_0141 = fs.readFileSync(new URL('0141_firmador_r2_rol.sql', FIX), 'utf8');

async function baseNueva() {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
                 create table public.otra (x int); insert into public.otra values (1);`);
  await db.exec(SQL_0129);
  await db.exec(SQL_0141);
  return db;
}
const comoFirmador = (db) => async (sql, params) => {
  await db.exec('set role firmador_r2');
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
};
const fila = (clave, venceIso, extra = {}) => ({ clave, url: 'https://c.r2.cloudflarestorage.com/satchi-mapas/' + clave + '?X-Amz-Signature=' + venceIso, vence: new Date(venceIso), emitido: '2026-11-06', bytes: 123, ...extra });
const tabla = async (db) => (await db.query('select clave, url, vence, emitido::text as emitido, bytes from public.r2_enlaces order by clave')).rows;

/** Las aserciones del contrato del upsert; `sql` permite correrlas con un upsert mutado */
async function contrato(sql) {
  const db = await baseNueva();
  const q = comoFirmador(db);
  const up = (filas) => upsertEnlaces((s, p) => q(sql, p), filas);
  // fila de la PC, de antes
  await db.query(`insert into public.r2_enlaces (clave, url, vence, emitido, bytes) values
    ('escenarios/brasil.json', 'https://pc/viejo', '2026-11-03T15:07:00Z', '2026-10-26', 10),
    ('tormentas/proyeccion_tormentas.json', 'https://pc/nuevo', '2026-11-20T05:40:00Z', '2026-11-12', 20),
    ('opera/cog/pasadas.json', 'https://pc/pasadas', '2026-11-01T00:00:00Z', '2026-10-25', 30)`);
  const r1 = await up([
    fila('escenarios/brasil.json', '2026-11-14T23:14:05Z'),
    fila('tormentas/proyeccion_tormentas.json', '2026-11-14T23:14:05Z'),
    fila('opera/cog/pasadas.json', '2026-11-14T23:14:05Z', { emitido: null }),
    fila('rayos-hora/2026/11/07/05.json', '2026-11-14T23:14:05Z', { emitido: '2026-11-07' }),
  ]);
  assert.deepEqual(r1, { nuevas: 1, actualizadas: 2, sinCambio: 1 }, 'conteo nuevas/actualizadas/sin cambio');
  const t = Object.fromEntries((await tabla(db)).map((x) => [x.clave, x]));
  assert.equal(t['escenarios/brasil.json'].url.startsWith('https://c.r2'), true, 'el enlace vencido se renueva');
  assert.equal(t['escenarios/brasil.json'].emitido, '2026-11-06', 'emitido nuevo');
  assert.equal(t['tormentas/proyeccion_tormentas.json'].url, 'https://pc/nuevo', 'no pisa un enlace que vence después');
  assert.equal(t['opera/cog/pasadas.json'].emitido, '2026-10-25', 'emitido null no pisa el que había');
  assert.equal(t['rayos-hora/2026/11/07/05.json'].bytes, 123, 'fila nueva');
  // idempotente: lo mismo otra vez no cambia nada (salvo «actualizado»)
  const antes = await tabla(db);
  const r2 = await up([fila('escenarios/brasil.json', '2026-11-14T23:14:05Z'), fila('rayos-hora/2026/11/07/05.json', '2026-11-14T23:14:05Z', { emitido: '2026-11-07' })]);
  assert.deepEqual(await tabla(db), antes, 'idempotente');
  assert.equal(r2.nuevas, 0, 'idempotente: sin filas nuevas');
  assert.equal((await db.query('select count(*)::int as n from public.r2_enlaces')).rows[0].n, 4, 'nunca se borran filas');
  await db.close();
}

test('upsert · contrato (renueva, no pisa uno más nuevo, coalesce de emitido, idempotente, sin borrar)', async () => {
  await contrato(SQL_UPSERT);
});

test('rol firmador_r2 · puede select/insert/update en r2_enlaces y nada más', async () => {
  const db = await baseNueva();
  const q = comoFirmador(db);
  await q("insert into public.r2_enlaces (clave, url, vence) values ('tormentas/x.json', 'https://u', now())");
  await q("update public.r2_enlaces set url = 'https://v' where clave = 'tormentas/x.json'");
  assert.equal((await q('select url from public.r2_enlaces')).rows[0].url, 'https://v');
  const negadas = [
    "delete from public.r2_enlaces where clave = 'tormentas/x.json'",
    'truncate public.r2_enlaces',
    'select * from public.otra',
    'insert into public.otra values (2)',
    'create table public.nueva (x int)',
    "insert into public.r2_enlaces (clave, url, vence) values ('usuarios/clave.json', 'https://u', now())",   // la política: sólo los 4 prefijos
    "update public.r2_enlaces set clave = 'otra/x.json' where clave = 'tormentas/x.json'",
    'alter table public.r2_enlaces disable row level security',
    'create role otro',
  ];
  let rechazadas = 0;
  for (const s of negadas) { try { await q(s); } catch { rechazadas++; } }
  assert.equal(rechazadas, negadas.length, `rechazadas ${rechazadas}/${negadas.length}`);
  assert.equal((await db.query('select count(*)::int as n from public.r2_enlaces')).rows[0].n, 1, 'el delete no borró');
  // anon y authenticated siguen sin ver nada
  for (const rol of ['anon', 'authenticated']) {
    await db.exec(`set role ${rol}`);
    await assert.rejects(db.query('select * from public.r2_enlaces'));
    await db.exec('reset role');
  }
  // privilegios exactos
  const g = (await db.query("select privilege_type from information_schema.role_table_grants where grantee = 'firmador_r2' order by 1")).rows.map((x) => x.privilege_type);
  assert.deepEqual(g, ['INSERT', 'SELECT', 'UPDATE']);
  const rol = (await db.query("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin, rolpassword is null as sin_clave from pg_authid where rolname = 'firmador_r2'")).rows[0];
  assert.deepEqual(rol, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true, sin_clave: true });
  // 0141 se puede volver a aplicar
  await db.exec(SQL_0141);
  await db.close();
});

test('0141 no trae contraseña adentro', () => {
  const sinComentarios = SQL_0141.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(sinComentarios, /password|contrase/i);
});

test('upsert · rechaza filas malas antes de ir a la base', async () => {
  const nunca = async () => { throw new Error('no tenía que llegar a la base'); };
  await assert.rejects(upsertEnlaces(nunca, [fila('a', '2026-11-14T00:00:00Z'), fila('a', '2026-11-14T00:00:00Z')]), /repetida/);
  await assert.rejects(upsertEnlaces(nunca, [{ ...fila('a', '2026-11-14T00:00:00Z'), url: 'http://x' }]), /url/);
  await assert.rejects(upsertEnlaces(nunca, [{ ...fila('a', '2026-11-14T00:00:00Z'), vence: new Date('x') }]), /vence/);
  assert.deepEqual(await upsertEnlaces(nunca, []), { nuevas: 0, actualizadas: 0, sinCambio: 0 });
});

test('control negativo · el upsert roto da rojo (contado)', async () => {
  const mutantes = {
    'sin la guarda de vence': SQL_UPSERT.replace(' where t.vence <= excluded.vence', ''),
    'sin coalesce de emitido': SQL_UPSERT.replace('coalesce(excluded.emitido, t.emitido)', 'excluded.emitido'),
    'do nothing': SQL_UPSERT.replace(/do update[\s\S]*?where t\.vence <= excluded\.vence/, 'do nothing'),
    'vence al revés': SQL_UPSERT.replace('t.vence <= excluded.vence', 't.vence >= excluded.vence'),
    'borra antes': 'with b as (delete from public.r2_enlaces) ' + SQL_UPSERT,
  };
  let rojos = 0;
  for (const [nombre, sql] of Object.entries(mutantes)) {
    assert.notEqual(sql, SQL_UPSERT);
    // cada mutante tiene que caer por una aserción del contrato (AssertionError), no por un error de sintaxis
    try { await contrato(sql); } catch (e) { if (e instanceof assert.AssertionError || /permission denied/.test(e.message)) rojos++; if (process.env.VER_MUTANTES) console.log('mutante', nombre, '→', e.message.split('\n')[0]); }
  }
  assert.equal(rojos, Object.keys(mutantes).length, `mutantes detectados ${rojos}/${Object.keys(mutantes).length}`);
});
