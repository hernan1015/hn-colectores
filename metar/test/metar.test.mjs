// Tests del colector de METAR (317). Sin red: la API de mentira y el almacén en una carpeta temporal.
// Correr: npm test (dentro de metar/). El control negativo contado está en control-negativo.mjs.
// Los ejemplos REALES: test/datos/actual_20261117T0257Z.json (las 93 estaciones, últimas 2 h, 17/11 02:57 UTC) y
// test/datos/historia_20261116_14-24Z.json (13 estaciones de Cuyo y Córdoba, 16/11 14-24 UTC): respuestas tal cual de
// aviationweather.gov/api/data/metar (dato público de NOAA), bajadas una vez con el UA hn-colector/1.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = process.env.METAR_LIB || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const imp = (f) => import(new URL('file:///' + path.join(LIB, f).replace(/\\/g, '/')).href);
const M = await imp('metar.mjs');
const C = await imp('colector.mjs');
const E = await imp('estaciones.mjs');
const V = await imp('validacion.mjs');
const { almacenCarpeta } = await import('../../rayos-hora/lib/almacen.mjs');

const DATOS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos');
const dato = (f) => JSON.parse(fs.readFileSync(path.join(DATOS, f), 'utf8'));
const ACTUAL = dato('actual_20261117T0257Z.json');
const HIST = dato('historia_20261116_14-24Z.json');
const TMP = process.env.METAR_TMP || os.tmpdir();
let n = 0;
const carpeta = () => { const d = path.join(TMP, `metar-test-${process.pid}-${n++}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const callado = () => {};
const sinEspera = async () => {};

/** la API de mentira: responde lo que diga `fn(url)` → { status, cuerpo } y anota cada pedido */
function api(fn) {
  const pedidos = [];
  const f = async (url, init) => {
    pedidos.push({ url, ua: init?.headers?.['user-agent'] });
    const r = await fn(url, pedidos.length);
    if (r instanceof Error) throw r;
    const texto = typeof r.cuerpo === 'string' ? r.cuerpo : JSON.stringify(r.cuerpo ?? []);
    return { status: r.status ?? 200, text: async () => texto };
  };
  f.pedidos = pedidos;
  return f;
}
/** un almacén que cuenta lecturas y escrituras */
function contado(alm) {
  const c = { leer: 0, escribir: 0, listar: 0, claves: [] };
  return { c, leer: (k) => { c.leer++; return alm.leer(k); }, escribir: (k, b, o) => { c.escribir++; c.claves.push(k); return alm.escribir(k, b, o); }, listar: (p) => { c.listar++; return alm.listar(p); } };
}
const leerJ = async (alm, k) => JSON.parse((await alm.leer(k)).toString('utf8'));
const AHORA = Date.parse('2026-11-17T02:57:59Z');
const correr = (o) => C.correr({ llave: 'si', ahoraMs: AHORA, esperar: sinEspera, log: callado, ...o });
const parte = (raw, extra = {}) => {
  const p = M.parsear(raw);
  const d = new Date(Date.UTC(2026, 10, p.dia, p.hora, p.minuto));
  return { icaoId: p.estacion, rawOb: raw, reportTime: d.toISOString(), metarType: p.tipo || 'METAR', ...extra };
};

// ───────────────────────── el parser ─────────────────────────
test('parser: GR en el tiempo presente (real: Río Cuarto, 16/11 18:25 UTC, «+TSSHGRRA»)', () => {
  const p = M.parsear('SPECI SAOC 161825Z 23035G45KT 0400 +TSSHGRRA BKN030 FEW045CB 20/18 Q1003');
  assert.equal(p.ok, true);
  assert.equal(p.tipo, 'SPECI'); assert.equal(p.estacion, 'SAOC'); assert.equal(p.dia, 16); assert.equal(p.hora, 18); assert.equal(p.minuto, 25);
  assert.deepEqual(p.presente[0], { grupo: '+TSSHGRRA', intensidad: '+', descriptores: ['TS', 'SH'], fenomenos: ['GR', 'RA'] });
  assert.equal(p.granizo.observado, true); assert.equal(p.granizo.intenso, true); assert.equal(p.granizo.con_tormenta, true);
  assert.deepEqual(p.granizo.tipos, ['GR']);
  // control negativo: el parte anterior de la misma estación (18:20, «+TSRA») no tiene granizo
  const q = M.parsear('SPECI SAOC 161820Z 18022G45KT +TSRA FEW006 BKN030 FEW045CB 20/17 Q1003');
  assert.equal(q.granizo.alguno, false); assert.equal(q.granizo.tormenta, true);
});

test('parser: «+TSGR», «TSGR», «SHGS», «-GS» y «GS»: granizo y granizo pequeño', () => {
  const g = (w) => M.parsear(`METAR SACO 161800Z 18010KT 3000 ${w} BKN030CB 20/18 Q1005`).granizo;
  assert.equal(g('+TSGR').observado, true); assert.deepEqual(g('+TSGR').tipos, ['GR']); assert.equal(g('+TSGR').intenso, true);
  assert.equal(g('TSGR').intenso, false);
  assert.deepEqual(g('SHGS').tipos, ['GS']); assert.deepEqual(g('-GS').tipos, ['GS']); assert.deepEqual(g('TSGRGS').tipos, ['GR', 'GS']);
  assert.equal(g('+TSRAGR').observado, true, 'el GR después de RA también cuenta');
  // control negativo: lluvia, llovizna, nieve, polvo y tornado no son granizo
  for (const w of ['+TSRA', '-DZ', 'SN', 'BLDU', '+FC', 'TS', 'RA BR']) assert.equal(g(w).alguno, false, w);
});

test('parser: REGR (granizo reciente, real: Río Cuarto 16/11 18:45 UTC) y «RE TSRA» con espacio (real: San Luis)', () => {
  const p = M.parsear('SPECI SAOC 161845Z 17018G28KT 3000 +TSRA BKN030 FEW045CB 20/18 Q1004 REGR');
  assert.equal(p.granizo.observado, false); assert.equal(p.granizo.reciente, true); assert.deepEqual(p.granizo.grupos, ['REGR']);
  const q = M.parsear('SPECI SAOU COR 161835Z 11019G32KT 9999 BKN030 FEW045CB 20/18 Q1007 RE TSRA');
  assert.equal(q.cor, true, 'COR después de la estación (como lo manda el SMN)');
  assert.equal(q.reciente[0].grupo, 'RE TSRA'); assert.equal(q.granizo.alguno, false);
  // control negativo: RETS / RERA no son granizo
  assert.equal(M.parsear('METAR SAZG 161500Z 14006KT 2000 -RA BR BKN007 FEW048CB OVC056 18/18 Q1007 RETS').granizo.alguno, false);
});

test('parser: VCTS es tormenta en las cercanías, no granizo (real: San Rafael 16/11 16 UTC)', () => {
  const p = M.parsear('METAR SAMR 161600Z 14016KT 9999 VCTS SCT035 FEW040CB 24/15 Q1009');
  assert.equal(p.granizo.tormenta_cerca, true); assert.equal(p.granizo.tormenta, false); assert.equal(p.granizo.alguno, false);
  // control negativo: un «VCGR» inventado no cuenta como granizo en la estación (VC = cercanías)
  assert.equal(M.parsear('METAR SAMR 161600Z 14016KT 9999 VCSH SCT035 24/15 Q1009').granizo.alguno, false);
  assert.equal(M.parsear('METAR SAMR 161600Z 14016KT 9999 VCSHGR SCT035 24/15 Q1009').granizo.alguno, false);
});

test('parser: la tendencia (BECMG/TEMPO) es pronóstico: un TSGR ahí NO es granizo observado (real: Córdoba 16/11 22 UTC)', () => {
  const real = M.parsear('METAR SACO 162200Z 26007KT 210V300 8000 SCT040 26/21 Q1004 BECMG 18015KT 6000 TSRA BKN025 FEW040CB');
  assert.equal(real.granizo.tormenta, false, 'la TSRA de la tendencia no es la de ahora');
  assert.match(real.tendencia, /^BECMG 18015KT 6000 TSRA/);
  const t = M.parsear('METAR SACO 162200Z 26007KT 8000 SCT040 26/21 Q1004 TEMPO 2000 TSGR');
  assert.equal(t.granizo.alguno, false);
  // control negativo: el mismo grupo ANTES de la tendencia sí cuenta
  assert.equal(M.parsear('METAR SACO 162200Z 26007KT 2000 TSGR SCT040 26/21 Q1004 TEMPO 8000 NSW').granizo.observado, true);
});

test('parser: RMK — el ejemplo de la documentación de la API y el granizo al estilo FMH-1 (GR 1 3/4, GRB37E46)', () => {
  // el ejemplo de rawOb de la OpenAPI de aviationweather.gov (components/schemas METARproperties.rawOb)
  const k = M.parsear('KORD 032151Z 23006KT 10SM BKN110 OVC250 14/03 A3000 RMK AO2 SLP162 VIRGA OHD T01440028');
  assert.equal(k.ok, true); assert.equal(k.tipo, null); assert.equal(k.rmk, 'AO2 SLP162 VIRGA OHD T01440028');
  assert.equal(k.granizo.alguno, false);
  // FMH-1 cap. 12 (observaciones): tamaño de la piedra «GR 1 3/4» y «GR LESS THAN 1/4»; comienzo y fin «GRB37E46», «RAB05E30SNB20E55»
  assert.deepEqual(M.granizoEnRmk('AO2 GR 1 3/4')[0], { fenomeno: 'GR', texto: 'GR 1 3/4', tamano_pulgadas: 1.75, tamano_mm: 44.5, menor_que: false });
  assert.equal(M.granizoEnRmk('GR LESS THAN 1/4')[0].menor_que, true);
  assert.equal(M.granizoEnRmk('GR 3/4')[0].tamano_mm, 19.1);
  assert.deepEqual(M.granizoEnRmk('TSB30 GRB37E46')[0].tiempos, [{ que: 'empezo', minuto: '37' }, { que: 'termino', minuto: '46' }]);
  const r = M.parsear('METAR KXYZ 011755Z 27015KT 2SM -TSRA BKN020CB 22/18 A2990 RMK AO2 GRB37E46');
  assert.equal(r.granizo.observado, false); assert.equal(r.granizo.en_rmk, true); assert.equal(r.granizo.alguno, true);
  // control negativo: «RAB05E30SNB20E55» (lluvia y nieve) y «CB OBS TO W» no son granizo; el RMK pegado (real, SAMR) se separa
  assert.deepEqual(M.granizoEnRmk('RAB05E30SNB20E55'), []);
  const s = M.parsear('METAR SAMR 161700Z 18008KT 9999 -TSRA BKN025 FEW040CB 20/15 Q1009RMK CB OBS TO W');
  assert.equal(s.rmk, 'CB OBS TO W'); assert.equal(s.granizo.alguno, false);
});

test('parser: los CB de las nubes y otros grupos no se confunden con tiempo presente', () => {
  const p = M.parsear('METAR SAAR 170200Z 22032G46KT 1500 +TSRA BKN013 SCT045CB 18/17 Q1006');
  assert.deepEqual(p.presente.map((g) => g.grupo), ['+TSRA']);
  for (const tok of ['SCT045CB', 'CAVOK', 'NSC', 'NSW', 'Q1006', 'R20/0900N', 'SQ1', 'GRASS', 'SNOW', 'BRKN']) assert.equal(M.grupoTiempo(tok), null, tok);
  assert.ok(M.grupoTiempo('SQ'), 'SQ (turbonada) sí es un grupo');
  // control negativo: un parte roto no tira, sale ok:false con su motivo
  assert.equal(M.parsear('').ok, false);
  assert.equal(M.parsear('METAR SAOC 162599Z 0000KT').motivo, 'hora imposible');
  assert.equal(M.parsear('METAR 12 161800Z').motivo, 'sin estación OACI');
});

test('parser: TODOS los partes reales de los fixtures se entienden, y el único con granizo es el de Río Cuarto', () => {
  const todos = [...ACTUAL, ...HIST];
  assert.equal(todos.length, 94 + 119);
  for (const e of todos) assert.equal(M.parsear(e.rawOb).ok, true, e.rawOb);
  const con = todos.filter((e) => M.parsear(e.rawOb).granizo.alguno).map((e) => e.rawOb);
  assert.deepEqual(con.sort(), ['SPECI SAOC 161825Z 23035G45KT 0400 +TSSHGRRA BKN030 FEW045CB 20/18 Q1003', 'SPECI SAOC 161845Z 17018G28KT 3000 +TSRA BKN030 FEW045CB 20/18 Q1004 REGR']);
  // la API trae su propio wxString: el granizo presente coincide con el nuestro en los 213 partes
  for (const e of todos) assert.equal(/GR|GS/.test(e.wxString || ''), M.parsear(e.rawOb).granizo.observado, e.rawOb);
  // control negativo: el decodificador de la API toma «RE TSRA» (San Luis, 18:40) como tormenta PRESENTE («TSRA»); el nuestro, como reciente
  const sl = todos.find((e) => e.rawOb.startsWith('SPECI SAOU 161840Z'));
  assert.equal(sl.wxString, 'TSRA');
  assert.equal(M.parsear(sl.rawOb).granizo.tormenta, false);
});

test('horaParte: el mes sale de la referencia; un día 31 con referencia del 1.º es del mes anterior', () => {
  const p = M.parsear('METAR SAEZ 312300Z 18010KT CAVOK 20/10 Q1015');
  assert.equal(new Date(M.horaParte(p, Date.parse('2026-11-01T00:10:00Z'))).toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal(new Date(M.horaParte(M.parsear('METAR SAEZ 161800Z 18010KT CAVOK 20/10 Q1015'), Date.parse('2026-11-16T18:00:00Z'))).toISOString(), '2026-11-16T18:00:00.000Z');
  // control negativo: un 31 en un mes de 30 días no existe
  assert.equal(M.horaParte(p, Date.parse('2026-12-01T00:10:00Z')), null);
});

// ───────────────────────── estaciones y pedido ─────────────────────────
test('estaciones: las 93 de la lista de NOAA (SA*, AR), con Río Cuarto, Mendoza y Ushuaia; sin Marambio', () => {
  assert.equal(E.ESTACIONES.length, 93);
  for (const e of E.ESTACIONES) { assert.match(e.id, /^SA[A-Z]{2}$/); assert.ok(e.lat < -21 && e.lat > -56 && e.lon < -53 && e.lon > -73.6, e.id); }
  assert.deepEqual([E.POR_ID.SAOC.lat, E.POR_ID.SAOC.lon], [-33.095, -64.273]);
  assert.ok(E.POR_ID.SAME && E.POR_ID.SAWH);
  assert.equal(E.POR_ID.SAWB, undefined, 'Marambio (AQ) queda afuera');
  assert.equal(new Set(E.IDS).size, 93);
});

test('el pedido: UNO con las 93 estaciones juntas, JSON, 3 h; el relleno con la hora final; el UA de cortesía', async () => {
  const u = C.urlMetar(E.IDS);
  assert.match(u, /^https:\/\/aviationweather\.gov\/api\/data\/metar\?ids=SAAC,SAAG,/);
  assert.equal(new URL(u).searchParams.get('ids').split(',').length, 93);
  assert.equal(new URL(u).searchParams.get('format'), 'json');
  assert.equal(new URL(u).searchParams.get('hours'), '3');
  assert.equal(new URL(C.urlMetar(['SAOC'], { horas: 3, hastaMs: Date.parse('2026-11-16T21:00:00Z') })).searchParams.get('date'), '20261116_2100');
  const f = api(() => ({ cuerpo: ACTUAL }));
  const r = await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: f });
  assert.equal(r.pedidos, 1);
  assert.equal(f.pedidos.length, 1);
  assert.equal(f.pedidos[0].ua, 'hn-colector/1.0');
  // control negativo: la URL de prueba es la que se usó a mano el 17/11 (sin date en una corrida normal)
  assert.equal(new URL(f.pedidos[0].url).searchParams.get('date'), null);
});

// ───────────────────────── el colector ─────────────────────────
test('guarda cada parte una vez, con su clave por estación y hora del PARTE; el índice del día lo lista', async () => {
  const alm = almacenCarpeta(carpeta());
  const r = await correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: ACTUAL })) });
  assert.equal(r.estado, 'ok');
  assert.equal(r.partes_api, 94);
  assert.equal(r.guardados, 94); assert.equal(r.descartados, 0);
  const ind = await leerJ(alm, 'metar/2026/11/17/indice.json');
  assert.equal(Object.keys(ind.obs).length, 94);
  const saar = Object.values(ind.obs).find((o) => o.estacion === 'SAAR' && o.hora === '2026-11-17T02:51:00Z');
  assert.match(saar.clave, /^metar\/2026\/11\/17\/SAAR\/0251-SPECI-[0-9a-f]{8}\.json$/);
  const sobre = await leerJ(alm, saar.clave);
  assert.equal(sobre.crudo, 'SPECI SAAR 170251Z 20020KT 9000 -TSRA BKN013 FEW045CB 18/17 Q1004');
  assert.equal(sobre.fuente, 'METAR · aviationweather.gov (NOAA)');
  assert.equal(sobre.api.icaoId, 'SAAR', 'el crudo de la API va entero');
  assert.equal(sobre.parseado.granizo.tormenta, true);
  // control negativo: el parte de las 23:xx del 16 va al índice del 16, no al de la corrida
  const r2 = await correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: [parte('METAR SAEZ 162300Z 18010KT CAVOK 20/10 Q1015')] })) });
  assert.equal(r2.guardados, 1);
  assert.ok(Object.values((await leerJ(alm, 'metar/2026/11/16/indice.json')).obs).some((o) => o.estacion === 'SAEZ'));
});

test('IDEMPOTENCIA: correr dos veces con lo mismo no escribe ningún parte nuevo; un COR sí es otro parte', async () => {
  const alm = contado(almacenCarpeta(carpeta()));
  await correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: ACTUAL })) });
  const antes = alm.c.escribir;
  const r = await correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: ACTUAL })) });
  assert.equal(r.guardados, 0); assert.equal(r.repetidos, 94);
  assert.equal(alm.c.claves.slice(antes).filter((k) => !/indice\.json$/.test(k)).length, 0, 'ni un parte reescrito');
  // control negativo: la corrección (COR) del mismo parte es otro texto → otra clave, y se guarda
  const cor = parte('METAR SAAV 170200Z COR 15011KT 120V180 5000 -TSRA SCT017 FEW050CB OVC050 19/19 Q1006');
  const orig = ACTUAL.find((e) => e.icaoId === 'SAAV' && /170200Z/.test(e.rawOb));
  assert.ok(orig);
  const r3 = await correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: [cor, { ...cor, rawOb: cor.rawOb.replace(' COR', '') }] })) });
  assert.equal(r3.guardados + r3.repetidos, 2);
  assert.ok(r3.guardados >= 1);
});

test('IDEMPOTENCIA tras un corte: el parte que quedó escrito sin índice se adopta (no se reescribe)', async () => {
  const alm = almacenCarpeta(carpeta());
  const e = parte('SPECI SAOC 161825Z 23035G45KT 0400 +TSSHGRRA BKN030 FEW045CB 20/18 Q1003');
  const x = C.normalizar(e);
  await alm.escribir(C.claveParte(x.est, x.tipo, x.ms, x.crudo), '{"dejado":"por una corrida cortada"}');
  const r = await C.correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: [e] })), llave: 'si', ahoraMs: Date.parse('2026-11-16T19:00:00Z'), esperar: sinEspera, log: callado });
  assert.equal(r.recuperados, 1); assert.equal(r.guardados, 0);
  const ind = await leerJ(alm, 'metar/2026/11/16/indice.json');
  assert.equal(Object.values(ind.obs)[0].granizo.observado, true);
  assert.equal(Object.values(ind.obs)[0].crudo, e.rawOb, 'el índice lleva el crudo de los partes con granizo');
});

test('FALTANTES: por hora cerrada, la estación sin parte es «sin dato»; un parte que llega tarde la pasa a «con dato»', async () => {
  const alm = almacenCarpeta(carpeta());
  const ahora = Date.parse('2026-11-16T21:20:00Z');
  const run = (cuerpo) => C.correr({ almacen: alm, fetchFn: api(() => ({ cuerpo })), llave: 'si', ahoraMs: ahora, esperar: sinEspera, log: callado });
  const r = await run(HIST.filter((e) => e.icaoId !== 'SAOC'));
  assert.deepEqual([...C.horasRevisables(ahora - 3 * 3600e3, ahora, ahora)].map((t) => new Date(t).toISOString().slice(11, 13)), ['19', '20']);
  assert.equal(r.horas_revisadas, 2);
  let ind = await leerJ(alm, 'metar/2026/11/16/indice.json');
  assert.ok(ind.horas['19'].sin_dato.includes('SAOC'));
  assert.ok(ind.horas['19'].con_dato.includes('SAOU'));
  assert.equal(ind.horas['19'].con_dato.length + ind.horas['19'].sin_dato.length, 93);
  assert.equal(r.faltantes, ind.horas['19'].sin_dato.length + ind.horas['20'].sin_dato.length);
  // llega el de Río Cuarto
  await run(HIST.filter((e) => e.icaoId === 'SAOC'));
  ind = await leerJ(alm, 'metar/2026/11/16/indice.json');
  assert.ok(ind.horas['19'].con_dato.includes('SAOC'));
  assert.ok(!ind.horas['19'].sin_dato.includes('SAOC'));
  // control negativo: una corrida vacía no le saca el dato a nadie, y la hora en curso (21) no se revisa
  await run([]);
  ind = await leerJ(alm, 'metar/2026/11/16/indice.json');
  assert.ok(ind.horas['19'].con_dato.includes('SAOC'));
  assert.equal(ind.horas['21'], undefined);
});

test('descartados: otra estación, otro país, sin texto o con la hora cruzada no se guardan', async () => {
  assert.match(C.normalizar({ icaoId: 'SCEL', rawOb: 'METAR SCEL 161800Z 18010KT CAVOK 20/10 Q1015', reportTime: '2026-11-16T18:00:00Z' }).descartado, /fuera de la lista/);
  assert.match(C.normalizar({ icaoId: 'SAOC', rawOb: 'METAR SACO 161800Z 18010KT CAVOK 20/10 Q1015', reportTime: '2026-11-16T18:00:00Z' }).descartado, /otra estación/);
  assert.match(C.normalizar({ icaoId: 'SAOC', rawOb: 'METAR SAOC 161800Z 18010KT CAVOK 20/10 Q1015', reportTime: '2026-11-16T21:00:00Z' }).descartado, /no coincide/);
  assert.match(C.normalizar({ icaoId: 'SAOC', rawOb: '', reportTime: '2026-11-16T18:00:00Z' }).descartado, /sin texto/);
  // control: el bueno pasa
  assert.equal(C.normalizar({ icaoId: 'SAOC', rawOb: 'METAR SAOC 161800Z 18010KT CAVOK 20/10 Q1015', reportTime: '2026-11-16T18:00:00Z' }).est, 'SAOC');
});

test('TOPE de la API (400): se parte la lista en dos; sin lugar en el tope queda TRUNCADO y no se inventan faltantes', async () => {
  const lleno = Array.from({ length: 400 }, (_, i) => parte(`METAR SAEZ 17${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}Z 18010KT CAVOK 20/10 Q1015`));
  const f = api((u, k) => ({ cuerpo: k === 1 ? lleno : ACTUAL.filter((e) => new URL(u).searchParams.get('ids').split(',').includes(e.icaoId)) }));
  const r = await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: f });
  assert.equal(r.pedidos, 3); assert.equal(r.partidos, 1);
  assert.equal(new URL(f.pedidos[1].url).searchParams.get('ids').split(',').length + new URL(f.pedidos[2].url).searchParams.get('ids').split(',').length, 93);
  assert.equal(r.guardados, 94);
  // con tope 1: no se puede partir → truncado, se guarda lo que vino y NO se revisan horas (no hay faltantes falsos)
  const alm = almacenCarpeta(carpeta());
  const r2 = await correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: lleno })), tope: 1 });
  assert.equal(r2.pedidos, 1); assert.equal(r2.truncados, 1); assert.equal(r2.horas_revisadas, 0);
  assert.match((await alm.leer('metar/alertas.txt')).toString(), /tope de 400/);
  // control negativo: con 399 no se parte
  const r3 = await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: api(() => ({ cuerpo: lleno.slice(1) })) });
  assert.equal(r3.pedidos, 1); assert.equal(r3.partidos, 0);
});

test('acotarTope: normal 1 a 10 (3 por defecto), relleno hasta 120 (30 por defecto)', () => {
  assert.equal(C.acotarTope(undefined), 3); assert.equal(C.acotarTope('500'), 10); assert.equal(C.acotarTope('0'), 1);
  assert.equal(C.acotarTope(undefined, 'relleno'), 30); assert.equal(C.acotarTope('999', 'relleno'), 120);
  assert.equal(C.acotarTope('abc'), 3);
});

test('la API caída (500, red, no JSON): se anota, no se guarda NINGÚN parte ni índice y la corrida sale bien', async () => {
  for (const resp of [{ status: 500, cuerpo: 'error' }, new Error('ECONNRESET'), { status: 200, cuerpo: '<html>' }, { status: 200, cuerpo: { error: 'x' } }]) {
    const alm = contado(almacenCarpeta(carpeta()));
    const r = await correr({ almacen: alm, fetchFn: api(() => resp) });
    assert.equal(r.estado, 'api-caida');
    assert.deepEqual(alm.c.claves, ['metar/alertas.txt']);
  }
  // 204 (sin partes) no es caída: es una respuesta vacía, y las horas sí se revisan (todas sin dato)
  const r = await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: api(() => ({ status: 204, cuerpo: '' })) });
  assert.equal(r.estado, 'ok'); assert.equal(r.horas_revisadas, 2); assert.equal(r.faltantes, 2 * 93);
});

test('cortesía: 429 corta y lo anota; la pausa entre pedidos; 3 fallas seguidas cortan el relleno', async () => {
  const alm = almacenCarpeta(carpeta());
  const r = await correr({ almacen: alm, fetchFn: api(() => ({ status: 429 })) });
  assert.equal(r.estado, 'api-caida');
  const esperas = [];
  const lleno = Array.from({ length: 400 }, () => parte('METAR SAEZ 170100Z 18010KT CAVOK 20/10 Q1015'));
  await C.correr({ almacen: almacenCarpeta(carpeta()), fetchFn: api((u, k) => ({ cuerpo: k === 1 ? lleno : [] })), llave: 'si', ahoraMs: AHORA, log: callado, esperar: async (ms) => esperas.push(ms) });
  assert.deepEqual(esperas, [2000, 2000], '2 s entre pedido y pedido');
  const f = api(() => ({ status: 503 }));
  const r2 = await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: f, modo: 'relleno', tope: 50, desdeMs: Date.parse('2026-11-10T00:00:00Z'), hastaMs: Date.parse('2026-11-12T00:00:00Z') });
  assert.equal(f.pedidos.length, 3); assert.equal(r2.estado, 'cortada');
});

test('LA LLAVE: sin METAR_ON=«si» no hay ni un pedido ni una lectura de R2', async () => {
  for (const llave of [undefined, '', 'no', 'SI', 'true', 'si ']) {
    const f = api(() => ({ cuerpo: ACTUAL }));
    const alm = contado(almacenCarpeta(carpeta()));
    const r = await C.correr({ almacen: alm, fetchFn: f, llave, ahoraMs: AHORA, esperar: sinEspera, log: callado });
    assert.equal(r.estado, 'apagado'); assert.equal(f.pedidos.length, 0); assert.equal(alm.c.leer + alm.c.escribir + alm.c.listar, 0);
  }
  // control: con «si», pide
  const f = api(() => ({ cuerpo: ACTUAL }));
  await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: f });
  assert.equal(f.pedidos.length, 1);
});

test('SECO: un pedido y nada guardado (ni alertas)', async () => {
  const alm = contado(almacenCarpeta(carpeta()));
  const r = await correr({ almacen: alm, fetchFn: api(() => ({ cuerpo: ACTUAL })), modo: 'seco' });
  assert.equal(r.estado, 'seco'); assert.equal(r.pedidos, 1); assert.equal(alm.c.escribir, 0);
});

test('RELLENO: tramos de 3 h dentro de los 30 días de la API, del más viejo al más nuevo; lo hecho no se repide', async () => {
  const ahora = Date.parse('2026-11-17T03:00:00Z');
  const t = C.tramosRelleno(Date.parse('2026-11-16T12:00:00Z'), Date.parse('2026-11-17T00:00:00Z'), ahora);
  assert.deepEqual(t.map((x) => new Date(x).toISOString().slice(5, 13)), ['11-16T15', '11-16T18', '11-16T21', '11-17T00']);
  // control negativo: lo de más de 30 días no se pide (el 3/11 ya cae adentro; el 10/10 no)
  assert.equal(C.tramosRelleno(Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-11T00:00:00Z'), ahora).length, 0);
  assert.ok(C.tramosRelleno(Date.parse('2026-11-03T00:00:00Z'), Date.parse('2026-11-04T00:00:00Z'), ahora).length === 8);
  const alm = almacenCarpeta(carpeta());
  const f = api((u) => ({ cuerpo: HIST.filter((e) => { const d = new URL(u).searchParams.get('date'); const fin = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:00:00Z`); const r = Date.parse(e.reportTime); return r > fin - 3 * 3600e3 && r <= fin; }) }));
  const r = await C.correr({ almacen: alm, fetchFn: f, llave: 'si', ahoraMs: ahora, modo: 'relleno', desdeMs: Date.parse('2026-11-16T12:00:00Z'), hastaMs: Date.parse('2026-11-17T00:00:00Z'), esperar: sinEspera, log: callado });
  assert.equal(r.tramos, 4); assert.equal(r.pedidos, 4);
  assert.equal(new URL(f.pedidos[0].url).searchParams.get('date'), '20261116_1500');
  assert.equal(r.con_granizo, 2, 'el granizo de Río Cuarto del 16/11, recuperado por el relleno');
  const prog = await leerJ(alm, 'metar/relleno.json');
  assert.equal(prog.tramos['2026111618'], 'hecho');
  const f2 = api(() => ({ cuerpo: [] }));
  const r2 = await C.correr({ almacen: alm, fetchFn: f2, llave: 'si', ahoraMs: ahora, modo: 'relleno', desdeMs: Date.parse('2026-11-16T12:00:00Z'), hastaMs: Date.parse('2026-11-17T00:00:00Z'), esperar: sinEspera, log: callado });
  assert.equal(f2.pedidos.length, 0); assert.equal(r2.tramos, 0);
});

