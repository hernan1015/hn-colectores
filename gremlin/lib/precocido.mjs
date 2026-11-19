// HN AGRO · [r77 · 18/11/2026] LAS TESELAS DE SATCHI YA REPROYECTADAS («PRECOCIDAS»): GeoColor, visible (banda 2) y GREMLIN de
// CIRA/RAMMB SLIDER, en el depósito PÚBLICO de SATCHI, para que la película satelital arranque en 1-2 s. Ver gremlin/LEEME-precocido.md.
//
// Una corrida, por cada producto: 1 pedido a latest_times.json; después, los tiempos que faltan dentro de la retención, DEL MÁS NUEVO
// AL MÁS VIEJO (la película arranca por el último), intercalando los productos. Para cada tiempo se piden las nativas de SLIDER que
// hacen falta para TODAS sus teselas de Leaflet de Z_MIN a Z_MAX dentro del recorte del relevo, se reproyecta cada tesela con LA MISMA
// cuenta que el relevo (lib/satelite-slider.copia.mjs, copia textual del de hn-agro) y se guarda en
//     slider/{producto}/{tiempo}/{z}/{x}/{y}.png        (inmutable: un tiempo cerrado de SLIDER no cambia)
//     slider/{producto}/indice.json                     (qué tiempos están, completos o no; lo lee el relevo de hn-agro)
// LA REGLA DE LA _v1829: un fallo parcial nunca es una imagen buena. Una tesela a la que le faltó una nativa NO SE ESCRIBE (la página y el
// relevo, al no encontrarla, van a CIRA como hoy); el tiempo queda «incompleto» con la cantidad que falta, y se reintenta.
// EL ORDEN DE LAS ESCRITURAS: primero las teselas, después el índice (el índice nunca nombra un tiempo cuyas teselas no estén). Al borrar,
// al revés: primero el índice (el tiempo deja de figurar), después las teselas.
// LA RETENCIÓN: RETENCION_H (6 h por defecto; de 1 a 24), medida contra SLIDER (el tiempo más nuevo de latest_times), no contra el reloj.
// [Codex n3-r77-colector · 1 y 2] EL BORRADO ES DIFERIDO: un tiempo vencido sale del índice y pasa a `borrar` con la hora en que salió;
// sus teselas se borran recién en una corrida POSTERIOR, a más de ESPERA_BORRADO_MS (5 min: el max-age del índice, 30 s, la memoria del
// relevo, 60 s, y margen). `tiempos` y `borrar` tienen que ser disjuntos; `borrar` sólo acepta tiempos con forma válida, que ya
// salieron del índice y que están vencidos según SLIDER. Si el índice no valida, o el reloj y SLIDER difieren en más de 1 h, NO SE BORRA
// NADA. DELETE de R2 es gratis; con un tope por corrida, lo que no se llegó a borrar queda para la próxima.
// [Codex n3-r77 pelicula · 3] LA HORA EN EL PNG: cada tesela lleva un chunk tEXt «hn-slider» = «producto/tiempo/z/x/y»; el relevo de hn-agro
// sirve una tesela del depósito sólo si su etiqueta es exactamente la pedida (un PNG íntegro de otra hora o de otro lugar no pasa).
// [r77 · reintento, 18/11] LOS 5xx Y LOS ERRORES DE RED DE R2 SE REINTENTAN (la primera corrida real cortó con un 500 al 5.º tiempo):
// cada PUT y cada DELETE, hasta REINTENTO_ESPERAS_MS.length + 1 intentos, con espera exponencial y jitter, sin pasarse del presupuesto de
// la corrida (PRESUPUESTO_MS, debajo del timeout de 9 min del workflow). Un 4xx NO se reintenta: es configuración (403, 400) y corta,
// como antes. Una tesela que no se pudo escribir deja su tiempo SIN PUBLICAR (el índice no lo nombra ni le cuenta un intento: la
// próxima corrida lo rehace) y la corrida sigue con el siguiente; con TOPE_ESCRITURAS_FALLIDAS fallidas en la corrida, se corta
// (error:almacen tope-de-fallas). La escritura del índice se reintenta igual; si al final falla, en esa corrida NO SE BORRA NADA.
// En el registro: «reintento:almacen http 500 (2/4)» y el total al final. Nunca el mensaje.
// El almacén (R2 o carpeta) y fetch vienen de afuera, para probar sin red. Se imprimen SÓLO CANTIDADES (el registro de Actions es público).
//
// [r79 · punto 1 · la opción 1-bis del maker, 19/11] LA PELÍCULA EN MENOS DE 10 s: además de las teselas, por cada tiempo,
//   · UN CUADRO ENTERO en WebP por zoom de Z_CUADRO (4 y 5): el mosaico de TODAS las teselas de ese zoom del recorte, en una sola imagen
//         slider/{producto}/{tiempo}/c/{z}.webp          (z4: 1280 × 1280 px; z5: 2048 × 2304 px; la página dibuja z3 con el de z4)
//   · METATESELAS de 1024 px (4 × 4 teselas) sobre la Argentina (CAJA_META), en los zooms de Z_META (6-7; 6-8 en el visible; 6 en GREMLIN)
//         slider/{producto}/{tiempo}/m/{z}/{mx}/{my}.webp   (mx = x div 4, my = y div 4)
//     Sólo el zoom más alto de cada producto se reproyecta (con la cuenta del relevo); los de abajo salen de REDUCIR a la mitad el de
//     arriba (promedio 2 × 2 con el alfa): así no se piden más nativas que las del zoom más alto.
//   Así la película pide 18 imágenes (o unas pocas metateselas por cuadro) en lugar de ~70 teselas por cuadro.
//   LAS MISMAS REGLAS: un cuadro o una metatesela se escribe SÓLO si todas sus teselas salieron enteras (la regla de la _v1829: lo que
//   no está, la página lo pide tesela por tesela, como hoy); se escribe ANTES del índice, que lo nombra después (`c`: los zooms de cuadro
//   escritos; `m`: las metateselas escritas, las que faltan y las vacías de noche); el borrado diferido las incluye; cada WebP lleva su
//   ETIQUETA en un chunk XMP (<hn-slider>producto/tiempo/c/z</hn-slider> o …/m/z/mx/my), que la página exige exacta.
//   EL VISIBLE DE NOCHE: una metatesela entera sin sol no se escribe (ni se piden sus nativas): el índice la nombra en `m.vacias`, y con la
//   caja entera de noche, `m.noche` = true. La página la dibuja transparente y dice «sin luz solar», como hoy.
//   LA LLAVE: `cuadros` (en el script, PRECOCIDO_CUADROS; «no» la apaga y el colector queda exactamente como en la r77). Con la llave
//   prendida, las nativas de SLIDER se piden de a EN_VUELO_SLIDER (3) a la vez, con el mismo ritmo de cortesía: una por PAUSA_MS como
//   máximo (1 s), contadas desde el comienzo de cada pedido; así un tiempo de los tres productos (~180 nativas) entra en la corrida.
//   El WebP lo arma `codificarWebp(rgba, w, h, etiqueta, producto)`, que viene de afuera (gremlin/webp.mjs, con sharp): esta lib no tiene
//   dependencias.
import { crc32 } from './slider.mjs';
import {
  PRODUCTOS, RECORTE, TESELA, TESELA_SLIDER, CITA, CITA_GREMLIN, UA as UA_RELEVO,
  rutaTiempos, rutaNativa, normalizarTiempos, tiempoMs, validarTesela, nativasDe, enteraDeNoche, reproyectar, codificarPng,
  decodificarPng, motivoPngMalo,
} from './satelite-slider.copia.mjs';

