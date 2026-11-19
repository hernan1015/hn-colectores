// [r79 · punto 1 · 1-bis] Tests de los CUADROS ENTEROS y las METATESELAS WebP del precocido (lib/precocido.mjs con `cuadros`).
// Sin red: SLIDER de mentira y almacén en carpeta temporal. El codificador es el de verdad (gremlin/webp.mjs, sharp) y la lectura de
// los píxeles también (sharp): GREMLIN va sin pérdida, así que sus píxeles se comparan EXACTOS con las teselas PNG del relevo.
// GREMLIN_LIB apunta a la copia mutada de lib/ cuando corre el control negativo (test/control-cuadros.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { ALM, sliderFalso, carpetaTemporal, sinEspera, callado, tiemposHasta } from './falsos.mjs';

const LIB = process.env.GREMLIN_LIB || new URL('../lib/', import.meta.url).href;
const P = await import(LIB + 'precocido.mjs');
const SS = await import(LIB + 'satelite-slider.copia.mjs');
const { codificarWebp, AJUSTE_WEBP } = await import(new URL('../webp.mjs', import.meta.url).href);
const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const AHORA = Date.parse('2026-11-18T22:50:00Z');
const T = tiemposHasta(Date.parse('2026-11-18T22:30:00Z'), 3);
const correr = (o) => P.correr({ ahoraMs: AHORA, llave: 'si', pausaMs: 0, esperar: sinEspera, log: callado, productos: ['gremlin'], tope: 600, cuadros: true, codificarWebp, ...o });
const archivos = (dir, ext) => { const out = []; const r = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) r(p); else if (p.endsWith(ext)) out.push(path.relative(dir, p).split(path.sep).join('/')); } }; r(dir); return out.sort(); };
const leerIndice = (dir, prod) => JSON.parse(fs.readFileSync(path.join(dir, 'slider', prod, 'indice.json'), 'utf8'));
const crudo = async (b) => { const { data, info } = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { px: new Uint8Array(data), w: info.width, h: info.height }; };
const metasGremlin = P.metasDe('gremlin', 6).length;

test('la geometría: el cuadro de z4 es de 5 × 5 teselas y el de z5 de 8 × 9; la cobertura de las metateselas, la Argentina y sus hijas', () => {
  assert.deepEqual(P.Z_CUADRO, [4, 5]);
  const c4 = P.cajaCuadro('geocolor', 4), c5 = P.cajaCuadro('geocolor', 5);
  assert.deepEqual([c4.x1 - c4.x0 + 1, c4.y1 - c4.y0 + 1], [5, 5]); assert.deepEqual([c5.x1 - c5.x0 + 1, c5.y1 - c5.y0 + 1], [8, 9]);
  for (const [x, y] of P.teselasDe('geocolor', 5)) assert.ok(x >= c5.x0 && x <= c5.x1 && y >= c5.y0 && y <= c5.y1);
  assert.deepEqual(P.Z_META.geocolor, [6, 7]); assert.deepEqual(P.Z_META.band_02, [6, 7, 8]); assert.deepEqual(P.Z_META.gremlin, [6]);
  for (const prod of ['geocolor', 'band_02', 'gremlin']) {
    const zs = P.Z_META[prod], top = zs.at(-1), n = 2 ** top, c = P.coberturaMeta(prod, top);
    const tx = (lon) => Math.floor((lon + 180) / 360 * n), ty = (lat) => { const q = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(q) + 1 / Math.cos(q)) / Math.PI) / 2 * n); };
    assert.deepEqual(c, { x0: tx(P.CAJA_META.oeste), x1: tx(P.CAJA_META.este), y0: ty(P.CAJA_META.norte), y1: ty(P.CAJA_META.sur) }, 'la caja de la Argentina, sin agrandar');
    for (let i = zs.length - 2; i >= 0; i--) {   // cada tesela cubierta de abajo tiene sus 4 hijas cubiertas arriba
      const ab = P.coberturaMeta(prod, zs[i]), ar = P.coberturaMeta(prod, zs[i + 1]);
      for (const [x, y] of [[ab.x0, ab.y0], [ab.x1, ab.y1]]) for (const [a, b] of [[0, 0], [1, 1]]) assert.ok(P.enCobertura(ar, 2 * x + a, 2 * y + b));
      assert.ok(!P.enCobertura(ab, ab.x0 - 1, ab.y0));
    }
    for (const [mx, my] of P.metasDe(prod, top)) assert.ok(mx * 4 + 3 >= c.x0 && mx * 4 <= c.x1 && my * 4 + 3 >= c.y0 && my * 4 <= c.y1);
  }
  /* las nativas del zoom más alto: la caja, sin agrandar (band_02 z8 ≈ 55, no ~195) */
  assert.ok(P.planMeta('band_02', '20261119141021').nativas.size <= 60);
  assert.equal(P.claveCuadro('geocolor', '20261118223021', 5), 'slider/geocolor/20261118223021/c/5.webp');
  assert.equal(P.claveMeta('band_02', '20261118223021', 8, 21, 37), 'slider/band_02/20261118223021/m/8/21/37.webp');
  assert.equal(P.etiquetaMeta('band_02', '20261118223021', 8, 21, 37), 'band_02/20261118223021/m/8/21/37');
});

