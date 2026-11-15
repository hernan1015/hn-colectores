// node --test · la 0154 contra un PostgreSQL de verdad (PGlite), con la 0110 y la 0075 (copia del parseo), la 0147 y
// las políticas de la 0147b (los archivos del repo). El job corre COMO el rol medicion_app: grants y RLS de verdad.
// La sección del rol es de psql (\gexec y :'clave'): acá se reemplazan esas dos líneas, y el test exige encontrarlas.
//   HN_PGLITE=C:/HN-AGRO/herramientas-pglite/node_modules/@electric-sql/pglite node --test test/pglite.test.mjs
// Sin HN_PGLITE, se saltea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { correr } from '../medir-app.mjs';
import { crearBase, ejecutorPglite } from '../lib/base.mjs';
import { FECHA, SIG, estacionCompleta, fila, fetchFalso, sinEspera } from './fixtures.mjs';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(RAIZ, '..');
const DIR = process.env.HN_PGLITE || '';
const salto = !(DIR && fs.existsSync(path.join(DIR, 'dist', 'index.js'))) && 'sin HN_PGLITE';
const leer = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');

/** La 0154 para PGlite: las dos líneas de psql, reemplazadas (y si no están, el test se cae). */
export function m0154ParaPglite() {
  const sql = leer('medicion-app', 'migracion', '0154_medicion_app_PROPUESTA.sql');
  const gexec = /select 'create role medicion_app login nocreatedb nocreaterole noinherit connection limit 2'\n where not exists \(select 1 from pg_roles where rolname = 'medicion_app'\) \\gexec/;
  if (!gexec.test(sql) || !sql.includes("password :'clave';")) throw new Error('la sección del rol de la 0154 cambió');
  return sql.replace(gexec, `do $g$ begin if not exists (select 1 from pg_roles where rolname = 'medicion_app') then
    create role medicion_app login nocreatedb nocreaterole noinherit connection limit 2; end if; end $g$;`)
    .replace("password :'clave';", 'password null;');
}
function politicas0147b() {
  const t = leer('sipan-alto-valle', 'migracion', '0147b_rol_colector_estaciones.sql');
  const a = t.indexOf('grant usage on schema public to colector_estaciones;');
  const b = t.indexOf('-- (Una política «for all» no da DELETE');
  if (!(a > 0 && b > a)) throw new Error('la 0147b cambió');
  return t.slice(a, b) + '\nalter table public.registro_procesos enable row level security;\n';
}
async function nueva({ con0147b = true } = {}) {
  const { PGlite } = await import(pathToFileURL(path.join(DIR, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(leer('estaciones-privadas', 'parseo', 'test', 'esquema-previo.sql'));
  await pg.exec(leer('sipan-alto-valle', 'migracion', '0147_estaciones_noche_y_muestreo.sql'));
  if (con0147b) await pg.exec(politicas0147b());
  return pg;
}
/** Carga estaciones y filas diarias como el parseo (como postgres: el parseo tiene su propio rol). */
async function cargar(pg, obs) {
  const vistas = new Set();
  for (const o of obs) {
    const k = o.red + '|' + o.estacion_id;
    if (!vistas.has(k)) {
      vistas.add(k);
      const meta = { mostrar: false, uso: 'interno', ...(o.zona ? { zona: o.zona } : {}), nombre_privado: 'Chacra de Fulano' };
      await pg.query(`insert into estaciones (red, estacion_id, nombre, lat, lon, metadatos) values ($1, $2, 'Chacra de Fulano', $3, $4, $5::jsonb)`,
        [o.red, o.estacion_id, o.lat, o.lon, JSON.stringify(meta)]);
    }
    await pg.query(`insert into estaciones_obs (red, estacion_id, fecha, hora_corte, lluvia_mm, horas_validas, tmin_c, tmax_c, crudo, tmin_noche_c,
        noche_registros, noche_esperados, registros_validos, registros_esperados, muestreo_min)
      values ($1, $2, $3::date, '00:00', 12.5, 24, 1, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
    [o.red, o.estacion_id, o.fecha, o.tmax_c, JSON.stringify(o.lecturas ? { fuente: 'x', lecturas: o.lecturas, firma: 'f' } : { fuente: 'sipan' }),
      o.tmin_noche_c, o.noche_registros, o.noche_esperados, o.registros_validos, o.registros_esperados, o.muestreo_min]);
  }
}
const OBS = [
  ...estacionCompleta({ id: '100', lat: -33.9, lon: -60.6, zona: 'agricola', tmin: 4.2, tmax: 27.5, hum: 60 }),
  ...estacionCompleta({ red: 'INTA_SIPAN_AV', id: '7', lat: -39.03, lon: -67.7, zona: 'natural', tmin: -1, tmax: 30, hum: 40 }),
  fila(FECHA, { red: 'SNIH', estacion_id: '9', lat: -31, lon: -61, zona: null, tmax_c: null, tmin_noche_c: null }),
  // sin zona todavía (la 257 no la clasificó) y sin lecturas en el crudo: cuenta como sin_dato
  fila(FECHA, { red: 'SMN_ABIERTO', estacion_id: '5', lat: -31.3, lon: -64.2, zona: null }),
  fila(SIG, { red: 'SMN_ABIERTO', estacion_id: '5', lat: -31.3, lon: -64.2, zona: null }),
];
const comoRol = (pg) => ejecutorPglite(pg, { rol: 'medicion_app' });
const rechaza = async (pg, sql, re = /permission denied|row-level security|violates/) => {
  await pg.exec('set role medicion_app');
  try { await assert.rejects(pg.query(sql), re, sql); } finally { await pg.exec('reset role'); }
};

test('0154: el job COMO el rol lee por la función, escribe su tabla y su proceso, y es idempotente', { skip: salto }, async () => {
  const pg = await nueva();
  await pg.exec(m0154ParaPglite());
  await pg.exec(m0154ParaPglite());                          // idempotente
  await cargar(pg, OBS);
  const base = crearBase(comoRol(pg));
  const r = await correr({ base, fecha: FECHA, real: true, fetchFn: fetchFalso(), esperar: sinEspera, log: () => {} });
  assert.equal(r.ok, true, JSON.stringify(r.errores_por_codigo));
  assert.equal(r.escritas, 3, 'la del SNIH (sin temperaturas) no la devuelve la función');
  const filas = (await pg.query(`select red, estacion_id, fecha::text f, regla, zona, region, noche_ok, noche_dif_c::float8 nd, tmax_dif_c::float8 td,
    hr_dif_pp::float8 hd, motivos from medicion_app_estacion order by 1, 2`)).rows;
  assert.deepEqual(filas.map((x) => [x.red, x.estacion_id, x.f, x.regla, x.zona, x.region, x.noche_ok]),
    [['INTA_SIPAN_AV', '7', FECHA, 'm1', 'natural', 'patagonia', true], ['SIGA_RT', '100', FECHA, 'm1', 'agricola', 'pampa_norte', true],
     ['SMN_ABIERTO', '5', FECHA, 'm1', 'sin_dato', 'pampa_norte', true]]);
  assert.equal(filas[1].nd, 0.8); assert.equal(filas[1].td, 0.5); assert.equal(filas[1].hd, -5);
  assert.ok(filas[2].motivos.includes('noche_huecos_sin_verificar'));
  const reg = (await pg.query(`select proceso, ok, resumen from registro_procesos`)).rows;
  assert.equal(reg.length, 1); assert.equal(reg[0].proceso, 'medicion_app'); assert.equal(reg[0].ok, true);
  assert.equal(reg[0].resumen.por_region.patagonia.noche.n, 1);
  assert.ok(!JSON.stringify(reg[0].resumen).includes('Fulano'));
  // la segunda corrida actualiza: no duplica
  await correr({ base, fecha: FECHA, real: true, fetchFn: fetchFalso(() => ({ noche: 6 })), esperar: sinEspera, log: () => {} });
  const otra = (await pg.query(`select count(*)::int n, max(noche_dif_c)::float8 m from medicion_app_estacion`)).rows[0];
  assert.equal(otra.n, 3); assert.equal(otra.m, 7, '6 − (−1): se actualizó');
});

test('0154: el rol no ve estaciones ni estaciones_obs, no borra, no anota otro proceso; la función no da nombres', { skip: salto }, async () => {
  const pg = await nueva();
  await pg.exec(m0154ParaPglite());
  await cargar(pg, OBS);
  await rechaza(pg, 'select count(*) from estaciones');
  await rechaza(pg, 'select count(*) from estaciones_obs');
  await rechaza(pg, `update estaciones set metadatos = '{}'`);
  await rechaza(pg, 'select count(*) from pronostico_helada_medicion');
  await rechaza(pg, 'delete from medicion_app_estacion');
  await rechaza(pg, `insert into registro_procesos (proceso, ok) values ('sipan_alto_valle', true)`);
  await rechaza(pg, 'select count(*) from registro_procesos');
  // la función: sólo las columnas de la lista; ni el nombre ni el resto de metadatos ni la lluvia
  const cols = (await comoRol(pg).query(`select * from medicion_app_obs($1::date)`, [FECHA]));
  assert.ok(cols.length >= 3);
  assert.deepEqual(Object.keys(cols[0]).sort(), ['estacion_id', 'fecha', 'lat', 'lecturas', 'lon', 'muestreo_min', 'noche_esperados',
    'noche_registros', 'red', 'registros_esperados', 'registros_validos', 'tmax_c', 'tmin_noche_c', 'zona'].sort());
  assert.ok(!JSON.stringify(cols).includes('Fulano'));
  assert.ok(cols.every((c) => [FECHA, SIG].includes(String(c.fecha instanceof Date ? c.fecha.toISOString().slice(0, 10) : c.fecha))));
  // anon y authenticated: nada
  for (const r of ['anon', 'authenticated']) {
    await pg.exec(`set role ${r}`);
    try {
      await assert.rejects(pg.query(`select * from medicion_app_obs('${FECHA}'::date)`), /permission denied/);
      await assert.rejects(pg.query('select * from medicion_app_estacion'), /permission denied/);
    } finally { await pg.exec('reset role'); }
  }
  const rol = (await pg.query(`select rolcanlogin, rolconnlimit, rolbypassrls, rolsuper from pg_roles where rolname = 'medicion_app'`)).rows[0];
  assert.deepEqual(rol, { rolcanlogin: true, rolconnlimit: 2, rolbypassrls: false, rolsuper: false });
});

test('0154: los CHECK: la diferencia sólo si vale y es app − estación; zona y región de la lista', { skip: salto }, async () => {
  const pg = await nueva();
  await pg.exec(m0154ParaPglite());
  await cargar(pg, OBS);
  const ins = (extra) => {
    const f = { red: 'SIGA_RT', estacion_id: '100', fecha: FECHA, regla: 'm1', zona: 'agricola', region: 'pampa_norte', lat: -33.9, lon: -60.6,
      noche_est_c: 4, noche_app_c: 5, noche_dif_c: 1, noche_ok: true, tmax_ok: false, hr_ok: false, ...extra };
    const c = Object.keys(f);
    return pg.query(`insert into medicion_app_estacion (${c.join(', ')}) values (${c.map((_, i) => '$' + (i + 1)).join(', ')})`, Object.values(f));
  };
  await assert.rejects(ins({ noche_dif_c: -1 }), /mae_noche/, 'el signo es app − estación');
  await assert.rejects(ins({ noche_ok: false }), /mae_noche/, 'sin validez no hay diferencia');
  await assert.rejects(ins({ noche_app_c: null }), /mae_noche/);
  await assert.rejects(ins({ zona: 'selva' }), /mae_zona/);
  await assert.rejects(ins({ region: 'mesopotamia' }), /mae_region/);
  await assert.rejects(ins({ regla: 'x' }), /mae_regla/);
  await assert.rejects(ins({ tmax_ok: true }), /mae_tmax/);
  await assert.rejects(ins({ hr_est_pct: 120 }), /mae_hr/);
  await assert.rejects(ins({ estacion_id: 'no-existe' }), /foreign key/);
  await ins({});                                              // la buena entra
});

test('0154: sin la 0147b (registro_procesos sin RLS) no se aplica', { skip: salto }, async () => {
  const pg = await nueva({ con0147b: false });
  await assert.rejects(pg.exec(m0154ParaPglite()), /registro_procesos sin RLS/);
});