export const BASE = 'https://slider.cira.colostate.edu/';
export const UA = UA_RELEVO;                         // 'hn-colector/1.0', el mismo del relevo y de gremlin
export const RAIZ = 'slider';
export const PRODUCTOS_PRE = Object.freeze(['geocolor', 'band_02', 'gremlin']);
export const Z_MIN = 3, Z_MAX = 5;                   // la vista continente: hasta el zoom 6 del mapa la página pide z5 como máximo
export const RETENCION_DEF_H = 6, RETENCION_MIN_H = 1, RETENCION_MAX_H = 24;
export const TOPE_DEFECTO = 120, TOPE_MIN = 20, TOPE_MAX = 600;   // pedidos a SLIDER por corrida (los latest_times incluidos)
export const TOPE_CUADROS = 300;   // [r79] con los cuadros y las metateselas, un tiempo de los 3 productos pide ~180 nativas de día
export const PAUSA_MS = 1000;
export const MAX_INTENTOS = 4;
export const FALLAS_SEGUIDAS_CORTE = 3;
export const TOPE_BORRADOS = 3000, PARALELO = 8, PARALELO_ESCRITURA = 8;
export const DESFASE_MAX_MS = 3600e3;      // [Codex · 2] reloj contra SLIDER: más de 1 h de diferencia, no se borra nada
export const ESPERA_BORRADO_MS = 5 * 60e3;  // [Codex · 1] lo que salió del índice se borra recién en una corrida posterior
export const CLAVE_ETIQUETA = 'hn-slider';
/** la etiqueta de una tesela (la que lleva su PNG en tEXt) */
export const etiqueta = (prod, t, z, x, y) => prod + '/' + t + '/' + z + '/' + x + '/' + y;
/** PNG + un chunk tEXt «hn-slider» con la etiqueta, después del IHDR (ancillary: el PNG sigue siendo el mismo para cualquier lector) */
export function conEtiqueta(png, texto) {
  const datos = Buffer.from(CLAVE_ETIQUETA + '\0' + texto, 'latin1');
  const t = Buffer.concat([Buffer.from('tEXt', 'latin1'), datos]);
  const l = Buffer.alloc(4); l.writeUInt32BE(datos.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(t));
  const b = Buffer.from(png), finIhdr = 8 + 12 + 13;
  return Buffer.concat([b.subarray(0, finIhdr), l, t, c, b.subarray(finIhdr)]);
}
/** [Codex · 3] el error, en una CATEGORÍA FIJA y un código HTTP numérico si lo hay: nunca el mensaje (el registro de Actions es público) */
export function categoriaError(e) {
  if (e && typeof e.categoria === 'string' && /^error:[a-z]+( [a-z-]+)?$/.test(e.categoria)) return e.categoria;
  const m = String((e && e.message) || ''), http = /\bHTTP (\d{3})\b/.exec(m);
  const cat = /^R2 |almac/i.test(m) || (e && e.almacen) ? 'error:almacen' : e && (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'TypeError') ? 'error:red' : 'error:interno';
  return cat + (http ? ' http ' + http[1] : '');
}
// ---------- el reintento ante R2 (5xx o red; un 4xx no) ----------
export const REINTENTO_ESPERAS_MS = Object.freeze([500, 1500, 4000]);   // 4 intentos en total
export const TOPE_ESCRITURAS_FALLIDAS = 20;   // PUT que fallaron después de los reintentos, en la corrida: se corta
export const PRESUPUESTO_MS = 7 * 60e3;       // el workflow corta a los 9 min: lo que no entra queda para la próxima
// ---------- [r79 · 1-bis] los cuadros enteros y las metateselas ----------
export const Z_CUADRO = Object.freeze([4, 5]);
export const META_LADO = 4, META_PX = META_LADO * 256;   // 4 × 4 teselas = 1024 px
export const CAJA_META = Object.freeze({ oeste: -74, este: -53, norte: -21.5, sur: -55.2 });   // la Argentina continental y Tierra del Fuego
export const Z_META = Object.freeze({ geocolor: Object.freeze([6, 7]), band_02: Object.freeze([6, 7, 8]), gremlin: Object.freeze([6]) });
export const EN_VUELO_SLIDER = 3;
export const claveCuadro = (prod, t, z) => `${RAIZ}/${prod}/${t}/c/${z}.webp`;
export const claveMeta = (prod, t, z, mx, my) => `${RAIZ}/${prod}/${t}/m/${z}/${mx}/${my}.webp`;
export const etiquetaCuadro = (prod, t, z) => prod + '/' + t + '/c/' + z;
export const etiquetaMeta = (prod, t, z, mx, my) => prod + '/' + t + '/m/' + z + '/' + mx + '/' + my;
/** el texto XMP de la etiqueta (lo único que va en el chunk «XMP » del WebP) */
export const xmpDe = (et) => '<x:xmpmeta xmlns:x="adobe:ns:meta/"><hn-slider>' + et + '</hn-slider></x:xmpmeta>';
/** PURA. la etiqueta de un WebP (el texto de <hn-slider> en su único chunk XMP), o null (no es un WebP RIFF, no la trae o trae dos) */
export function etiquetaWebp(u) {
  const b = u instanceof Uint8Array ? u : new Uint8Array(u || []);
  if (b.length < 20 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'RIFF' || String.fromCharCode(b[8], b[9], b[10], b[11]) !== 'WEBP') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(4, true) + 8 !== b.length) return null;
  let o = 12, hallada = null, n = 0;
  while (o + 8 <= b.length) {
    const tipo = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), len = dv.getUint32(o + 4, true);
    if (o + 8 + len > b.length) return null;
    if (tipo === 'XMP ') {
      n++;
      const m = /^<x:xmpmeta xmlns:x="adobe:ns:meta\/"><hn-slider>([A-Za-z0-9_/]{1,80})<\/hn-slider><\/x:xmpmeta>$/.exec(Buffer.from(b.subarray(o + 8, o + 8 + len)).toString('latin1'));
      hallada = m ? m[1] : null;
    }
    o += 8 + len + (len & 1);
  }
  return n === 1 ? hallada : null;
}
/** la caja (en teselas) del cuadro entero del zoom z: el rectángulo de todas las teselas del recorte de ese zoom */
const memoCaja = new Map();
export function cajaCuadro(prod, z) {
  const k = prod + '/' + z; if (memoCaja.has(k)) return memoCaja.get(k);
  const l = teselasDe(prod, z), r = { x0: Math.min(...l.map((q) => q[0])), x1: Math.max(...l.map((q) => q[0])), y0: Math.min(...l.map((q) => q[1])), y1: Math.max(...l.map((q) => q[1])) };
  memoCaja.set(k, r); return r;
}
/** el rango de metateselas { x0, x1, y0, y1 } (en índices de metatesela) del zoom z: el del zoom más alto, alineado para que cada
 *  metatesela de un zoom menor tenga sus 4 hijas adentro */
