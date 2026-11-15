// node --test estaciones-privadas/parseo/test/parseo.test.mjs
// El parseo de R2 → estaciones_obs con fixtures en el FORMATO REAL que guarda ronda.mjs ({ leido, partes: { nombre:
// { status, tipo, cuerpo } } }, el cuerpo como lo deja r.text()). Las respuestas son las reales del 15/11 (un pedido
// manual por fuente); SIGA y la temperatura/humedad del INA son SINTÉTICAS (ver LISTO-139-internas.md). NINGÚN pedido
// real: el almacén es una carpeta. El guardado, contra PGlite con las migraciones REALES 0110 (hn-agro) + 0147 + 0147b
// (este repo); sin HN_PGLITE esos casos se saltean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { correr, instanteDeClave, juntar, FUENTES } from '../parsear.mjs';
import { almacenCarpeta } from '../../../sipan-alto-valle/lib/almacen.mjs';
import { ejecutorPglite } from '../lib/base.mjs';
import { numero, controlar, filaDia, filasEstacion } from '../lib/diario.mjs';
import { parsearDavis } from '../fuentes/er.mjs';
import { parsearMapa } from '../fuentes/bcp.mjs';
import { parsearAutomaticas } from '../fuentes/siga.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
/* Los fixtures son DATOS de fuentes de uso interno: NO van en este repo (es público). Viven en el cortex (privado):
   HN_FIXTURES_139=<…>/hn-cortex/docs/red-nacional-139/fixtures/r2. Sin ellos, los tests que los usan se saltean. */
const R2 = process.env.HN_FIXTURES_139 || 'C:/HN-AGRO/hn-cortex/docs/red-nacional-139/fixtures/r2';
const sinFix = !fs.existsSync(path.join(R2, 'estaciones-internas')) && 'sin HN_FIXTURES_139 (los fixtures están en el cortex privado)';
const REPO = path.resolve(DIR, '..', '..', '..');
const obj = (id, dia, hhmm) => JSON.parse(fs.readFileSync(path.join(R2, 'estaciones-internas', id, dia, hhmm + '.json'), 'utf8'));
const fuente = (id) => FUENTES.find((f) => f.id === id);
const AHORA = Date.parse('2026-11-15T16:10:00Z');
const nada = () => {};

/* ── la forma de las claves ── */
test('la clave de ronda.mjs (día ARG + HHMM UTC) → el instante; de 00 a 02:59 UTC es el día siguiente', () => {
  assert.equal(new Date(instanteDeClave('estaciones-internas/eeaoc/2026-11-15/1541.json')).toISOString(), '2026-11-15T15:41:00.000Z');
  assert.equal(new Date(instanteDeClave('estaciones-internas/eeaoc/2026-11-15/0211.json')).toISOString(), '2026-11-16T02:11:00.000Z');
  assert.equal(instanteDeClave('estaciones-internas/eeaoc/_cortes.json'), null);
  /* control negativo: de las 03 UTC en adelante, el mismo día */
  assert.equal(new Date(instanteDeClave('estaciones-internas/eeaoc/2026-11-15/0311.json')).toISOString(), '2026-11-15T03:11:00.000Z');
});

/* ── cada fuente con su fixture de R2 ── */
test('EEAOC: estaciones.php de la ronda; la del futuro (1802,6 °C) y las paradas no entran', { skip: sinFix }, () => {
  const j = juntar(fuente('eeaoc'), [obj('eeaoc', '2026-11-15', '1541')]);
  const r = j.porRed.get('EEAOC');
  assert.equal(r.estaciones.size, 61);
  assert.ok(r.descartadas >= 20, 'viejas o futuras: ' + r.descartadas);
  const porId = new Map(); for (const l of r.lecturas) (porId.get(l.id) || porId.set(l.id, []).get(l.id)).push(l);
  for (const ls of porId.values()) for (const f of filasEstacion({ nuevas: ls, cfg: fuente('eeaoc').redes.EEAOC, ahoraLocal: '2026-11-15T12:41' }).filas) assert.ok(f.tmax_c == null || f.tmax_c < 50, 'entró un imposible: ' + f.tmax_c);
  assert.ok(!r.lecturas.some((l) => l.local > '2026-11-15T12:56'), 'entró una del futuro');
  /* control negativo: Bajastine (12:30) sí */
  assert.ok(r.lecturas.some((l) => l.local === '2026-11-15T12:30' && l.v.temp === 25.9));
});

