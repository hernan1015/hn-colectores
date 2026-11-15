// node --test cap-archivo/test/cap-archivo.test.mjs   (sin red: el SMN y GitHub son falsos; ver falsos.mjs)
// El archivo del índice CAP (225): un pedido al índice por corrida, los XML nuevos una sola vez (por URL y por hash),
// la lista blanca de la 222, el corte ante un 429 con pausa, avisos separados de fallas y registro_procesos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correr, desempaquetar, RE_SOBRE, PROCESO, esFalla, codigoSalida, notasRelease, tagDe } from '../lib/flujo.mjs';
import { crearPedidor, leerIndice, INDICE_URL, UA, CARPETAS, minutosDePausa, segundosRetryAfter, cuerpoDe, bytesDe, sha256 } from '../lib/smn.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerEstado, RE_ESTADO } from '../lib/estado.mjs';
import { INDICE_1426, smnFalso, almacenFalso, baseFalsa, indiceCon, capDe } from './falsos.mjs';

const AHORA = Date.parse('2026-11-14T17:30:00Z');   // 14:30 ART
const MIN = 60000;
const XG = (n) => `https://ssl.smn.gob.ar/feeds/CAP/xml_generados/CAP_20261114154119_Tormenta_Llanura_alertas_alertas_${n}.xml`;

async function corrida({ smn, alm, base = baseFalsa(), ms = AHORA, tope, seco = false, pausaMs = 0, dormir = async () => {} }) {
  const pedidor = crearPedidor({ fetchFn: smn.fetchFn, pausaMs, dormir, ahora: () => ms });
  const r = await correr({ cliente: alm.cliente, pedidor, base, seco, ahora: () => ms, ...(tope ? { tope } : {}) });
  return { ...r, pedidor, base };
}
const sobres = (alm, tag = tagDe(AHORA)) => [...alm.rels.get(tag).archivos.entries()].filter(([n]) => RE_SOBRE.test(n)).sort().map(([n, b]) => ({ n, s: desempaquetar(b) }));
const estadoDe = (alm, tag = tagDe(AHORA)) => { const e = [...alm.rels.get(tag).archivos.entries()].filter(([n]) => RE_ESTADO.test(n)); assert.equal(e.length, 1, 'un solo estado'); return leerEstado(e[0][1]); };
const tipos = (r) => r.avisos.map((a) => a.tipo).sort();

test('el índice real del 14/11 14:26: 96 ítems, 96 XML en la lista blanca (93 + 1 ACP + 2 de calor), nada fuera', () => {
  const l = leerIndice(INDICE_1426);
  assert.equal(l.items, 96); assert.equal(l.abiertos, 96); assert.equal(l.entero, true);
  assert.equal(l.enlaces.length, 96);
  assert.deepEqual(l.por_carpeta, { xml_generados: 93, avisocortoplazo: 1, oladecalor: 2 });
  assert.deepEqual(l.fuera, {}); assert.equal(l.raros, 0);
  assert.deepEqual([...CARPETAS], ['xml_generados', 'avisocortoplazo', 'oladecalor']);
});

