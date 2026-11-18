// [r77] Tests del colector de teselas PRECOCIDAS (lib/precocido.mjs). Sin red: SLIDER de mentira y almacén en carpeta temporal.
// GREMLIN_LIB apunta a la copia mutada de lib/ cuando corre el control negativo (test/control-precocido.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALM, sliderFalso, carpetaTemporal, sinEspera, callado, tiemposHasta } from './falsos.mjs';

const LIB = process.env.GREMLIN_LIB || new URL('../lib/', import.meta.url).href;
const P = await import(LIB + 'precocido.mjs');
const SS = await import(LIB + 'satelite-slider.copia.mjs');
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = path.resolve(AQUI, '..', '..');

const AHORA = Date.parse('2026-11-18T22:50:00Z');
const T = tiemposHasta(Date.parse('2026-11-18T22:30:00Z'), 6);   // 21:40 … 22:30 (segundos 00: sirven para los 3 productos en el falso)
const correr = (o) => P.correr({ ahoraMs: AHORA, llave: 'si', pausaMs: 0, esperar: sinEspera, log: callado, productos: ['gremlin'], ...o });
const pngs = (dir) => { const out = []; const r = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) r(p); else if (p.endsWith('.png')) out.push(path.relative(dir, p).split(path.sep).join('/')); } }; r(dir); return out.sort(); };
const leerIndice = (dir, prod) => JSON.parse(fs.readFileSync(path.join(dir, 'slider', prod, 'indice.json'), 'utf8'));
const porTiempo = P.teselasDe('gremlin', 3).length + P.teselasDe('gremlin', 4).length + P.teselasDe('gremlin', 5).length;

test('la copia de la lib del relevo es textual (sha256 de hn-agro netlify/functions/lib/satelite-slider.mjs @ af3412df)', () => {
  const b = fs.readFileSync(new URL('satelite-slider.copia.mjs', LIB));
  assert.equal(crypto.createHash('sha256').update(b).digest('hex'), '8ee5d250cbe1652289d259aafa9d69cd78b6895649cf42396600c8cdf98ca593');
});

test('la geometría: z3-z5 del recorte entero, 106 teselas por tiempo y producto (9 + 25 + 72)', () => {
  assert.deepEqual([3, 4, 5].map((z) => P.teselasDe('geocolor', z).length), [9, 25, 72]);
  assert.equal(porTiempo, 106);
  assert.equal(P.Z_MIN, 3); assert.equal(P.Z_MAX, 5);
  assert.equal(P.claveTesela('geocolor', '20261118223021', 5, 10, 18), 'slider/geocolor/20261118223021/5/10/18.png');
  assert.equal(P.claveIndice('band_02'), 'slider/band_02/indice.json');
});

test('llave apagada: ni un pedido ni una lectura', async () => {
  for (const llave of [undefined, '', 'no', 'SI', 'true']) {
    const s = sliderFalso({ tiempos: T }); let lecturas = 0;
    const alm = { leer: async () => { lecturas++; return null; }, escribir: async () => { throw new Error('no'); }, borrar: async () => {} };
    const r = await correr({ almacen: alm, fetchFn: s.fetchFn, llave });
    assert.equal(r.estado, 'apagado'); assert.equal(s.pedidos.length, 0); assert.equal(lecturas, 0);
  }
});

test('seco: sólo latest_times, nada escrito', async () => {
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: T });
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn, modo: 'seco', productos: ['gremlin', 'geocolor'] });
  assert.equal(r.estado, 'seco'); assert.equal(s.teselasPedidas().length, 0); assert.equal(s.pedidos.length, 2);
  assert.equal(r.pendientes, 12); assert.equal(pngs(dir).length, 0);
});