export function rangoMeta(prod, z) {
  const zs = Z_META[prod]; if (!zs || zs.indexOf(z) < 0) return null;
  const top = zs[zs.length - 1], al = 2 ** (top - zs[0]);
  const x0 = Math.floor(Math.floor(tx(CAJA_META.oeste, top) / META_LADO) / al) * al, x1 = (Math.floor(Math.floor(tx(CAJA_META.este, top) / META_LADO) / al) + 1) * al - 1;
  const y0 = Math.floor(Math.floor(ty(CAJA_META.norte, top) / META_LADO) / al) * al, y1 = (Math.floor(Math.floor(ty(CAJA_META.sur, top) / META_LADO) / al) + 1) * al - 1;
  const d = 2 ** (top - z);
  return { x0: x0 / d, x1: (x1 + 1) / d - 1, y0: y0 / d, y1: (y1 + 1) / d - 1 };
}
/** todas las metateselas [mx, my] del zoom z */
export function metasDe(prod, z) { const r = rangoMeta(prod, z), out = []; if (!r) return out; for (let mx = r.x0; mx <= r.x1; mx++) for (let my = r.y0; my <= r.y1; my++) out.push([mx, my]); return out; }
/** el plan de las metateselas del zoom más alto de un tiempo: sus 16 teselas (fuera / noche / con sus nativas) y las nativas */
export function planMeta(prod, t) {
  const zs = Z_META[prod]; if (!zs) return { z: null, metas: [], nativas: new Map() };
  const z = zs[zs.length - 1], ms = tiempoMs(t), metas = [], nativas = new Map();
  for (const [mx, my] of metasDe(prod, z)) {
    const tes = [];
    for (let j = 0; j < META_LADO; j++) for (let i = 0; i < META_LADO; i++) {
      const x = mx * META_LADO + i, y = my * META_LADO + j;
      if (validarTesela(prod, z, x, y)) { tes.push({ x, y, fuera: true, nat: [] }); continue; }
      if (PRODUCTOS[prod].diurno && enteraDeNoche(z, x, y, ms)) { tes.push({ x, y, noche: true, nat: [] }); continue; }
      const { zs: zsl, lista } = nativasTesela(prod, z, x, y);
      if (!lista.length) { tes.push({ x, y, fuera: true, nat: [] }); continue; }
      const nat = lista.map((q) => zsl + ':' + q.f + '_' + q.c);
      nat.forEach((k, n) => { if (!nativas.has(k)) nativas.set(k, { zs: zsl, f: lista[n].f, c: lista[n].c }); });
      tes.push({ x, y, nat });
    }
    metas.push({ mx, my, tes, vacia: tes.every((s) => s.noche || s.fuera) && tes.some((s) => s.noche) });
  }
  return { z, metas, nativas };
}
/** PURA. pega una tesela de 256 × 256 (RGBA) en un mosaico de ancho W, en la posición (px, py) */
export function pegar(dst, W, src, px, py) {
  for (let j = 0; j < 256; j++) dst.set(src.subarray(j * 1024, j * 1024 + 1024), ((py + j) * W + px) * 4);
}
/** PURA. reduce a la mitad (2 × 2 → 1, promediando con el alfa: el color de lo transparente no tiñe) la imagen src (lado S) y la pega
 *  en dst (lado D) en (ox, oy) */