test('el DERIVADO PÚBLICO para SATCHI: el granizo de las últimas 24 h y la última hora leída de cada estación (null = sin dato)', async () => {
  const alm = almacenCarpeta(carpeta()), pub = almacenCarpeta(carpeta());
  const ahora = Date.parse('2026-11-16T21:20:00Z');
  await C.correr({ almacen: alm, publico: pub, fetchFn: api(() => ({ cuerpo: HIST })), llave: 'si', ahoraMs: ahora, esperar: sinEspera, log: callado });
  const j = await leerJ(pub, 'metar/v1/ultimas.json');
  assert.equal(j.v, 1); assert.equal(j.fuente.texto, 'METAR · aviationweather.gov (NOAA)');
  assert.equal(j.estaciones.length, 93);
  assert.equal(j.estaciones.find((e) => e.id === 'SAOC').ultima, '2026-11-16T21:00:00Z');
  assert.equal(j.estaciones.find((e) => e.id === 'SAWH').ultima, null, 'Ushuaia no estaba en el pedido: sin dato');
  assert.deepEqual(j.granizo.map((g) => [g.estacion, g.hora, g.observado, g.reciente]), [['SAOC', '2026-11-16T18:45:00Z', false, true], ['SAOC', '2026-11-16T18:25:00Z', true, false]]);
  assert.equal(j.granizo[1].crudo, 'SPECI SAOC 161825Z 23035G45KT 0400 +TSSHGRRA BKN030 FEW045CB 20/18 Q1003');
  assert.deepEqual([j.granizo[1].lat, j.granizo[1].lon], [-33.095, -64.273]);
  // control negativo: 30 h después el granizo ya no está (ventana de 24 h) y Río Cuarto queda sin dato
  const k = C.armarPublico([await leerJ(alm, 'metar/2026/11/16/indice.json')], ahora + 30 * 3600e3);
  assert.equal(k.granizo.length, 0); assert.equal(k.estaciones.find((e) => e.id === 'SAOC').ultima, null);
});

