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

const limpiar = () => adm.unsafe('delete from imerg_pp_diario; delete from imerg_celda_estado; delete from lotes;');
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
      'select * from imerg_colector._candidatas(0)', 'select imerg_colector.celda_js(1, 2)', 'delete from imerg_pp_diario']) {
      await assert.rejects(c.unsafe(q), (e) => e.code === '42501', q);
    }
  } finally { await c.end(); }
  for (const r of ['anon', 'authenticated', 'public']) {
    for (const f of ['imerg_colector.tomar(integer)', 'imerg_colector.guardar(numeric, numeric, date[], real[])', 'imerg_colector.contar(integer)', 'imerg_colector.soltar(numeric, numeric)']) {
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
  assert.equal(await base.guardar(c1, serie), 3);
  assert.deepEqual(await estado(c1.latTxt, c1.lonTxt), { fuente: 'GPM_3IMERGDF_07 (Giovanni · colectores)', filas: 3, desde: '2000-06-01', hasta: '2025-09-30' });
  const c2 = await base.tomar(180);
  assert.ok(c2 && (c2.latTxt !== c1.latTxt || c2.lonTxt !== c1.lonTxt));
  await base.guardar(c2, serie);
  assert.equal(await base.tomar(180), null); assert.equal(await base.contar(180), 0);
  const [{ n }] = await adm`select count(*)::int as n from imerg_pp_diario`;
  assert.equal(n, 6);
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

test('la reserva de la app: fresca no se toca (hn-agro puede tener un run), trabada (> espera) sí; con espera 0, enseguida', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const { clat, clon } = imergCell(-34.0, -60.7);
  assert.equal((await adm.unsafe(SQL_RESERVAR, [clat, clon])).length, 1);           // el alta reservó y despachó
  assert.equal(await base.tomar(180), null);
  assert.equal(await base.contar(0), 1);
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

test('retoma: si GitHub corta el job, la toma vence a los 90 min y se vuelve a tomar; un fallo espera 6 h', { skip: SALTEAR }, async () => {
  await limpiar();
  await lote('a', -34.0, -60.7);
  const c = await base.tomar(0);
  await envejecer(c.latTxt, c.lonTxt, 80);
  assert.equal(await base.tomar(0), null, 'a los 80 min sigue viva');
  await envejecer(c.latTxt, c.lonTxt, 91);
  const again = await base.tomar(0);
  assert.deepEqual([again.latTxt, again.lonTxt], [c.latTxt, c.lonTxt]);
  assert.equal(await base.soltar(again), true);
  assert.equal((await estado(c.latTxt, c.lonTxt)).fuente, 'fallo (colectores)');
  assert.equal(await base.tomar(0), null, 'recién fallada: no');
  await envejecer(c.latTxt, c.lonTxt, 5 * 60); assert.equal(await base.tomar(0), null, 'a las 5 h: no');
  await envejecer(c.latTxt, c.lonTxt, 6 * 60 + 1); assert.ok(await base.tomar(0), 'pasadas 6 h: sí');
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

test('el caso del 13/11 contra la base de verdad: 9 celdas trabadas se llenan de a ≤ 2 por corrida, sin disparar nada', { skip: SALTEAR }, async () => {
  await limpiar();
  const pts = [[-34.05, -60.75], [-33.15, -61.25], [-37.85, -58.45], [-28.85, -56.75], [-32.76, -62.18], [-30.1, -59.3], [-31.4, -64.2], [-35.6, -62.9], [-36.2, -57.7]];
  for (const [i, p] of pts.entries()) { await lote('l' + i, p[0], p[1]); const { clat, clon } = imergCell(...p); await adm.unsafe(SQL_RESERVAR, [clat, clon]); await envejecer(clat, clon, 30 * 60); }
  let corridas = 0, pedidos = 0;
  while (corridas < 10) {
    corridas++;
    const r = await barrer({ base, esperaLazyMin: 180, dormir: async () => {}, log: () => {}, serie: async () => { pedidos++; return serie; } });
    assert.ok(r.tomadas <= 2);
    if (r.motivo === 'nada_pendiente') break;
  }
  const [{ n }] = await adm`select count(*)::int as n from imerg_celda_estado where filas = 3`;
  assert.equal(n, 9); assert.equal(pedidos, 9, 'un pedido por celda, ninguno repetido');
  assert.equal(corridas, 5, '5 corridas: 2+2+2+2 y la 5.ª toma 1 y ya no encuentra otra');
});