test('primera corrida: UN pedido al índice y UNO por cada XML, con el User-Agent; todo guardado con su hora y registrado', async () => {
  const smn = smnFalso(), alm = almacenFalso();
  const r = await corrida({ smn, alm });
  assert.equal(smn.pedidos.filter((p) => p.url === INDICE_URL).length, 1, 'el índice una sola vez');
  assert.equal(smn.pedidos.length, 97);
  assert.equal(new Set(smn.pedidos.map((p) => p.url)).size, 97, 'ninguna URL dos veces');
  assert.ok(smn.pedidos.every((p) => p.ua === UA && /hn-colectores-cap-archivo/.test(p.ua)));
  assert.ok(smn.pedidos.every((p) => /^https?:\/\/(ssl|forms)\.smn\.gob\.ar\//.test(p.url)), 'sólo al SMN');
  const [{ n, s }] = sobres(alm);
  assert.match(n, /^20261114T173000Z\.cap\.json\.gz$/);
  assert.equal(s.pedido_utc, '2026-11-14T17:30:00.000Z'); assert.equal(s.pedido_art, '2026-11-14T14:30:00-03:00');
  assert.equal(s.indice.cuerpo, INDICE_1426, 'el índice ENTERO, tal cual');
  assert.equal(s.xml.length, 96); assert.ok(s.xml.every((x) => x.cuerpo === capDe(x.url) && x.sha256 && x.http === 200));
  assert.match(s.licencia, /CC BY 4\.0/);
  assert.equal(alm.rels.get('smn-cap-2026-11-14').notas, notasRelease('2026-11-14'));
  assert.match(notasRelease('x'), /Servicio Meteorológico Nacional.*CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/deed\.es\)/s);
  assert.equal(r.codigo, 0); assert.deepEqual(tipos(r), ['estado_nuevo']);
  assert.equal(r.base.filas.length, 1);
  const f = r.base.filas[0];
  assert.equal(f.proceso, PROCESO); assert.equal(f.ok, true);
  assert.equal(f.resumen.pedidos, 97);
  assert.equal(f.resumen.indice.items, 96); assert.equal(f.resumen.indice.nuevo, true);
  assert.deepEqual(f.resumen.xml, { en_indice: 96, ya_guardados: 0, ya_fallidos: 0, pendientes: 96, pedidos: 96, nuevos: 96, repetidos_hash: 0, no_disponibles: 0, redirigidos: 0, cortados: 0, sin_pedir: 0 });
  assert.equal(Object.keys(estadoDe(alm).urls).length, 96);
});

test('segunda corrida con el mismo índice: sólo el índice (1 pedido), guardado como referencia por hash', async () => {
  const smn = smnFalso(), alm = almacenFalso();
  await corrida({ smn, alm });
  const r = await corrida({ smn, alm, ms: AHORA + 10 * MIN });
  assert.equal(smn.pedidos.length, 98, 'un pedido más: el índice');
  const ss = sobres(alm);
  assert.equal(ss.length, 2, 'la hora queda guardada igual');
  assert.equal(ss[1].s.indice.cuerpo, undefined); assert.equal(ss[1].s.indice.igual_a, ss[0].n);
  assert.equal(ss[1].s.indice.sha256, ss[0].s.indice.sha256);
  assert.equal(ss[1].s.xml.length, 0);
  assert.equal(r.codigo, 0); assert.deepEqual(tipos(r), []);
  assert.deepEqual({ ...r.base.filas[0].resumen.xml }, { en_indice: 96, ya_guardados: 96, ya_fallidos: 0, pendientes: 0, pedidos: 0, nuevos: 0, repetidos_hash: 0, no_disponibles: 0, redirigidos: 0, cortados: 0, sin_pedir: 0 });
  assert.equal(r.base.filas[0].resumen.indice.nuevo, false);
});

test('un aviso nuevo en el índice: se pide SÓLO ese', async () => {
  const smn = smnFalso({ indice: indiceCon([XG(1), XG(2)]) }), alm = almacenFalso();
  await corrida({ smn, alm });
  const smn2 = smnFalso({ indice: indiceCon([XG(1), XG(2), XG(3)]) });
  const r = await corrida({ smn: smn2, alm, ms: AHORA + 10 * MIN });
  assert.deepEqual(smn2.pedidos.map((p) => p.url), [INDICE_URL, XG(3)]);
  assert.equal(r.resumen.xml.nuevos, 1); assert.equal(r.resumen.xml.ya_guardados, 2);
  assert.ok(sobres(alm)[1].s.indice.cuerpo, 'el índice cambió: va entero');
});

test('dedup por hash: dos URL con el mismo contenido se guardan una vez (la otra, referencia)', async () => {
  const igual = capDe('mismo');
  const smn = smnFalso({ indice: indiceCon([XG(1), XG(2)]), rutas: { [XG(1)]: { status: 200, cuerpo: igual }, [XG(2)]: { status: 200, cuerpo: igual } } });
  const alm = almacenFalso();
  const r = await corrida({ smn, alm });
  const [{ n, s }] = sobres(alm);
  assert.equal(s.xml[0].cuerpo, igual); assert.equal(s.xml[1].cuerpo, undefined); assert.equal(s.xml[1].igual_a, n);
  assert.equal(r.resumen.xml.nuevos, 1); assert.equal(r.resumen.xml.repetidos_hash, 1);
});

test('429 en el índice: corta (ni un XML), FALLA smn_corto, pausa; dentro de la pausa NO se le pide nada al SMN', async () => {
  const alm = almacenFalso();
  const smn = smnFalso({ rutas: { [INDICE_URL]: { status: 429, cuerpo: 'Too Many', headers: { 'Retry-After': '120' } } } });
  const r = await corrida({ smn, alm });
  assert.equal(smn.pedidos.length, 1);
  assert.equal(r.codigo, 2); assert.ok(r.avisos.some((a) => a.tipo === 'smn_corto' && a.motivo === 'http_429'));
  assert.equal(r.base.filas[0].ok, false);
  assert.equal(sobres(alm)[0].s.indice.http, 429, 'la falla también queda guardada con su hora');
  const e = estadoDe(alm);
  assert.equal(e.pausa_motivo, 'http_429'); assert.equal(e.pausa_hasta, AHORA + 60 * MIN);
  const smn2 = smnFalso();
  const r2 = await corrida({ smn: smn2, alm, ms: AHORA + 30 * MIN });
  assert.equal(smn2.pedidos.length, 0, 'en pausa: cero pedidos');
  assert.equal(r2.codigo, 0); assert.ok(r2.avisos.some((a) => a.tipo === 'en_pausa'));
  assert.equal(r2.base.filas[0].resumen.pedidos, 0);
  const r3 = await corrida({ smn: smn2, alm, ms: AHORA + 61 * MIN });
  assert.equal(smn2.pedidos.filter((p) => p.url === INDICE_URL).length, 1, 'pasada la pausa, vuelve a pedir');
  assert.equal(r3.codigo, 0);
});

test('429 a mitad de los XML: deja de pedir; el cortado se reintenta UNA vez en otra corrida, nunca más', async () => {
  const alm = almacenFalso();
  const links = [XG(1), XG(2), XG(3), XG(4)];
  const smn = smnFalso({ indice: indiceCon(links), rutas: { [XG(2)]: { status: 429, cuerpo: '' } } });
  const r = await corrida({ smn, alm });
  assert.deepEqual(smn.pedidos.map((p) => p.url), [INDICE_URL, XG(1), XG(2)], 'después del 429 no se pide nada');
  assert.equal(r.codigo, 2); assert.equal(r.resumen.xml.cortados, 1); assert.equal(r.resumen.xml.sin_pedir, 2);
  assert.equal(estadoDe(alm).urls[XG(2)].intentos, 1); assert.equal(estadoDe(alm).urls[XG(2)].final, false);
  // pasada la pausa: XG(2) otra vez 429 → queda final; XG(3) y XG(4) no se piden (cortó)
  const smn2 = smnFalso({ indice: indiceCon(links), rutas: { [XG(2)]: { status: 429, cuerpo: '' } } });
  await corrida({ smn: smn2, alm, ms: AHORA + 61 * MIN });
  assert.deepEqual(smn2.pedidos.map((p) => p.url), [INDICE_URL, XG(2)]);
  assert.equal(estadoDe(alm).urls[XG(2)].final, true);
  const smn3 = smnFalso({ indice: indiceCon(links) });
  await corrida({ smn: smn3, alm, ms: AHORA + 125 * MIN });
  assert.deepEqual(smn3.pedidos.map((p) => p.url), [INDICE_URL, XG(3), XG(4)], 'XG(2) ya no se pide');
});

test('403, 5xx y sin conexión también cortan', async () => {
  for (const [ruta, motivo] of [[{ status: 403, cuerpo: '' }, 'http_403'], [{ status: 503, cuerpo: '' }, 'http_5xx'], [{ lanzar: 'ECONNRESET' }, 'red']]) {
    const smn = smnFalso({ indice: indiceCon([XG(1), XG(2), XG(3)]), rutas: { [XG(1)]: ruta } });
    const r = await corrida({ smn, alm: almacenFalso() });
    assert.equal(smn.pedidos.length, 2, motivo);
    assert.ok(r.avisos.some((a) => a.tipo === 'smn_corto' && a.motivo === motivo), motivo);
  }
  assert.equal(minutosDePausa('http_429', '7200'), 120, 'un Retry-After más largo se respeta');
  assert.equal(minutosDePausa('http_429', '5'), 60);
});

test('un XML 404: aviso de ESTADO (no rojo), no corta y no se vuelve a pedir', async () => {
  const alm = almacenFalso();
  const smn = smnFalso({ indice: indiceCon([XG(1), XG(2)]), rutas: { [XG(1)]: { status: 404, cuerpo: 'no' } } });
  const r = await corrida({ smn, alm });
  assert.equal(smn.pedidos.length, 3);
  assert.equal(r.codigo, 0); assert.ok(r.avisos.some((a) => a.tipo === 'xml_no_disponible' && !esFalla(a)));
  assert.equal(r.base.filas[0].ok, true);
  const smn2 = smnFalso({ indice: indiceCon([XG(1), XG(2)]) });
  await corrida({ smn: smn2, alm, ms: AHORA + 10 * MIN });
  assert.deepEqual(smn2.pedidos.map((p) => p.url), [INDICE_URL]);
});

test('lista blanca: una carpeta nueva del SMN y un link de otro host NO se piden y son FALLA; el índice se guarda igual', async () => {
  const otra = 'https://ssl.smn.gob.ar/feeds/CAP/nuevacarpeta/a.xml', ajeno = 'https://ejemplo.com/feeds/CAP/xml_generados/b.xml', cortado = 'https://ssl.smn.gob.ar/feeds/CAP/xml_gen';
  const smn = smnFalso({ indice: indiceCon([XG(1), otra, ajeno, cortado]) }), alm = almacenFalso();
  const r = await corrida({ smn, alm });
  assert.deepEqual(smn.pedidos.map((p) => p.url), [INDICE_URL, XG(1)]);
  assert.equal(r.codigo, 2);
  assert.ok(r.avisos.some((a) => a.tipo === 'carpeta_nueva' && a.carpeta === 'nuevacarpeta'));
  assert.ok(r.avisos.some((a) => a.tipo === 'enlace_raro' && a.n === 2));
  assert.ok(sobres(alm)[0].s.indice.cuerpo.includes('nuevacarpeta'));
});

test('índice cortado o que no es RSS: FALLA (pero se guarda)', async () => {
  const smn = smnFalso({ indice: INDICE_1426.slice(0, 30000) });
  const r = await corrida({ smn, alm: almacenFalso() });
  assert.equal(r.codigo, 2); assert.ok(r.avisos.some((a) => a.tipo === 'indice_cortado'));
  const r2 = await corrida({ smn: smnFalso({ indice: '<html>mantenimiento</html>' }), alm: almacenFalso() });
  assert.ok(r2.avisos.some((a) => a.tipo === 'indice_no_rss')); assert.equal(r2.codigo, 2);
  const r3 = await corrida({ smn: smnFalso({ rutas: { [INDICE_URL]: { status: 404, cuerpo: '' } } }), alm: almacenFalso() });
  assert.ok(r3.avisos.some((a) => a.tipo === 'indice_http')); assert.equal(r3.codigo, 2);
});

test('índice sin avisos (canal vacío) es válido: ok, sin pedidos de XML', async () => {
  const smn = smnFalso({ indice: indiceCon([]) });
  const r = await corrida({ smn, alm: almacenFalso() });
  assert.equal(smn.pedidos.length, 1); assert.equal(r.codigo, 0);
});

test('tope por corrida: pide sólo `tope` XML, aviso de estado, y la próxima sigue donde quedó', async () => {
  const smn = smnFalso(), alm = almacenFalso();
  const r = await corrida({ smn, alm, tope: 10 });
  assert.equal(smn.pedidos.length, 11); assert.equal(r.codigo, 0);
  assert.ok(r.avisos.some((a) => a.tipo === 'tope' && a.sin_pedir === 86));
  const smn2 = smnFalso();
  await corrida({ smn: smn2, alm, ms: AHORA + 10 * MIN, tope: 10 });
  const vistos = new Set(smn.pedidos.map((p) => p.url).filter((u) => u !== INDICE_URL));
  assert.ok(smn2.pedidos.filter((p) => p.url !== INDICE_URL).every((p) => !vistos.has(p.url)), 'ninguna URL repetida');
});

test('pausa entre pedidos: se duerme ANTES de cada pedido salvo el primero', async () => {
  let dormidas = 0;
  const smn = smnFalso({ indice: indiceCon([XG(1), XG(2), XG(3)]) });
  await corrida({ smn, alm: almacenFalso(), pausaMs: 1500, dormir: async (ms) => { assert.equal(ms, 1500); dormidas++; } });
  assert.equal(dormidas, 3);
});

test('el pedidor no repite una URL ni pide después de un corte', async () => {
  const smn = smnFalso({ rutas: { [XG(9)]: { status: 429, cuerpo: '' } } });
  const p = crearPedidor({ fetchFn: smn.fetchFn, pausaMs: 0 });
  assert.equal((await p.pedir(XG(1))).pedido, true);
  assert.deepEqual(await p.pedir(XG(1)), { url: XG(1), pedido: false, motivo: 'ya_pedida' });
  await p.pedir(XG(9));
  assert.equal((await p.pedir(XG(2))).motivo, 'cortado');
  assert.equal(smn.pedidos.length, 2);
});

test('seco: UN pedido al índice, ni un XML, nada subido ni registrado', async () => {
  const smn = smnFalso(), alm = almacenFalso(), base = baseFalsa();
  const r = await corrida({ smn, alm, base, seco: true });
  assert.equal(smn.pedidos.length, 1);
  assert.equal(alm.rels.size, 0); assert.equal(base.filas.length, 0);
  assert.equal(r.resumen.xml.sin_pedir, 96);
});

test('cambio de día: el estado del día anterior se lee y no se vuelve a pedir nada', async () => {
  const smn = smnFalso(), alm = almacenFalso();
  await corrida({ smn, alm });
  const manana = Date.parse('2026-11-15T03:05:00Z');   // 00:05 ART del 15
  const smn2 = smnFalso();
  const r = await corrida({ smn: smn2, alm, ms: manana });
  assert.equal(r.resumen.tag, 'smn-cap-2026-11-15');
  assert.equal(r.resumen.estado_de, '1 día(s) antes');
  assert.deepEqual(smn2.pedidos.map((p) => p.url), [INDICE_URL]);
  assert.equal(Object.keys(estadoDe(alm, 'smn-cap-2026-11-15').urls).length, 96);
});

test('el día de la release es el argentino: 23:55 ART del 14 va al 14 (en UTC ya es el 15)', async () => {
  const alm = almacenFalso();
  const r = await corrida({ smn: smnFalso({ indice: indiceCon([]) }), alm, ms: Date.parse('2026-11-15T02:55:00Z') });
  assert.equal(r.resumen.tag, 'smn-cap-2026-11-14');
});

test('registro_procesos: sin base o con la base fallando es FALLA (los datos quedan guardados igual)', async () => {
  const alm = almacenFalso();
  const r = await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm, base: null });
  assert.ok(r.avisos.some((a) => a.tipo === 'sin_registro')); assert.equal(r.codigo, 2);
  assert.equal(sobres(alm).length, 1);
  const r2 = await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm: almacenFalso(), base: baseFalsa({ fallar: true }) });
  assert.ok(r2.avisos.some((a) => a.tipo === 'registro_no_anotado')); assert.equal(r2.codigo, 2);
});