// ───────────────────────── la validación del ojo ─────────────────────────
const celda = (lat, lon, destacada, patas) => ({ lat, lon, destacada, patas });
const barr = (iso, celdas, zona = { latMin: -38, latMax: -22, lonMin: -66, lonMax: -56 }) => ({ cuerpo: JSON.stringify({ ok: true, scan_t: iso, zona, celdas }) });

test('validación: Río Cuarto 16/11 contra barridos sintéticos — ACIERTO, PÉRDIDA y SIN DATO, con ±30 min y ≤ 30 km', () => {
  const partes = V.partesDe({ api: HIST });
  assert.equal(partes.filter((p) => p.granizo).length, 2);
  const solo = (b) => V.validar({ partes: partes.filter((p) => p.granizo && p.granizo.observado), barridos: b.map(V.barridoDe) });
  // destacada a ~11 km, 10 min antes → ACIERTO
  assert.equal(solo([barr('2026-11-16T18:15:21Z', [celda(-33.1, -64.15, true, 3)])]).filas[0].resultado, 'ACIERTO');
  // control negativo: la misma a 40 min → PÉRDIDA; a 45 km → PÉRDIDA; con 2 patas → PÉRDIDA
  assert.equal(solo([barr('2026-11-16T17:44:00Z', [celda(-33.1, -64.15, true, 3)])]).filas[0].resultado, 'SIN DATO', 'fuera de ±30 min no hay barrido en la ventana');
  assert.equal(solo([barr('2026-11-16T17:44:00Z', [celda(-33.1, -64.15, true, 3)]), barr('2026-11-16T18:20:21Z', [])]).filas[0].resultado, 'PÉRDIDA');
  assert.equal(solo([barr('2026-11-16T18:20:21Z', [celda(-33.1, -63.79, true, 3)])]).filas[0].resultado, 'PÉRDIDA', '~45 km');
  const dos = solo([barr('2026-11-16T18:20:21Z', [celda(-33.1, -64.15, false, 2)])]).filas[0];
  assert.equal(dos.mejor.patas, 2); assert.equal(dos.resultado, 'PÉRDIDA', '2 patas no es destacada');
  // sin barridos, o con el aeropuerto fuera de la zona del ojo: SIN DATO (nunca pérdida)
  assert.equal(solo([]).filas[0].resultado, 'SIN DATO');
  assert.equal(solo([barr('2026-11-16T18:20:21Z', [], { latMin: -38, latMax: -22, lonMin: -62, lonMax: -56 })]).filas[0].resultado, 'SIN DATO');
});

