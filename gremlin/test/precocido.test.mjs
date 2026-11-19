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
  const cruda = Buffer.from(SS.codificarPng(256, 256, SS.reproyectar('gremlin', t, 5, 10, 18, m).rgba));
  assert.ok(P.conEtiqueta(cruda, 'gremlin/' + t + '/5/10/18').equals(b), 'los píxeles del relevo, con la etiqueta de su hora');
  assert.ok(b.includes(Buffer.from('tEXthn-slider\0gremlin/' + t + '/5/10/18', 'latin1')), 'la etiqueta: producto/tiempo/z/x/y');
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

test('el orden: cada vez que se escribe el índice, las teselas de cada tiempo que nombra ya están', async () => {
  const dir = carpetaTemporal(), base = ALM.almacenCarpeta(dir), malos = [];
  const alm = { ...base, escribir: async (k, b, o) => {
    if (k.endsWith('indice.json')) { const j = JSON.parse(b); for (const [t, q] of Object.entries(j.tiempos || {})) { const hay = pngs(dir).filter((x) => x.includes('/' + t + '/')).length; if (hay < (q.n || 0)) malos.push(t + ': ' + hay + ' de ' + q.n); } }
    return base.escribir(k, b, o);
  } };
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn });
  assert.deepEqual(malos, []);
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
  /* la retención se mide contra SLIDER: con el más nuevo a las 22:30, lo de 8 h antes queda afuera */
  const viejo = sliderFalso({ tiempos: [...tiemposHasta(AHORA - 8 * 3600e3, 3), T.at(-1)] });
  const r = await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn: viejo.fetchFn });
  assert.equal(r.pendientes, 1); assert.equal(viejo.teselasPedidas().length, 14);
});

test('un 429 corta la corrida', async () => {
  const s = sliderFalso({ tiempos: T.slice(-2), tesela: () => ({ status: 429 }) });
  const r = await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn: s.fetchFn });
  assert.equal(r.estado, 'cortada'); assert.equal(s.teselasPedidas().length, 1);
});

/* [Codex n3-r77-colector · 1] EL BORRADO DIFERIDO: lo vencido sale del índice en una corrida y sus teselas se borran en una POSTERIOR */
const nuevoSlider = (hhmm) => sliderFalso({ tiempos: [tiemposHasta(Date.parse('2026-11-19T' + hhmm + ':00Z'), 1)[0]], tesela: () => ({ status: 404 }) });
test('la retención DIFERIDA: sale del índice en una corrida, se borra recién en la siguiente (a 10 min), y todo', async () => {
  const dir = carpetaTemporal(), base = ALM.almacenCarpeta(dir), orden = [];
  const alm = { ...base, escribir: async (k, b, o) => { if (k.endsWith('indice.json')) orden.push(['indice', JSON.parse(b)]); return base.escribir(k, b, o); }, borrar: async (k) => { orden.push(['borrar', k]); return base.borrar(k); } };
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6 });
  assert.equal(pngs(dir).length, 2 * porTiempo);
  // 05:05: SLIDER va por las 04:40 (vencen los dos: 6 h antes de las 04:40 son las 22:40). Salen del índice; NO se borra nada todavía
  orden.length = 0;
  const r1 = await correr({ almacen: alm, fetchFn: nuevoSlider('04:40').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:05:00Z') });
  assert.equal(r1.sacados, 2); assert.equal(r1.borrados, 0);
  assert.equal(orden.filter((x) => x[0] === 'borrar').length, 0);
  const ind = leerIndice(dir, 'gremlin');
  assert.ok(!ind.tiempos[T.at(-1)] && !ind.tiempos[T.at(-2)]);
  assert.deepEqual(ind.borrar.map((x) => x.t).sort(), T.slice(-2).sort());
  assert.ok(ind.borrar.every((x) => x.salio === Date.parse('2026-11-19T05:05:00Z')));
  assert.equal(pngs(dir).length, 2 * porTiempo, 'las teselas siguen: un índice viejo en caché todavía puede nombrarlas');
  // 2 min después: tampoco (todavía no pasó la espera)
  const r2 = await correr({ almacen: alm, fetchFn: nuevoSlider('04:40').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:07:00Z') });
  assert.equal(r2.borrados, 0);
  // la corrida siguiente (10 min): ahora sí, todo
  const r3 = await correr({ almacen: alm, fetchFn: nuevoSlider('04:50').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:15:00Z') });
  assert.equal(r3.borrados, 2 * porTiempo);
  assert.equal(pngs(dir).filter((k) => k.includes(T.at(-1)) || k.includes(T.at(-2))).length, 0);
  assert.deepEqual(leerIndice(dir, 'gremlin').borrar, []);
});

test('[Codex · 2] contra SLIDER: con el reloj 12 h adelantado (o 2 h atrasado) no se saca ni se borra nada', async () => {
  for (const desfase of [12 * 3600e3, -2 * 3600e3]) {
    const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir);
    await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6 });
    const r = await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6, ahoraMs: AHORA + desfase });
    assert.equal(r.sacados, 0); assert.equal(r.borrados, 0);
    assert.equal(pngs(dir).length, 2 * porTiempo);
    assert.ok(leerIndice(dir, 'gremlin').tiempos[T.at(-1)]);
  }
});