test('la etiqueta del WebP: el XMP <hn-slider> exacto; sin él, con dos, o con el RIFF roto, no hay etiqueta', async () => {
  const px = new Uint8Array(8 * 8 * 4).fill(200);
  const b = await codificarWebp(px, 8, 8, 'gremlin/20261118223000/c/5', 'gremlin');
  assert.equal(P.etiquetaWebp(b), 'gremlin/20261118223000/c/5');
  const sin = await sharp(Buffer.from(px), { raw: { width: 8, height: 8, channels: 4 } }).webp({ lossless: true }).toBuffer();
  assert.equal(P.etiquetaWebp(sin), null);
  const dos = Buffer.concat([b, Buffer.from('XMP ', 'latin1'), Buffer.from([8, 0, 0, 0]), Buffer.from('<x:abc/>', 'latin1')]); dos.writeUInt32LE(dos.length - 8, 4);
  assert.equal(P.etiquetaWebp(dos), null);
  const corto = Buffer.from(b); corto.writeUInt32LE(b.length, 4); assert.equal(P.etiquetaWebp(corto), null);
  assert.equal(P.etiquetaWebp(Buffer.from('no es un webp')), null);
  assert.equal(AJUSTE_WEBP.gremlin.lossless, true, 'GREMLIN sin pérdida: un artefacto cambiaría el dBZ estimado');
});

test('reducir a la mitad: el promedio 2 × 2 va con el alfa (lo transparente no tiñe) y un bloque transparente queda transparente', () => {
  const S = 4, src = new Uint8Array(S * S * 4);
  const pon = (x, y, r, g, b, a) => src.set([r, g, b, a], (y * S + x) * 4);
  pon(0, 0, 200, 100, 0, 255); pon(1, 0, 0, 0, 255, 0); pon(0, 1, 100, 50, 0, 85); pon(1, 1, 0, 0, 0, 0);   // un bloque con 2 transparentes
  const dst = new Uint8Array(2 * 2 * 4);
  P.reducirEn(dst, 2, src, S, 0, 0);
  assert.deepEqual([...dst.subarray(0, 4)], [175, 88, 0, 85]);   // pesado por el alfa ((200·255 + 100·85) / 340); el azul transparente no entra
  assert.deepEqual([...dst.subarray(4, 8)], [0, 0, 0, 0]);       // el bloque de la derecha arriba: todo transparente
});