test('validación: REGR mira la hora anterior; las destacadas cerca de un aeropuerto con parte SIN granizo son «no confirmadas»', () => {
  const partes = V.partesDe({ api: HIST });
  const regr = partes.find((p) => p.granizo && p.granizo.reciente);
  const v = V.ventana(regr);
  assert.equal(new Date(v.desde).toISOString(), '2026-11-16T17:15:00.000Z');
  assert.equal(new Date(v.hasta).toISOString(), '2026-11-16T19:15:00.000Z');
  // control negativo: el presente no se estira
  const pres = partes.find((p) => p.granizo && p.granizo.observado);
  assert.equal(new Date(V.ventana(pres).desde).toISOString(), '2026-11-16T17:55:00.000Z');
  const r = V.validar({ partes, barridos: [V.barridoDe(barr('2026-11-16T21:00:21Z', [celda(-33.3, -66.3, true, 3)], { latMin: -38, latMax: -22, lonMin: -70, lonMax: -56 }))] });
  assert.equal(r.no_confirmadas.length, 1);
  assert.equal(r.no_confirmadas[0].estacion, 'SAOU');
  // control negativo: sin parte de la estación en ±30 min no se cuenta (sin dato del METAR)
  const r2 = V.validar({ partes: partes.filter((p) => p.estacion !== 'SAOU'), barridos: [V.barridoDe(barr('2026-11-16T21:00:21Z', [celda(-33.3, -66.3, true, 3)], { latMin: -38, latMax: -22, lonMin: -70, lonMax: -56 }))] });
  assert.equal(r2.no_confirmadas.length, 0);
});