test('si no se puede subir el sobre, el estado NO cambia (lo no guardado se vuelve a pedir) y sale 1', async () => {
  const alm = almacenFalso({ fallarSubida: true });
  const r = await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm });
  assert.equal(r.codigo, 1); assert.equal(r.errores.length, 1);
  assert.equal([...alm.rels.get(tagDe(AHORA)).archivos.keys()].length, 0);
});

test('avisos y fallas separados como en la SIPAN: un tipo nuevo cuenta como falla', () => {
  for (const t of ['en_pausa', 'tope', 'xml_no_disponible', 'xml_no_cap', 'estado_nuevo']) assert.equal(esFalla({ tipo: t }), false, t);
  for (const t of ['smn_corto', 'carpeta_nueva', 'enlace_raro', 'indice_cortado', 'indice_no_rss', 'indice_http', 'sin_registro', 'registro_no_anotado', 'otro_nuevo']) assert.equal(esFalla({ tipo: t }), true, t);
  assert.equal(codigoSalida({ avisos: [{ tipo: 'tope' }] }), 0);
  assert.equal(codigoSalida({ avisos: [{ tipo: 'smn_corto' }] }), 2);
  assert.equal(codigoSalida({ avisos: [], errores: ['x'] }), 1);
});

test('el registro de Actions no imprime secretos ni URLs de la base', async () => {
  const { redactar, lineaResumen } = await import('../archivar.mjs');
  const tok = 'ghp_abcdefghijklmnop';
  assert.equal(redactar(`x ${tok} postgresql://colector_cap.x:clave@h.pooler.supabase.com:6543/postgres y`, [tok]), 'x [secreto] [url] y');
  const r = await corrida({ smn: smnFalso(), alm: almacenFalso() });
  assert.match(lineaResumen(r), /índice HTTP 200 .* 96 ítems, 96 XML .* pedidos 97 .* XML nuevos 96/);
});

