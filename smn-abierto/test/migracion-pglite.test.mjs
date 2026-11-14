// node --test smn-abierto/test/migracion-pglite.test.mjs
// La 0149 (el rol para SMN_ABIERTO) y la 0149b (llave + jobs) contra un PostgreSQL de verdad (PGlite), sin red.
// PGlite va FUERA del repo: HN_PGLITE=<…>/node_modules/@electric-sql/pglite (en pc-nanci: C:/HN-AGRO/herramientas-pglite).
// Sin él, SALTEADO. Las políticas de partida salen del TEXTO de la 0147b de main (no de una copia).
// Cada caso fuerte con su control negativo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR_PGLITE = process.env.HN_PGLITE || '';
const HAY = !!DIR_PGLITE && fs.existsSync(path.join(DIR_PGLITE, 'dist', 'index.js'));
const salto = !HAY && 'sin HN_PGLITE';
const M0149 = fs.readFileSync(path.join(RAIZ, 'migracion', '0149_smn_abierto_rol.sql'), 'utf8');
const M0149B = fs.readFileSync(path.join(RAIZ, 'migracion', '0149b_smn_abierto_disparo.sql'), 'utf8');
const P0147B = path.join(RAIZ, '..', 'sipan-alto-valle', 'migracion', '0147b_rol_colector_estaciones.sql');

/** Los grants y las políticas de la 0147b, tal como están en el archivo (sin lo que es de psql: clave, \gexec). */
function politicas0147b() {
  const t = fs.readFileSync(P0147B, 'utf8').replace(/\r\n/g, '\n');
  const a = t.indexOf('grant usage on schema public to colector_estaciones;');
  const b = t.indexOf('-- (Una política «for all» no da DELETE');
  assert.ok(a > 0 && b > a, 'no encontré los grants y las políticas en la 0147b');
  return t.slice(a, b);
}

const BASE = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create role colector_estaciones nologin;
create table estaciones (red text not null, estacion_id text not null, metadatos jsonb not null default '{}', primary key (red, estacion_id));
create table estaciones_obs (red text not null, estacion_id text not null, fecha date not null, crudo jsonb not null default '{}', primary key (red, estacion_id, fecha));
create table pronostico_helada_medicion (red text not null, estacion_id text not null);
create table registro_procesos (id bigserial primary key, proceso text not null, ok boolean, resumen jsonb, creado_at timestamptz default now());
alter table estaciones enable row level security; alter table estaciones_obs enable row level security;
alter table pronostico_helada_medicion enable row level security; alter table registro_procesos enable row level security;
`;

async function nueva({ con0147b = true } = {}) {
  const { PGlite } = await import(pathToFileURL(path.join(DIR_PGLITE, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(BASE);
  if (con0147b) await pg.exec(politicas0147b());
  return pg;
}
/** ¿el rol puede hacer esto? (true / el mensaje del error) */
async function comoRol(pg, sql) {
  try { await pg.exec(`set role colector_estaciones; ${sql}; reset role;`); return true; }
  catch (e) { await pg.exec('reset role;'); return String(e.message); }
}

test('0149: con la 0147b sola, el rol NO puede escribir SMN_ABIERTO (control negativo de partida)', { skip: salto }, async () => {
  const pg = await nueva();
  assert.match(String(await comoRol(pg, `insert into estaciones (red, estacion_id) values ('SMN_ABIERTO', 'X')`)), /row-level security/);
  assert.match(String(await comoRol(pg, `insert into registro_procesos (proceso, ok) values ('smn_abierto', true)`)), /row-level security/);
  await pg.close();
});

test('0149: el rol escribe SMN_ABIERTO y anota smn_abierto; lo de antes sigue; otras redes y procesos, no', { skip: salto }, async () => {
  const pg = await nueva();
  await pg.exec(M0149);
  await pg.exec(M0149);                                                           // idempotente
  for (const t of ['estaciones', 'estaciones_obs']) {
    assert.equal(await comoRol(pg, `insert into ${t} (red, estacion_id${t === 'estaciones_obs' ? ', fecha' : ''}) values ('SMN_ABIERTO', 'X'${t === 'estaciones_obs' ? ", '2026-11-13'" : ''})`), true, t);
  }
  assert.equal(await comoRol(pg, `insert into estaciones (red, estacion_id) values ('INTA_SIPAN_AV', '10')`), true);
  assert.equal(await comoRol(pg, `insert into estaciones (red, estacion_id) values ('WEATHERLINK_PUB', 'w1')`), true);
  for (const p of ['smn_abierto', 'sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico']) {
    assert.equal(await comoRol(pg, `insert into registro_procesos (proceso, ok) values ('${p}', true)`), true, p);
  }
  /* control negativo: SNIH y un proceso cualquiera siguen afuera; y no puede borrar */
  assert.match(String(await comoRol(pg, `insert into estaciones (red, estacion_id) values ('SNIH', 'x')`)), /row-level security/);
  assert.match(String(await comoRol(pg, `insert into registro_procesos (proceso, ok) values ('otro', true)`)), /row-level security/);
  assert.match(String(await comoRol(pg, `delete from estaciones where red = 'SMN_ABIERTO'`)), /permission denied/);
  const pol = (await pg.query(`select tablename, coalesce(qual, '') || ' ' || coalesce(with_check, '') as t from pg_policies where policyname like 'colector_estaciones_sus_%'`)).rows;
  assert.equal(pol.length, 4);
  for (const r of pol.filter((r) => r.tablename !== 'registro_procesos')) assert.match(r.t, /SMN_ABIERTO/);
  await pg.close();
});

test('0149: sin la 0147b se corta (no crea políticas a ciegas)', { skip: salto }, async () => {
  const pg = await nueva({ con0147b: false });
  await assert.rejects(pg.exec(M0149), /0147b/);
  assert.equal((await pg.query(`select count(*)::int as n from pg_policies`)).rows[0].n, 0);
  await pg.close();
  /* a medias: sólo la de registro_procesos (faltan las de las redes) → también se corta, y no amplía nada */
  const pg2 = await nueva({ con0147b: false });
  await pg2.exec(`grant insert on registro_procesos to colector_estaciones; create policy colector_estaciones_sus_procesos on public.registro_procesos for insert to colector_estaciones with check (proceso in ('sipan_alto_valle'))`);
  await assert.rejects(pg2.exec(M0149), /colector_estaciones_sus_redes/);
  assert.doesNotMatch((await pg2.query(`select with_check from pg_policies`)).rows[0].with_check, /smn_abierto/);
  await pg2.close();
});

const SHIM_0148 = `
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname, schedule, command) values (n, s, c) returning jobid $$;
create function cron.unschedule(n text) returns boolean language sql as $$ with d as (delete from cron.job where jobname = n returning 1) select exists(select 1 from d) $$;
create table public.colector_llaves (etiqueta text primary key, activa boolean not null default false, nota text, cambiada_en timestamptz not null default now());
create table public.llamadas (workflow text, inputs jsonb, etiqueta text);
create function public.gh_colector_disparo(p_workflow text, p_inputs jsonb, p_etiqueta text) returns bigint language sql as
  $$ insert into public.llamadas values (p_workflow, p_inputs, p_etiqueta); select 1::bigint $$;