// ───────────────────────── 2.ª vuelta: n3-317col-1611 y n3-317-1611 (Codex) ─────────────────────────
test('[n3 P2] NIL es «no hubo parte»: se guarda marcado, pero no suma con_dato, ni «ultima», ni «no confirmada»', async () => {
  const alm = almacenCarpeta(carpeta()), pub = almacenCarpeta(carpeta());
  const ahora = Date.parse('2026-11-16T20:15:00Z');
  const nil = parte('METAR SAOC 161900Z NIL');
  assert.equal(C.normalizar(nil).parseado.nil, true);
  await C.correr({ almacen: alm, publico: pub, fetchFn: api(() => ({ cuerpo: [nil] })), llave: 'si', ahoraMs: ahora, esperar: sinEspera, log: callado });
  const ind = await leerJ(alm, 'metar/2026/11/16/indice.json');
  assert.equal(Object.values(ind.obs)[0].nil, true, 'queda para auditar');
  assert.ok(ind.horas['19'].sin_dato.includes('SAOC'));
  assert.equal((await leerJ(pub, 'metar/v1/ultimas.json')).estaciones.find((e) => e.id === 'SAOC').ultima, null);
  const b = [V.barridoDe(barr('2026-11-16T19:00:21Z', [celda(-33.1, -64.2, true, 3)]))];
  assert.equal(V.validar({ partes: V.partesDe({ api: [nil] }), barridos: b }).no_confirmadas.length, 0);
  assert.equal(V.validar({ partes: V.partesDe({ indices: [ind] }), barridos: b }).no_confirmadas.length, 0);
  // control negativo: un parte de verdad sin granizo sí es dato y sí da «no confirmada»
  const ok = parte('METAR SAOC 161900Z 18010KT 9999 SCT040 20/15 Q1010');
  const alm2 = almacenCarpeta(carpeta());
  await C.correr({ almacen: alm2, fetchFn: api(() => ({ cuerpo: [ok] })), llave: 'si', ahoraMs: ahora, esperar: sinEspera, log: callado });
  assert.ok((await leerJ(alm2, 'metar/2026/11/16/indice.json')).horas['19'].con_dato.includes('SAOC'));
  assert.equal(V.validar({ partes: V.partesDe({ api: [ok] }), barridos: b }).no_confirmadas.length, 1);
});