// ── 2.ª vuelta de Codex (n3-225-1511): una reproducción por cada P2 ──────────────────────────────────────────────────

test('P2-1 · un XML 404 NO pasa a «ya guardado» en la corrida siguiente: va a ya_fallidos', async () => {
  const alm = almacenFalso();
  const links = [XG(1), XG(2), XG(3)];
  await corrida({ smn: smnFalso({ indice: indiceCon(links), rutas: { [XG(1)]: { status: 404, cuerpo: 'no' } } }), alm });
  const r = await corrida({ smn: smnFalso({ indice: indiceCon(links) }), alm, ms: AHORA + 10 * MIN });
  assert.equal(r.resumen.xml.ya_guardados, 2, 'sólo los que tienen su contenido en un asset');
  assert.equal(r.resumen.xml.ya_fallidos, 1, 'el 404 es un faltante, no un guardado');
  const x = r.resumen.xml;
  assert.equal(x.en_indice, x.ya_guardados + x.ya_fallidos + x.pendientes);
  assert.equal(r.base.filas[0].resumen.xml.ya_guardados, 2, 'también en registro_procesos');
});

test('P2-2 · el sobre archiva los pedidos de verdad (índice + XML = 2), sin campos de la subida', async () => {
  const smn = smnFalso({ indice: indiceCon([XG(1)]) }), alm = almacenFalso();
  const r = await corrida({ smn, alm });
  const [{ s }] = sobres(alm);
  assert.equal(r.resumen.pedidos, 2);
  assert.equal(s.resumen.pedidos, 2, 'el número que queda para siempre en el archivo');
  assert.equal('asset' in s.resumen, false); assert.equal('errores' in s.resumen, false); assert.equal('fallas' in s.resumen, false);
});