test('Mendoza y San Luis: una lectura por estación; PRONO afuera; la lluvia de origen dudoso NO va a la lluvia', { skip: sinFix }, () => {
  const m = juntar(fuente('mendoza'), [obj('mendoza', '2026-11-15', '1541')]).porRed.get('DACC_MZA');
  assert.equal(m.estaciones.size, 60);
  const s = juntar(fuente('sanluis'), [obj('sanluis', '2026-11-15', '1541')]).porRed.get('REM_SL');
  assert.equal(s.estaciones.size, 100, 'las 4 PRONO no');
  assert.ok([...s.estaciones.values()].some((e) => /Ca.ada Honda/.test(e.nombre)), 'la ñ llega como \\uFFFD (r.text()), pero el nombre se lee');
  const f = filasEstacion({ nuevas: m.lecturas.filter((l) => l.id === '5'), cfg: fuente('mendoza').redes.DACC_MZA, ahoraLocal: '2026-11-15T13:10' }).filas[0];
  assert.equal(f.lluvia_mm, null); assert.equal(f.lluvia_origen, null); assert.equal(f.muestreo_min, 60);
});

test('BCP: los casilleros salen de las constantes de la página; N/D es null; tmin/tmax de consola; lluvia del día', { skip: sinFix }, () => {
  const p = parsearMapa(obj('bcp', '2026-11-15', '1607').partes.mapa.cuerpo);
  assert.equal(p.estaciones.length, 40, 'las 40 habilitadas (las 15 viejas no)');
  const g = p.lecturas.find((l) => l.id === '1');
  assert.deepEqual([g.local, g.v.temp, g.v.tmin, g.v.tmax, g.v.lluvia_acum], ['2026-11-15T13:07', 18.6, 12.4, 19.5, 0.3]);
  assert.equal(g.v.x.hum, null, 'N/D');
  assert.equal(g.v.hum, undefined, 'la humedad de la Bolsa no se usa (sólo al crudo)');
  assert.equal(p.estaciones.find((e) => e.estacion_id === '1').nombre, 'Grumbein');
  const f = filaDia(controlar([{ local: g.local, v: g.v }]), '2026-11-15', fuente('bcp').redes.BCP_RT);
  assert.deepEqual([f.tmin_c, f.tmax_c, f.lluvia_mm, f.muestreo_min, f.lluvia_origen], [12.4, 19.5, 0.3, null, 'acumulado_consola']);
  /* control negativo: si la página deja de declarar los casilleros, se rechaza (no se lee por posición) */
  assert.throws(() => parsearMapa(obj('bcp', '2026-11-15', '1607').partes.mapa.cuerpo.replace(/iSensorPpDia\s*=\s*10/, 'iSensorOtro = 10')), /no declara iSensorPpDia/);
});

