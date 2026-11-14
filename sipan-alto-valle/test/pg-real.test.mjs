// node --test sipan-alto-valle/test/pg-real.test.mjs
// La 0147b y la base del colector contra un PostgreSQL DE VERDAD, aplicada por un rol NO superusuario como el
// `postgres` de Supabase (CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS). Corre sólo si SIPAN_PG_BIN apunta a la
// carpeta `bin` de un PostgreSQL ≥ 16 (initdb, pg_ctl, postgres); si no, se saltea (en Actions no hay). Arma un
// cluster temporal en 127.0.0.1, lo apaga y lo borra al final. Emula lo que hace psql con la 0147b: `\gexec` y
// `-v clave=…` (`:'clave'` → literal entre comillas).
// En pc-nanci: SIPAN_PG_BIN=C:/Users/jeshe/AppData/Local/hn-tools/pg-embebido/node_modules/@embedded-postgres/windows-x64/native/bin
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { crearBase } from '../lib/base.mjs';
import { verificador } from '../migracion/scram.mjs';

const BIN = process.env.SIPAN_PG_BIN;
const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SALTEAR = !BIN && 'sin SIPAN_PG_BIN (PostgreSQL portable)';
const PUERTO = 54000 + Math.floor(Math.random() * 900);
let DIR, su, adm;
const exe = (n) => path.join(BIN, process.platform === 'win32' ? n + '.exe' : n);

/** Las migraciones de hn-agro que necesita la 0147: la 0075 y la 0110 (copias mínimas fieles a lo que usan: tablas, FK, RLS). */
const M0075 = `CREATE TABLE IF NOT EXISTS registro_procesos (id BIGSERIAL PRIMARY KEY, proceso TEXT NOT NULL, ok BOOLEAN NOT NULL, resumen JSONB, creado_at TIMESTAMPTZ NOT NULL DEFAULT now());`;
const M0110 = `create table if not exists estaciones (red text not null, estacion_id text not null, nombre text, partido text, provincia text, lat numeric, lon numeric,
  precision_ubicacion text, fuente_ubicacion text, activa boolean not null default true, metadatos jsonb not null default '{}'::jsonb,
  actualizado_en timestamptz not null default now(), primary key (red, estacion_id));
create table if not exists estaciones_obs (red text not null, estacion_id text not null, fecha date not null, lluvia_mm numeric, horas_validas smallint,
  hora_corte time, tmin_c numeric, tmax_c numeric, leido_en timestamptz not null default now(), url text, crudo jsonb not null,
  primary key (red, estacion_id, fecha), foreign key (red, estacion_id) references estaciones (red, estacion_id),
  constraint estaciones_obs_sin_horas_sin_lluvia check (horas_validas is distinct from 0 or lluvia_mm is null));
alter table estaciones enable row level security; alter table estaciones_obs enable row level security;
revoke all on table estaciones, estaciones_obs from anon, authenticated;`;