test('P2-3 · un estado ilegible NO permite saltear la pausa: cero pedidos y FALLA (sin volver a un estado viejo)', async () => {
  const alm = almacenFalso();
  await corrida({ smn: smnFalso({ rutas: { [INDICE_URL]: { status: 429, cuerpo: 'Too Many' } } }), alm });
  const rel = alm.rels.get(tagDe(AHORA));
  const [nombreEstado] = [...rel.archivos.keys()].filter((n) => RE_ESTADO.test(n));
  rel.archivos.set(nombreEstado, Buffer.from('basura, no es gzip'));
  const smn2 = smnFalso();
  const r = await corrida({ smn: smn2, alm, ms: AHORA + 10 * MIN });
  assert.equal(smn2.pedidos.length, 0, 'ni el índice');
  assert.ok(r.avisos.some((a) => a.tipo === 'estado_ilegible' && esFalla(a)));
  assert.equal(r.codigo, 2); assert.equal(r.base.filas[0].ok, false);
  assert.ok(rel.archivos.get(nombreEstado).equals(Buffer.from('basura, no es gzip')), 'el estado roto no se pisa');
  // el día siguiente: el de HOY está roto → no retrocede al de ayer
  const alm2 = almacenFalso();
  await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm: alm2 });
  const manana = Date.parse('2026-11-15T12:00:00Z');
  await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm: alm2, ms: manana });
  const relM = alm2.rels.get(tagDe(manana));
  for (const n of [...relM.archivos.keys()].filter((n) => RE_ESTADO.test(n))) relM.archivos.set(n, Buffer.from('roto'));
  const smn3 = smnFalso({ indice: indiceCon([XG(1)]) });
  const r3 = await corrida({ smn: smn3, alm: alm2, ms: manana + 10 * MIN });
  assert.equal(smn3.pedidos.length, 0); assert.ok(r3.avisos.some((a) => a.tipo === 'estado_ilegible'));
  // a la madrugada siguiente (sin estado de hoy): el de AYER está roto → no salta al de anteayer (que no sabe la pausa)
  const alm3 = almacenFalso();
  const anteayer = AHORA - 864e5;
  await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm: alm3, ms: anteayer });
  await corrida({ smn: smnFalso({ rutas: { [INDICE_URL]: { status: 429, cuerpo: '', headers: { 'Retry-After': '21600' } } } }), alm: alm3 });
  const relA = alm3.rels.get(tagDe(AHORA));
  for (const n of [...relA.archivos.keys()].filter((n) => RE_ESTADO.test(n))) relA.archivos.set(n, Buffer.from('roto'));
  const smn4 = smnFalso();
  const r4 = await corrida({ smn: smn4, alm: alm3, ms: Date.parse('2026-11-15T03:05:00Z') });
  assert.equal(r4.resumen.estado_de, '1 día(s) antes');
  assert.equal(smn4.pedidos.length, 0, 'la pausa de 6 h de ayer sigue vigente'); assert.ok(r4.avisos.some((a) => a.tipo === 'estado_ilegible'));
});

test('P2-4 · un XML que redirige al índice: NO se sigue (un pedido, no dos), es FALLA y queda final', async () => {
  const alm = almacenFalso();
  const smn = smnFalso({ indice: indiceCon([XG(1), XG(2)]), rutas: { [XG(1)]: { status: 302, cuerpo: '', headers: { Location: INDICE_URL } } } });
  const r = await corrida({ smn, alm });
  assert.deepEqual(smn.pedidos.map((p) => p.url), [INDICE_URL, XG(1), XG(2)], 'el índice una sola vez');
  assert.ok(r.avisos.some((a) => a.tipo === 'xml_redirige' && a.n === 1 && esFalla(a))); assert.equal(r.codigo, 2);
  assert.equal(r.resumen.xml.redirigidos, 1);
  assert.equal(sobres(alm)[0].s.xml[0].location, INDICE_URL, 'a dónde mandaba queda anotado');
  const smn2 = smnFalso({ indice: indiceCon([XG(1), XG(2)]) });
  await corrida({ smn: smn2, alm, ms: AHORA + 10 * MIN });
  assert.deepEqual(smn2.pedidos.map((p) => p.url), [INDICE_URL]);
});

