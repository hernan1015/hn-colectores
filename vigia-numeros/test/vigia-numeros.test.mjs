// Tests del vigía de números con respuestas REALES guardadas el 10/11/2026 (test/datos/): la app (precios-granos), el BNA
// (cotizaciones, recortado a las tablas), MAGyP FOB del 10/11 y la pizarra BCR (recortada a los tableros). Sin red.
// node --test vigia-numeros/test/vigia-numeros.test.mjs · control negativo: node vigia-numeros/test/control-negativo.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsearBNA, parsearBCR, numeroAR, URLS } from '../lib/fuentes.mjs';
import { comparar, UMBRALES, textoDe } from '../lib/reglas.mjs';
import { correr } from '../vigia-numeros.mjs';

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos');
const txt = (n) => fs.readFileSync(path.join(D, n), 'utf8');
const APP = JSON.parse(txt('app_precios-granos_2026-11-10.json')), FOB = JSON.parse(txt('magyp_fob_2026-11-10.json'));
const BNA_HTML = txt('bna_cotizaciones_2026-11-10.html'), BCR_HTML = txt('bcr_pizarra_2026-11-10.html');
const BNA = parsearBNA(BNA_HTML), BCR = parsearBCR(BCR_HTML), FOBR = { ok: true, posts: FOB.posts };
const conApp = (cambio) => { const a = JSON.parse(JSON.stringify(APP)); cambio(a); return { ok: true, ...a }; };
const tipos = (r) => r.desvios.map((d) => d.tipo + (d.cultivo ? ':' + d.cultivo : '')).sort();

/* red falsa: cada URL pública devuelve su respuesta guardada (o lo que se le pida) */
function red({ app = JSON.stringify(APP), bna = BNA_HTML, bcr = BCR_HTML, magypPrimaria = 'Error: Could not connect to host', magyp = JSON.stringify(FOB), caidas = [] } = {}) {
  const pedidos = [];
  const f = async (url) => {
    pedidos.push(url);
    const de = url.startsWith(URLS.app) ? 'app' : url.startsWith(URLS.bna) ? 'bna' : url.startsWith(URLS.bcr) ? 'bcr' : url.startsWith(URLS.magyp[0]) ? 'magyp0' : url.startsWith(URLS.magyp[1]) ? 'magyp1' : '?';
    if (caidas.includes(de)) return { ok: false, status: 503, text: async () => '' };
    const cuerpo = { app, bna, bcr, magyp0: magypPrimaria, magyp1: magyp }[de];
    return { ok: cuerpo != null, status: cuerpo != null ? 200 : 404, text: async () => cuerpo || '' };
  };
  f.pedidos = pedidos;
  return f;
}

/* ── los parsers, con la página real ─────────────────────────────────── */
test('BNA: la tabla de DIVISAS (no billetes): 5/11/2026, compra 1536,50, venta 1545,50', () => {
  assert.deepEqual(BNA, { ok: true, fecha: '2026-11-05', compra: 1536.5, venta: 1545.5 });
});
test('BCR: pizarra del 06/11/2026, trigo $313.300 y soja $535.000; maíz «S/C» (el estimado no se usa)', () => {
  assert.equal(BCR.fecha, '2026-11-06');
  assert.equal(BCR.precios.trigo.ars, 313300); assert.equal(BCR.precios.soja.ars, 535000);
  assert.equal(BCR.precios.maiz.sin_cotizacion, true);
});
test('números argentinos', () => { assert.equal(numeroAR('313.300,00'), 313300); assert.equal(numeroAR('1545.5000'), 1545.5); assert.equal(numeroAR('1520,00'), 1520); });

/* ── el día real: todo coincide ──────────────────────────────────────── */
test('⭐ el 10/11 real: las 5 comparaciones se hacen y no hay desvíos', () => {
  const r = comparar({ app: { ok: true, ...APP }, bna: BNA, fob: FOBR, bcr: BCR });
  assert.deepEqual(r.hechas, ['tc', 'fob_trigo', 'fob_soja', 'pizarra_trigo', 'pizarra_soja']);
  assert.deepEqual(r.desvios, []); assert.deepEqual(r.faltan, []);
  assert.ok(r.afuera.some((x) => /A3/.test(x)), 'A3 queda afuera y se dice');
});