test('real: el cuadro entero (z4 y z5) y las metateselas (z6) de GREMLIN, píxel por píxel iguales a las teselas del relevo, con su etiqueta', async () => {
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: T.slice(-1) }), t = T.at(-1);
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn });
  assert.equal(r.completos, 1); assert.equal(r.cuadros, 2); assert.equal(r.metas, metasGremlin); assert.equal(r.metas_faltantes, 0);
  const w = archivos(dir, '.webp');
  assert.deepEqual(w.filter((k) => k.includes('/c/')), ['slider/gremlin/' + t + '/c/4.webp', 'slider/gremlin/' + t + '/c/5.webp']);
  assert.equal(w.filter((k) => k.includes('/m/6/')).length, metasGremlin);
  /* el cuadro z5: cada tesela PNG del relevo es exactamente su recorte */
  const c5 = fs.readFileSync(path.join(dir, 'slider/gremlin', t, 'c/5.webp'));
  assert.equal(P.etiquetaWebp(c5), 'gremlin/' + t + '/c/5');
  const cj = P.cajaCuadro('gremlin', 5), img = await crudo(c5);
  assert.deepEqual([img.w, img.h], [(cj.x1 - cj.x0 + 1) * 256, (cj.y1 - cj.y0 + 1) * 256]);
  for (const [x, y] of [P.teselasDe('gremlin', 5)[0], [10, 18], P.teselasDe('gremlin', 5).at(-1)]) {
    /* [decisión 7] ya no hay PNG sueltas: la tesela de referencia es la reproyección del relevo, con las mismas nativas */
    const nd = SS.nativasDe('gremlin', 5, x, y), mm = new Map();
    for (const q of nd.lista) { const resp = await s.fetchFn('https://slider.cira.colostate.edu/' + SS.rutaNativa('gremlin', t, nd.zs, q.f, q.c)); mm.set(q.f + '_' + q.c, SS.decodificarPng(Buffer.from(await resp.arrayBuffer()))); }
    const png = SS.reproyectar('gremlin', t, 5, x, y, mm);
    for (const j of [0, 77, 255]) for (const i of [0, 130, 255]) {
      const a = (j * 256 + i) * 4, b = (((y - cj.y0) * 256 + j) * img.w + (x - cj.x0) * 256 + i) * 4;
      assert.deepEqual([...img.px.subarray(b, b + 4)], [...png.rgba.subarray(a, a + 4)], `z5 ${x}/${y} píxel ${i},${j}`);
    }
  }
  /* una metatesela z6: sus 16 teselas son la reproyección del relevo */
  const [mx, my] = P.metasDe('gremlin', 6)[0], mb = fs.readFileSync(path.join(dir, 'slider/gremlin', t, 'm/6', String(mx), my + '.webp'));
  assert.equal(P.etiquetaWebp(mb), 'gremlin/' + t + '/m/6/' + mx + '/' + my);
  const mi = await crudo(mb); assert.deepEqual([mi.w, mi.h], [1024, 1024]);
  const cob = P.coberturaMeta('gremlin', 6); let xx = null, yy = null; for (let k = 15; k >= 0; k--) if (P.enCobertura(cob, mx * 4 + (k % 4), my * 4 + (k >> 2))) { xx = mx * 4 + (k % 4); yy = my * 4 + (k >> 2); }
  const { zs, lista } = SS.nativasDe('gremlin', 6, xx, yy), m = new Map();
  for (const q of lista) { const resp = await s.fetchFn('https://slider.cira.colostate.edu/' + SS.rutaNativa('gremlin', t, zs, q.f, q.c)); m.set(q.f + '_' + q.c, SS.decodificarPng(Buffer.from(await resp.arrayBuffer()))); }
  const rp = SS.reproyectar('gremlin', t, 6, xx, yy, m);
  /* y una tesela FUERA de la cobertura queda transparente (la página la pide suelta) */
  for (let k = 0; k < 16; k++) { const x2 = mx * 4 + (k % 4), y2 = my * 4 + (k >> 2); if (P.enCobertura(cob, x2, y2)) continue; const b = (((k >> 2) * 256 + 100) * 1024 + (k % 4) * 256 + 100) * 4; assert.equal(mi.px[b + 3], 0); }
  for (const j of [3, 128, 250]) for (const i of [5, 129, 254]) { const a = (j * 256 + i) * 4, b = (((yy - my * 4) * 256 + j) * 1024 + (xx - mx * 4) * 256 + i) * 4; assert.deepEqual([...mi.px.subarray(b, b + 4)], [...rp.rgba.subarray(a, a + 4)]); }
  /* el índice: la cabecera dice dónde está todo; el tiempo, qué se escribió */
  const ind = leerIndice(dir, 'gremlin');
  assert.equal(ind.cuadro.ruta, 'slider/gremlin/{tiempo}/c/{z}.webp'); assert.deepEqual(ind.cuadro.z, [4, 5]); assert.deepEqual(ind.cuadro.cajas[5], cj);
  assert.equal(ind.meta.ruta, 'slider/gremlin/{tiempo}/m/{z}/{x}/{y}.webp'); assert.deepEqual(ind.meta.z, [6]); assert.equal(ind.meta.lado, 4); assert.deepEqual(ind.meta.cobertura[6], P.coberturaMeta('gremlin', 6));
  assert.deepEqual(ind.tiempos[t].c, [4, 5]); assert.deepEqual(ind.tiempos[t].m, { n: metasGremlin, faltan: 0, faltantes: [], vacias: [], noche: false });
  assert.equal(P.hecho(ind.tiempos[t], true), true);
});