test('P2-4 · con fetch de verdad contra un servidor de fixture en 127.0.0.1: el redirect no genera otro pedido', async () => {
  const vistos = [];
  const srv = http.createServer((req, res) => {
    vistos.push(req.url);
    if (req.url === '/aviso.xml') { res.writeHead(302, { Location: '/index' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end('<rss/>');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const p = crearPedidor({ pausaMs: 0 });
    const r = await p.pedir(base + '/aviso.xml');
    assert.equal(r.http, 302); assert.equal(r.location, '/index');
    assert.deepEqual(vistos, ['/aviso.xml'], 'un solo pedido HTTP');
    assert.equal(p.pedidos, 1);
  } finally { await new Promise((ok) => srv.close(ok)); }
});

test('P2-5 · un Retry-After con FECHA HTTP se respeta (3 h → 180 min), desde la hora del pedido', async () => {
  const fecha = new Date(AHORA + 3 * 3600e3).toUTCString();
  assert.equal(segundosRetryAfter(fecha, AHORA), 10800);
  assert.equal(minutosDePausa('http_429', fecha, AHORA), 180);
  assert.equal(minutosDePausa('http_5xx', new Date(AHORA + 30 * 3600e3).toUTCString(), AHORA), 360, 'con el tope de 6 h');
  assert.equal(minutosDePausa('http_429', new Date(AHORA - 3600e3).toUTCString(), AHORA), 60, 'una fecha pasada no acorta');
  assert.equal(minutosDePausa('http_429', 'cualquier cosa', AHORA), 60);
  const alm = almacenFalso();
  await corrida({ smn: smnFalso({ rutas: { [INDICE_URL]: { status: 429, cuerpo: '', headers: { 'Retry-After': fecha } } } }), alm });
  assert.equal(estadoDe(alm).pausa_hasta, AHORA + 180 * MIN);
});

test('P2-6 · un XML y un índice con BOM se archivan byte por byte (el sha256 cierra con lo reconstruido)', async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<alert/>')]);
  assert.equal(bom.length, 11);
  const c = cuerpoDe(bom);
  assert.ok(c.cuerpo.startsWith('﻿'), 'el BOM queda en el texto'); assert.ok(bytesDe(c).equals(bom));
  const latin = Buffer.from([0x3c, 0x61, 0xe1, 0x3e]);   // no es UTF-8 → base64
  assert.ok(bytesDe(cuerpoDe(latin)).equals(latin));
  const conBom = (t) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf8')]);
  const alm = almacenFalso();
  await corrida({ smn: smnFalso({ rutas: { [INDICE_URL]: { status: 200, cuerpo: conBom(indiceCon([XG(1)])) }, [XG(1)]: { status: 200, cuerpo: conBom(capDe(XG(1))) } } }), alm });
  const [{ s }] = sobres(alm);
  assert.equal(s.xml.length, 1);
  for (const x of [s.indice, ...s.xml]) {
    assert.ok(x.cuerpo.startsWith('﻿'), x.url);
    assert.equal(sha256(bytesDe(x)), x.sha256, x.url);
    assert.equal(bytesDe(x).length, x.bytes, x.url);
  }
});

test('P2-7 · si el nombre del sobre ya existía con OTRO contenido, no se guarda el estado (y sale 1); si es igual, sí', async () => {
  const nombre = '20261114T173000Z.cap.json.gz';
  const alm = almacenFalso({ previos: { [tagDe(AHORA)]: { [nombre]: Buffer.from('otro contenido') } } });
  const r = await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm });
  assert.equal(r.codigo, 1); assert.ok(r.errores.some((e) => /otro contenido/.test(e)));
  const rel = alm.rels.get(tagDe(AHORA));
  assert.equal([...rel.archivos.keys()].filter((n) => RE_ESTADO.test(n)).length, 0, 'sin estado que apunte a un XML que no está');
  // el mismo contenido (otra corrida idéntica ya lo subió): está bien, y el estado se guarda
  const a1 = almacenFalso();
  await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm: a1 });
  const igual = a1.rels.get(tagDe(AHORA)).archivos.get(nombre);
  const a2 = almacenFalso({ previos: { [tagDe(AHORA)]: { [nombre]: igual } } });
  const r2 = await corrida({ smn: smnFalso({ indice: indiceCon([XG(1)]) }), alm: a2 });
  assert.equal(r2.codigo, 0); assert.match(r2.resumen.asset, /ya estaba, igual/);
  assert.equal(Object.keys(estadoDe(a2).urls).length, 1);
});