/* ── cada desvío, con el caso que caza ───────────────────────────────── */
test('dólar 5 % abajo del BNA → tc_desvio; 1,5 % → no (umbral 2 %)', () => {
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.tc_ars_usd = 1468)), bna: BNA, fob: FOBR, bcr: BCR })), ['tc_desvio']);
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.tc_ars_usd = 1522)), bna: BNA, fob: FOBR, bcr: BCR })), []);
  assert.equal(UMBRALES.tc_desvio_rel, 0.02);
});
test('dólar billete (1570) en vez de divisa: 1,6 % → dentro del umbral (se documenta, no se avisa)', () => {
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.tc_ars_usd = 1570)), bna: BNA, fob: FOBR, bcr: BCR })), []);
});
test('dólar de hace 6 días contra el último del BNA → tc_viejo; de 3 días → no', () => {
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.fecha_tc = '2026-10-30')), bna: BNA, fob: FOBR, bcr: BCR })), ['tc_viejo']);
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.fecha_tc = '2026-11-02')), bna: BNA, fob: FOBR, bcr: BCR })), []);
});
test('el dólar de respaldo de la app (fallback) → tc_respaldo, aunque el número se parezca', () => {
  assert.ok(tipos(comparar({ app: conApp((a) => (a.fuente_tc = 'fallback_sin_presupuesto')), bna: BNA, fob: FOBR, bcr: BCR })).includes('tc_respaldo'));
});
test('⭐ soja con el respaldo de junio (313 USD) → fuera del FOB del día (444-503) y fuera de la banda de pizarra', () => {
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.precios.soja.usd = 313)), bna: BNA, fob: FOBR, bcr: BCR })), ['fob_fuera_de_rango:soja', 'pizarra_fuera_de_banda:soja']);
});
test('⭐ trigo CANDEAL (1001.19, 271) en lugar de trigo pan (234-261) → fob_fuera_de_rango', () => {
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.precios.trigo.usd = 271)), bna: BNA, fob: FOBR, bcr: BCR })), ['fob_fuera_de_rango:trigo']);
});
test('⭐ pesos tomados como dólares (trigo 361.530 «USD») → FOB y pizarra lo cazan', () => {
  assert.deepEqual(tipos(comparar({ app: conApp((a) => (a.precios.trigo.usd = 361530)), bna: BNA, fob: FOBR, bcr: BCR })), ['fob_fuera_de_rango:trigo', 'pizarra_fuera_de_banda:trigo']);
});
test('la app marca respaldo o estimado → se avisa', () => {
  assert.ok(tipos(comparar({ app: conApp((a) => (a.es_referencia = true)), bna: BNA, fob: FOBR, bcr: BCR })).includes('precios_respaldo'));
  assert.ok(tipos(comparar({ app: conApp((a) => (a.estimados = ['soja'])), bna: BNA, fob: FOBR, bcr: BCR })).includes('precio_estimado:soja'));
});

/* ── lo que falta no se compara ni se avisa con lo viejo ─────────────── */
test('BNA caído: no hay comparación del dólar, aunque el dólar de la app esté mal', () => {
  const r = comparar({ app: conApp((a) => (a.tc_ars_usd = 900)), bna: { ok: false }, fob: FOBR, bcr: { ...BCR, precios: {} } });
  assert.ok(r.faltan.includes('bna')); assert.ok(!tipos(r).includes('tc_desvio'));
});
test('pizarra «S/C» o vieja: no se compara', () => {
  const sc = comparar({ app: { ok: true, ...APP }, bna: BNA, fob: FOBR, bcr: { ok: true, fecha: '2026-11-06', precios: { trigo: { sin_cotizacion: true }, soja: { ars: 535000 } } } });
  assert.ok(sc.faltan.includes('bcr_trigo')); assert.ok(!sc.hechas.includes('pizarra_trigo'));
  const vieja = comparar({ app: { ok: true, ...APP }, bna: BNA, fob: FOBR, bcr: { ...BCR, fecha: '2026-10-20' } });
  assert.ok(vieja.faltan.includes('bcr_vieja')); assert.ok(!vieja.hechas.some((h) => h.startsWith('pizarra')));
});
test('la app no contesta → un solo aviso: app_no_sirve', () => {
  assert.deepEqual(tipos(comparar({ app: { ok: false, motivo: 'HTTP 502' }, bna: BNA, fob: FOBR, bcr: BCR })), ['app_no_sirve']);
});