export function reducirEn(dst, D, src, S, ox, oy) {
  const h = S / 2;
  for (let j = 0; j < h; j++) for (let i = 0; i < h; i++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let q = 0; q < 4; q++) {
      const s = (((2 * j + (q >> 1)) * S) + 2 * i + (q & 1)) * 4, al = src[s + 3];
      a += al; r += src[s] * al; g += src[s + 1] * al; b += src[s + 2] * al;
    }
    const d = ((oy + j) * D + ox + i) * 4;
    if (a > 0) { dst[d] = Math.round(r / a); dst[d + 1] = Math.round(g / a); dst[d + 2] = Math.round(b / a); dst[d + 3] = Math.round(a / 4); }
    else { dst[d] = 0; dst[d + 1] = 0; dst[d + 2] = 0; dst[d + 3] = 0; }
  }
}
/** todas las claves de los cuadros y las metateselas de un tiempo (para el borrado diferido, sin listar) */
export function clavesCuadros(prod, t) {
  const out = Z_CUADRO.map((z) => claveCuadro(prod, t, z));
  for (const z of Z_META[prod] || []) for (const [mx, my] of metasDe(prod, z)) out.push(claveMeta(prod, t, z, mx, my));
  return out;
}
/** ¿el tiempo ya no hace falta rehacerlo? (con la llave de los cuadros, también sus cuadros y sus metateselas) */
export function hecho(q, conCuadros) {
  if (!q || q.estado !== 'completo') return false;
  if (!conCuadros) return true;
  return Array.isArray(q.c) && Z_CUADRO.every((z) => q.c.indexOf(z) >= 0) && !!q.m && q.m.faltan === 0;
}
/** el código HTTP del error del almacén («R2 escribir: HTTP 500»), o null */
export const httpDe = (e) => { const h = /\bHTTP (\d{3})\b/.exec(String((e && e.message) || '')); return h ? Number(h[1]) : null; };
/** se reintenta un 5xx o un error de red (fetch falló, se colgó); un 4xx u otra cosa, no */
export function reintentable(e) {
  const st = httpDe(e);
  if (st != null) return st >= 500;
  return !!e && (e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'TimeoutError');
}
/** fn() con reintentos: la espera i es REINTENTO_ESPERAS_MS[i] × (0,75 a 1,25); no espera más allá de `vence` (reloj()). */
export async function conReintento(fn, { esperar, log, reloj = Date.now, vence = Infinity, azar = Math.random, cuenta = { reintentos: 0 } } = {}) {
  const total = REINTENTO_ESPERAS_MS.length + 1;
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!reintentable(e) || i >= REINTENTO_ESPERAS_MS.length) throw e;
      const ms = Math.round(REINTENTO_ESPERAS_MS[i] * (0.75 + 0.5 * azar()));
      if (reloj() + ms > vence) throw e;   // el presupuesto de la corrida
      cuenta.reintentos++;
      log(`precocido: reintento:${categoriaError(e).replace(/^error:/, '')} (${i + 2}/${total})`);
      await esperar(ms);
    }
  }
}
export const CACHE_TESELA = 'public, max-age=86400, immutable';
export const CACHE_INDICE = 'public, max-age=30';
const HORA = 3600000;

export const claveTesela = (prod, t, z, x, y) => `${RAIZ}/${prod}/${t}/${z}/${x}/${y}.png`;
export const claveIndice = (prod) => `${RAIZ}/${prod}/indice.json`;

export const acotar = (v, def, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
export const acotarTope = (v) => acotar(v, TOPE_DEFECTO, TOPE_MIN, TOPE_MAX);
export const acotarRetencion = (v) => acotar(v, RETENCION_DEF_H, RETENCION_MIN_H, RETENCION_MAX_H);

// ---------- la geometría: qué teselas y qué nativas (no depende del tiempo: se calcula una vez) ----------
const latMerc = (k, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * k / n))) * 180 / Math.PI;
const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const memoTes = new Map(), memoNat = new Map();
/** las teselas [x, y] de Leaflet del zoom z que el relevo sirve (validarTesela) y que tocan algo que ve el GOES-19 */
export function teselasDe(prod, z) {
  const k = prod + '/' + z; if (memoTes.has(k)) return memoTes.get(k);
  const out = [];
  for (let x = tx(RECORTE.oeste, z); x <= tx(RECORTE.este - 1e-9, z); x++)
    for (let y = ty(RECORTE.norte, z); y <= ty(RECORTE.sur, z); y++)
      if (!validarTesela(prod, z, x, y) && nativasDe(prod, z, x, y).lista.length) out.push([x, y]);
  memoTes.set(k, out); return out;
}
export function nativasTesela(prod, z, x, y) {
  const k = prod + '/' + z + '/' + x + '/' + y; if (memoNat.has(k)) return memoNat.get(k);
  const r = nativasDe(prod, z, x, y); memoNat.set(k, r); return r;
}
/** todas las claves de las teselas de un tiempo (para borrar sin listar) */
export function clavesTiempo(prod, t, zMin = Z_MIN, zMax = Z_MAX) {
  const out = [];
  for (let z = zMin; z <= zMax; z++) for (const [x, y] of teselasDe(prod, z)) out.push(claveTesela(prod, t, z, x, y));
  return out;
}
/** el plan de un tiempo: las teselas (con su zs y sus nativas, o «noche» entera) y el conjunto de nativas a pedir */
export function planTiempo(prod, t, zMin = Z_MIN, zMax = Z_MAX) {
  const ms = tiempoMs(t), teselas = [], nativas = new Map();
  for (let z = zMin; z <= zMax; z++) for (const [x, y] of teselasDe(prod, z)) {
    if (PRODUCTOS[prod].diurno && enteraDeNoche(z, x, y, ms)) { teselas.push({ z, x, y, noche: true, nat: [] }); continue; }
    const { zs, lista } = nativasTesela(prod, z, x, y), nat = lista.map((q) => zs + ':' + q.f + '_' + q.c);
    nat.forEach((k, i) => { if (!nativas.has(k)) nativas.set(k, { zs, f: lista[i].f, c: lista[i].c }); });
    teselas.push({ z, x, y, noche: false, nat });
  }
  return { teselas, nativas };
}