test('las metateselas de abajo salen de REDUCIR las de arriba (GeoColor z6 = z7 a la mitad), sin pedir más nativas', async () => {
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: T.slice(-1) }), t = T.at(-1);
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn, productos: ['geocolor'] });
  assert.equal(r.metas, P.metasDe('geocolor', 6).length + P.metasDe('geocolor', 7).length);
  const conMetas = new Set(s.teselasPedidas().map((p) => p.url)).size;
  const soloTop = new Set([...P.planTiempo('geocolor', t, 3, 5).nativas.keys(), ...P.planMeta('geocolor', t).nativas.keys()]).size;
  assert.equal(conMetas, soloTop, 'las nativas son las de z3-z5 y las del z7: ninguna de z6');
  assert.ok(P.planMeta('geocolor', t).z === 7);
});

test('una nativa que falta: no se escribe el cuadro de ese zoom ni la metatesela con el hueco; el tiempo no queda «hecho» y la próxima corrida lo completa', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir), t = T.at(-1); let romper = true;
  /* una nativa de zs 3 (fila o columna ≥ 4: no existe en zs 0-2, así que sólo la usan las metateselas de z6) */
  const zsMeta = SS.zSlider('gremlin', 6);
  let mx = null, my = null, una = null;
  for (const [x0, y0] of P.metasDe('gremlin', 6)) { for (let k = 0; k < 16 && !una; k++) { if (!P.enCobertura(P.coberturaMeta('gremlin', 6), x0 * 4 + (k % 4), y0 * 4 + (k >> 2))) continue; const l = SS.nativasDe('gremlin', 6, x0 * 4 + (k % 4), y0 * 4 + (k >> 2)).lista.find((q) => q.f >= 4 || q.c >= 4); if (l) { una = l; mx = x0; my = y0; } } if (una) break; }
  const s = sliderFalso({ tiempos: T.slice(-1), tesela: (tt, f, c) => (romper && f === una.f && c === una.c ? { status: 404 } : null) });
  const r = await correr({ almacen: alm, fetchFn: s.fetchFn });
  /* [Codex n3-r79b-colector · 1] el tiempo NO es «completo» (faltan metateselas) y el índice dice CUÁLES faltan */
  assert.equal(r.incompletos, 1); assert.equal(r.teselas_faltantes, 0, 'las teselas z3-z5 no la usan'); assert.equal(r.cuadros, 2);
  assert.ok(r.metas_faltantes >= 1); assert.equal(fs.existsSync(path.join(dir, 'slider/gremlin', t, 'm/6', String(mx), my + '.webp')), false);
  const q = leerIndice(dir, 'gremlin').tiempos[t];
  assert.ok(q.m.faltan >= 1); assert.equal(q.estado, 'incompleto'); assert.equal(P.hecho(q, true), false);
  /* «hecho» también mira cuadros y metateselas (un índice de la r77 que dice «completo» sin ellos se rehace) */
  assert.equal(P.hecho({ estado: 'completo', c: [4], m: { faltan: 0 } }, true), false); assert.equal(P.hecho({ estado: 'completo' }, true), false); assert.equal(P.hecho({ estado: 'completo' }, false), true);
  assert.equal(q.m.faltantes.length, q.m.faltan); assert.ok(q.m.faltantes.includes('6/' + mx + '/' + my), JSON.stringify(q.m.faltantes));
  for (const k of q.m.faltantes) assert.equal(fs.existsSync(path.join(dir, 'slider/gremlin', t, 'm', ...k.split('/')) + '.webp'), false, 'la que figura como faltante no está');
  const escritas = archivos(path.join(dir, 'slider/gremlin', t, 'm'), '.webp').map((k) => k.replace('.webp', ''));
  assert.equal(escritas.length, q.m.n); for (const k of escritas) assert.ok(!q.m.faltantes.includes(k));
  assert.equal(zsMeta, 3);
  romper = false;
  const r2 = await correr({ almacen: alm, fetchFn: s.fetchFn });
  assert.equal(r2.guardados, 1); const q2 = leerIndice(dir, 'gremlin').tiempos[t];
  assert.equal(q2.m.faltan, 0); assert.deepEqual(q2.m.faltantes, []); assert.equal(q2.estado, 'completo'); assert.equal(q2.m.n, metasGremlin); assert.equal(P.hecho(q2, true), true); assert.equal(q2.intentos, 2);
  /* y en una tesela de z5: su cuadro z5 no se escribe (el z4 sí) */
  const d3 = carpetaTemporal(), nat5 = SS.nativasDe('gremlin', 5, 10, 18).lista[0];
  const s3 = sliderFalso({ tiempos: T.slice(-1), tesela: (tt, f, c) => (f === nat5.f && c === nat5.c ? { status: 404 } : null) });
  const r3 = await correr({ almacen: ALM.almacenCarpeta(d3), fetchFn: s3.fetchFn });
  const q3 = leerIndice(d3, 'gremlin').tiempos[t];
  assert.ok(!q3.c.includes(5)); assert.equal(fs.existsSync(path.join(d3, 'slider/gremlin', t, 'c/5.webp')), false); assert.ok(r3.cuadros_faltantes >= 1);
});