test('real: las teselas en slider/{producto}/{tiempo}/{z}/{x}/{y}.png, PNG válidos de 256, iguales a los del relevo, y el índice', async () => {
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: T.slice(-1) });
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn });
  const t = T.at(-1);
  assert.equal(r.completos, 1); assert.equal(r.teselas, porTiempo);
  const l = pngs(dir); assert.equal(l.length, porTiempo);
  assert.ok(l.every((k) => new RegExp('^slider/gremlin/' + t + '/[345]/\\d+/\\d+\\.png$').test(k)));
  const b = fs.readFileSync(path.join(dir, 'slider/gremlin', t, '5/10/18.png'));
  assert.equal(SS.motivoPngMalo(b), null); const img = SS.decodificarPng(b); assert.equal(img.w, 256); assert.equal(img.h, 256);
  const delColector = s.pedidos.slice();
  // la misma tesela, con la cuenta del relevo
  const { zs, lista } = SS.nativasDe('gremlin', 5, 10, 18), m = new Map();
  for (const q of lista) { const resp = await s.fetchFn('https://slider.cira.colostate.edu/' + SS.rutaNativa('gremlin', t, zs, q.f, q.c)); m.set(q.f + '_' + q.c, SS.decodificarPng(Buffer.from(await resp.arrayBuffer()))); }
  assert.ok(Buffer.from(SS.codificarPng(256, 256, SS.reproyectar('gremlin', t, 5, 10, 18, m).rgba)).equals(b));
  const ind = leerIndice(dir, 'gremlin');
  assert.equal(ind.v, 1); assert.equal(ind.z_min, 3); assert.equal(ind.z_max, 5); assert.equal(ind.ruta, 'slider/gremlin/{tiempo}/{z}/{x}/{y}.png');
  assert.equal(ind.cita, 'GREMLIN (CIRA) · GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER');
  assert.deepEqual(ind.tiempos[t], { estado: 'completo', n: porTiempo, faltan: 0, intentos: 1, z: [3, 5] });
  // UA en todos, y sólo las nativas que hacen falta (zs 0, 1 y 2)
  assert.ok(delColector.every((p) => p.ua === 'hn-colector/1.0'));
  const nat = delColector.filter((p) => p.url.endsWith('.png'));
  assert.equal(nat.length, 1 + 4 + 9);
  assert.ok(nat.every((p) => /\/0[012]\/\d{3}_\d{3}\.png$/.test(p.url)));
});

test('idempotente: la segunda corrida no pide nativas ni escribe', async () => {
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: T.slice(-1) }), alm = ALM.almacenCarpeta(dir);
  await correr({ almacen: alm, fetchFn: s.fetchFn });
  const n0 = s.teselasPedidas().length;
  const r = await correr({ almacen: alm, fetchFn: s.fetchFn });
  assert.equal(s.teselasPedidas().length, n0); assert.equal(r.guardados, 0); assert.equal(r.pendientes, 0);
});

test('del más nuevo al más viejo, intercalando productos, y el tope de pedidos', async () => {
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: T });
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn, productos: ['gremlin', 'geocolor'], tope: 2 + 14 * 2 + 5 });
  assert.ok(r.pedidos <= 2 + 14 * 2 + 5);
  assert.equal(r.guardados, 2);
  assert.ok(leerIndice(dir, 'gremlin').tiempos[T.at(-1)]); assert.ok(leerIndice(dir, 'geocolor').tiempos[T.at(-1)]);
  assert.equal(Object.keys(leerIndice(dir, 'gremlin').tiempos).length, 1);
  assert.equal(P.acotarTope('5'), P.TOPE_MIN); assert.equal(P.acotarTope('9999'), P.TOPE_MAX); assert.equal(P.acotarTope('x'), P.TOPE_DEFECTO);
});