test('Entre Ríos: el downld08 como lo guarda la ronda (Máx./Mín. con \\uFFFD) se lee por cabecera; el 404 se salta', { skip: sinFix }, () => {
  const o = obj('entrerios', '2026-11-15', '1542');
  assert.ok(o.partes.parana.cuerpo.includes('\uFFFD'), 'el fixture tiene que traer la pérdida de r.text()');
  const p = parsearDavis(o.partes.parana.cuerpo);
  assert.deepEqual(p.columnas.slice(2, 5), ['temp. ext.', 'temp. m?x.', 'temp. m?n.']);
  assert.equal(p.paso, 10);
  const r = juntar(fuente('entrerios'), [o]).porRed.get('ER_HIDRAULICA');
  assert.deepEqual([...r.estaciones.keys()], ['parana'], 'bovril dio 404');
  assert.equal(juntar(fuente('entrerios'), [o]).problemas, 0, 'el 404 ni se intenta leer');
  const d9 = filasEstacion({ nuevas: r.lecturas, cfg: { ...fuente('entrerios').redes.ER_HIDRAULICA, pasoMin: 10 }, ahoraLocal: '2026-11-15T13:10' }).filas.find((f) => f.fecha === '2026-11-09');
  assert.equal(d9.registros_validos, 144); assert.equal(d9.muestreo_min, null); assert.equal(d9.lluvia_mm, 0);
  assert.ok(d9.tmin_c < d9.tmax_c);
});

test('INA: temperatura y humedad a INA_METEO (misma fila por estación), la lluvia de 9 a 9 a INA_ALERTA; HR 0 y la de hace 14 h afuera', { skip: sinFix }, () => {
  const j = juntar(fuente('ina'), [obj('ina', '2026-11-15', '1600')]);
  const m = j.porRed.get('INA_METEO'), a = j.porRed.get('INA_ALERTA');
  assert.equal(m.descartadas, 1, 'la del 14/11 20Z es de hace más de 12 h');
  assert.equal(m.lecturas.length, 6);
  assert.ok(m.lecturas.every((l) => l.id === '2115'), 'estacion_id = la estación, no la serie');
  const f = filasEstacion({ nuevas: m.lecturas, cfg: fuente('ina').redes.INA_METEO, ahoraLocal: '2026-11-15T13:10' }).filas[0];
  assert.equal(f.tmin_c, 23); assert.equal(f.tmax_c, 25.5);
  assert.ok(!f.crudo.lecturas.some((l) => l.hum === 0 && !l.m?.includes('hum_fuera_de_rango')), 'HR 0 tiene que quedar marcada');
  const lluvia = a.diarias.flatMap((d) => d.obs.map((o) => [d.id, o.fecha, o.lluvia_mm]));
  assert.ok(lluvia.some(([id, fecha]) => id === '2115' && fecha === '2026-11-10'), '12Z del 10/11 = 09:00 local → día 10');
  const filas = fuente('ina').redes.INA_ALERTA.armar({ nuevas: a.diarias.filter((d) => d.id === '2115').flatMap((d) => d.obs) });
  assert.ok(filas.every((x) => x.hora_corte === '09:00' && x.horas_validas === 24));
  /* un total de lluvia que no arranca a las 09:00 local no es el de 9 a 9: no entra */
  const o2 = obj('ina', '2026-11-15', '1600');
  o2.partes.obs_0 = { status: 200, tipo: 'application/json', cuerpo: JSON.stringify([{ series_id: 31971, timestart: '2026-11-14T15:00:00.000Z', timeend: '2026-11-15T15:00:00.000Z', valor: 5 }]) };
  assert.equal(juntar(fuente('ina'), [o2]).porRed.get('INA_ALERTA').diarias.length, 0);
  /* control negativo: lo mismo otra vez no se reescribe */
  assert.equal(fuente('ina').redes.INA_ALERTA.armar({ nuevas: a.diarias.filter((d) => d.id === '2115').flatMap((d) => d.obs), viejas: filas.map((x) => ({ fecha: x.fecha, crudo: x.crudo })) }).length, 0);
});

test('SIGA (sintético): sólo automáticas válidas; catálogo aunque no haya lectura; un formato que no es lista se rechaza', { skip: sinFix }, () => {
  const p = parsearAutomaticas(obj('siga', '2026-11-15', '1541').partes.estaciones.cuerpo);
  assert.deepEqual(p.estaciones.map((e) => e.estacion_id), ['234', '296']);
  assert.deepEqual(p.lecturas.map((l) => [l.id, l.local, l.v.temp]), [['234', '2026-11-15T12:30', 24.1]]);
  assert.throws(() => parsearAutomaticas('{"error":1}'), /no es un arreglo/);
  assert.throws(() => parsearAutomaticas('[{"x":1}]'), /formato cambiado/);
});

