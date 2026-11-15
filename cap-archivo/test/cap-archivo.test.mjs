// node --test cap-archivo/test/cap-archivo.test.mjs   (sin red: el SMN y GitHub son falsos; ver falsos.mjs)
// El archivo del índice CAP (225): un pedido al índice por corrida, los XML nuevos una sola vez (por URL y por hash),
// la lista blanca de la 222, el corte ante un 429 con pausa, avisos separados de fallas y registro_procesos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correr, desempaquetar, RE_SOBRE, PROCESO, esFalla, codigoSalida, notasRelease, tagDe } from '../lib/flujo.mjs';
import { crearPedidor, leerIndice, INDICE_URL, UA, CARPETAS, minutosDePausa } from '../lib/smn.mjs';
import { leerEstado, RE_ESTADO } from '../lib/estado.mjs';
import { INDICE_1426, smnFalso, almacenFalso, baseFalsa, indiceCon, capDe } from './falsos.mjs';

const AHORA = Date.parse('2026-11-14T17:30:00Z');   // 14:30 ART
const MIN = 60000;
const XG = (n) => `https://ssl.smn.gob.ar/feeds/CAP/xml_generados/CAP_20261114154119_Tormenta_Llanura_alertas_alertas_${n}.xml`;

async function corrida({ smn, alm, base = baseFalsa(), ms = AHORA, tope, seco = false, pausaMs = 0, dormir = async () => {} }) {
  const pedidor = crearPedidor({ fetchFn: smn.fetchFn, pausaMs, dormir });
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
  assert.deepEqual(f.resumen.xml, { en_indice: 96, ya_guardados: 0, pendientes: 96, pedidos: 96, nuevos: 96, repetidos_hash: 0, no_disponibles: 0, cortados: 0, sin_pedir: 0 });
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
  assert.deepEqual({ ...r.base.filas[0].resumen.xml }, { en_indice: 96, ya_guardados: 96, pendientes: 0, pedidos: 0, nuevos: 0, repetidos_hash: 0, no_disponibles: 0, cortados: 0, sin_pedir: 0 });
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