/** Aplica la 0147b como lo haría `psql -v clave=VERIF -f …`, con la conexión `c`. */
async function aplicar0147b(c, verif) {
  const txt = fs.readFileSync(path.join(RAIZ, 'migracion', '0147b_rol_colector_estaciones.sql'), 'utf8').replace(/\r\n/g, '\n');
  const [antes, despues] = txt.split('\\gexec');
  const sel = antes.slice(antes.lastIndexOf("select 'create role"));
  for (const fila of await c.unsafe(sel)) await c.unsafe(Object.values(fila)[0]);
  await c.unsafe(despues.replace(":'clave'", "'" + verif.replace(/'/g, "''") + "'"));
}

before(async () => {
  if (!BIN) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sipan-'));
  const datos = path.join(DIR, 'datos');
  const pw = path.join(DIR, 'pw'); fs.writeFileSync(pw, 'su_clave_local');
  execFileSync(exe('initdb'), ['-D', datos, '-U', 'su', '--pwfile', pw, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-instructions'], { stdio: 'ignore' });
  execFileSync(exe('pg_ctl'), ['-D', datos, '-l', path.join(DIR, 'log.txt'), '-o', `-p ${PUERTO} -c listen_addresses=127.0.0.1 -c log_statement=all`, '-w', 'start'], { stdio: 'ignore' });
  su = postgres(`postgres://su:su_clave_local@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1 });
  await su.unsafe(`create role adm login password 'adm_clave_local' createrole createdb replication bypassrls;
    create role authenticator nologin noinherit; create role anon nologin; create role authenticated nologin;
    grant all on schema public to adm; grant create on database postgres to adm;
    create schema campana; create table campana.lotes (id int); insert into campana.lotes values (1);`);
  adm = postgres(`postgres://adm:adm_clave_local@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1 });
  await adm.unsafe(M0075); await adm.unsafe(M0110);
  await adm.unsafe(fs.readFileSync(path.join(RAIZ, 'migracion', '0147_estaciones_noche_y_muestreo.sql'), 'utf8'));
  await adm.unsafe(`insert into estaciones (red, estacion_id) values ('SNIH', '1'); insert into registro_procesos (proceso, ok) values ('netlify_x', true);`);
});

after(async () => {
  if (!BIN) return;
  try { await adm.end(); await su.end(); } catch { /* nada */ }
  try { execFileSync(exe('pg_ctl'), ['-D', path.join(DIR, 'datos'), '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* nada */ }
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('0147b como NO superusuario (el postgres de Supabase): se aplica, deja el rol limpio y es idempotente', { skip: SALTEAR }, async () => {
  const clave = crypto.randomBytes(32).toString('hex');
  await aplicar0147b(adm, verificador(clave));
  await aplicar0147b(adm, verificador(clave));                                // 2.ª vez: no rompe
  const [r] = await su`select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname = 'colector_estaciones'`;
  assert.deepEqual(r, { rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true, rolreplication: false, rolbypassrls: false, rolconnlimit: 3 });
  /* la clave en texto no llegó a la base: ni en pg_authid ni en el log de sentencias */
  const [{ rolpassword }] = await su`select rolpassword from pg_authid where rolname = 'colector_estaciones'`;
  assert.match(rolpassword, /^SCRAM-SHA-256\$/);
  assert.ok(!fs.readFileSync(path.join(DIR, 'log.txt'), 'utf8').includes(clave));
  /* el rol entra por SCRAM y la base del colector lo acepta (current_user y session_user) */
  const b = await crearBase({ url: `postgresql://colector_estaciones:${clave}@127.0.0.1:${PUERTO}/postgres`, hostPermitido: (h) => h === '127.0.0.1' });
  assert.equal(b.usuario, 'colector_estaciones');
  await b.guardarEstaciones([{ red: 'INTA_SIPAN_AV', estacion_id: '10', nombre: 'Guerrico', lat: -39.016667, lon: -67.666667, activa: true, metadatos: { a: "co'mi\"lla" } }]);
  const g = await b.guardarObs([{ red: 'INTA_SIPAN_AV', estacion_id: '10', fecha: '2026-09-10', tmin_c: -1.5, tmin_noche_c: -2, tmin_noche_en: '2026-09-10T08:40:00Z', noche_registros: 90, noche_esperados: 90, crudo: { x: 1 } }]);
  assert.equal(g.ok, 1, g.errores.join(' | '));
  const [o] = await b.obs('10', ['2026-09-10', '2026-09-11']);
  assert.equal(o.fecha, '2026-09-10'); assert.equal(o.tmin_c, -1.5); assert.equal(o.tmin_noche_en, '2026-09-10T08:40:00.000Z');
  const [e] = await b.estaciones();
  assert.equal(e.lat, -39.016667);
  await b.registrar('sipan_alto_valle', false, { prueba: 'pg-real' });
  await b.cerrar();
});

test('0147b · control negativo: si el rol ya existía con BYPASSRLS (o REPLICATION), la migración ABORTA', { skip: SALTEAR }, async () => {
  await su.unsafe(`alter role colector_estaciones bypassrls`);
  await assert.rejects(aplicar0147b(adm, verificador(crypto.randomBytes(32).toString('hex'))), /atributos de más/);
  await su.unsafe(`alter role colector_estaciones nobypassrls`);
  /* y la versión vieja del ALTER (nombrando NOSUPERUSER) es justamente la que falla como no superusuario */
  await assert.rejects(adm.unsafe(`alter role colector_estaciones with nosuperuser`), (e) => e.code === '42501');
});

test('0147b · la versión NOLOGIN anterior dada a authenticator: se revoca', { skip: SALTEAR }, async () => {
  await adm.unsafe(`grant colector_estaciones to authenticator`);   // como la versión NOLOGIN: la aplicó el mismo admin
  await aplicar0147b(adm, verificador(crypto.randomBytes(32).toString('hex')));
  const m = await su`select a.rolname from pg_auth_members x join pg_roles r on r.oid = x.roleid join pg_roles a on a.oid = x.member where r.rolname = 'colector_estaciones' and a.rolname = 'authenticator'`;
  assert.equal(m.length, 0);
});

test('el rol, conectado: no ve otras redes, no crea tablas, no borra y no anota procesos ajenos (los chequeos del paso 3)', { skip: SALTEAR }, async () => {
  const clave = crypto.randomBytes(32).toString('hex');
  await aplicar0147b(adm, verificador(clave));
  const c = postgres(`postgresql://colector_estaciones:${clave}@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1, prepare: false });
  try {
    const [{ u, s }] = await c`select current_user as u, session_user as s`;
    assert.equal(u, 'colector_estaciones'); assert.equal(s, 'colector_estaciones');
    assert.equal((await c`select count(*)::int as n from estaciones where red = 'SNIH'`)[0].n, 0);
    assert.equal((await c`select has_schema_privilege('public', 'CREATE') as p`)[0].p, false);
    await assert.rejects(c`insert into estaciones (red, estacion_id) values ('SNIH', 'x')`, (e) => e.code === '42501');
    await assert.rejects(c`delete from estaciones_obs where red = 'INTA_SIPAN_AV'`, (e) => e.code === '42501');
    await assert.rejects(c`select count(*) from campana.lotes`, (e) => e.code === '42501');
    await assert.rejects(c`insert into registro_procesos (proceso, ok) values ('otro', true)`, (e) => e.code === '42501');
    await assert.rejects(c`create table public.x (i int)`, (e) => e.code === '42501');
    /* control negativo: lo permitido sí pasa */
    await c`insert into registro_procesos (proceso, ok, resumen) values ('sipan_alto_valle', false, '{"prueba": "pg-real"}')`;
  } finally { await c.end(); }
});