test('el orden: cada vez que se escribe el índice, los cuadros y las metateselas que nombra ya están', async () => {
  const dir = carpetaTemporal(), base = ALM.almacenCarpeta(dir), malos = [];
  const alm = { ...base, escribir: async (k, b, o) => {
    if (k.endsWith('indice.json')) { const j = JSON.parse(b); for (const [t, q] of Object.entries(j.tiempos || {})) {
      for (const z of q.c || []) if (!fs.existsSync(path.join(dir, 'slider/gremlin', t, 'c', z + '.webp'))) malos.push(t + ' c' + z);
      const hay = archivos(path.join(dir, 'slider/gremlin', t), '.webp').filter((x) => x.startsWith('m/')).length; if (q.m && hay < q.m.n) malos.push(t + ' m ' + hay + ' de ' + q.m.n);
    } }
    return base.escribir(k, b, o);
  } };
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-2) }).fetchFn });
  assert.deepEqual(malos, []);
});

test('el visible de NOCHE: la caja entera sin sol no escribe metateselas ni pide sus nativas, y el índice dice «noche»', async () => {
  const noche = tiemposHasta(Date.parse('2026-11-19T06:00:00Z'), 1);   // 03:00 en la Argentina
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: noche });
  const r = await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: s.fetchFn, productos: ['band_02'], ahoraMs: Date.parse('2026-11-19T06:20:00Z') });
  const q = leerIndice(dir, 'band_02').tiempos[noche[0]];
  assert.equal(q.m.noche, true); assert.equal(q.m.n, 0); assert.deepEqual(q.m.vacias, []);
  assert.equal(archivos(dir, '.webp').filter((k) => k.includes('/m/')).length, 0);
  assert.ok(r.metas_vacias > 0);
  assert.equal(P.planMeta('band_02', noche[0]).nativas.size, 0);
  assert.equal(P.hecho(q, true), true);
});