test('[n3 P2] el derivado público dice si la lectura vino COMPLETA (truncada = completo:false) y cuándo se leyó', async () => {
  const lleno = Array.from({ length: 400 }, (_, i) => parte(`METAR SAEZ 17${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}Z 18010KT CAVOK 20/10 Q1015`));
  const pub = almacenCarpeta(carpeta());
  await correr({ almacen: almacenCarpeta(carpeta()), publico: pub, fetchFn: api(() => ({ cuerpo: lleno })), tope: 1 });
  const j = await leerJ(pub, 'metar/v1/ultimas.json');
  assert.equal(j.completo, false); assert.equal(j.leido, '2026-11-17T02:57:59Z');
  // control negativo: una lectura entera es completo:true
  const pub2 = almacenCarpeta(carpeta());
  await correr({ almacen: almacenCarpeta(carpeta()), publico: pub2, fetchFn: api(() => ({ cuerpo: ACTUAL })) });
  assert.equal((await leerJ(pub2, 'metar/v1/ultimas.json')).completo, true);
});

test('[n3 P7] el relleno y la API caída NO reescriben el derivado público (su «leido» envejece)', async () => {
  const pub = contado(almacenCarpeta(carpeta()));
  await C.correr({ almacen: almacenCarpeta(carpeta()), publico: pub, fetchFn: api(() => ({ cuerpo: [] })), llave: 'si', ahoraMs: AHORA, modo: 'relleno', desdeMs: AHORA - 6 * 3600e3, hastaMs: AHORA, esperar: sinEspera, log: callado });
  await correr({ almacen: almacenCarpeta(carpeta()), publico: pub, fetchFn: api(() => ({ status: 500 })) });
  assert.equal(pub.c.escribir, 0);
  // control negativo: una corrida real buena sí lo escribe
  await correr({ almacen: almacenCarpeta(carpeta()), publico: pub, fetchFn: api(() => ({ cuerpo: ACTUAL })) });
  assert.equal(pub.c.escribir, 1);
});