test('[Codex · 2] el reloj saltado 12 h NO se saltea la espera del borrado diferido (con ±1 h contra SLIDER no se borra)', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir);
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6 });
  await correr({ almacen: alm, fetchFn: nuevoSlider('04:40').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:05:00Z') });
  assert.equal(leerIndice(dir, 'gremlin').borrar.length, 2);
  // 2 min después de verdad, pero el reloj dice 12 h más: no se borra (el índice viejo puede seguir en caché)
  const r = await correr({ almacen: alm, fetchFn: nuevoSlider('04:40').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T17:07:00Z') });
  assert.equal(r.borrados, 0); assert.equal(pngs(dir).length, 2 * porTiempo);
});

test('[Codex · 2] la retención se mide contra SLIDER, no contra el reloj: con el reloj 55 min adelante, lo de hace 5 h 45 min se queda', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir), viejo = tiemposHasta(Date.parse('2026-11-18T16:45:00Z'), 1)[0];
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: [viejo, T.at(-1)] }).fetchFn, retencionH: 6 });
  assert.ok(leerIndice(dir, 'gremlin').tiempos[viejo]);
  const r = await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: [viejo, T.at(-1)] }).fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-18T23:25:00Z') });
  assert.equal(r.sacados, 0); assert.ok(leerIndice(dir, 'gremlin').tiempos[viejo]);
});

test('[Codex · 1 y 2] el índice estricto: tiempos y borrar disjuntos, borrar con forma; si no valida, no se borra nada', () => {
  const ok = { v: 1, producto: 'gremlin', tiempos: { [T[0]]: { estado: 'completo' } }, borrar: [{ t: T[1], salio: 1 }] };
  assert.equal(P.indiceDe(ok, 'gremlin').roto, false);
  const malos = [
    { ...ok, borrar: [{ t: T[0], salio: 1 }] },                           // el mismo tiempo en los dos
    { ...ok, borrar: [T[1]] },                                             // sin la hora de salida
    { ...ok, borrar: [{ t: '../../otra', salio: 1 }] },                    // sin forma de tiempo
    { ...ok, borrar: [{ t: T[1], salio: 1 }, { t: T[1], salio: 2 }] },     // repetido
    { ...ok, borrar: [{ t: T[1], salio: 'ayer' }] },
    { ...ok, tiempos: { malo: {} } },
    { ...ok, borrar: {} },
    { ...ok, producto: 'geocolor' },
  ];
  for (const m of malos) assert.equal(P.indiceDe(m, 'gremlin').roto, true, JSON.stringify(m));
});