test('el borrado diferido borra también los cuadros y las metateselas', async () => {
  const dir = carpetaTemporal(), alm = ALM.almacenCarpeta(dir);
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, retencionH: 6 });
  assert.ok(archivos(dir, '.webp').length > 0);
  const nuevo = (hhmm) => sliderFalso({ tiempos: [tiemposHasta(Date.parse('2026-11-19T' + hhmm + ':00Z'), 1)[0]], tesela: () => ({ status: 404 }) });
  await correr({ almacen: alm, fetchFn: nuevo('04:40').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:05:00Z') });
  assert.ok(archivos(dir, '.webp').some((k) => k.includes(T.at(-1))), 'todavía no: sale del índice y se borra en la próxima');
  const r = await correr({ almacen: alm, fetchFn: nuevo('04:50').fetchFn, retencionH: 6, ahoraMs: Date.parse('2026-11-19T05:15:00Z') });
  assert.equal(archivos(dir, '.webp').filter((k) => k.includes(T.at(-1))).length, 0);
  assert.ok(r.borrados >= 106 + 2 + metasGremlin);
});

test('el ritmo de cortesía con 3 en vuelo: nunca más de 3 pedidos a la vez y cada uno empieza PAUSA después del anterior, como pronto', async () => {
  let vivos = 0, maxVivos = 0; const inicios = [], PAUSA = 60;   // (el reloj de los timers de libuv es de ms y va «cacheado»: se tolera un cuarto)
  const s = sliderFalso({ tiempos: T.slice(-1) });
  const fetchFn = async (u, o) => { inicios.push(performance.now()); vivos++; maxVivos = Math.max(maxVivos, vivos); await new Promise((r) => setTimeout(r, 90)); vivos--; return s.fetchFn(u, o); };
  await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn, pausaMs: PAUSA, reloj: () => performance.now(), esperar: (ms) => new Promise((r) => setTimeout(r, ms)) });
  assert.ok(maxVivos <= 3, 'en vuelo: ' + maxVivos); assert.equal(P.EN_VUELO_SLIDER, 3); assert.ok(maxVivos > 1, 'con los cuadros, más de uno a la vez');
  for (let i = 1; i < inicios.length; i++) assert.ok(inicios[i] - inicios[i - 1] >= PAUSA * 0.75, 'pedido ' + i + ': ' + Math.round(inicios[i] - inicios[i - 1]) + ' ms');
  assert.ok(inicios.length > 20);
});

test('[Codex n3-r79b-colector · 2] el ritmo se comprueba al ARRANCAR: con los temporizadores vencidos juntos (event loop trabado), los pedidos igual salen separados', async () => {
  let t = 0; const inicios = [], PAUSA = 1000;
  const s = sliderFalso({ tiempos: T.slice(-1) });
  const fetchFn = async (u, o) => { inicios.push(t); await new Promise((r) => setTimeout(r, 1)); return s.fetchFn(u, o); };
  /* cada espera tarda de verdad 3 ms y, al volver, el reloj saltó 10 s: como si el event loop hubiera estado trabado y vencieran todas juntas */
  const esperar = async () => { await new Promise((r) => setTimeout(r, 3)); t += 10 * PAUSA; };
  await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn, pausaMs: PAUSA, reloj: () => t, esperar });
  assert.ok(inicios.length > 20);
  for (let i = 1; i < inicios.length; i++) assert.ok(inicios[i] - inicios[i - 1] >= PAUSA, 'pedido ' + i + ': ' + (inicios[i] - inicios[i - 1]) + ' ms');
});

