// node --test imerg-pendientes/test/pg-real.test.mjs
// La migración imerg_colector y la base del colector contra un PostgreSQL DE VERDAD, aplicada por un rol NO
// superusuario como el `postgres` de Supabase. Corre sólo si IMERG_PG_BIN (o SIPAN_PG_BIN) apunta a la carpeta `bin`
// de un PostgreSQL ≥ 16; si no, se saltea (en Actions no hay). Arma un cluster temporal en 127.0.0.1 y lo borra.
// Emula lo que hace psql con la migración: `\gexec` y `-v clave=…`.
// En pc-nanci: IMERG_PG_BIN=C:/Users/jeshe/AppData/Local/hn-tools/pg-embebido/node_modules/@embedded-postgres/windows-x64/native/bin
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
import { barrer } from '../lib/barrido.mjs';
import { ErrorNasa } from '../lib/giovanni.mjs';
import { verificador } from '../../sipan-alto-valle/migracion/scram.mjs';

const BIN = process.env.IMERG_PG_BIN || process.env.SIPAN_PG_BIN;
const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SALTEAR = !BIN && 'sin IMERG_PG_BIN (PostgreSQL portable)';
const PUERTO = 55000 + Math.floor(Math.random() * 900);
let DIR, su, adm, CLAVE, base;
const exe = (n) => path.join(BIN, process.platform === 'win32' ? n + '.exe' : n);

/** Copias mínimas fieles de hn-agro: lotes (0001, las columnas que se usan), imerg_* (0060) y la RLS de la 0064. */
const ESQUEMA = `
create table lotes (id uuid primary key default gen_random_uuid(), nombre text not null, lat numeric(10,6) not null,
  lon numeric(10,6) not null, activo boolean not null default true);
create table imerg_pp_diario (celda_lat numeric(5,2) not null, celda_lon numeric(6,2) not null, fecha date not null,
  pp_mm real not null, primary key (celda_lat, celda_lon, fecha));
create table imerg_celda_estado (celda_lat numeric(5,2) not null, celda_lon numeric(6,2) not null, desde date, hasta date,
  filas integer, fuente text default 'GPM_3IMERGDF_07 (Harmony)', actualizado timestamptz default now(), primary key (celda_lat, celda_lon));
alter table lotes enable row level security; alter table imerg_pp_diario enable row level security;
alter table imerg_celda_estado enable row level security;`;

/** imergCell de hn-agro netlify/functions/_lib/imerg-lazy.js, tal cual. */
function imergCell(lat, lon) {
  const clat = Math.round((Math.floor((lat + 89.95) / 0.1) * 0.1 - 89.95) * 100) / 100;
  const clon = Math.round((Math.floor((lon + 179.95) / 0.1) * 0.1 - 179.95) * 100) / 100;
  return { clat, clon };
}
/** SQL_RESERVAR de imerg-lazy.js, tal cual (el anti-spam del alta). */
const SQL_RESERVAR = `insert into imerg_celda_estado (celda_lat, celda_lon, fuente) values ($1, $2, 'pendiente (lazy)')
  on conflict (celda_lat, celda_lon) do update set actualizado = now()
  where imerg_celda_estado.filas is null and imerg_celda_estado.actualizado < now() - interval '3 hours' returning celda_lat`;