test('una nativa que falta: sus teselas NO se escriben, el tiempo queda incompleto y la corrida siguiente lo completa', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir); let romper = true;
  const s = sliderFalso({ tiempos: T.slice(-1), tesela: (t, f, c, n) => (romper && f === 2 && c === 1 ? { status: 404 } : null) });
  const r = await correr({ almacen: alm, fetchFn: s.fetchFn });
  assert.equal(r.incompletos, 1); assert.ok(r.teselas_faltantes > 0); assert.equal(r.nativas_malas, 1);
  const q = leerIndice(dir, 'gremlin').tiempos[T.at(-1)];
  assert.equal(q.estado, 'incompleto'); assert.equal(q.faltan, r.teselas_faltantes); assert.equal(q.n + q.faltan, porTiempo);
  assert.equal(pngs(dir).length, porTiempo - r.teselas_faltantes);
  romper = false;
  const r2 = await correr({ almacen: alm, fetchFn: s.fetchFn });
  assert.equal(r2.completos, 1); assert.equal(pngs(dir).length, porTiempo);
  assert.equal(leerIndice(dir, 'gremlin').tiempos[T.at(-1)].intentos, 2);
});

test('una nativa que no es un PNG válido cuenta como faltante (nunca se reproyecta basura)', async () => {
  const dir = carpetaTemporal();
  const s = sliderFalso({ tiempos: T.slice(-1), tesela: (t, f, c) => (f === 0 ? { cuerpo: '<html>hola</html>', status: 200, tipo: 'text/html' } : null) });
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn });
  assert.equal(r.incompletos, 1); assert.ok(r.nativas_malas >= 1);
  assert.ok(!pngs(dir).some((k) => /\/3\/\d+\/\d+\.png$/.test(k)));   // el z3 usa la nativa de zs 0
});

test('los intentos tienen tope (4) y fuera de la retención no se pide nada', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir);
  const s = sliderFalso({ tiempos: T.slice(-1), tesela: (t, f) => (f === 0 ? { status: 404 } : null) });
  for (let i = 0; i < 5; i++) await correr({ almacen: alm, fetchFn: s.fetchFn });
  assert.equal(leerIndice(dir, 'gremlin').tiempos[T.at(-1)].intentos, 4);
  const viejo = sliderFalso({ tiempos: tiemposHasta(AHORA - 8 * 3600e3, 3) });
  const r = await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn: viejo.fetchFn });
  assert.equal(r.pendientes, 0); assert.equal(viejo.teselasPedidas().length, 0);
});

test('un 429 corta la corrida', async () => {
  const s = sliderFalso({ tiempos: T.slice(-2), tesela: () => ({ status: 429 }) });
  const r = await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn: s.fetchFn });
  assert.equal(r.estado, 'cortada'); assert.equal(s.teselasPedidas().length, 1);
});

test('la retención: lo vencido sale del índice ANTES de borrar sus teselas, y se borra todo', async () => {
  const dir = carpetaTemporal(), base = ALM.almacenCarpeta(dir), orden = [];
  const alm = { ...base, escribir: async (k, b, o) => { if (k.endsWith('indice.json')) orden.push(['indice', JSON.parse(b).tiempos]); return base.escribir(k, b, o); }, borrar: async (k) => { orden.push(['borrar', k]); return base.borrar(k); } };
  const s = sliderFalso({ tiempos: T.slice(-2) });
  await correr({ almacen: alm, fetchFn: s.fetchFn, retencionH: 6 });
  assert.equal(pngs(dir).length, 2 * porTiempo);
  orden.length = 0;
  // 6 h y 15 min después: los dos vencen (retención 6 h); SLIDER ya tiene sólo uno nuevo, a las 04:40
  const s2 = sliderFalso({ tiempos: [tiemposHasta(Date.parse('2026-11-19T04:40:00Z'), 1)[0]], tesela: () => ({ status: 404 }) });
  const r = await correr({ almacen: alm, fetchFn: s2.fetchFn, retencionH: 6, ahoraMs: AHORA + 6.25 * 3600e3 });
  assert.equal(r.sacados, 2); assert.equal(r.borrados, 2 * porTiempo);
  const iInd = orden.findIndex((x) => x[0] === 'indice' && !x[1][T.at(-1)]), iBor = orden.findIndex((x) => x[0] === 'borrar');
  assert.ok(iInd >= 0 && iInd < iBor, 'el índice deja de nombrarlo antes del primer borrado');
  assert.equal(pngs(dir).filter((k) => k.includes(T.at(-1)) || k.includes(T.at(-2))).length, 0);
  assert.deepEqual(leerIndice(dir, 'gremlin').borrar, []);
});