test('[Codex · 2] con un índice que no valida (o una entrada de borrar no vencida según SLIDER) no se borra nada', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir);
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6 });
  // a) el índice dice «borrar» un tiempo que también está en «tiempos»: no valida
  const ind = leerIndice(dir, 'gremlin');
  fs.writeFileSync(path.join(dir, 'slider/gremlin/indice.json'), JSON.stringify({ ...ind, borrar: [{ t: T.at(-1), salio: 0 }] }));
  const r = await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6, ahoraMs: AHORA + 600e3 });
  assert.equal(r.borrados, 0); assert.equal(pngs(dir).length, 2 * porTiempo);
  // b) un «borrar» con forma, fuera de «tiempos», pero NO vencido según SLIDER: no se borra
  const { [T.at(-2)]: _q, ...resto } = ind.tiempos;
  fs.writeFileSync(path.join(dir, 'slider/gremlin/indice.json'), JSON.stringify({ ...ind, tiempos: resto, borrar: [{ t: T.at(-2), salio: 0 }] }));
  const r2 = await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-1), tesela: () => ({ status: 404 }) }).fetchFn, retencionH: 6, ahoraMs: AHORA + 600e3 });
  assert.equal(r2.borrados, 0); assert.equal(pngs(dir).filter((k) => k.includes(T.at(-2))).length, porTiempo);
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