test('imposibles: HR 0 o 255, 50 °C; un 0 de lluvia medido sigue 0 y el faltante es null', () => {
  const c = controlar([{ local: '2026-11-15T10:00', v: { temp: 50, hum: 0 } }, { local: '2026-11-15T11:00', v: { temp: 20, hum: 255 } }]);
  assert.deepEqual([c[0].ok.temp, c[0].ok.hum, c[1].ok.hum, c[1].ok.temp], [null, null, null, 20]);
  assert.equal(numero('0.00'), 0); assert.equal(numero('N/D'), null); assert.equal(numero('---'), null);
});

test('en seco: no se conecta a ninguna base, y el log imprime SÓLO cantidades (el registro de Actions es público)', { skip: sinFix }, async () => {
  const lineas = [];
  let conecto = false;
  const r = await correr({ almacen: almacenCarpeta(R2), ahora: AHORA, seco: true, conectar: () => { conecto = true; }, log: (x) => lineas.push(x) });
  assert.equal(conecto, false); assert.equal(r.ok, true);
  assert.ok(r.total.eeaoc.filas_escritas > 20 && r.total.ina.filas_escritas > 0 && r.total.bcp.filas_escritas > 20);
  const log = lineas.join('\n');
  for (const x of ['Grumbein', 'Bajastine', 'parana', '-38.75', '2115', 'Agua Amarga']) assert.ok(!log.includes(x), 'el log trae ' + x);
  /* control negativo: fuera de la ventana de horas no lee nada */
  const r2 = await correr({ almacen: almacenCarpeta(R2), ahora: AHORA + 10 * 3600e3, seco: true, log: nada });
  assert.equal(r2.total.eeaoc.rondas, 0);
});