/* ── la corrida entera, sin red ──────────────────────────────────────── */
test('⭐ --seco: lee las 4 fuentes (MAGyP primaria rota → la alternativa), no manda nada, y con desvío MUESTRA el mail', async () => {
  let mandados = 0; const logs = [];
  const f = red({ app: JSON.stringify({ ...APP, tc_ars_usd: 1300 }) });
  const x = await correr({ seco: true, fetchFn: f, mandarFn: async () => { mandados++; return { ok: true }; }, log: (s) => logs.push(s), env: {} });
  assert.equal(mandados, 0); assert.equal(x.resumen.desvios, 1); assert.equal(x.resumen.comparaciones, 5);
  assert.ok(f.pedidos.some((u) => u.startsWith(URLS.magyp[1])), 'cayó a la URL alternativa de MAGyP');
  assert.equal(f.pedidos.length, 5);   // app, bna, bcr, magyp primaria y alternativa
  assert.ok(logs.join('\n').includes('lo que mandaría'));
});
test('⭐ real con desvío: UN mail, con «[prueba]» por defecto; el registro lleva sólo cantidades', async () => {
  const mails = []; const logs = [];
  await correr({ seco: false, fetchFn: red({ app: JSON.stringify({ ...APP, precios: { ...APP.precios, soja: { ...APP.precios.soja, usd: 313 } } }) }),
    mandarFn: async (m) => { mails.push(m); return { ok: true }; }, log: (s) => logs.push(s), env: {} });
  assert.equal(mails.length, 1);
  assert.match(mails[0].asunto, /^\[prueba\] HN AGRO · vigía de números: 2 desvíos/);
  assert.match(mails[0].cuerpo, /FOB de soja: la app muestra 313/);
  assert.equal(logs.length, 1); assert.ok(!/313|535000|1545/.test(logs[0]), 'el registro público no lleva números de precios');
});
test('real sin desvíos: no manda', async () => {
  const mails = [];
  const x = await correr({ seco: false, fetchFn: red(), mandarFn: async (m) => { mails.push(m); return { ok: true }; }, log: () => {}, env: {} });
  assert.equal(mails.length, 0); assert.equal(x.resumen.mail, 'nada que avisar');
});
test('todas las fuentes públicas caídas: no hay comparaciones ni mail del desvío (sólo cuenta lo que faltó)', async () => {
  const mails = [];
  const x = await correr({ seco: false, fetchFn: red({ caidas: ['bna', 'bcr', 'magyp0', 'magyp1'] }), mandarFn: async (m) => { mails.push(m); return { ok: true }; }, log: () => {}, env: {} });
  assert.equal(x.resumen.comparaciones, 0); assert.equal(mails.length, 0);
  assert.deepEqual(x.resumen.faltan.sort(), ['bcr', 'bna', 'magyp']);
});
test('el texto del mail dice los umbrales y lo que quedó afuera', () => {
  const m = textoDe(comparar({ app: conApp((a) => (a.tc_ars_usd = 1300)), bna: BNA, fob: FOBR, bcr: BCR }), { hoy: '2026-11-10' });
  assert.match(m.cuerpo, /Dólar: la app muestra 1300 y el BNA/); assert.match(m.cuerpo, /A3/); assert.match(m.cuerpo, /reglas\.mjs/);
});
test('repo público: ni el código ni los datos de prueba traen mails, claves ni tokens', () => {
  const raiz = path.resolve(D, '..', '..');
  const archivos = []; const andar = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) andar(p); else archivos.push(p); } }; andar(raiz);
  for (const f of archivos) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(s.replace(/@[a-z]+\.(mjs|json|html)/g, '')), 'mail en ' + f);
    assert.ok(!/(api[_-]?key|token|password|secret)\s*[:=]\s*['"][^'"]{8,}/i.test(s), 'clave en ' + f);
  }
});