test('[n3 P7] tres 200 que no son una lista JSON seguidos cortan el relleno', async () => {
  const f = api(() => ({ status: 200, cuerpo: '<html>mantenimiento</html>' }));
  const r = await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: f, modo: 'relleno', tope: 50, desdeMs: Date.parse('2026-11-10T00:00:00Z'), hastaMs: Date.parse('2026-11-12T00:00:00Z') });
  assert.equal(f.pedidos.length, 3); assert.equal(r.estado, 'cortada');
  const g = api(() => ({ status: 200, cuerpo: { no: 'lista' } }));
  assert.equal((await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: g, modo: 'relleno', tope: 50, desdeMs: Date.parse('2026-11-10T00:00:00Z'), hastaMs: Date.parse('2026-11-12T00:00:00Z') })).estado, 'cortada');
  // control negativo: dos malas y después buenas no cortan (el contador se reinicia)
  const h = api((u, k) => (k <= 2 ? { status: 200, cuerpo: '<html>' } : { cuerpo: [] }));
  const r3 = await correr({ almacen: almacenCarpeta(carpeta()), fetchFn: h, modo: 'relleno', tope: 50, desdeMs: Date.parse('2026-11-10T00:00:00Z'), hastaMs: Date.parse('2026-11-11T00:00:00Z') });
  assert.equal(r3.estado, 'ok'); assert.equal(h.pedidos.length, 8);
});