test('[decisión 7 del maker] con los cuadros NO se escriben las teselas PNG z3-z5: el índice lo dice (png: false) y z3-z5 sale del cuadro', async () => {
  const dir = carpetaTemporal(), s = sliderFalso({ tiempos: T.slice(-1) }), t = T.at(-1), alm = ALM.almacenCarpeta(dir), puts = [];
  const r = await correr({ almacen: { ...alm, escribir: (k, b, o) => { puts.push(k); return alm.escribir(k, b, o); } }, fetchFn: s.fetchFn });
  assert.equal(archivos(dir, '.png').length, 0, 'ni una PNG suelta'); assert.ok(puts.every((k) => !k.endsWith('.png')));
  assert.equal(r.teselas, 0); assert.equal(r.teselas_en_cuadro, 106); assert.equal(r.cuadros, 2); assert.equal(r.completos, 1);
  const ind = leerIndice(dir, 'gremlin'); assert.equal(ind.png, false); assert.deepEqual(ind.cuadro.z, [4, 5]);
  assert.equal(ind.tiempos[t].estado, 'completo'); assert.equal(ind.tiempos[t].n, 106); assert.deepEqual(ind.tiempos[t].c, [4, 5]);
  /* las escrituras por tiempo: 2 cuadros + las metateselas + el índice (antes, además, 106 PNG) */
  assert.equal(puts.length, 2 + metasGremlin + 1);
  /* sin la llave, como en la r77: las 106 PNG y png: true */
  const d2 = carpetaTemporal();
  await correr({ almacen: ALM.almacenCarpeta(d2), fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, cuadros: false, codificarWebp: null });
  assert.equal(archivos(d2, '.png').length, 106); assert.equal(leerIndice(d2, 'gremlin').png, true);
});

test('la llave apagada (cuadros: false): ni un WebP, el índice sin «cuadro» ni «meta», y el script lo apaga con PRECOCIDO_CUADROS=no', async () => {
  const dir = carpetaTemporal();
  await correr({ almacen: ALM.almacenCarpeta(dir), fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, cuadros: false, codificarWebp: null });
  assert.equal(archivos(dir, '.webp').length, 0);
  const ind = leerIndice(dir, 'gremlin'); assert.equal(ind.cuadro, undefined); assert.equal(ind.meta, undefined); assert.equal(ind.tiempos[T.at(-1)].c, undefined);
  await assert.rejects(correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, codificarWebp: null }), /codificador/);
  const script = fs.readFileSync(path.join(RAIZ_REPO, 'gremlin', 'precocido.mjs'), 'utf8');
  assert.match(script, /env\.PRECOCIDO_CUADROS !== 'no'/);
});

test('el registro es PÚBLICO: con los cuadros, la línea final dice sólo cantidades (ni rutas ni URL)', async () => {
  const lineas = [];
  await correr({ almacen: ALM.almacenCarpeta(carpetaTemporal()), fetchFn: sliderFalso({ tiempos: T.slice(-1) }).fetchFn, log: (l) => lineas.push(l) });
  const fin = lineas.at(-1);
  assert.match(fin, /\d+ cuadros \(\d+ sin escribir, [\d.]+ MB\) · \d+ metateselas/);
  assert.ok(lineas.every((l) => !/https?:|slider\/|\.webp|\.png/.test(l)), lineas.join('\n'));
});

test('el workflow: instala sharp con su lock (npm ci) y pasa PRECOCIDO_CUADROS y el tope de 300; sharp con versión fija', () => {
  const y = fs.readFileSync(path.join(RAIZ_REPO, 'gremlin', 'precocido.workflow.yml.txt'), 'utf8');
  assert.match(y, /npm ci --prefix gremlin --no-audit --no-fund/);
  assert.match(y, /PRECOCIDO_CUADROS: \$\{\{ vars\.PRECOCIDO_CUADROS \|\| 'si' \}\}/);
  assert.match(y, /'300'/);
  const pk = JSON.parse(fs.readFileSync(path.join(RAIZ_REPO, 'gremlin', 'package.json'), 'utf8'));
  assert.match(pk.dependencies.sharp, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(fs.readFileSync(path.join(RAIZ_REPO, 'gremlin', 'package-lock.json'), 'utf8'));
  assert.ok(lock.packages['node_modules/@img/sharp-linux-x64'], 'el binario de Linux (Actions) está en el lock');
});