insert into public.colector_llaves values ('sipan', true, 'de la 0148');
`;

test('0149b: la llave nace APAGADA, dos jobs en UTC con smn-abierto.yml, y volver a aplicarla no prende la llave', { skip: salto }, async () => {
  const { PGlite } = await import(pathToFileURL(path.join(DIR_PGLITE, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(SHIM_0148);
  await pg.exec(M0149B);
  const jobs = (await pg.query(`select jobname, schedule, command from cron.job order by jobname`)).rows;
  assert.deepEqual(jobs.map((j) => [j.jobname, j.schedule]), [['smn-abierto-disparo', '17 13 * * *'], ['smn-abierto-disparo-tarde', '17 19 * * *']]);
  assert.equal((await pg.query(`select activa from colector_llaves where etiqueta = 'smn-abierto'`)).rows[0].activa, false);
  for (const j of jobs) await pg.exec(j.command);
  const ll = (await pg.query(`select workflow, inputs, etiqueta from llamadas`)).rows;
  assert.deepEqual(ll.map((l) => [l.workflow, l.etiqueta]), [['smn-abierto.yml', 'smn-abierto'], ['smn-abierto.yml', 'smn-abierto']]);
  assert.deepEqual(ll.map((l) => l.inputs), [{ modo: 'real' }, { modo: 'real', ultimo: 'si' }]);
  for (const l of ll) for (const v of Object.values(l.inputs)) assert.equal(typeof v, 'string');   // la API quiere textos
  /* volver a aplicar con la llave PRENDIDA a mano: sigue prendida (no la apaga) y los jobs no se duplican */
  await pg.exec(`update colector_llaves set activa = true where etiqueta = 'smn-abierto'`);
  await pg.exec(M0149B);
  assert.equal((await pg.query(`select activa from colector_llaves where etiqueta = 'smn-abierto'`)).rows[0].activa, true);
  assert.equal((await pg.query(`select count(*)::int as n from cron.job`)).rows[0].n, 2);
  /* las llaves de la 0148 no se tocan */
  assert.equal((await pg.query(`select activa from colector_llaves where etiqueta = 'sipan'`)).rows[0].activa, true);
  await pg.close();
});

test('0149b · control negativo: sin la 0148 se corta antes de crear jobs', { skip: salto }, async () => {
  const { PGlite } = await import(pathToFileURL(path.join(DIR_PGLITE, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(`create schema cron; create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);`);
  await assert.rejects(pg.exec(M0149B), /0148/);
  assert.equal((await pg.query(`select count(*)::int as n from cron.job`)).rows[0].n, 0);
  await pg.close();
});

test('las dos migraciones son aditivas: sin DROP, sin tocar grants ni la contraseña, sin tokens', () => {
  for (const [n, s] of [['0149', M0149], ['0149b', M0149B]]) {
    const sinComentarios = s.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(sinComentarios, /\bdrop\b|\btruncate\b|\bdelete\b/i, n);
    assert.doesNotMatch(sinComentarios, /\bgrant\b|\brevoke\b|password|:'clave'/i, n);
    assert.doesNotMatch(s, /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/, n);
  }
  /* control negativo: el detector encuentra un DROP si lo hubiera */
  assert.match('drop table x;', /\bdrop\b/i);
});
