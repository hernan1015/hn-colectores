// node --test test/guardado-pglite.test.mjs · el guardado de punta a punta contra un PostgreSQL de verdad (PGlite),
// COMO el rol colector_estaciones, con la 0110 (copia), la 0147 y las políticas de la 0147b (los archivos del repo) y
// la 0152 unificada. PGlite va FUERA del repo: HN_PGLITE=<…>/node_modules/@electric-sql/pglite. Sin él, SALTEADO.
// (Los 7 casos de la 138b, pasados a la capa unificada de lib/base.mjs, más el lote de la notebook.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { correr } from '../parseo.mjs';
import { crearGuardado, ejecutorPglite, REDES, conectarPg } from '../lib/base.mjs';
import { FUENTES } from '../fuentes/index.mjs';
import WL from '../fuentes/weatherlink.mjs';
import * as WC from '../fuentes/weathercloud.mjs';
import { RAIZ, politicas0147b, carpeta, rondaWL, indiceWL, rondaWC, detalleWL, devWC, WC_PRUEBA, loteWL, loteWC } from './fixtures.mjs';

const DIR = process.env.HN_PGLITE || '';
const salto = !(DIR && fs.existsSync(path.join(DIR, 'dist', 'index.js'))) && 'sin HN_PGLITE';
const REPO = path.resolve(RAIZ, '..', '..');
const leerTxt = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const PREVIO = leerTxt(path.join(RAIZ, 'test', 'esquema-previo.sql'));
const M0147 = leerTxt(path.join(REPO, 'sipan-alto-valle', 'migracion', '0147_estaciones_noche_y_muestreo.sql'));
const M0152 = leerTxt(path.join(RAIZ, 'migracion', '0152_parseo_estaciones_unificada_PROPUESTA.sql'));
async function nueva({ con0152 = true } = {}) {
  const { PGlite } = await import(pathToFileURL(path.join(DIR, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(PREVIO); await pg.exec(M0147); await pg.exec(politicas0147b());
  if (con0152) await pg.exec(M0152);
  return pg;
}
/** El ejecutor del guardado, COMO el rol (RLS y grants de verdad). */
const comoRol = (pg) => ejecutorPglite(pg, { rol: 'colector_estaciones' });
const q = (pg) => comoRol(pg).query;
const filas = async (pg) => (await pg.query(`select red, estacion_id, fecha::text f, tmin_c::float8 tmin, tmax_c::float8 tmax, registros_validos rv,
  registros_esperados re, tmin_noche_c::float8 tn, noche_registros nr, muestreo_min mm, lluvia_mm::float8 ll, lluvia_origen lo
  from estaciones_obs order by 1, 2, 3`)).rows;
const nada = () => {};
const SOLO = [WL, WC.default];

const AHORA = Date.parse('2026-11-15T19:30:00Z');
async function r2ConDatos() {
  const { r2 } = carpeta();
  await indiceWL(r2, '2026-11-15', [{ id: '501', lat: -39.03, lng: -67.58, tb: 1 }, { id: '502', lat: -34.6, lng: -58.4, tb: -1 }]);
  for (const [h, f] of [[3, 41], [9, 35], [15, 60], [18, 70]]) {        // 00, 06, 12, 15 ART
    const ms = Date.parse(`2026-11-15T${String(h).padStart(2, '0')}:11:00Z`);
    await rondaWL(r2, ms, [{ id: '501', d: detalleWL({ t: new Date(ms - 6 * 60e3).toISOString(), f, rainIn: h / 100, nombre: 'Chacra 03 Ã±' }) }]);
  }
  // la misma lectura que vuelve en la ronda siguiente (la consola no subió nada nuevo): dedup
  await rondaWL(r2, Date.parse('2026-11-15T19:11:00Z'), [{ id: '501', d: detalleWL({ t: '2026-11-15T18:05:00Z', f: 70, rainIn: 0.18, edad: 3960, nombre: 'Chacra 03 Ã±' }) }]);
  await rondaWC(r2, Date.parse('2026-11-15T15:11:00Z'), [devWC('c1'), devWC('c2', { estado: 1 })]);
  return r2;
}

test('real: guarda WL como el rol, con nombre arreglado, mostrar=false y el día bien armado', { skip: salto }, async () => {
  const pg = await nueva();
  const r2 = await r2ConDatos();
  const res = await correr({ r2, ejecutor: comoRol(pg), ahora: AHORA, horas: 24, fuentes: SOLO, log: nada });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.fuentes.weatherlink.repetidas, 1);
  const f = await filas(pg);
  assert.deepEqual(f, [{ red: 'WEATHERLINK_PUB', estacion_id: '501', f: '2026-11-15', tmin: 1.67, tmax: 21.11, rv: 4, re: 24, tn: 1.67, nr: 2, mm: 60, ll: 4.57, lo: 'acumulado_consola' }]);
  const e = (await pg.query(`select estacion_id, nombre, activa, lat::float8 lat, metadatos from estaciones order by 1`)).rows;
  assert.equal(e[0].nombre, 'Chacra 03 ñ'); assert.equal(e[0].lat, -39.03); assert.equal(e[0].metadatos.mostrar, false);
  assert.equal(e[1].activa, false);
  const u = (await pg.query(`select instante, temp_c::float8 t from estaciones_ultima_lectura`)).rows;
  assert.equal(u.length, 1); assert.equal(new Date(u[0].instante).toISOString(), '2026-11-15T18:05:00.000Z');
  // Weathercloud sin verificar: nada
  assert.equal((await pg.query(`select count(*)::int n from estaciones where red = 'WEATHERCLOUD_PUB'`)).rows[0].n, 0);
  const reg = (await pg.query(`select proceso, ok, resumen from registro_procesos order by id`)).rows;
  assert.deepEqual(reg.map((x) => [x.proceso, x.resumen.fuente]), [['estaciones_privadas_parseo', 'weatherlink'], ['estaciones_privadas_parseo', 'weathercloud']]);
  assert.ok(!JSON.stringify(reg).includes('501'));
  await pg.close();
});

test('IDEMPOTENTE: dos corridas iguales dejan las mismas filas; una con menos crudo no pisa lo más completo', { skip: salto }, async () => {
  const pg = await nueva();
  const r2 = await r2ConDatos();
  const ej = comoRol(pg);
  const c = (r, ahora = AHORA) => correr({ r2: r, ejecutor: ej, ahora, horas: 24, fuentes: SOLO, log: nada });
  await c(r2);
  const una = await filas(pg);
  const otra = await c(r2);
  assert.deepEqual(await filas(pg), una);
  assert.equal(otra.fuentes.weatherlink.filas_escritas, 0, 'sin cambios no se reescribe');
  assert.equal((await pg.query('select count(*)::int n from estaciones_obs')).rows[0].n, 1);
  // falta un archivo en R2 (p. ej., una lectura a medias): no baja lo guardado
  const { r2: chico } = carpeta();
  await rondaWL(chico, Date.parse('2026-11-15T18:11:00Z'), [{ id: '501', d: detalleWL({ t: '2026-11-15T18:05:00Z', f: 70, rainIn: 0.18 }) }]);
  await c(chico);
  assert.deepEqual(await filas(pg), una);
  // un crudo MÁS VIEJO (sólo la de las 15:05) no hace retroceder la última lectura
  const { r2: viejo } = carpeta();
  await rondaWL(viejo, Date.parse('2026-11-15T15:11:00Z'), [{ id: '501', d: detalleWL({ t: '2026-11-15T15:05:00Z', f: 60, rainIn: 0.15 }) }]);
  await c(viejo);
  const u = (await pg.query('select instante, temp_c::float8 t from estaciones_ultima_lectura')).rows[0];
  assert.equal(new Date(u.instante).toISOString(), '2026-11-15T18:05:00.000Z'); assert.equal(u.t, 21.11);
  // lo que otros pusieron en metadatos (p. ej. la zona de la 254/257) queda, aunque se reescriba el catálogo
  await pg.exec(`update estaciones set metadatos = metadatos || '{"zona":"agricola"}', nombre = 'otro' where estacion_id = '501'`);
  await c(r2);
  const md = (await pg.query(`select nombre, metadatos from estaciones where estacion_id = '501'`)).rows[0];
  assert.equal(md.nombre, 'Chacra 03 ñ', 'el catálogo se reescribió'); assert.equal(md.metadatos.zona, 'agricola'); assert.equal(md.metadatos.mostrar, false);
  // control negativo: una lectura nueva SÍ suma
  await rondaWL(r2, Date.parse('2026-11-15T20:11:00Z'), [{ id: '501', d: detalleWL({ t: '2026-11-15T20:05:00Z', f: 80 }) }]);
  await c(r2, Date.parse('2026-11-15T20:30:00Z'));
  assert.equal((await filas(pg))[0].rv, 5);
  await pg.close();
});

test('Weathercloud verificado: guarda WEATHERCLOUD_PUB (décimas) como el rol, sólo las en línea', { skip: salto }, async () => {
  const pg = await nueva();
  const r2 = await r2ConDatos();
  const res = await correr({ r2, ejecutor: comoRol(pg), ahora: AHORA, horas: 24, fuentes: [WC.crear(WC_PRUEBA)], log: nada });
  assert.equal(res.ok, true, JSON.stringify(res));
  const f = (await filas(pg)).filter((x) => x.red === 'WEATHERCLOUD_PUB');
  assert.deepEqual(f.map((x) => [x.estacion_id, x.tmax, x.ll, x.mm]), [['c1', 21.5, 1.2, 60]]);
  assert.equal((await pg.query(`select count(*)::int n from estaciones where red = 'WEATHERCLOUD_PUB'`)).rows[0].n, 2);
  await pg.close();
});

test('SIN la 0152 el rol no puede escribir Weathercloud ni la última lectura ni anotar el proceso (control negativo)', { skip: salto }, async () => {
  const pg = await nueva({ con0152: false });
  const qq = q(pg);
  await assert.rejects(() => qq(`insert into estaciones (red, estacion_id) values ('WEATHERCLOUD_PUB', 'x')`), /row-level security/);
  await qq(`insert into estaciones (red, estacion_id) values ('WEATHERLINK_PUB', 'x')`);
  await assert.rejects(() => qq(`insert into estaciones_ultima_lectura (red, estacion_id, instante) values ('WEATHERLINK_PUB', 'x', now())`), /permission denied/);
  await assert.rejects(() => qq(`insert into registro_procesos (proceso, ok) values ('estaciones_privadas_parseo', true)`), /row-level security/);
  await pg.close();
});

test('CON la 0152: idempotente, amplía sin perder lo de antes, y el rol sigue sin poder borrar ni ver otras redes', { skip: salto }, async () => {
  const pg = await nueva();
  await pg.exec(M0152);
  const qq = q(pg);
  for (const red of ['WEATHERCLOUD_PUB', 'WEATHERLINK_PUB', 'INTA_SIPAN_AV', 'SMN_ABIERTO']) await qq(`insert into estaciones (red, estacion_id) values ('${red}', 'x')`);
  await qq(`insert into estaciones_ultima_lectura (red, estacion_id, instante) values ('WEATHERCLOUD_PUB', 'x', now())`);
  for (const p of ['estaciones_privadas_parseo', 'sipan_alto_valle', 'weatherlink_publico', 'smn_abierto']) await qq(`insert into registro_procesos (proceso, ok) values ('${p}', true)`);
  await assert.rejects(() => qq(`insert into estaciones (red, estacion_id) values ('SNIH', 'x')`), /row-level security/);
  await assert.rejects(() => qq(`insert into registro_procesos (proceso, ok) values ('otro', true)`), /row-level security/);
  await assert.rejects(() => qq(`delete from estaciones_ultima_lectura`), /permission denied/);
  await assert.rejects(() => qq(`delete from estaciones_obs`), /permission denied/);
  await pg.exec(`insert into estaciones (red, estacion_id) values ('SNIH', 'oculta')`);
  assert.equal((await qq(`select count(*)::int n from estaciones where red = 'SNIH'`))[0].n, 0);
  // las redes del guardado son exactamente las de las 9 fuentes, y todas están en la política
  assert.deepEqual([...REDES].sort(), [...new Set(FUENTES.flatMap((f) => Object.keys(f.redes)))].sort());
  for (const red of REDES) assert.ok(M0152.includes(`'${red}'`), red);
  await pg.close();
});

test('el guardado rechaza una red que no es suya (antes de ir a la base)', async () => {
  const ej = { query: async () => { throw new Error('no tendría que llegar'); } };
  assert.throws(() => crearGuardado(ej, 'SNIH'), /red no permitida/);
  await assert.rejects(() => crearGuardado(ej, 'WEATHERLINK_PUB').guardarObs([{ red: 'SNIH', estacion_id: '1' }]), /otra red/);
});

test('la conexión: sólo colector_estaciones y sólo el pooler; los errores sin la URL', async () => {
  const CL = 'Cl4ve-De-Prueba-NoEsReal-3c2b1a';
  const ok = `postgresql://colector_estaciones.abcdefgh:${CL}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;
  await assert.rejects(() => conectarPg({ url: '' }), /falta la URL de la base \(PARSEO_PG_URL\)/);
  await assert.rejects(() => conectarPg({ url: ok.replace('colector_estaciones.abcdefgh', 'postgres.abcdefgh') }), /tiene que ser del usuario/);
  await assert.rejects(() => conectarPg({ url: ok.replace('aws-0-sa-east-1.pooler.supabase.com', 'db.otro.com') }), /pooler/);
  const falso = (u) => ({ unsafe: async (t) => { if (/current_user/.test(t)) return [{ u, s: u }]; throw Object.assign(new Error(`falló ${ok}`), { code: '42501' }); }, end: async () => {} });
  await assert.rejects(() => conectarPg({ url: ok, conectar: () => falso('postgres') }), /otro usuario/);
  const b = await conectarPg({ url: ok, conectar: () => falso('colector_estaciones') });
  const e = await b.query('select 1').catch((x) => x);
  assert.equal(e.message, 'base: 42501 (sin permiso (RLS o grant))'); assert.ok(!e.message.includes(CL));
});

test('el LOTE de la notebook (local.jsonl.gz): se lee, no duplica el instante que bajó la nube y es idempotente', { skip: salto }, async () => {
  const pg = await nueva();
  const { r2 } = carpeta();
  // la nube: la ronda de las 15:11Z con la lectura de las 15:05Z
  await rondaWL(r2, Date.parse('2026-11-15T15:11:00Z'), [{ id: '501', d: detalleWL({ t: '2026-11-15T15:05:00Z', f: 60 }) }]);
  // la notebook: la MISMA lectura de las 15:05Z, una anterior (12:05Z) con otra forma de renglón, una vieja y uno roto
  await loteWL(r2, '2026-11-15', [
    { id: '501', leido: '2026-11-15T15:07:00Z', d: detalleWL({ t: '2026-11-15T15:05:00Z', f: 60 }) },
    { stationId: '501', ts: '2026-11-15T12:06:00Z', ...detalleWL({ t: '2026-11-15T12:05:00Z', f: 41 }) },
    { id: '501', leido: '2026-11-15T13:00:00Z', d: detalleWL({ t: '2026-11-15T09:00:00Z', f: 30, edad: 14400 }) },
    { sin: 'forma' },
  ]);
  // Weathercloud (formato de prueba): un renglón por pasada y uno por device
  await loteWC(r2, '2026-11-15', [{ leido: '2026-11-15T12:00:00Z', devices: [devWC('c1', { t: 150 })] }, { leido: '2026-11-15T13:00:00Z', d: devWC('c1', { t: 180 }) }]);
  const fuentes = [WL, WC.crear(WC_PRUEBA)];
  const res = await correr({ r2, ejecutor: comoRol(pg), ahora: Date.parse('2026-11-15T16:00:00Z'), fuentes, log: nada });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.fuentes.weatherlink.repetidas, 1, 'la de las 15:05Z vino por los dos lados');
  assert.deepEqual(res.fuentes.weatherlink.cuentas.descartadas, { lote_sin_forma: 1, vieja: 1 });
  const f = await filas(pg);
  assert.deepEqual(f.map((x) => [x.red, x.estacion_id, x.rv, x.tmin, x.tmax]), [['WEATHERCLOUD_PUB', 'c1', 2, 15, 18], ['WEATHERLINK_PUB', '501', 2, 5, 15.56]]);
  const otra = await correr({ r2, ejecutor: comoRol(pg), ahora: Date.parse('2026-11-15T16:30:00Z'), fuentes, log: nada });
  assert.ok(Object.values(otra.fuentes).every((x) => x.filas_escritas === 0), JSON.stringify(otra.fuentes));
  assert.deepEqual((await filas(pg)).map((x) => x.rv), [2, 2]);
  // un día después, sin --desde el lote queda afuera de la ventana; con --desde (horas largas) vuelve a entrar, igual
  const sin = await correr({ r2, ahora: Date.parse('2026-11-17T12:00:00Z'), fuentes, log: nada });
  assert.equal(sin.fuentes.weatherlink.rondas, 0);
  const tarde = await correr({ r2, ejecutor: comoRol(pg), ahora: Date.parse('2026-11-17T12:00:00Z'), horas: 60, fuentes, log: nada });
  assert.equal(tarde.fuentes.weatherlink.rondas, 2, 'la ronda y el lote'); assert.equal(tarde.fuentes.weatherlink.filas_escritas, 0);
  await pg.close();
});