test('[n3 P5] validación: un barrido sin información útil para el aeropuerto no da PÉRDIDA (SIN DATO); uno parcial con destacada sí da ACIERTO', () => {
  const partes = V.partesDe({ api: HIST }).filter((p) => p.granizo && p.granizo.observado);
  const parcial = (celdas) => ({ cuerpo: JSON.stringify({ ok: true, parcial: true, scan_t: '2026-11-16T18:20:21Z', zona: { latMin: -38, latMax: -22, lonMin: -66, lonMax: -56 }, celdas }) });
  const r = (b) => V.validar({ partes, barridos: b.map(V.barridoDe) }).filas[0];
  assert.equal(r([parcial([])]).resultado, 'SIN DATO');
  assert.match(r([parcial([])]).motivo, /no sirven/);
  assert.equal(r([parcial([celda(-33.1, -64.15, true, 3)])]).resultado, 'ACIERTO');
  const inc = [{ lat: -33.1, lon: -64.15, patas: null, patas_min: 1, destacada: false, incompleta: true }];
  assert.equal(r([barr('2026-11-16T18:20:21Z', inc)]).resultado, 'SIN DATO', 'completo pero con las celdas cercanas incompletas');
  // control negativo: un barrido completo sin destacadas sí es PÉRDIDA
  assert.equal(r([barr('2026-11-16T18:20:21Z', [celda(-33.1, -64.15, false, 1)])]).resultado, 'PÉRDIDA');
});

test('[n3 P6] el workflow de validación baja las releases del día argentino anterior, del día y del siguiente', () => {
  const y = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'metar-validacion.workflow.yml.txt'), 'utf8');
  assert.match(y, /for r in "\$\(date -u -d "\$d - 1 day" \+%F\)" "\$d" "\$\(date -u -d "\$d \+ 1 day" \+%F\)"; do/);
  // control: un scan del 16/11 01:00 UTC es del 15/11 argentino (la release granizo-2026-11-15)
  assert.equal(new Date(Date.parse('2026-11-16T01:00:00Z') - 3 * 3600e3).toISOString().slice(0, 10), '2026-11-15');
});