test('P2-8 · comentarios, CDATA y links anidados no se piden; cada link rechazado cuenta (aunque el ítem tenga uno bueno)', async () => {
  const ajeno = 'https://ejemplo.com/feeds/CAP/xml_generados/x.xml';
  const t = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>SMN</title>` +
    `<!--<item><link>${XG(7)}</link></item>-->` +
    `<description><![CDATA[<item><link>${XG(8)}</link></item>]]></description>` +
    `<item><link>${XG(1)}</link><link>${ajeno}</link></item>` +
    `<item><!--<link>${XG(9)}</link>--><x><link>${XG(6)}</link></x></item>` +
    `<item><link><![CDATA[${XG(2)}]]></link></item>` +
    `</channel></rss>\n`;
  const l = leerIndice(t);
  assert.deepEqual(l.enlaces.map((e) => e.url), [XG(1), XG(2)]);
  assert.equal(l.items, 3); assert.equal(l.abiertos, 3);
  assert.equal(l.raros, 2, 'el link ajeno del ítem mixto + el ítem sin link propio');
  const smn = smnFalso({ indice: t });
  const r = await corrida({ smn, alm: almacenFalso() });
  assert.deepEqual(smn.pedidos.map((p) => p.url), [INDICE_URL, XG(1), XG(2)]);
  assert.ok(r.avisos.some((a) => a.tipo === 'enlace_raro' && a.n === 2)); assert.equal(r.codigo, 2);
});

test('P2-9 · los cuerpos de error que llegaron enteros se archivan (índice 429, XML 404 y 503)', async () => {
  const alm = almacenFalso();
  await corrida({ smn: smnFalso({ rutas: { [INDICE_URL]: { status: 429, cuerpo: 'Too Many Requests' } } }), alm });
  const [{ s }] = sobres(alm);
  assert.equal(s.indice.cuerpo, 'Too Many Requests'); assert.equal(sha256(bytesDe(s.indice)), s.indice.sha256);
  const alm2 = almacenFalso();
  await corrida({ smn: smnFalso({ indice: indiceCon([XG(1), XG(2)]), rutas: { [XG(1)]: { status: 404, cuerpo: 'no está' }, [XG(2)]: { status: 503, cuerpo: 'mantenimiento' } } }), alm: alm2 });
  const [{ s: s2 }] = sobres(alm2);
  assert.equal(s2.xml[0].cuerpo, 'no está'); assert.equal(s2.xml[1].cuerpo, 'mantenimiento');
  const e = estadoDe(alm2);
  assert.equal(e.urls[XG(1)].asset, null, 'un cuerpo de error no cuenta como aviso guardado');
  assert.equal(e.urls[XG(1)].final, true); assert.equal(e.urls[XG(2)].final, false, 'el corte sigue con su reintento');
});

test('P2-10 · los comandos de activación van sin comillas escapadas (la clave y la URL llegan limpias)', () => {
  const AQUI = path.dirname(fileURLToPath(import.meta.url));
  const prender = fs.readFileSync(path.join(AQUI, '..', 'PRENDER.md'), 'utf8');
  const sql = fs.readFileSync(path.join(AQUI, '..', 'migracion', '0225_rol_colector_cap.sql'), 'utf8');
  const VERIF = 'VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)';
  const PSQL = 'psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f cap-archivo/migracion/0225_rol_colector_cap.sql';
  for (const [n, txt] of [['PRENDER.md', prender], ['0225', sql]]) {
    assert.ok(txt.includes(VERIF), n + ': el verificador'); assert.ok(txt.includes(PSQL), n + ': psql');
    assert.equal(txt.includes('\\"'), false, n + ': ninguna \\" (pasaría las comillas como parte de la clave)');
  }
});

// ── 3.ª vuelta (n3-225-v2-1511) ──
// P2 · un estado LISTADO cuya descarga da 404: con el cliente de releases REAL y un fetch completamente falso.
function githubFalso({ hoy = null, ayer = null } = {}) {
  // hoy/ayer: { id, assets: [{ id, name, buf | null (404) }] } o null (la release no existe: 404)
  const pedidos = [];
  const rels = { [tagDe(Date.parse('2026-11-15T12:00:00Z'))]: hoy, [tagDe(Date.parse('2026-11-14T12:00:00Z'))]: ayer };
  const res = (status, cuerpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    arrayBuffer: async () => (Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(String(cuerpo))) });
  const fetchFn = async (url, opts = {}) => {
    pedidos.push(`${opts.method || 'GET'} ${url}`);
    if ((opts.method || 'GET') === 'POST' && /\/releases$/.test(url)) {   // la release del día, nueva y vacía
      const { tag_name } = JSON.parse(opts.body);
      rels[tag_name] = { id: 100 + Object.keys(rels).length, assets: [] };
      return res(201, { id: rels[tag_name].id, tag_name });
    }
    if ((opts.method || 'GET') !== 'GET') return res(500, 'no se escribe nada en este test');
    let m = /\/releases\/tags\/([^/?]+)$/.exec(url);
    if (m) { const r = rels[decodeURIComponent(m[1])]; return r ? res(200, { id: r.id, tag_name: decodeURIComponent(m[1]) }) : res(404, '{}'); }
    m = /\/releases\/(\d+)\/assets\?per_page=100&page=(\d+)$/.exec(url);
    if (m) {
      const r = Object.values(rels).find((x) => x && x.id === +m[1]);
      return res(200, m[2] === '1' && r ? r.assets.map((a) => ({ id: a.id, name: a.name, state: 'uploaded', size: 10 })) : []);
    }
    m = /\/releases\/assets\/(\d+)$/.exec(url);
    if (m) {
      const a = Object.values(rels).flatMap((x) => (x ? x.assets : [])).find((x) => x.id === +m[1]);
      return a && a.buf ? res(200, a.buf) : res(404, 'Not Found');
    }
    return res(404, '{}');
  };
  return { fetchFn, pedidos };
}

test('3.ª P2 · un estado listado cuya descarga da 404 es ILEGIBLE: cero pedidos al SMN, en seco y en real (cliente real, fetch falso)', async () => {
  const { clienteReleases } = await import('../../lib/releases.mjs');
  const { empaquetarEstado, vacio } = await import('../lib/estado.mjs');
  const ms = Date.parse('2026-11-15T12:00:00Z');
  const sano = empaquetarEstado(vacio());
  for (const [que, gh] of [
    ['la reproducción de Codex: el único estado de hoy da 404 (y ayer no hay release)', { hoy: { id: 1, assets: [{ id: 7, name: 'estado__20261115T115000.json.gz', buf: null }] } }],
    ['hay otro estado sano en la misma release', { hoy: { id: 1, assets: [{ id: 7, name: 'estado__20261115T115000.json.gz', buf: null }, { id: 8, name: 'estado__20261115T114000.json.gz', buf: sano }] } }],
    ['sin release de hoy: el estado de ayer da 404 (no salta a anteayer ni arranca vacío)', { ayer: { id: 2, assets: [{ id: 9, name: 'estado__20261114T235000.json.gz', buf: null }] } }],
  ]) {
    for (const seco of [true, false]) {
      const g = githubFalso(gh);
      const cliente = clienteReleases({ token: 'x', repo: 'dueno/repo', fetchFn: g.fetchFn });
      const smn = smnFalso();
      const pedidor = crearPedidor({ fetchFn: smn.fetchFn, pausaMs: 0, dormir: async () => {}, ahora: () => ms });
      const base = baseFalsa();
      const r = await correr({ cliente, pedidor, base, seco, ahora: () => ms });
      const q = `${que} (${seco ? 'seco' : 'real'})`;
      assert.equal(smn.pedidos.length, 0, q + ': ni el índice');
      assert.ok(r.avisos.some((a) => a.tipo === 'estado_ilegible' && esFalla(a)), q + ': ' + JSON.stringify(r.avisos));
      assert.ok(!r.avisos.some((a) => a.tipo === 'estado_nuevo'), q + ': no arranca vacío');
      assert.equal(r.codigo, 2, q);
      if (seco) assert.ok(!g.pedidos.some((p) => !p.startsWith('GET ')), q + ': en seco no se escribe nada en GitHub');
      else assert.ok(!g.pedidos.some((p) => /\/assets\?name=|DELETE /.test(p)), q + ': ni sobre, ni estado, ni borrado');
    }
  }
  // control: el mismo cliente real con el estado sano solo SÍ sigue (la descarga ausente es lo que frena)
  const g = githubFalso({ hoy: { id: 1, assets: [{ id: 8, name: 'estado__20261115T114000.json.gz', buf: sano }] } });
  const smn = smnFalso({ indice: indiceCon([XG(1)]) });
  const pedidor = crearPedidor({ fetchFn: smn.fetchFn, pausaMs: 0, dormir: async () => {}, ahora: () => ms });
  const r = await correr({ cliente: clienteReleases({ token: 'x', repo: 'dueno/repo', fetchFn: g.fetchFn }), pedidor, seco: true, ahora: () => ms });
  assert.deepEqual(smn.pedidos.map((p) => p.url), [INDICE_URL], 'en seco: sólo el índice');
  assert.ok(!r.avisos.some((a) => a.tipo === 'estado_ilegible'));
});

test('3.ª P2 · un <!DOCTYPE o <!ENTITY en el índice es FALLA y no se pide ningún XML (la entidad sin usar ya no fabrica un ítem)', async () => {
  const x = 'https://ssl.smn.gob.ar/feeds/CAP/xml_generados/x.xml';
  const codex = `<!DOCTYPE rss [<!ENTITY unused "> <rss><channel><item><link>${x}</link></item></channel></rss>">]><rss><channel></channel></rss>`;
  const l = leerIndice(codex);
  assert.equal(l.dtd, true); assert.equal(l.items, 0); assert.deepEqual(l.enlaces, []);
  for (const [que, t] of [
    ['la reproducción de Codex', codex],
    ['DOCTYPE simple delante de un índice bueno', '<?xml version="1.0"?>\n<!DOCTYPE rss>\n' + indiceCon([XG(1)]).replace(/^<\?xml[^>]*>\n/, '')],
    ['ENTITY suelta adentro del canal', indiceCon([XG(1)]).replace('<channel>', '<channel><!ENTITY e "x">')],
    ['doctype en minúsculas', indiceCon([XG(1)]).replace('<rss', '<!doctype rss><rss')],
  ]) {
    const smn = smnFalso({ indice: t }), alm = almacenFalso();
    const r = await corrida({ smn, alm });
    assert.deepEqual(smn.pedidos.map((p) => p.url), [INDICE_URL], que + ': sólo el índice, ningún XML');
    assert.ok(r.avisos.some((a) => a.tipo === 'indice_dtd' && esFalla(a)), que);
    assert.equal(r.codigo, 2, que); assert.equal(r.resumen.indice.items, 0, que); assert.equal(r.resumen.xml.pedidos, 0, que);
    const [{ s }] = sobres(alm);
    assert.equal(s.xml.length, 0, que + ': el sobre no archiva XML');
  }
  // el índice real sigue igual (sin DTD)
  assert.equal(leerIndice(INDICE_1426).dtd, undefined);
});