test('retención 12 h: a las 6 h y 15 min no se borra nada; con el reloj adelantado, tampoco', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir);
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, retencionH: 12 });
  const s2 = sliderFalso({ tiempos: [tiemposHasta(Date.parse('2026-11-19T04:40:00Z'), 1)[0]], tesela: () => ({ status: 404 }) });
  const r = await correr({ almacen: alm, fetchFn: s2.fetchFn, retencionH: 12, ahoraMs: AHORA + 6.25 * 3600e3 });
  assert.equal(r.sacados, 0); assert.equal(pngs(dir).length, porTiempo);
  const s3 = sliderFalso({ tiempos: T.slice(-1) });
  const r3 = await correr({ almacen: alm, fetchFn: s3.fetchFn, retencionH: 6, ahoraMs: AHORA + 3 * 86400e3 });
  assert.equal(r3.sacados, 0); assert.equal(pngs(dir).length, porTiempo);
  assert.equal(P.acotarRetencion('12'), 12); assert.equal(P.acotarRetencion('100'), 24); assert.equal(P.acotarRetencion(''), 6);
});

test('el visible de noche: tesela transparente sin pedir nativas para ella', async () => {
  const dir = carpetaTemporal(), noche = ['20261119033000'];   // 00:30 ART: noche en casi todo el recorte
  const s = sliderFalso({ tiempos: noche });
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn, productos: ['band_02'], ahoraMs: Date.parse('2026-11-19T03:50:00Z') });
  assert.ok(r.teselas_noche > 50, 'casi todas de noche: ' + r.teselas_noche); assert.ok(s.teselasPedidas().length < 1 + 4 + 9); assert.equal(r.completos, 1);
  assert.equal(pngs(dir).length, porTiempo);
  const img = SS.decodificarPng(fs.readFileSync(path.join(dir, 'slider/band_02', noche[0], '5/10/18.png')));
  assert.ok(img.rgba.every((v, i) => i % 4 !== 3 || v === 0));
});

test('el registro es PÚBLICO: el script no imprime ninguna llave, y sin llave no hace nada', () => {
  const env = { ...process.env, R2_OPERA_CUENTA: 'cuentaSECRETA0123456789abcdef0123', R2_OPERA_ACCESS_KEY_ID: 'idSECRETO', R2_OPERA_SECRET_ACCESS_KEY: 'secretoSECRETO', PRECOCIDO_ON: '' };
  delete env.PUBLICO_CARPETA;
  const r = spawnSync(process.execPath, [path.join(RAIZ_REPO, 'gremlin', 'precocido.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  const todo = r.stdout + r.stderr;
  assert.match(todo, /llave apagada/);
  for (const s of ['cuentaSECRETA', 'idSECRETO', 'secretoSECRETO']) assert.ok(!todo.includes(s));
});

test('el workflow: nace apagado, a mano corre en seco, usa las llaves del depósito público y no imprime secretos', () => {
  const y = fs.readFileSync(path.join(RAIZ_REPO, 'gremlin', 'precocido.workflow.yml.txt'), 'utf8');
  assert.match(y, /vars\.PRECOCIDO_ON == 'si'/);
  assert.match(y, /default: seco/);
  for (const s of ['R2_OPERA_CUENTA', 'R2_OPERA_ACCESS_KEY_ID', 'R2_OPERA_SECRET_ACCESS_KEY']) assert.match(y, new RegExp('secrets\\.' + s));
  assert.ok(!/echo .*secrets/.test(y));
  assert.match(y, /node gremlin\/precocido\.mjs/);
});