test('[Codex · 3] el registro es PÚBLICO: un error del almacén con URL firmada, cabeceras y secretos cortos sale como CATEGORÍA, sin nada de eso', async () => {
  const { principal } = await import(new URL('../precocido.mjs', import.meta.url).href);
  const SECRETOS = ['X-Amz-Signature=deadbeef', 'cuentaX.r2.cloudflarestorage.com', 'AKIDcorto', 's3cr', 'Credential=', 'authorization'];
  const mensaje = 'fetch failed https://cuentaX.r2.cloudflarestorage.com/dep/slider/gremlin/indice.json?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIDcorto authorization: AWS4-HMAC-SHA256 Credential=AKIDcorto/s3cr';
  const casos = [
    // el cliente R2 de verdad, con un fetch que falla con todo eso adentro (red)
    ALM.almacenR2({ cuenta: 'cuentaX', clave: 'AKIDcorto', secreto: 's3cr', deposito: 'dep', fetchFn: async () => { throw new TypeError(mensaje); } }),
    // un 403 del depósito (el cliente arma «R2 leer: HTTP 403»), y un error cualquiera con el mensaje sucio
    ALM.almacenR2({ cuenta: 'cuentaX', clave: 'AKIDcorto', secreto: 's3cr', deposito: 'dep', fetchFn: async () => new Response('<Error>AKIDcorto s3cr</Error>', { status: 403 }) }),
    { leer: async () => { throw new Error(mensaje + ' HTTP 500'); }, escribir: async () => {}, borrar: async () => {} },
  ];
  const vistos = [];
  for (const almacen of casos) {
    const lineas = [];
    const cod = await principal({ env: { PRECOCIDO_ON: 'si' }, almacen, fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, log: (x) => lineas.push(String(x)), logError: (x) => lineas.push(String(x)) });
    assert.equal(cod, 1);
    const todo = lineas.join('\n');
    for (const sec of SECRETOS) assert.ok(!todo.includes(sec), 'el log trae «' + sec + '»: ' + todo);
    const f = lineas.find((l) => l.startsWith('precocido: falló'));
    assert.match(f, /^precocido: falló \(error:(almacen|red|interno)( http \d{3})?\)$/);
    vistos.push(f);
  }
  assert.deepEqual(vistos, ['precocido: falló (error:almacen)', 'precocido: falló (error:almacen http 403)', 'precocido: falló (error:almacen http 500)']);
  assert.equal(P.categoriaError(new TypeError('x https://a?b')), 'error:red');
  assert.equal(P.categoriaError(new Error('lo que sea s3cr')), 'error:interno');
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

/* [r77 · reintento] R2 FALSO: el cliente R2 de verdad (almacen.mjs) contra un fetch de mentira con un Map; `regla(metodo, clave, n)`
 * decide (n = cuántas veces se pidió esa clave con ese método): null = anda, un número = ese HTTP, 'red' = fetch que falla. */
function r2Falso(regla = () => null) {
  const datos = new Map(), veces = new Map(), pedidos = [];
  const fetchFn = async (url, o = {}) => {
    const clave = decodeURIComponent(new URL(url).pathname.replace(/^\/dep\/?/, '')), metodo = o.method || 'GET';
    const id = metodo + ' ' + clave, n = (veces.get(id) || 0) + 1; veces.set(id, n); pedidos.push(id);
    const r = regla(metodo, clave, n);
    if (r === 'red') throw new TypeError('fetch failed https://cuentaX.r2.cloudflarestorage.com/dep/' + clave + '?X-Amz-Signature=deadbeef');
    if (r) return new Response('<Error><Code>InternalError</Code> AKIDcorto s3cr</Error>', { status: r });
    if (metodo === 'PUT') { datos.set(clave, Buffer.from(o.body)); return new Response('', { status: 200 }); }
    if (metodo === 'DELETE') { datos.delete(clave); return new Response(null, { status: 204 }); }
    return datos.has(clave) ? new Response(datos.get(clave), { status: 200 }) : new Response('no', { status: 404 });
  };
  const almacen = ALM.almacenR2({ cuenta: 'cuentaX', clave: 'AKIDcorto', secreto: 's3cr', deposito: 'dep', fetchFn });
  return { almacen, datos, veces, pedidos, intentos: (m, k) => veces.get(m + ' ' + k) || 0,
    teselas: () => [...datos.keys()].filter((k) => k.endsWith('.png')), indice: (p = 'gremlin') => datos.has('slider/' + p + '/indice.json') ? JSON.parse(datos.get('slider/' + p + '/indice.json').toString('utf8')) : null };
}

test('[reintento] un 500 intermitente de R2 se reintenta y el tiempo queda completo', async () => {
  const f = r2Falso((m, k, n) => (m === 'PUT' && n <= (k.endsWith('indice.json') ? 2 : (k.length % 3)) ? 500 : null));
  const lineas = [];
  const r = await correr({ almacen: f.almacen, fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, log: (x) => lineas.push(x) });
  assert.equal(r.completos, 1); assert.equal(r.escrituras_fallidas, 0); assert.equal(r.sin_publicar, 0);
  assert.ok(r.reintentos > 0); assert.equal(f.teselas().length, porTiempo);
  assert.equal(f.intentos('PUT', 'slider/gremlin/indice.json'), 3);
  assert.deepEqual(f.indice().tiempos[T.at(-1)], { estado: 'completo', n: porTiempo, faltan: 0, intentos: 1, z: [3, 5] });
  assert.ok(lineas.some((l) => l === 'precocido: reintento:almacen http 500 (2/4)'));
  assert.ok(lineas.at(-1).includes(r.reintentos + ' reintentos · 0 escrituras fallidas'));
});

test('[reintento] la espera: exponencial con jitter (0,5 · 1,5 · 4 s ± 25 %), 4 intentos, y nunca más allá del presupuesto', async () => {
  for (const [azar, esperadas] of [[0, [375, 1125, 3000]], [1, [625, 1875, 5000]], [0.5, [500, 1500, 4000]]]) {
    const esperas = []; let n = 0;
    await assert.rejects(P.conReintento(async () => { n++; throw new Error('R2 escribir: HTTP 503'); }, { esperar: async (ms) => { esperas.push(ms); }, log: callado, azar: () => azar }));
    assert.equal(n, 4); assert.deepEqual(esperas, esperadas);
  }
  // el presupuesto: con 1 s de margen se hace el primer reintento (500 ms) pero no el segundo (1,5 s)
  let reloj = 0, n = 0;
  await assert.rejects(P.conReintento(async () => { n++; throw new TypeError('fetch failed'); }, { esperar: async (ms) => { reloj += ms; }, log: callado, reloj: () => reloj, vence: 1000, azar: () => 0.5 }));
  assert.equal(n, 2);
  // y la corrida entera: con el presupuesto ya gastado, no empieza ningún tiempo
  const s = sliderFalso({ tiempos: T.slice(-2) });
  const r = await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn: s.fetchFn, presupuestoMs: -1 });
  assert.equal(r.guardados, 0); assert.equal(s.teselasPedidas().length, 0);
  assert.equal(P.reintentable(new Error('R2 escribir: HTTP 500')), true); assert.equal(P.reintentable(new Error('R2 borrar: HTTP 502')), true);
  assert.equal(P.reintentable(new TypeError('fetch failed')), true); assert.equal(P.reintentable(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  for (const st of [400, 403, 404, 409, 412, 429]) assert.equal(P.reintentable(new Error('R2 escribir: HTTP ' + st)), false, String(st));
  assert.equal(P.reintentable(Object.assign(new Error('EACCES'), { code: 'EACCES' })), false);
});

test('[reintento] 500 persistentes en UNA tesela: el tiempo NO se publica (ni gasta un intento), la corrida sigue con el siguiente', async () => {
  const mala = P.claveTesela('gremlin', T.at(-1), 5, 10, 18);
  let romper = true;
  const f = r2Falso((m, k) => (romper && m === 'PUT' && k === mala ? 500 : null));
  const e = await correr({ almacen: f.almacen, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn }).then(() => null, (x) => x);
  assert.ok(e, 'la corrida termina en rojo (para que se vea)'); assert.equal(P.categoriaError(e), 'error:almacen escritura-con-fallas');
  assert.equal(f.intentos('PUT', mala), 4, '4 intentos y no más');
  const r = e.resumen;
  assert.equal(r.escrituras_fallidas, 1); assert.equal(r.sin_publicar, 1); assert.equal(r.completos, 1); assert.equal(r.guardados, 1);
  const ind = f.indice();
  assert.equal(ind.tiempos[T.at(-1)], undefined, 'el tiempo con la tesela que no quedó no figura en el índice');
  assert.equal(ind.tiempos[T.at(-2)].estado, 'completo', 'el siguiente se hizo igual');
  // la próxima corrida, con R2 sano, lo rehace como primer intento
  romper = false;
  const r2 = await correr({ almacen: f.almacen, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn });
  assert.equal(r2.completos, 1); assert.deepEqual(f.indice().tiempos[T.at(-1)], { estado: 'completo', n: porTiempo, faltan: 0, intentos: 1, z: [3, 5] });
});

test('[reintento] con 20 escrituras fallidas en la corrida se corta (error:almacen tope-de-fallas) y no se empieza otro tiempo', async () => {
  const f = r2Falso((m) => (m === 'PUT' ? 'red' : null)), s = sliderFalso({ tiempos: T.slice(-3) });
  const e = await correr({ almacen: f.almacen, fetchFn: s.fetchFn }).then(() => null, (x) => x);
  assert.equal(P.TOPE_ESCRITURAS_FALLIDAS, 20);
  assert.equal(P.categoriaError(e), 'error:almacen tope-de-fallas');
  assert.ok(e.resumen.escrituras_fallidas >= 20 && e.resumen.escrituras_fallidas < 20 + P.PARALELO_ESCRITURA, String(e.resumen.escrituras_fallidas));
  assert.equal(e.resumen.guardados, 0); assert.equal(s.teselasPedidas().length, 14, 'sólo las nativas del primer tiempo');
  assert.ok(f.pedidos.filter((p) => p.startsWith('PUT')).length <= 4 * (20 + P.PARALELO_ESCRITURA));
  assert.equal(f.indice(), null);
});

test('[reintento] un 403 (o un 400) de R2 NO se reintenta y corta la corrida, como antes', async () => {
  for (const st of [403, 400]) {
    const f = r2Falso((m) => (m === 'PUT' ? st : null)), s = sliderFalso({ tiempos: T.slice(-2) });
    const e = await correr({ almacen: f.almacen, fetchFn: s.fetchFn }).then(() => null, (x) => x);
    assert.ok(e); assert.equal(P.categoriaError(e), 'error:almacen http ' + st);
    const puts = f.pedidos.filter((p) => p.startsWith('PUT'));
    assert.ok(puts.length >= 1 && puts.length <= P.PARALELO_ESCRITURA); assert.equal(new Set(puts).size, puts.length, 'ninguna clave dos veces');
    assert.equal(f.indice(), null); assert.equal(s.teselasPedidas().length, 14);
  }
});

test('[reintento] el índice que falla hasta el final: no se borra nada en esa corrida', async () => {
  let indiceRoto = false;
  const f = r2Falso((m, k) => (indiceRoto && m === 'PUT' && k.endsWith('indice.json') ? 503 : null));
  await correr({ almacen: f.almacen, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6 });
  await correr({ almacen: f.almacen, fetchFn: nuevoSlider('04:40').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:05:00Z') });
  assert.equal(f.indice().borrar.length, 2); assert.equal(f.teselas().length, 2 * porTiempo);
  const antes = f.intentos('PUT', 'slider/gremlin/indice.json');
  indiceRoto = true;
  const e = await correr({ almacen: f.almacen, fetchFn: nuevoSlider('04:50').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:15:00Z') }).then(() => null, (x) => x);
  assert.ok(e); assert.equal(P.categoriaError(e), 'error:almacen escritura-con-fallas');
  assert.equal(e.resumen.indices_fallidos, 1); assert.equal(e.resumen.borrados, 0);
  assert.equal(f.pedidos.filter((p) => p.startsWith('DELETE')).length, 0, 'ni un DELETE');
  assert.equal(f.teselas().length, 2 * porTiempo); assert.equal(f.indice().borrar.length, 2);
  assert.equal(f.intentos('PUT', 'slider/gremlin/indice.json') - antes, 4, 'el índice: 4 intentos');
});

test('[reintento] un DELETE con 500 o error de red intermitente se reintenta y el borrado diferido termina', async () => {
  const f = r2Falso((m, k, n) => (m === 'DELETE' && n === 1 ? (k.length % 2 ? 500 : 'red') : null));
  await correr({ almacen: f.almacen, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn, retencionH: 6 });
  await correr({ almacen: f.almacen, fetchFn: nuevoSlider('04:40').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:05:00Z') });
  const r = await correr({ almacen: f.almacen, fetchFn: nuevoSlider('04:50').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:15:00Z') });
  assert.equal(r.borrados, 2 * porTiempo); assert.equal(r.reintentos, 2 * porTiempo); assert.equal(f.teselas().length, 0);
  assert.deepEqual(f.indice().borrar, []);
});

test('[reintento] el registro: «reintento:almacen http 500 (n/4)» o «reintento:red (n/4)», el total, y NUNCA el mensaje', async () => {
  const { principal } = await import(new URL('../precocido.mjs', import.meta.url).href);
  const SECRETOS = ['X-Amz-Signature', 'deadbeef', 'cuentaX', 'AKIDcorto', 's3cr', 'InternalError', 'fetch failed', 'slider/gremlin/'];
  for (const modo of [500, 'red']) {
    const f = r2Falso((m) => (m === 'PUT' ? modo : null)), lineas = [];
    const cod = await principal({ env: { PRECOCIDO_ON: 'si' }, almacen: f.almacen, fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, log: (x) => lineas.push(String(x)), logError: (x) => lineas.push(String(x)) });
    assert.equal(cod, 1);
    const todo = lineas.join('\n');
    for (const sec of SECRETOS) assert.ok(!todo.includes(sec), 'el log trae «' + sec + '»');
    const re = lineas.filter((l) => l.includes('reintento:'));
    assert.ok(re.length > 0);
    for (const l of re) assert.match(l, modo === 'red' ? /^precocido: reintento:(almacen|red) \([234]\/4\)$/ : /^precocido: reintento:almacen http 500 \([234]\/4\)$/);
    assert.ok(lineas.some((l) => / \d+ reintentos · \d+ escrituras fallidas/.test(l)));
    assert.equal(lineas.at(-1), 'precocido: falló (error:almacen tope-de-fallas)');
  }
});