const cabecera = (prod, conCuadros) => Object.assign({
  v: 1, producto: prod, titulo: PRODUCTOS[prod].titulo, z_min: Z_MIN, z_max: Z_MAX, tesela_px: TESELA, recorte: { ...RECORTE },
  ruta: `${RAIZ}/${prod}/{tiempo}/{z}/{x}/{y}.png`,
  cita: prod === 'gremlin' ? CITA_GREMLIN + ' · ' + CITA : CITA,
  nota: 'Teselas de Leaflet reproyectadas desde CIRA/RAMMB SLIDER con la misma cuenta que el relevo de SATCHI. Una tesela que falta no es «despejado»: es sin dato.',
}, conCuadros ? {
  /* [r79 · 1-bis] lo que la página necesita para pedir un cuadro entero o una metatesela (y saber qué teselas cubre cada una) */
  cuadro: { ruta: `${RAIZ}/${prod}/{tiempo}/c/{z}.webp`, z: [...Z_CUADRO], cajas: Object.fromEntries(Z_CUADRO.map((z) => [z, cajaCuadro(prod, z)])) },
  meta: { ruta: `${RAIZ}/${prod}/{tiempo}/m/{z}/{x}/{y}.webp`, z: [...(Z_META[prod] || [])], lado: META_LADO, caja: { ...CAJA_META },
    rangos: Object.fromEntries((Z_META[prod] || []).map((z) => [z, rangoMeta(prod, z)])) },
} : {});
const leerJSON = async (almacen, clave) => {
  const b = await almacen.leer(clave); if (!b) return null;
  try { return JSON.parse(b.toString('utf8')); } catch { return null; }
};
const RE_T = /^20\d{12}$/;
/** [Codex · 1 y 2] el índice leído, VALIDADO: tiempos con forma, `borrar` = [{ t, salio }] con forma, y los dos disjuntos. Si no valida,
 *  se arma uno nuevo y `roto` = true: con un índice roto no se borra nada. */
export function indiceDe(j, prod, conCuadros) {
  const nuevo = { ind: { ...cabecera(prod, conCuadros), tiempos: {}, borrar: [] }, roto: j != null, conC: !!(j && j.cuadro) };
  if (!j || j.v !== 1 || j.producto !== prod || !j.tiempos || typeof j.tiempos !== 'object' || Array.isArray(j.tiempos)) return nuevo;
  const borrar = j.borrar === undefined ? [] : j.borrar;
  if (!Array.isArray(borrar)) return nuevo;
  for (const [t, q] of Object.entries(j.tiempos)) if (!RE_T.test(t) || !Number.isFinite(tiempoMs(t)) || !q || typeof q !== 'object') return nuevo;
  const vistos = new Set();
  for (const b of borrar) {
    if (!b || typeof b !== 'object' || !RE_T.test(String(b.t)) || !Number.isFinite(tiempoMs(b.t)) || !Number.isFinite(b.salio)) return nuevo;
    if (vistos.has(b.t) || Object.prototype.hasOwnProperty.call(j.tiempos, b.t)) return nuevo;   // disjuntos, sin repetidos
    vistos.add(b.t);
  }
  return { ind: { ...cabecera(prod, conCuadros), tiempos: { ...j.tiempos }, borrar: borrar.map((b) => ({ t: String(b.t), salio: b.salio })) }, roto: false, conC: !!j.cuadro };
}
async function enParalelo(lista, n, fn) {
  const out = new Array(lista.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => { while (i < lista.length) { const k = i++; out[k] = await fn(lista[k], k); } }));
  return out;
}

/**
 * Una corrida. Devuelve el resumen (cantidades). @param {object} o
 * @param {object} o.almacen   leer / escribir / borrar (rayos-hora/lib/almacen.mjs): el depósito PÚBLICO
 * @param {string} o.llave     PRECOCIDO_ON: sólo «si» hace algo
 * @param {'real'|'seco'} [o.modo]
 */