/* ── contra PGlite ── */
const DIR_PGLITE = process.env.HN_PGLITE || '';
const MIG = {
  m0110: process.env.HN_MIG_0110 || 'C:/HN-AGRO/hn-agro/migrations/0110_estaciones_comun.sql',
  m0147: path.join(REPO, 'sipan-alto-valle', 'migracion', '0147_estaciones_noche_y_muestreo.sql'),
  m0147b: path.join(REPO, 'sipan-alto-valle', 'migracion', '0147b_rol_colector_estaciones.sql'),
};
const saltoPg = (!(DIR_PGLITE && fs.existsSync(path.join(DIR_PGLITE, 'dist', 'index.js'))) && 'sin HN_PGLITE') || (!Object.values(MIG).every((p) => fs.existsSync(p)) && 'sin las migraciones 0110/0147/0147b');
async function pgNueva() {
  const { PGlite } = await import(pathToFileURL(path.join(DIR_PGLITE, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table registro_procesos (id bigserial primary key, proceso text not null, ok boolean, resumen jsonb, creado_at timestamptz default now());
    alter table registro_procesos enable row level security;`);
  await pg.exec(fs.readFileSync(MIG.m0110, 'utf8'));
  await pg.exec(fs.readFileSync(MIG.m0147, 'utf8'));
  return pg;
}
const REDES = ['BCP_RT', 'DACC_MZA', 'EEAOC', 'ER_HIDRAULICA', 'INA_ALERTA', 'INA_METEO', 'REM_SL', 'SIGA_RT'];

test('guardado (PGlite, 0110 + 0147): las 8 redes pasan los CHECK, mostrar=false forzado, idempotente', { skip: saltoPg || sinFix }, async () => {
  const pg = await pgNueva();
  const ej = ejecutorPglite(pg);
  await pg.exec(`insert into estaciones (red, estacion_id, metadatos) values ('DACC_MZA', '5', '{"mostrar": true, "nota": "vieja"}')`);
  const r = await correr({ almacen: almacenCarpeta(R2), ejecutor: ej, ahora: AHORA, log: nada });
  assert.equal(r.ok, true, JSON.stringify(r.total));
  const foto = async () => (await pg.query(`select red, count(*)::int n, md5(string_agg(estacion_id || fecha || coalesce(tmin_c::text,'') || coalesce(lluvia_mm::text,'') || (crudo->>'firma'), ',' order by estacion_id, fecha)) h
    from estaciones_obs group by red order by red`)).rows;
  const antes = await foto();
  assert.deepEqual(antes.map((x) => x.red), REDES);
  /* idempotente: la misma corrida otra vez no escribe nada */
  const r2 = await correr({ almacen: almacenCarpeta(R2), ejecutor: ej, ahora: AHORA + 60e3, log: nada });
  assert.ok(Object.values(r2.total).every((t) => t.filas_escritas === 0 && t.estaciones_nuevas === 0), JSON.stringify(r2.total));
  assert.deepEqual(await foto(), antes);
  const m = (await pg.query(`select count(*) filter (where (metadatos->>'mostrar')::boolean is distinct from false)::int abiertas from estaciones`)).rows[0];
  assert.equal(m.abiertas, 0);
  const vieja = (await pg.query(`select metadatos from estaciones where red = 'DACC_MZA' and estacion_id = '5'`)).rows[0].metadatos;
  assert.equal(vieja.mostrar, false); assert.equal(vieja.nota, 'vieja');
  const ina = (await pg.query(`select hora_corte::text h, horas_validas v from estaciones_obs where red = 'INA_ALERTA' limit 1`)).rows[0];
  assert.deepEqual(ina, { h: '09:00:00', v: 24 });
  assert.equal((await pg.query(`select count(*)::int n from registro_procesos`)).rows[0].n, 14, 'un renglón por fuente y corrida');
  await pg.close();
});

test('0152 (PGlite): con la 0147b sola el rol NO escribe las internas; con la 0152 sí; SNIH sigue cerrada; idempotente', { skip: saltoPg }, async () => {
  const pg = await pgNueva();
  await pg.exec('create role colector_estaciones nologin;');
  const t = fs.readFileSync(MIG.m0147b, 'utf8').replace(/\r\n/g, '\n');
  await pg.exec(t.slice(t.indexOf('grant usage on schema public to colector_estaciones;'), t.indexOf('-- (Una política «for all» no da DELETE')));
  const como = async (sql) => { try { await pg.exec(`set role colector_estaciones; ${sql}; reset role;`); return true; } catch (e) { await pg.exec('reset role;'); return String(e.message); } };
  assert.match(String(await como(`insert into estaciones (red, estacion_id) values ('BCP_RT', 'X')`)), /row-level security/);
  const M = fs.readFileSync(path.join(DIR, '..', 'migracion', '0152_parseo_estaciones_unificada_PROPUESTA.sql'), 'utf8');
  await pg.exec(M); await pg.exec(M);
  for (const red of REDES) assert.equal(await como(`insert into estaciones (red, estacion_id) values ('${red}', 'X'); insert into estaciones_obs (red, estacion_id, fecha, crudo) values ('${red}', 'X', '2026-11-16', '{}')`), true, red);
  assert.equal(await como("insert into estaciones (red, estacion_id) values ('WEATHERCLOUD_PUB', 'X'); insert into estaciones_ultima_lectura (red, estacion_id, instante) values ('WEATHERCLOUD_PUB', 'X', now())"), true, 'la parte de la 138b');
  for (const p of [...FUENTES.map((f) => f.proceso), 'estaciones_privadas_parseo']) assert.equal(await como(`insert into registro_procesos (proceso, ok) values ('${p}', true)`), true, p);
  /* control negativo */
  assert.match(String(await como(`insert into estaciones (red, estacion_id) values ('SNIH', 'X')`)), /row-level security/);
  assert.match(String(await como(`insert into registro_procesos (proceso, ok) values ('otro', true)`)), /row-level security/);
  await pg.close();
});