export async function aplicarMigracion(c, verif) {
  const txt = fs.readFileSync(path.join(RAIZ, 'migracion', 'imerg_colector.sql'), 'utf8').replace(/\r\n/g, '\n');
  const [antes, despues] = txt.split('\\gexec');
  const i = antes.lastIndexOf("select 'create role");
  await c.unsafe(antes.slice(0, i));
  for (const fila of await c.unsafe(antes.slice(i))) await c.unsafe(Object.values(fila)[0]);
  await c.unsafe(despues.replace(":'clave'", "'" + verif.replace(/'/g, "''") + "'"));
}

before(async () => {
  if (!BIN) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-imerg-'));
  const datos = path.join(DIR, 'datos');
  const pw = path.join(DIR, 'pw'); fs.writeFileSync(pw, 'su_clave_local');
  execFileSync(exe('initdb'), ['-D', datos, '-U', 'su', '--pwfile', pw, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-instructions'], { stdio: 'ignore' });
  execFileSync(exe('pg_ctl'), ['-D', datos, '-l', path.join(DIR, 'log.txt'), '-o', `-p ${PUERTO} -c listen_addresses=127.0.0.1 -c log_statement=all`, '-w', 'start'], { stdio: 'ignore' });
  su = postgres(`postgres://su:su_clave_local@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1 });
  await su.unsafe(`create role adm login password 'adm_clave_local' createrole createdb replication bypassrls;
    create role anon nologin; create role authenticated nologin;
    grant all on schema public to adm; grant create on database postgres to adm;`);
  adm = postgres(`postgres://adm:adm_clave_local@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1 });
  await adm.unsafe(ESQUEMA);
  /* Lo peor de Supabase: privilegios por defecto que le dan EXECUTE y las tablas nuevas directo a anon/authenticated
     (no por PUBLIC). La migración tiene que sacárselos igual. */
  await adm.unsafe(`alter default privileges for role adm grant execute on functions to anon, authenticated;
    alter default privileges for role adm grant select, insert, update, delete on tables to anon, authenticated;`);
  CLAVE = crypto.randomBytes(32).toString('hex');
  await aplicarMigracion(adm, verificador(CLAVE));
  base = await crearBase({ url: `postgresql://colector_imerg:${CLAVE}@127.0.0.1:${PUERTO}/postgres`, hostPermitido: (h) => h === '127.0.0.1' });
});

after(async () => {
  if (!BIN) return;
  try { await base.cerrar(); await adm.end(); await su.end(); } catch { /* nada */ }
  try { execFileSync(exe('pg_ctl'), ['-D', path.join(DIR, 'datos'), '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* nada */ }
  fs.rmSync(DIR, { recursive: true, force: true });
});

const limpiar = () => adm.unsafe('delete from imerg_pp_diario; delete from imerg_celda_estado; delete from lotes; delete from imerg_colector.tomas;');
/** Pasa el tiempo: corre para atrás TODAS las horas guardadas (las filas de la app y las tomas del colector). */
const correrReloj = (min) => adm.unsafe(`update imerg_celda_estado set actualizado = actualizado - make_interval(mins => ${Number(min)});
  update imerg_colector.tomas set tomada = tomada - make_interval(mins => ${Number(min)}), no_antes_de = no_antes_de - make_interval(mins => ${Number(min)}),
    cerrada = cerrada - make_interval(mins => ${Number(min)});`);
/** La serie COMPLETA que da Giovanni hoy: todos los días de 2000-06-01 a 2025-09-30 (9253), menos `faltan` del medio. */
function serieCompleta({ hasta = '2025-09-30', faltan = 0 } = {}) {
  const out = []; const fin = Date.parse(hasta + 'T00:00:00Z');
  for (let t = Date.parse('2000-06-01T00:00:00Z'), i = 0; t <= fin; t += 86400000, i++) out.push([new Date(t).toISOString().slice(0, 10), i % 7 ? 0 : 3.5]);
  if (faltan) out.splice(4000, faltan);
  return out;
}
const COMPLETA = serieCompleta();
const lote = (nombre, lat, lon, activo = true) => adm`insert into lotes (nombre, lat, lon, activo) values (${nombre}, ${lat}, ${lon}, ${activo})`;
const estado = async (lat, lon) => (await adm`select fuente, filas, desde::text, hasta::text from imerg_celda_estado where celda_lat = ${lat} and celda_lon = ${lon}`)[0];
const envejecer = (lat, lon, min) => adm`update imerg_celda_estado set actualizado = now() - make_interval(mins => ${min}) where celda_lat = ${lat} and celda_lon = ${lon}`;
const serie = [['2000-06-01', 0], ['2000-06-02', 12.5], ['2025-09-30', 0.25]];

test('migración: rol limpio (LOGIN, sin BYPASSRLS, límite 2), clave sólo como SCRAM, idempotente', { skip: SALTEAR }, async () => {
  await aplicarMigracion(adm, verificador(CLAVE));     // 2.ª vez: no rompe
  const [r] = await su`select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname = 'colector_imerg'`;
  assert.deepEqual(r, { rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true, rolreplication: false, rolbypassrls: false, rolconnlimit: 2 });
  const [{ rolpassword }] = await su`select rolpassword from pg_authid where rolname = 'colector_imerg'`;
  assert.match(rolpassword, /^SCRAM-SHA-256\$/);
  assert.ok(!fs.readFileSync(path.join(DIR, 'log.txt'), 'utf8').includes(CLAVE));
});

test('migración · si el rol ya existía con BYPASSRLS, ABORTA', { skip: SALTEAR }, async () => {
  await su.unsafe('alter role colector_imerg bypassrls');
  try { await assert.rejects(aplicarMigracion(adm, verificador(CLAVE)), /atributos de más/); }
  finally { await su.unsafe('alter role colector_imerg nobypassrls'); }
});

test('el rol no ve tablas ni la función interna; anon y authenticated no ejecutan nada', { skip: SALTEAR }, async () => {
  const c = postgres(`postgresql://colector_imerg:${CLAVE}@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1, prepare: false });
  try {
    for (const q of ['select count(*) from lotes', 'select count(*) from imerg_celda_estado', 'select count(*) from imerg_pp_diario',
      'select * from imerg_colector._candidatas(0)', 'select imerg_colector.celda_js(1, 2)', 'delete from imerg_pp_diario',
      'select count(*) from imerg_colector.tomas', 'delete from imerg_colector.tomas',
      "insert into imerg_colector.tomas (celda_lat, celda_lon, no_antes_de) values (1, 2, now())"]) {
      await assert.rejects(c.unsafe(q), (e) => e.code === '42501', q);
    }
  } finally { await c.end(); }
  for (const r of ['anon', 'authenticated', 'public']) {
    if (r !== 'public') {
      const [{ t }] = await su.unsafe(`select has_table_privilege('${r}', 'imerg_colector.tomas', 'select') or has_table_privilege('${r}', 'imerg_colector.tomas', 'insert')
        or has_table_privilege('${r}', 'imerg_colector.tomas', 'update') or has_table_privilege('${r}', 'imerg_colector.tomas', 'delete') as t`);
      assert.equal(t, false, `${r} sobre imerg_colector.tomas (aunque los privilegios por defecto se la den)`);
    }
    for (const f of ['imerg_colector.tomar(integer)', 'imerg_colector.guardar(numeric, numeric, date[], real[])', 'imerg_colector.contar(integer)', 'imerg_colector.soltar(numeric, numeric)',
      'imerg_colector._candidatas(integer)', 'imerg_colector.celda_js(float8, float8)']) {
      if (r === 'public') { const [{ p }] = await su.unsafe(`select bool_or(acl.grantee = 0) as p from pg_proc, aclexplode(proacl) acl where oid = '${f}'::regprocedure`); assert.notEqual(p, true, f); continue; }
      const [{ p }] = await su.unsafe(`select has_function_privilege('${r}', '${f}', 'execute') as p`);
      assert.equal(p, false, `${r} ${f}`);
    }
  }
});

test('celda_js da la MISMA celda que imergCell de la app (también en la frontera, lon −60,25)', { skip: SALTEAR }, async () => {
  const pts = [[-34.0, -60.25], [-33.98, -60.68], [-37.85, -58.45], [-27.052, -65.403], [-30.737832, -61.31016], [-26.85, -65.2], [-29.95, -59.95], [-40.05, -70.15]];
  let x = 12345; const azar = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 3000; i++) pts.push([Number((-55 + azar() * 34).toFixed(i % 3 ? 6 : 2)), Number((-74 + azar() * 20).toFixed(i % 3 ? 6 : 2))]);
  const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
  const filas = await su.unsafe(`select (imerg_colector.celda_js(a::numeric(10,6)::float8, b::numeric(10,6)::float8)).* from unnest($1::numeric[], $2::numeric[]) t(a, b)`, [lats, lons]);
  pts.forEach((p, i) => {
    const js = imergCell(p[0], p[1]);
    assert.deepEqual([Number(filas[i].clat), Number(filas[i].clon)], [js.clat, js.clon], `punto ${p}`);
  });
});

test('toma: una celda por vez (nunca dos vivas), guarda en una transacción y libera para la siguiente', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7); await lote('b', -33.1, -61.2); await lote('a2', -34.01, -60.71);   // a y a2: la misma celda
  assert.equal(await base.contar(180), 2);
  const c1 = await base.tomar(180);
  assert.ok(c1);
  assert.equal(await base.tomar(180), null, 'con una toma viva no se da otra');
  assert.equal((await estado(c1.latTxt, c1.lonTxt)).fuente, 'en curso (colectores)');
  assert.equal(await base.guardar(c1, COMPLETA), 9253);
  assert.deepEqual(await estado(c1.latTxt, c1.lonTxt), { fuente: 'GPM_3IMERGDF_07 (Giovanni · colectores)', filas: 9253, desde: '2000-06-01', hasta: '2025-09-30' });
  const c2 = await base.tomar(180);
  assert.ok(c2 && (c2.latTxt !== c1.latTxt || c2.lonTxt !== c1.lonTxt));
  await base.guardar(c2, COMPLETA);
  assert.equal(await base.tomar(180), null); assert.equal(await base.contar(180), 0);
  const [{ n }] = await adm`select count(*)::int as n from imerg_pp_diario`;
  assert.equal(n, 2 * 9253);
});

test('dos corridas a la vez (dos conexiones): sólo una se lleva una celda', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7); await lote('b', -33.1, -61.2);
  const otra = await crearBase({ url: `postgresql://colector_imerg:${CLAVE}@127.0.0.1:${PUERTO}/postgres`, hostPermitido: (h) => h === '127.0.0.1' });
  /* La carrera, forzada: otra sesión tiene el candado de la 1.ª celda candidata; las dos corridas arrancan a la vez y,
     sin el candado global, las dos pasarían el «¿hay una toma viva?» y esperarían ahí. Al soltarlo, una se llevaría la
     1.ª celda y la otra seguiría a la 2.ª: dos tomas vivas. Con el candado global, la 2.ª espera y ve la toma viva. */
  const [primera] = await adm`select celda_lat::text as a, celda_lon::text as b from imerg_colector._candidatas(0) limit 1`;
  const traba = postgres(`postgres://su:su_clave_local@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1 });
  await traba.unsafe(`select pg_advisory_lock(hashtext('imerg:${primera.a},${primera.b}'))`);
  try {
    const px = base.tomar(0), py = otra.tomar(0);
    await new Promise((r) => setTimeout(r, 600));
    await traba.unsafe(`select pg_advisory_unlock(hashtext('imerg:${primera.a},${primera.b}'))`);
    const [x, y] = await Promise.all([px, py]);
    assert.equal([x, y].filter(Boolean).length, 1);
    const [{ n }] = await adm`select count(*)::int as n from imerg_celda_estado where fuente = 'en curso (colectores)'`;
    assert.equal(n, 1);
  } finally { await otra.cerrar(); await traba.end(); }
});

test('la reserva de la app: fresca no se toca (hn-agro puede tener un run), trabada (> espera) sí', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const { clat, clon } = imergCell(-34.0, -60.7);
  assert.equal((await adm.unsafe(SQL_RESERVAR, [clat, clon])).length, 1);           // el alta reservó y despachó
  assert.equal(await base.tomar(180), null);
  assert.equal(await base.contar(180), 0);
  await envejecer(clat, clon, 24 * 60);                                              // el 13/11: trabada desde hace un día
  const c = await base.tomar(180);
  assert.deepEqual([c.lat, c.lon], [clat, clon]);
  // y el alta no la vuelve a despachar mientras el colector la tiene (la reserva del lazy sólo recupera > 3 h)
  assert.equal((await adm.unsafe(SQL_RESERVAR, [clat, clon])).length, 0);
});

test('lotes de baja no se piden; la celda sin fila (los «sin reserva» del 13/11) sí', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('baja', -30.0, -60.0, false);
  assert.equal(await base.contar(0), 0); assert.equal(await base.tomar(0), null);
  await lote('viva', -31.0, -61.0);
  const c = await base.tomar(180);
  assert.ok(c); assert.deepEqual([c.lat, c.lon], [imergCell(-31.0, -61.0).clat, imergCell(-31.0, -61.0).clon]);
});

test('retoma: si GitHub corta el job, la celda queda retenida 8 h (grabado al tomarla) y después se retoma sola; un fallo no acorta la espera', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const c = await base.tomar(0);
  assert.ok(c.noAntesDe instanceof Date);
  const h = (c.noAntesDe - Date.now()) / 3600000;
  assert.ok(h > 7.9 && h <= 8.01, 'el «no antes de» de la 1.ª toma: 8 h');
  await correrReloj(80); assert.equal(await base.tomar(0), null, 'a los 80 min sigue viva');
  await correrReloj(11); assert.equal(await base.tomar(0), null, 'a los 91 min: vencida, pero no antes de las 8 h');
  await correrReloj(7 * 60 + 59 - 91); assert.equal(await base.tomar(0), null, 'a las 7 h 59: no');
  await correrReloj(2);
  const again = await base.tomar(0);
  assert.ok(again, 'pasadas 8 h: sí, sin disparar nada');
  assert.deepEqual([again.latTxt, again.lonTxt], [c.latTxt, c.lonTxt]);
  assert.equal(await base.soltar(again), true);
  assert.equal((await estado(c.latTxt, c.lonTxt)).fuente, 'fallo (colectores)');
  assert.equal(await base.tomar(0), null, 'recién fallada: no');
  await correrReloj(6 * 60 + 1); assert.equal(await base.tomar(0), null, 'a las 6 h del fallo: todavía no (la 2.ª toma pidió 16 h)');
});

test('guardar valida: sólo la celda tomada, sin fechas repetidas, sin valores imposibles ni del futuro; si falla, no guarda nada', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7); await lote('b', -20.0, -60.0);
  const c = await base.tomar(0);
  const otra = { latTxt: '-19.95', lonTxt: '-59.95' };
  await assert.rejects(base.guardar(otra, serie), /guardar: P0001/);
  for (const mala of [[['2000-06-01', 1], ['2000-06-01', 2]], [['2000-06-01', -1]], [['2000-06-01', 5000]], [['1999-12-31', 1]], [['2999-01-01', 1]]]) {
    await assert.rejects(base.guardar(c, mala), /guardar: P0001/);
  }
  const [{ n }] = await adm`select count(*)::int as n from imerg_pp_diario`;
  assert.equal(n, 0);
  assert.equal((await estado(c.latTxt, c.lonTxt)).fuente, 'en curso (colectores)');
});

test('el caso del 13/11 contra la base de verdad: 9 celdas trabadas se llenan de a ≤ 2 por corrida (una por hora de cron), sin disparar nada', { skip: SALTEAR }, async () => {
  await limpiar();
  const pts = [[-34.05, -60.75], [-33.15, -61.25], [-37.85, -58.45], [-28.85, -56.75], [-32.76, -62.18], [-30.1, -59.3], [-31.4, -64.2], [-35.6, -62.9], [-36.2, -57.7]];
  for (const [i, p] of pts.entries()) { await lote('l' + i, p[0], p[1]); const { clat, clon } = imergCell(...p); await adm.unsafe(SQL_RESERVAR, [clat, clon]); await envejecer(clat, clon, 30 * 60); }
  let corridas = 0, pedidos = 0;
  while (corridas < 10) {
    corridas++;
    if (corridas > 1) await correrReloj(61);                                          // el cron: una corrida por hora
    const r = await barrer({ base, esperaLazyMin: 180, dormir: async () => {}, log: () => {}, serie: async () => { pedidos++; return COMPLETA; } });
    assert.ok(r.tomadas <= 2);
    if (r.motivo === 'nada_pendiente') break;
  }
  const [{ n }] = await adm`select count(*)::int as n from imerg_celda_estado where filas = 9253`;
  assert.equal(n, 9); assert.equal(pedidos, 9, 'un pedido por celda, ninguno repetido');
  assert.equal(corridas, 5, '5 corridas: 2+2+2+2 y la 5.ª toma 1 y ya no encuentra otra');
});

// ── 2.ª vuelta: las reproducciones del NO ENTRA de Codex (n3-232-1411) ───────────────────────────────────────────────
test('P1.1 · el fallo del colector: la app (si despacha) lo recupera a las 3 h, pero el colector igual espera lo grabado; ni borrar la fila acorta la espera', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const { clat, clon } = imergCell(-34.0, -60.7);
  const c = await base.tomar(180);
  assert.equal(await base.soltar(c), true);
  await correrReloj(181);
  // La reproducción de Codex: SQL_RESERVAR de hn-agro recupera la fila del fallo a las 3 h sin mirar la fuente. Por eso
  // el plan de encendido exige el imerg-backfill.yml SIN repository_dispatch antes de prender el colector: así esta
  // reserva no arranca ningún run (no hay pedido a la NASA). Este test deja constancia de que la base no lo impide.
  assert.equal((await adm.unsafe(SQL_RESERVAR, [clat, clon])).length, 1, 'la app recupera la fila (por eso el paso 4 va antes)');
  assert.equal(await base.tomar(180), null, 'el colector no: su espera está en la tabla tomas');
  // ?reintentar=1 del maker (con _v1681 apagado) borra la fila y la vuelve a reservar: tampoco acorta la espera
  await adm`delete from imerg_celda_estado where celda_lat = ${clat} and celda_lon = ${clon}`;
  assert.equal(await base.tomar(0), null, 'sin fila: igual retenida');
  await adm.unsafe(SQL_RESERVAR, [clat, clon]); await envejecer(clat, clon, 200);
  assert.equal(await base.tomar(0), null, "'pendiente (lazy)' vieja: igual retenida");
  await correrReloj(8 * 60 - 181 + 1);
  assert.ok(await base.tomar(180), 'pasado el «no antes de»: sí');
});

test('P1.2 · si soltar no llega, la espera igual está en la base: no se retoma a los 90 min ni a las 6 h del error, y el registro no dice que se soltó', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const sinSoltar = Object.assign(Object.create(base), { tomar: base.tomar, guardar: base.guardar, soltar: async () => { throw new Error('soltar: 08006'); } });
  const lineas = [];
  const r = await barrer({ base: sinSoltar, serie: async () => { throw new ErrorNasa(503); }, dormir: async () => {}, log: (l) => lineas.push(l) });
  assert.equal(r.motivo, 'fallo_nasa'); assert.equal(r.soltada, false);
  assert.ok(lineas.some((l) => /NO se pudo soltar/.test(l)), lineas.join('\n'));
  assert.ok(!lineas.some((l) => /soltada;/.test(l)), 'el registro no afirma lo que no pasó');
  const [t] = await adm`select cerrada, resultado, extract(epoch from no_antes_de - tomada) / 3600 as h from imerg_colector.tomas`;
  assert.equal(t.cerrada, null); assert.equal(t.resultado, null); assert.ok(Number(t.h) >= 8 - 1e-6, 'grabado al tomar: 8 h');
  const hora = /antes de (\d{4}-\d\d-\d\d \d\d:\d\d) UTC/.exec(lineas.join('\n'));
  assert.ok(hora, 'el registro dice la hora grabada');
  await correrReloj(91); assert.equal(await base.tomar(0), null, '91 min: no');
  assert.equal(await base.contar(0), 0, 'ni siquiera cuenta como candidata');
  const { clat, clon } = imergCell(-34.0, -60.7);
  await assert.rejects(base.guardar({ latTxt: String(clat), lonTxt: String(clon) }, COMPLETA), /guardar: P0001/, 'una toma vencida (91 min) ya no guarda');
  await correrReloj(6 * 60 + 5 - 91); assert.equal(await base.tomar(0), null, '6 h 5 min: no');
  await correrReloj(8 * 60 + 1 - (6 * 60 + 5)); assert.ok(await base.tomar(0), '8 h: sí');
});

test('P1.3 · tomar(0) con la credencial robada: la reserva fresca de la app no se pisa (el mínimo de 180 es de la base)', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const { clat, clon } = imergCell(-34.0, -60.7);
  await adm.unsafe(SQL_RESERVAR, [clat, clon]);
  assert.equal(await base.contar(0), 0); assert.equal(await base.tomar(0), null);
  assert.equal(await base.tomar(-100000), null); assert.equal(await base.tomar(null), null);
  await envejecer(clat, clon, 179); assert.equal(await base.tomar(0), null, '179 min: no');
  await envejecer(clat, clon, 181); assert.ok(await base.tomar(0), '181 min: sí');
});

test('P1.3 · como mucho 2 tomas por hora, aunque cada una termine en el acto', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7); await lote('b', -33.1, -61.2); await lote('c', -32.1, -62.2);
  for (let i = 0; i < 2; i++) { const c = await base.tomar(0); assert.ok(c); assert.equal(await base.guardar(c, COMPLETA), 9253); }
  assert.equal(await base.contar(0), 1);
  assert.equal(await base.tomar(0), null, 'la 3.ª en la misma hora: no');
  await correrReloj(30); assert.equal(await base.tomar(0), null, 'media hora después: tampoco');
  await correrReloj(31); assert.ok(await base.tomar(0), 'pasada la hora: sí');
});

test('P1.3 · guardar con una sola fecha en 0 mm no da la serie por terminada: no escribe nada, queda parcial y retenida', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7); await lote('b', -33.1, -61.2);
  const c = await base.tomar(0);
  assert.equal(await base.guardar(c, [['2000-06-01', 0]]), 0);
  assert.deepEqual(await estado(c.latTxt, c.lonTxt), { fuente: 'parcial (colectores)', filas: null, desde: null, hasta: null });
  const [{ n }] = await adm`select count(*)::int as n from imerg_pp_diario`;
  assert.equal(n, 0, 'lo parcial no se escribe');
  await assert.rejects(base.guardar(c, COMPLETA), /guardar: P0001/, 'la toma ya se cerró: no se puede completar con la misma');
  const otra = await base.tomar(0);
  assert.ok(otra && otra.latTxt !== c.latTxt, 'la otra celda sí (es la 2.ª toma de la hora)');
  await base.guardar(otra, COMPLETA);
  await correrReloj(61);
  assert.equal(await base.tomar(0), null, 'la parcial sigue retenida (8 h)');
  await correrReloj(8 * 60);
  const de_nuevo = await base.tomar(0);
  assert.deepEqual([de_nuevo.latTxt, de_nuevo.lonTxt], [c.latTxt, c.lonTxt]);
  assert.equal(await base.guardar(de_nuevo, COMPLETA), 9253);
});

test('P1.3 · la cobertura esperada: desde 2000-06-01 hasta al menos 2025-09-30, con 30 días de tolerancia (declarada)', { skip: SALTEAR }, async () => {
  for (const [que, s, esperado] of [
    ['faltan 31 días', serieCompleta({ faltan: 31 }), 0],
    ['termina antes (2025-08-31)', serieCompleta({ hasta: '2025-08-31' }), 0],
    ['no empieza en 2000-06-01', COMPLETA.slice(1), 0],
    ['faltan 30 días', serieCompleta({ faltan: 30 }), 9253 - 30],
    ['completa y un día más reciente', serieCompleta({ hasta: '2025-10-01' }), 9254],
  ]) {
    await limpiar();
    await lote('a', -34.0, -60.7);
    const c = await base.tomar(0);
    assert.equal(await base.guardar(c, s), esperado, que);
  }
});

test('P1.3 · una celda que nunca sale completa no se pide en bucle: la espera se duplica (8, 16, 32 h…)', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const horas = [];
  for (let i = 0; i < 4; i++) {
    const c = await base.tomar(0);
    assert.ok(c, 'toma ' + (i + 1));
    horas.push(Math.round((c.noAntesDe - Date.now()) / 3600000));
    assert.equal(await base.guardar(c, [['2000-06-01', 0]]), 0);
    await correrReloj(horas[i] * 60 - 2); assert.equal(await base.tomar(0), null, 'antes de su hora: no');
    await correrReloj(3);
  }
  assert.deepEqual(horas, [8, 16, 32, 64]);
});

test('search_path fijo (pg_catalog, pg_temp) y todo calificado: una tabla temporal del rol no se hace pasar por lotes', { skip: SALTEAR }, async () => {
  const conf = await su`select proname, proconfig from pg_proc where pronamespace = 'imerg_colector'::regnamespace order by proname`;
  assert.equal(conf.length, 6);
  for (const f of conf) assert.deepEqual(f.proconfig, ['search_path=pg_catalog, pg_temp'], f.proname);
  const defs = await su`select proname from pg_proc where pronamespace = 'imerg_colector'::regnamespace and prosecdef order by proname`;
  assert.deepEqual(defs.map((d) => d.proname).sort(), ['_candidatas', 'contar', 'guardar', 'soltar', 'tomar']);
  await limpiar();
  const c = postgres(`postgresql://colector_imerg:${CLAVE}@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1, prepare: false });
  try {
    await c.unsafe(`create temp table lotes (id int, nombre text, lat numeric, lon numeric, activo boolean);
      insert into lotes values (1, 'falso', -34.0, -60.7, true);
      create temp table imerg_celda_estado (celda_lat numeric, celda_lon numeric, desde date, hasta date, filas int, fuente text, actualizado timestamptz);
      create temp table tomas (celda_lat numeric, celda_lon numeric, tomada timestamptz, no_antes_de timestamptz, cerrada timestamptz, resultado text);`);
    assert.equal(Number((await c.unsafe('select imerg_colector.contar(180) as n'))[0].n), 0, 'no ve el lote falso');
    assert.equal((await c.unsafe('select * from imerg_colector.tomar(180)')).length, 0);
  } finally { await c.end(); }
  const [{ n }] = await adm`select count(*)::int as n from imerg_celda_estado`;
  assert.equal(n, 0);
});

// ── 3.ª vuelta: las reproducciones del NO ENTRA de Codex (n3-232-v2-1411) ────────────────────────────────────────────
const conexionRol = () => postgres(`postgresql://colector_imerg:${CLAVE}@127.0.0.1:${PUERTO}/postgres`, { onnotice: () => {}, max: 1, prepare: false });
const tomasAbiertas = async () => (await adm`select count(*)::int as n from imerg_colector.tomas where cerrada is null`)[0].n;

for (const nivel of ['repeatable read', 'serializable']) {
  test(`P1 · ${nivel.toUpperCase()}: la reproducción de Codex con dos conexiones del rol (A fija la foto con contar, B toma, A toma otra) ya no da dos tomas vivas`, { skip: SALTEAR }, async () => {
    await limpiar();
    await lote('reservada', -34.0, -60.7); await lote('sin fila', -33.1, -61.2);
    const r = imergCell(-34.0, -60.7);
    await adm.unsafe(SQL_RESERVAR, [r.clat, r.clon]); await envejecer(r.clat, r.clon, 200);   // la reserva de 200 min
    const a = conexionRol();
    try {
      let tomoA = 'sin llegar';
      await assert.rejects(a.begin(`isolation level ${nivel}`, async (tx) => {
        assert.equal(Number((await tx`select imerg_colector.contar(180) as n`)[0].n), 2, 'A: la foto ve las 2');
        const b = await base.tomar(180);                                                  // B, otra conexión del rol
        assert.deepEqual([b.lat, b.lon], [r.clat, r.clon], 'B se lleva la reserva de 200 min');
        tomoA = await tx`select * from imerg_colector.tomar(10000)`;                       // sin el arreglo: la celda sin fila
      }), (e) => e.code === 'P0001' && /sólo en READ COMMITTED/.test(e.message));
      assert.equal(tomoA, 'sin llegar', 'tomar rechazó la transacción antes de devolver nada');
      assert.equal(await tomasAbiertas(), 1, 'una sola toma viva: la de B');
      const [{ n }] = await adm`select count(*)::int as n from imerg_celda_estado where fuente = 'en curso (colectores)'`;
      assert.equal(n, 1);
      // y en READ COMMITTED (lo que usa el colector), la misma secuencia: A no toma (ve la toma viva de B)
      await a.begin(async (tx) => {
        await tx`select imerg_colector.contar(180)`;
        assert.equal((await tx`select * from imerg_colector.tomar(10000)`).length, 0);
      });
      assert.equal(await tomasAbiertas(), 1);
    } finally { await a.end(); }
  });

  test(`P1 · ${nivel.toUpperCase()}: guardar y soltar también rechazan la transacción (no leen una foto vieja de la toma)`, { skip: SALTEAR }, async () => {
    await limpiar();
    await lote('a', -34.0, -60.7);
    const c = await base.tomar(0);
    const a = conexionRol();
    try {
      for (const q of [
        (tx) => tx`select imerg_colector.guardar(${c.latTxt}::numeric, ${c.lonTxt}::numeric, ${'{2000-06-01}'}::date[], ${'{0}'}::real[])`,
        (tx) => tx`select imerg_colector.soltar(${c.latTxt}::numeric, ${c.lonTxt}::numeric)`,
      ]) {
        await assert.rejects(a.begin(`isolation level ${nivel}`, q), (e) => e.code === 'P0001' && /sólo en READ COMMITTED/.test(e.message));
      }
      assert.equal(await tomasAbiertas(), 1, 'la toma sigue abierta, sin tocar');
      assert.equal((await estado(c.latTxt, c.lonTxt)).fuente, 'en curso (colectores)');
    } finally { await a.end(); }
  });
}

test('P1 · la hora es la del reloj, no la del comienzo de la transacción: una transacción vieja no graba una toma ya «vencida»', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const a = conexionRol();
  try {
    let t0;
    await a.begin(async (tx) => {
      t0 = new Date((await tx`select now() as t`)[0].t);
      await tx`select pg_sleep(1.5)`;
      assert.equal((await tx`select * from imerg_colector.tomar(0)`).length, 1);
    });
    const [t] = await adm`select tomada, no_antes_de from imerg_colector.tomas`;
    assert.ok(new Date(t.tomada) - t0 >= 1400, `tomada ${new Date(t.tomada).toISOString()} vs comienzo ${t0.toISOString()}`);
    const [e] = await adm`select actualizado from imerg_celda_estado`;
    assert.ok(new Date(e.actualizado) - t0 >= 1400, 'la fila también lleva la hora del reloj');
  } finally { await a.end(); }
  // y ninguna de las funciones usa now() (la hora de la transacción de quien llama)
  const fuentes = await su`select proname, prosrc from pg_proc where pronamespace = 'imerg_colector'::regnamespace`;
  for (const f of fuentes) assert.doesNotMatch(f.prosrc, /\bnow\(\)|current_timestamp|transaction_timestamp/i, f.proname);
});