export async function correr({
  almacen, fetchFn = fetch, ahoraMs = Date.now(), llave, modo = 'real', tope = TOPE_DEFECTO, retencionH = RETENCION_DEF_H,
  productos = PRODUCTOS_PRE, pausaMs = PAUSA_MS, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, zMax = Z_MAX,
  reloj = Date.now, presupuestoMs = PRESUPUESTO_MS, azar = Math.random,
  cuadros = false, codificarWebp = null,   // [r79 · 1-bis] la llave de los cuadros enteros y las metateselas, y el codificador WebP
}) {
  const vence = reloj() + presupuestoMs;
  const res = { estado: 'ok', pedidos: 0, nativas: 0, nativas_malas: 0, tiempos_slider: 0, pendientes: 0, guardados: 0, completos: 0, incompletos: 0,
    teselas: 0, teselas_noche: 0, teselas_faltantes: 0, bytes: 0, sacados: 0, borrados: 0, productos_caidos: 0,
    reintentos: 0, escrituras_fallidas: 0, sin_publicar: 0, indices_fallidos: 0 };
  if (llave !== 'si') { log('precocido: llave apagada (PRECOCIDO_ON no vale «si»): no hago nada'); return { ...res, estado: 'apagado' }; }
  if (!almacen) throw new Error('precocido: sin almacén (faltan las llaves del depósito público o PUBLICO_CARPETA)');
  cuadros = cuadros === true;
  if (cuadros && typeof codificarWebp !== 'function') throw new Error('precocido: los cuadros necesitan el codificador WebP');
  Object.assign(res, { cuadros: 0, cuadros_faltantes: 0, metas: 0, metas_faltantes: 0, metas_vacias: 0, bytes_cuadros: 0, bytes_metas: 0 });
  const maxPedidos = acotarTope(tope), ret = acotarRetencion(retencionH), zM = Math.max(Z_MIN, Math.min(6, Number(zMax) || Z_MAX));
  let fallasSeguidas = 0, cortar = null, cortarAlmacen = false, noBorrar = false;
  const reint = { esperar, log, reloj, vence, azar, cuenta: res };
  /** [r79] el plan de un tiempo (las teselas z3-z5 y, con la llave, las metateselas) y TODAS sus nativas, sin repetir */
  const planes = new Map();
  const planDe = (prod, t) => {
    const k = prod + '/' + t; if (planes.has(k)) return planes.get(k);
    const p = planTiempo(prod, t, Z_MIN, zM), pm = cuadros ? planMeta(prod, t) : null, nativas = new Map(p.nativas);
    if (pm) for (const [kk, q] of pm.nativas) if (!nativas.has(kk)) nativas.set(kk, q);
    const r = { p, pm, nativas }; planes.set(k, r); return r;
  };
  const nativasDelTiempo = (prod, t) => planDe(prod, t).nativas;
  /** un PUT con reintentos: true si quedó; false si un 5xx/red siguió hasta el final (un 4xx, o lo que no es del almacén, sube y corta) */
  const escribirR = async (k, b, o) => {
    try { await conReintento(() => almacen.escribir(k, b, o), reint); return true; } catch (e) {
      if (!reintentable(e)) throw e;
      res.escrituras_fallidas++;
      if (res.escrituras_fallidas >= TOPE_ESCRITURAS_FALLIDAS) cortarAlmacen = true;
      return false;
    }
  };
  /* [r79] el ritmo de cortesía con varios en vuelo: cada pedido empieza, como pronto, PAUSA_MS después del comienzo del anterior */
  let proximo = 0;
  const ritmo = async () => { const a = reloj(), espera = Math.max(0, proximo - a); proximo = Math.max(a, proximo) + pausaMs; if (espera > 0) await esperar(espera); };
  const pedir = async (ruta, tipo, conRitmo) => {
    if (conRitmo) { if (pausaMs > 0) await ritmo(); }
    else if (res.pedidos > 0 && pausaMs > 0) await esperar(pausaMs);
    res.pedidos++;
    try {
      const r = await fetchFn(BASE + ruta, { headers: { 'user-agent': UA, accept: tipo === 'json' ? 'application/json' : 'image/png' }, signal: AbortSignal.timeout(30000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.status === 0 || r.status >= 500) fallasSeguidas++; else fallasSeguidas = 0;
      if (r.status === 429 || r.status === 403) cortar = `SLIDER respondió ${r.status}`;
      else if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;
      return { status: r.status, buf };
    } catch (e) {
      fallasSeguidas++; if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;
      return { status: 0, error: String(e?.name || e) };
    }
  };

  // 1) los tiempos de cada producto y su índice
  const est = {};
  let masNuevoMs = -Infinity;
  for (const prod of productos) {
    if (!PRODUCTOS[prod]) continue;
    if (cortar) break;
    const lt = await pedir(rutaTiempos(prod), 'json');
    let tiempos = null;
    try { if (lt.status === 200) tiempos = normalizarTiempos(JSON.parse(lt.buf.toString('utf8'))); } catch { tiempos = null; }
    if (!tiempos || !tiempos.length) { res.productos_caidos++; log(`precocido: ${prod}: SLIDER no dio la lista de tiempos; sigo con los otros`); continue; }
    res.tiempos_slider += tiempos.length;
    masNuevoMs = Math.max(masNuevoMs, tiempoMs(tiempos.at(-1)));
    est[prod] = { tiempos, ...indiceDe(await leerJSON(almacen, claveIndice(prod)), prod, cuadros) };
  }
  // 2) qué falta: dentro de la retención, sin completar y sin agotar los intentos; del más nuevo al más viejo, intercalando productos
  // [Codex · 2] la retención se mide contra SLIDER (el más nuevo de latest_times); el reloj sólo sirve si coincide (± 1 h)
  const refOk = Number.isFinite(masNuevoMs) && Math.abs(ahoraMs - masNuevoMs) <= DESFASE_MAX_MS;
  const desde = (Number.isFinite(masNuevoMs) ? masNuevoMs : ahoraMs) - ret * HORA, cola = [];
  for (const [prod, e] of Object.entries(est)) for (const t of e.tiempos) {
    const ms = tiempoMs(t); if (ms < desde || ms > ahoraMs + 15 * 60000) continue;
    const q = e.ind.tiempos[t]; if (q && (hecho(q, cuadros) || (q.intentos || 0) >= MAX_INTENTOS)) continue;
    if (e.ind.borrar.some((b) => b.t === t)) continue;
    cola.push({ prod, t, ms });
  }
  cola.sort((a, b) => b.ms - a.ms || productos.indexOf(a.prod) - productos.indexOf(b.prod));
  res.pendientes = cola.length;
  if (modo === 'seco') {
    const nat = cola.reduce((a, q) => a + nativasDelTiempo(q.prod, q.t).size, 0);
    log(`precocido (SECO): ${Object.keys(est).length} productos · ${res.tiempos_slider} tiempos en SLIDER · ${cola.length} por hacer (${nat} nativas) · retención ${ret} h · z${Z_MIN}-${zM}${cuadros ? ' · con cuadros y metateselas' : ''} · no bajo ni guardo nada`);
    return { ...res, estado: 'seco' };
  }

  // 3) cada tiempo: sus nativas (si no entran en el tope, queda para la próxima), la reproyección y las teselas
  for (const { prod, t } of cola) {
    if (cortar || cortarAlmacen) break;
    if (reloj() > vence) { log('precocido: se terminó el presupuesto de tiempo; lo que falta queda para la próxima corrida'); break; }
    const e = est[prod], { p: plan, pm, nativas: todas } = planDe(prod, t);
    if (res.pedidos + todas.size > maxPedidos) { log(`precocido: tope de ${maxPedidos} pedidos; lo que falta queda para la próxima corrida`); break; }
    const imgs = new Map();
    const unaNativa = async ([k, q], conRitmo) => {
      if (cortar) return;
      const r = await pedir(rutaNativa(prod, t, q.zs, q.f, q.c), 'png', conRitmo);
      res.nativas++;
      const img = r.status === 200 && !motivoPngMalo(r.buf) ? decodificarPng(r.buf) : null;
      if (!img || img.w !== TESELA_SLIDER || img.h !== TESELA_SLIDER) { res.nativas_malas++; return; }
      imgs.set(k, img);
    };
    /* [r79] con los cuadros, de a EN_VUELO_SLIDER a la vez y con el ritmo de cortesía; sin la llave, de a una, como en la r77 */
    if (cuadros) await enParalelo([...todas], EN_VUELO_SLIDER, (kq) => unaNativa(kq, true));
    else for (const kq of todas) { if (cortar) break; await unaNativa(kq, false); }
    let faltan = 0, escritas = 0;
    const transparente = codificarPng(TESELA, TESELA, new Uint8Array(TESELA * TESELA * 4));
    const aEscribir = [], rgbaDe = new Map(), malZ = new Set();
    for (const s of plan.teselas) {
      if (s.noche) { aEscribir.push({ s, png: transparente }); res.teselas_noche++; continue; }
      const m = new Map(s.nat.map((k) => [k.slice(k.indexOf(':') + 1), imgs.get(k)]));
      const rp = reproyectar(prod, t, s.z, s.x, s.y, m);
      if (rp.faltan > 0) { faltan++; malZ.add(s.z); continue; }   // a un píxel le faltó su nativa: NO se escribe (la regla de la _v1829)
      if (cuadros && Z_CUADRO.indexOf(s.z) >= 0) rgbaDe.set(s.z + '/' + s.x + '/' + s.y, rp.rgba);
      aEscribir.push({ s, png: codificarPng(TESELA, TESELA, rp.rgba) });
    }
    let fallidas = 0;
    await enParalelo(aEscribir, PARALELO_ESCRITURA, async ({ s, png }) => {
      if (cortarAlmacen) { fallidas++; return; }
      const b = conEtiqueta(png, etiqueta(prod, t, s.z, s.x, s.y));   // [Codex · 3] la hora y el lugar, dentro del PNG
      if (!(await escribirR(claveTesela(prod, t, s.z, s.x, s.y), b, { tipo: 'image/png', cache: CACHE_TESELA }))) { fallidas++; return; }
      escritas++; res.bytes += b.length;
    });
    /* [r79 · 1-bis] LOS CUADROS ENTEROS Y LAS METATESELAS: después de las teselas y antes del índice; cada uno, sólo si TODAS sus
       teselas salieron enteras (si no, no se escribe: la página va tesela por tesela, como hoy) */
    let cEsc = null, mInfo = null;
    if (cuadros && fallidas === 0) {
      const escribirWebp = async (clave, rgba, w, h, et, cual) => {
        if (cortarAlmacen) { fallidas++; return false; }
        const b = await codificarWebp(rgba, w, h, et, prod);
        if (!(await escribirR(clave, b, { tipo: 'image/webp', cache: CACHE_TESELA }))) { fallidas++; return false; }
        res['bytes_' + cual] += b.length; return true;
      };
      cEsc = [];
      for (const z of Z_CUADRO) {
        if (z > zM || malZ.has(z)) { res.cuadros_faltantes++; continue; }
        const cj = cajaCuadro(prod, z), W = (cj.x1 - cj.x0 + 1) * TESELA, H = (cj.y1 - cj.y0 + 1) * TESELA, buf = new Uint8Array(W * H * 4);
        for (const [x, y] of teselasDe(prod, z)) { const r = rgbaDe.get(z + '/' + x + '/' + y); if (r) pegar(buf, W, r, (x - cj.x0) * TESELA, (y - cj.y0) * TESELA); }
        if (await escribirWebp(claveCuadro(prod, t, z), buf, W, H, etiquetaCuadro(prod, t, z), 'cuadros')) { cEsc.push(z); res.cuadros++; }
      }
      rgbaDe.clear();
      const zs = Z_META[prod] || [], top = pm ? pm.z : null, vacias = [], padres = new Map();
      let mEsc = 0, mFal = 0;
      const subir = (z, mx, my, buf, estado) => {
        if (z <= zs[0]) return;
        const k = (z - 1) + '/' + (mx >> 1) + '/' + (my >> 1);
        let Q = padres.get(k); if (!Q) { Q = { z: z - 1, mx: mx >> 1, my: my >> 1, buf: null, mal: false, vacias: 0, n: 0 }; padres.set(k, Q); }
        Q.n++;
        if (estado === 'mal') Q.mal = true;
        else if (estado === 'vacia') Q.vacias++;
        else { if (!Q.buf) Q.buf = new Uint8Array(META_PX * META_PX * 4); reducirEn(Q.buf, META_PX, buf, META_PX, (mx - 2 * Q.mx) * META_PX / 2, (my - 2 * Q.my) * META_PX / 2); }
      };
      const cerrar = async (z, mx, my, buf, estado) => {
        if (estado === 'vacia') { vacias.push(z + '/' + mx + '/' + my); res.metas_vacias++; }
        else if (estado === 'mal') { mFal++; res.metas_faltantes++; }
        else if (await escribirWebp(claveMeta(prod, t, z, mx, my), buf, META_PX, META_PX, etiquetaMeta(prod, t, z, mx, my), 'metas')) { mEsc++; res.metas++; }
        else { estado = 'mal'; mFal++; }
        subir(z, mx, my, buf, estado);
      };
      if (top != null) {
        for (const mt of pm.metas) {
          if (mt.vacia) { await cerrar(top, mt.mx, mt.my, null, 'vacia'); continue; }
          const buf = new Uint8Array(META_PX * META_PX * 4); let mal = false;
          for (const s of mt.tes) {
            if (s.fuera || s.noche) continue;
            const m = new Map(s.nat.map((k) => [k.slice(k.indexOf(':') + 1), imgs.get(k)]));
            const rp = reproyectar(prod, t, top, s.x, s.y, m);
            if (rp.faltan > 0) { mal = true; break; }   // la regla de la _v1829: una metatesela con un hueco no se escribe
            pegar(buf, META_PX, rp.rgba, (s.x - mt.mx * META_LADO) * TESELA, (s.y - mt.my * META_LADO) * TESELA);
          }
          await cerrar(top, mt.mx, mt.my, mal ? null : buf, mal ? 'mal' : 'ok');
        }
        for (let z = top - 1; z >= zs[0]; z--) {
          for (const [k, Q] of [...padres]) {
            if (Q.z !== z) continue;
            padres.delete(k);
            await cerrar(z, Q.mx, Q.my, Q.buf, Q.mal || Q.n < 4 ? 'mal' : Q.vacias === 4 ? 'vacia' : 'ok');
            Q.buf = null;
          }
        }
      }
      const noche = vacias.length > 0 && mEsc === 0 && mFal === 0;
      mInfo = { n: mEsc, faltan: mFal, vacias: noche ? [] : vacias, noche };
    }
    res.teselas += escritas; res.teselas_faltantes += faltan;
    if (fallidas > 0) {   // [reintento] el almacén no tomó alguna tesela: el tiempo NO se publica ni gasta un intento; la próxima lo rehace
      res.sin_publicar++; log(`precocido: un tiempo con ${fallidas} teselas que el almacén no tomó; no lo publico`);
      continue;
    }
    const estado = faltan === 0 ? 'completo' : 'incompleto', previo = e.ind.tiempos[t];
    e.ind.tiempos[t] = { estado, n: escritas, faltan, intentos: (previo?.intentos || 0) + 1, z: [Z_MIN, zM], ...(cuadros ? { c: cEsc || [], m: mInfo || { n: 0, faltan: 0, vacias: [], noche: false } } : {}) };
    e.ind.actualizado = new Date(ahoraMs).toISOString();
    if (!(await escribirR(claveIndice(prod), JSON.stringify(e.ind), { tipo: 'application/json', cache: CACHE_INDICE }))) {   // después de las teselas
      res.indices_fallidos++; noBorrar = true; continue;   // [reintento] el índice no quedó: en esta corrida no se borra nada
    }
    res.guardados++; if (estado === 'completo') res.completos++; else res.incompletos++;
  }

  // 4) la retención, DIFERIDA y contra SLIDER: (a) se borran las teselas de lo que salió del índice en una corrida anterior (hace más de
  //    ESPERA_BORRADO_MS), vencido según SLIDER; (b) lo que vence ahora sale del índice (y se borra en la próxima). Con el reloj lejos de
  //    SLIDER (más de 1 h), o un índice que no valida, no se borra nada.
  if (noBorrar || cortarAlmacen) {
    log('precocido · retención: el almacén falló al escribir; en esta corrida no borro nada');
  } else if (!refOk) {
    log('precocido · retención: el reloj y SLIDER no coinciden (más de 1 h), o no hay tiempos; no borro nada');
  } else {
    let presupuesto = TOPE_BORRADOS, fallas = 0;
    for (const [prod, e] of Object.entries(est)) {
      if (e.roto) { log(`precocido · retención: el índice de ${prod} no valida; no borro nada de ${prod}`); continue; }
      let cambio = false;
      for (const q of [...e.ind.borrar]) {
        if (!(ahoraMs - q.salio > ESPERA_BORRADO_MS)) continue;              // salió hace poco: todavía puede haber un índice viejo en caché
        if (!(tiempoMs(q.t) < desde) || e.ind.tiempos[q.t]) continue;        // sólo lo vencido según SLIDER y fuera del índice
        const claves = clavesTiempo(prod, q.t, Z_MIN, Math.max(zM, Number(e.ind.z_max) || Z_MAX)).concat(cuadros || e.conC ? clavesCuadros(prod, q.t) : []);   // [r79] con sus cuadros y metateselas
        if (claves.length > presupuesto) break;
        const r = await enParalelo(claves, PARALELO, (k) => conReintento(() => almacen.borrar(k), reint).then(() => true, (err) => { if (!reintentable(err)) throw err; return false; }));
        const mal = r.filter((x) => !x).length;
        presupuesto -= claves.length; res.borrados += claves.length - mal;
        if (mal) { fallas += mal; continue; }   // queda en `borrar`: la próxima vuelve a probar
        e.ind.borrar = e.ind.borrar.filter((x) => x.t !== q.t); cambio = true;
      }
      const viejos = Object.keys(e.ind.tiempos).filter((t) => !(tiempoMs(t) >= desde));
      if (viejos.length) {
        viejos.forEach((t) => { delete e.ind.tiempos[t]; if (!e.ind.borrar.some((x) => x.t === t)) e.ind.borrar.push({ t, salio: ahoraMs }); });
        res.sacados += viejos.length; cambio = true;
      }
      if (cambio && !(await escribirR(claveIndice(prod), JSON.stringify(e.ind), { tipo: 'application/json', cache: CACHE_INDICE }))) res.indices_fallidos++;
    }
    if (fallas) { res.estado = 'borrado-con-fallas'; log(`precocido · retención: ${fallas} borrados fallaron; quedan para la próxima`); }
  }
  if (cortar) { res.estado = 'cortada'; }
  if (res.escrituras_fallidas) res.estado = cortarAlmacen ? 'cortada-almacen' : 'escritura-con-fallas';
  log(`precocido: ${res.pedidos} pedidos (${res.nativas} nativas, ${res.nativas_malas} malas) · ${res.pendientes} pendientes · ${res.guardados} tiempos guardados (${res.completos} completos, ${res.incompletos} incompletos) · ${res.teselas} teselas (${res.teselas_noche} de noche, ${res.teselas_faltantes} sin escribir) · ${(res.bytes / 1e6).toFixed(2)} MB · ${res.sacados} tiempos vencidos · ${res.borrados} borradas${cuadros ? ` · ${res.cuadros} cuadros (${res.cuadros_faltantes} sin escribir, ${(res.bytes_cuadros / 1e6).toFixed(2)} MB) · ${res.metas} metateselas (${res.metas_faltantes} sin escribir, ${res.metas_vacias} de noche, ${(res.bytes_metas / 1e6).toFixed(2)} MB)` : ''} · ${res.reintentos} reintentos · ${res.escrituras_fallidas} escrituras fallidas (${res.sin_publicar} tiempos sin publicar, ${res.indices_fallidos} índices)${cortar ? ' · CORTADA: ' + cortar : ''}${cortarAlmacen ? ' · CORTADA: ' + TOPE_ESCRITURAS_FALLIDAS + ' escrituras fallidas' : ''}`);
  if (res.escrituras_fallidas) {
    const e = new Error('R2 escribir: hubo fallas'); e.almacen = true; e.resumen = res;
    e.categoria = cortarAlmacen ? 'error:almacen tope-de-fallas' : 'error:almacen escritura-con-fallas';
    throw e;
  }
  if (res.estado === 'borrado-con-fallas') { const e = new Error('R2 borrar: hubo fallas'); e.almacen = true; throw e; }
  return res;
}
