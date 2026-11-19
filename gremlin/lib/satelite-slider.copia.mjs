/* ════════════════════════════════════════════════════════════════════════════
 * HN AGRO · lib/satelite-slider.mjs · [_v1829 · 16/11/2026 · la 311] GOES-19 DE CIRA/RAMMB SLIDER, POR NUESTRO RELEVO
 * ────────────────────────────────────────────────────────────────────────────
 * Pedido del maker (canal 2026-11-16_2154, 311): las 3 capas de GOES-19 que muestra TRP y nos faltan, de CIRA/RAMMB SLIDER
 * (público, NOAA/CIRA), sector `full_disk`:
 *   · geocolor  — GeoColor (CIRA), 1 km: color «real» de día y nubes de noche;
 *   · band_02   — Visible, banda 2 (0,64 µm), 0,5 km, sólo de día;
 *   · gremlin   — GREMLIN (CIRA), 2 km: reflectividad SINTÉTICA estimada desde ABI + GLM. BETA: «estimado desde satélite,
 *                 entrenado en EE. UU., no es radar».
 * LO LEÍDO DE SLIDER (16/11 21:59–22:01 ART, 5 pedidos espaciados; ver docs/mejora-continua/LISTO-311.md):
 *   · js/define-products.js: goes-19 · full_disk: max_zoom_level 5, tile_size 678; imagery_resolutions 3 = 2 km, 4 = 1 km,
 *     5 = 0,5 km. zoom_level_adjust: band_02 0 (z5), geocolor 1 (z4), gremlin 2 (z3). Títulos: «GeoColor (CIRA)»,
 *     «Band 2: 0.64 µm ("Red")», «GREMLIN (CIRA)».
 *   · data/json/goes-19/full_disk/{producto}/latest_times.json → { timestamps_int: [AAAAMMDDhhmmss, …] }, 100 tiempos cada 10 min,
 *     del más nuevo al más viejo. GeoColor termina en …0021 y GREMLIN en …0000 (cada producto tiene SUS tiempos).
 *   · data/imagery/AAAA/MM/DD/goes-19---full_disk/{producto}/{tiempo}/{zz}/{fff}_{ccc}.png → PNG 678 × 678 (GeoColor RGB 8 bits,
 *     ~400 KB; GREMLIN con paleta y tRNS, ~60 KB), «Cache-Control: max-age=604800, public, immutable». Sin CORS.
 * LA PROYECCIÓN: las teselas de SLIDER están en la vista desde el satélite (geoestacionaria), no en Web Mercator. El relevo
 *   REPROYECTA: para cada tesela 256 × 256 de Leaflet (z/x/y) calcula, píxel por píxel, el ángulo de barrido (GOES-R PUG, vol. 3
 *   §5.1.2.8) con la geometría que publica SLIDER (lat_lon_query: ver GEO, abajo; medida contra las luces de las ciudades) y lee
 *   el píxel más cercano de la tesela de SLIDER al zoom que corresponde a la resolución (zSlider = z − 3, con el tope del producto).
 * EL VISIBLE DE NOCHE: el píxel con el sol bajo el horizonte va TRANSPARENTE (nunca un negro mudo) y la página dice «sin luz solar».
 * LA CORTESÍA (como la 308 v10): validación (producto, tiempo de latest_times, z/x/y dentro del recorte de Sudamérica y hasta el
 *   zoom de la resolución), memoria por instancia (teselas nuestras y de SLIDER), UN pedido por tesela aunque la pidan N a la
 *   vez (en curso compartido), de a uno con pausa y un tope por minuto hacia CIRA, y el freno (429, 5xx, red). Delante, la red de
 *   Netlify guarda cada tesela buena 7 días (un tiempo cerrado no cambia). UNA FALLA NO SE GUARDA en ningún lado.
 * [revisión Codex n3-311-1611, NO ENTRA → arreglado] nativasDe píxel por píxel y una reproyección con faltantes es 503 (nunca
 *   se guarda); el PNG se valida entero (CRC de cada chunk, IEND, IDAT que se descomprime del largo exacto: motivoPngMalo, la regla
 *   de la 311b); el presupuesto total de la invocación (PRESUPUESTO_MS) y una cola acotada (COLA_MAX) hacia CIRA.
 * Tests: tests/v1829_satelite_slider_relevo.test.mjs
 * ════════════════════════════════════════════════════════════════════════════ */
import { inflateSync, deflateSync } from 'node:zlib';

export const BASE = 'https://slider.cira.colostate.edu/';
export const SAT = 'goes-19', SECTOR = 'full_disk', TESELA_SLIDER = 678, TESELA = 256;
export const UA = 'hn-colector/1.0';
export const CITA = 'GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER';
export const CITA_GREMLIN = 'GREMLIN (CIRA)';
export const ACLARACION_GREMLIN = 'Estimado desde satélite, entrenado en EE. UU., no es radar.';
/* zSlider: el zoom máximo del producto en SLIDER (max_zoom_level 5 − zoom_level_adjust); zMerc: el de Leaflet que le corresponde */
export const PRODUCTOS = {
  geocolor: { slider: 'geocolor', titulo: 'GeoColor (CIRA)', km: 1, zSlider: 4, zMerc: 7 },
  band_02: { slider: 'band_02', titulo: 'Visible (banda 2)', km: 0.5, zSlider: 5, zMerc: 8, diurno: true },
  gremlin: { slider: 'gremlin', titulo: 'GREMLIN (CIRA)', km: 2, zSlider: 3, zMerc: 6, beta: true }
};
export const Z_MIN = 3;
/* el recorte de Sudamérica (y su mar): fuera de esto, 404 sin pedir nada. [la 311c · cobertura amplia, regla del maker 17/11 19:20]
   TODA la vista a escala continente: del Pacífico (−100°) al Atlántico (−20°) y del Caribe (13° N) al sur de Tierra del Fuego
   (−60°). Antes: −82/−34, −56/13. Lo que el GOES-19 no ve (fuera del disco) queda transparente igual. BORDE_GRADOS: en el último
   grado antes del borde del recorte la imagen se DESVANECE (smoothstep): ningún corte recto a la vista. */
export const RECORTE = { oeste: -100, este: -20, sur: -60, norte: 13 };
export const BORDE_GRADOS = 1;
/** el alfa del borde del recorte en lat/lon: 0 afuera, 1 adentro a más de BORDE_GRADOS del borde, smoothstep en el medio */
export function alfaRecorte(lat, lon) {
  const d = Math.min(lat - RECORTE.sur, RECORTE.norte - lat, lon - RECORTE.oeste, RECORTE.este - lon);
  if (d <= 0) return 0;
  if (d >= BORDE_GRADOS) return 1;
  const t = d / BORDE_GRADOS; return t * t * (3 - 2 * t);
}
export const RUTA = '/.netlify/functions/satelite-slider/teselas/';
export const RE_TIEMPO = /^20\d{12}$/;
export const TIEMPOS_MS = 60e3, PAUSA_MS = 60, NATIVAS_POR_MIN = 300, MEMO_NATIVAS = 48, MEMO_TESELAS = 400, PLAZO_MS = 8000, FRENO_MS = 60e3;
/* [revisión Codex n3-311 · 5] EL PRESUPUESTO DE UNA INVOCACIÓN: todo (la espera en la cola + cada pedido a CIRA + la reproyección)
   tiene que terminar antes de PRESUPUESTO_MS (la plataforma corta a los 10 s, sin pasar por el handler); la cola hacia CIRA es de
   COLA_MAX pedidos esperando como mucho (más: «cola llena», sin pedir). Un pedido que ya no llega a tiempo no sale. */
export const PRESUPUESTO_MS = 8000, COLA_MAX = 32, MARGEN_MS = 300;
export const PNG_MAX_BYTES = 4 * 1024 * 1024;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function productoValido(p) { return typeof p === 'string' && own(PRODUCTOS, p); }

/* ── las rutas ──────────────────────────────────────────────────────────── */
export function urlTesela(prod, t) { return RUTA + prod + '/' + t + '/{z}/{x}/{y}.png'; }
export function rutaTiempos(prod) { return 'data/json/' + SAT + '/' + SECTOR + '/' + PRODUCTOS[prod].slider + '/latest_times.json'; }
const p0 = (n, k) => String(n).padStart(k, '0');
export function rutaNativa(prod, t, zs, f, c) {
  const s = String(t);
  return 'data/imagery/' + s.slice(0, 4) + '/' + s.slice(4, 6) + '/' + s.slice(6, 8) + '/' + SAT + '---' + SECTOR + '/' + PRODUCTOS[prod].slider
    + '/' + s + '/' + p0(zs, 2) + '/' + p0(f, 3) + '_' + p0(c, 3) + '.png';
}
/** «20261117004021» → ms (UTC), NaN si no es un tiempo */
export function tiempoMs(t) {
  const s = String(t); if (!RE_TIEMPO.test(s)) return NaN;
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
}
/** latest_times.json → [«AAAAMMDDhhmmss», …] del más viejo al más nuevo; null si no tiene la forma esperada */
export function normalizarTiempos(j) {
  if (!j || !Array.isArray(j.timestamps_int)) return null;
  const out = [];
  for (const v of j.timestamps_int) { const s = String(v); if (!RE_TIEMPO.test(s) || !isFinite(tiempoMs(s))) return null; out.push(s); }
  return Array.from(new Set(out)).sort();
}

/* ── la geometría ───────────────────────────────────────────────────────── */
/* LA GEOMETRÍA DE SLIDER, no la nominal del ABI: define-products.js · goes-19 · full_disk · lat_lon_query = { lon0: −75.0,
   sat_alt: 42171.7 (km, desde el centro de la Tierra), max_rad_x: 0.151337, max_rad_y: 0.150988, disk_radius_x_z0: 338,
   disk_radius_y_z0: 337 } sobre la tesela de 678 px (centro 339). MEDIDO el 16/11 con las luces de las ciudades de la GeoColor
   nocturna (tesela z4 013_009 de las 00:40Z): con estos números Bahía Blanca, Santa Rosa, Tandil y Trenque Lauquen caen a 0–4 px
   (1 km) de su luz; con la grilla nominal del ABI (75,2° O, ±0,151872 rad) caían todas 16 px (16 km) al este. La 311b (el colector
   de GREMLIN, hn-colectores lib/slider.mjs) usa los mismos números. */
const R_EQ = 6378.137, R_POL = 6356.75231414, E2 = 1 - (R_POL * R_POL) / (R_EQ * R_EQ);
export const GEO = { LON0: -75.0, ALT_KM: 42171.7, MAX_RAD_X: 0.151337, MAX_RAD_Y: 0.150988, RADIO_X_Z0: 338, RADIO_Y_Z0: 337, CENTRO_Z0: 339 };
const H_SAT = GEO.ALT_KM, LON0 = GEO.LON0 * Math.PI / 180;
/** lat/lon (grados) → ángulos de barrido { x, y } (rad), o null si el punto no se ve desde el satélite */
export function escan(lat, lon) {
  const ph = lat * Math.PI / 180, la = lon * Math.PI / 180;
  const pc = Math.atan((R_POL * R_POL) / (R_EQ * R_EQ) * Math.tan(ph));
  const cpc = Math.cos(pc), rc = R_POL / Math.sqrt(1 - E2 * cpc * cpc);
  const sx = H_SAT - rc * cpc * Math.cos(la - LON0), sy = -rc * cpc * Math.sin(la - LON0), sz = rc * Math.sin(pc);
  if (H_SAT * (H_SAT - sx) < sy * sy + (R_EQ * R_EQ) / (R_POL * R_POL) * sz * sz) return null;
  return { x: Math.asin(-sy / Math.sqrt(sx * sx + sy * sy + sz * sz)), y: Math.atan(sz / sx) };
}
/** lat/lon → { c, f } (columna y fila, en píxeles) de la imagen entera de SLIDER al zoom zs; null si no se ve */
export function pixelSlider(lat, lon, zs) {
  const s = escan(lat, lon); if (!s) return null;
  const k = Math.pow(2, zs);
  return { c: (GEO.CENTRO_Z0 + s.x / GEO.MAX_RAD_X * GEO.RADIO_X_Z0) * k, f: (GEO.CENTRO_Z0 - s.y / GEO.MAX_RAD_Y * GEO.RADIO_Y_Z0) * k };
}
export function zSlider(prod, z) { return Math.max(0, Math.min(PRODUCTOS[prod].zSlider, z - 3)); }
const latMerc = (k, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * k / n))) * 180 / Math.PI;
/** la caja (grados) de la tesela z/x/y de Web Mercator */
export function cajaMerc(z, x, y) { const n = 2 ** z; return { oeste: x / n * 360 - 180, este: (x + 1) / n * 360 - 180, norte: latMerc(y, n), sur: latMerc(y + 1, n) }; }
export function dentroRecorte(z, x, y) {
  const b = cajaMerc(z, x, y);
  return !(b.sur > RECORTE.norte || b.norte < RECORTE.sur || b.oeste > RECORTE.este || b.este < RECORTE.oeste);
}
/** ¿es una tesela que este relevo sirve? (sin el tiempo) → null si sí; el motivo si no */
export function validarTesela(prod, z, x, y) {
  if (!productoValido(prod)) return 'producto desconocido';
  if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) return 'tesela fuera de la grilla';
  const P = PRODUCTOS[prod];
  if (z < Z_MIN || z > P.zMerc) return 'zoom fuera de rango (de ' + Z_MIN + ' a ' + P.zMerc + ' para ' + prod + ')';
  if (x >= 2 ** z || y >= 2 ** z) return 'tesela fuera de la grilla';
  if (!dentroRecorte(z, x, y)) return 'tesela fuera del recorte de Sudamérica';
  return null;
}
/** el centro de cada píxel de la tesela → { lat, lon } (fila j, columna i) */
function latLonPixel(z, x, y, i, j) {
  const n = 2 ** z, gx = x + (i + 0.5) / TESELA, gy = y + (j + 0.5) / TESELA;
  return { lat: latMerc(gy, n), lon: gx / n * 360 - 180 };
}
/** las teselas de SLIDER que hacen falta para la tesela z/x/y → [{ f, c }] (sin repetir), con el zoom de SLIDER.
 *  [revisión Codex n3-311 · 1] PÍXEL POR PÍXEL, con la MISMA cuenta que reproyectar(): el muestreo de 4 × 4 dejaba afuera
 *  teselas de SLIDER que un píxel del borde necesitaba (GeoColor 7/43/82: faltaba 14_10). */
export function nativasDe(prod, z, x, y) {
  const zs = zSlider(prod, z), lado = TESELA_SLIDER * 2 ** zs, set = new Map();
  for (let j = 0; j < TESELA; j++) for (let i = 0; i < TESELA; i++) {
    const g = latLonPixel(z, x, y, i, j);
    if (alfaRecorte(g.lat, g.lon) <= 0) continue;   // [la 311c] fuera del recorte no hace falta ninguna nativa
    const p = pixelSlider(g.lat, g.lon, zs);
    if (!p || p.c < 0 || p.f < 0 || p.c >= lado || p.f >= lado) continue;
    const f = Math.floor(p.f / TESELA_SLIDER), c = Math.floor(p.c / TESELA_SLIDER), k = f + '_' + c;
    if (!set.has(k)) set.set(k, { f, c });
  }
  return { zs, lista: Array.from(set.values()) };
}
/** la elevación del sol (grados) en lat/lon a la hora ms (NOAA, precisión de décimas de grado: alcanza para «de día o de noche») */
export function elevacionSolar(lat, lon, ms) {
  const d = (ms - Date.UTC(2000, 0, 1, 12)) / 86400e3, rad = Math.PI / 180;
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}

/** ¿la tesela entera está sin sol? (una grilla de 9 × 9 puntos, todos con el sol a más de 1° bajo el horizonte) */
export function enteraDeNoche(z, x, y, ms) {
  for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) { const g = latLonPixel(z, x, y, i * 32 - 0.5, j * 32 - 0.5); if (elevacionSolar(g.lat, g.lon, ms) >= -1) return false; }
  return true;
}

/* ── PNG (sin librerías: node:zlib) ─────────────────────────────────────── */
const FIRMA = [137, 80, 78, 71, 13, 10, 26, 10];
export function esPng(b) { const u = b instanceof Uint8Array ? b : new Uint8Array(b || []); return u.length > 8 && FIRMA.every((v, i) => u[i] === v); }
/** [revisión Codex n3-311 · 4 · y la 3.ª vuelta de la 311b] ¿por qué este PNG no sirve? null si está entero y es válido según la
 *  especificación (la misma regla que motivoTeselaMala de hn-colectores gremlin/lib/slider.mjs @ 77df408a, para los tipos que trae
 *  SLIDER: paleta en GREMLIN, RGB en GeoColor; y RGBA, el de nuestras propias teselas):
 *   · firma; cada chunk entero, con nombre legible y su CRC; un chunk crítico desconocido lo invalida;
 *   · IHDR primero, uno solo, de 13 bytes; profundidad válida para el tipo (tabla 11.1); compresión 0, filtro 0, sin entrelazar;
 *   · PLTE: una sola, ANTES del IDAT, largo > 0 y múltiplo de 3; con paleta, entre 1 y min(256, 2^profundidad) entradas y
 *     obligatoria; prohibida en gris y gris+alfa;
 *   · tRNS: una sola, antes del IDAT; con paleta, después de PLTE y con no más entradas que ella; gris 2 bytes, RGB 6; nunca con alfa;
 *   · IDAT: al menos uno, todos seguidos; se descomprime ENTERO y da justo alto × (1 + bytes por fila según canales y profundidad);
 *   · cada fila con filtro 0 a 4 y SE DESHACE; con paleta, todo índice de píxel es menor que las entradas de la PLTE;
 *   · IEND último, vacío, y nada después. */
export const PROFUNDIDADES = Object.freeze({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] });
const CANALES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
export function motivoPngMalo(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  if (u.length < 8 + 25 + 12) return 'muy corto';
  if (!esPng(u)) return 'no es PNG';
  if (u.length > PNG_MAX_BYTES) return 'demasiado grande';
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let o = 8, ihdr = null, color = -1, prof = 0, entradas = 0, trns = false, idatCerrado = false, fin = false, previo = ''; const idat = [];
  while (o < u.length) {
    if (o + 12 > u.length) return 'chunk cortado';
    const len = dv.getUint32(o), tipo = String.fromCharCode(u[o + 4], u[o + 5], u[o + 6], u[o + 7]);
    if (!/^[A-Za-z]{4}$/.test(tipo)) return 'chunk ilegible';
    if (o + 12 + len > u.length) return 'el chunk ' + tipo + ' está cortado';
    if (crc32(u.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len)) return 'el CRC de ' + tipo + ' está mal';
    if (o === 8 && tipo !== 'IHDR') return 'sin IHDR';
    const d = u.subarray(o + 8, o + 8 + len);
    if (idat.length && previo === 'IDAT' && tipo !== 'IDAT') idatCerrado = true;
    if (tipo === 'IHDR') {
      if (ihdr || len !== 13) return 'IHDR raro';
      ihdr = d; prof = d[8]; color = d[9];
      if (!PROFUNDIDADES[color]) return 'tipo de color ' + color + ' desconocido';
      if (PROFUNDIDADES[color].indexOf(prof) < 0) return 'profundidad ' + prof + ' inválida para el tipo ' + color;
      if (d[10] !== 0 || d[11] !== 0) return 'compresión o filtro desconocidos';
      if (d[12] !== 0) return 'entrelazado (no se espera)';
    } else if (tipo === 'PLTE') {
      if (entradas) return 'dos PLTE';
      if (idat.length) return 'PLTE después del IDAT';
      if (color === 0 || color === 4) return 'PLTE en un PNG sin color';
      if (len === 0 || len % 3 !== 0) return 'PLTE de largo inválido';
      entradas = len / 3;
      if (entradas > (color === 3 ? Math.min(256, 2 ** prof) : 256)) return 'PLTE de ' + entradas + ' entradas (de más)';
    } else if (tipo === 'tRNS') {
      if (trns) return 'dos tRNS';
      if (idat.length) return 'tRNS después del IDAT';
      if (color === 4 || color === 6) return 'tRNS en un PNG con alfa';
      if (color === 3) { if (!entradas) return 'tRNS antes de la PLTE'; if (len > entradas) return 'más tRNS que entradas de PLTE'; }
      if (color === 0 && len !== 2) return 'tRNS de gris de largo inválido';
      if (color === 2 && len !== 6) return 'tRNS de RGB de largo inválido';
      trns = true;
    } else if (tipo === 'IDAT') {
      if (idatCerrado) return 'IDAT no consecutivos';
      if (color === 3 && !entradas) return 'paleta sin PLTE antes del IDAT';
      idat.push(d);
    } else if (tipo === 'IEND') {
      if (len !== 0) return 'IEND no vacío';
      o += 12 + len; fin = true; break;
    } else if (tipo.charCodeAt(0) < 97) return 'chunk crítico desconocido (' + tipo + ')';   // mayúscula inicial = crítico
    previo = tipo;
    o += 12 + len;
  }
  if (!fin) return 'cortado (sin IEND)';
  if (o !== u.length) return 'datos después de IEND';
  const w = new DataView(ihdr.buffer, ihdr.byteOffset, 13).getUint32(0), h = new DataView(ihdr.buffer, ihdr.byteOffset, 13).getUint32(4);
  if (!w || !h || w > 4096 || h > 4096) return 'tamaño ' + w + '×' + h;
  if (!idat.length) return 'sin IDAT';
  const bits = CANALES[color] * prof, bytesFila = Math.ceil(w * bits / 8), porFila = 1 + bytesFila, bpp = Math.max(1, bits >> 3);
  let crudo;
  try { crudo = inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))), { maxOutputLength: h * porFila + 1 }); }
  catch (e) { return 'IDAT corrupto o incompleto'; }
  if (crudo.length !== h * porFila) return 'IDAT de otro largo';
  /* se deshace el filtro de cada fila; con paleta, se mira cada índice */
  let arriba = new Uint8Array(bytesFila), fila = new Uint8Array(bytesFila);
  const mascara = (1 << prof) - 1;
  for (let j = 0; j < h; j++) {
    const ft = crudo[j * porFila]; if (ft > 4) return 'filtro de fila inválido';
    const ent = j * porFila + 1;
    for (let i = 0; i < bytesFila; i++) {
      const a = i >= bpp ? fila[i - bpp] : 0, b = arriba[i], c = i >= bpp ? arriba[i - bpp] : 0;
      let p = 0;
      if (ft === 1) p = a; else if (ft === 2) p = b; else if (ft === 3) p = (a + b) >> 1;
      else if (ft === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      fila[i] = (crudo[ent + i] + p) & 255;
    }
    if (color === 3) for (let x = 0; x < w; x++) {
      const bit = x * prof, ix = prof === 8 ? fila[x] : (fila[bit >> 3] >> (8 - prof - (bit & 7))) & mascara;
      if (ix >= entradas) return 'índice de píxel (' + ix + ') fuera de la PLTE de ' + entradas;
    }
    const t = arriba; arriba = fila; fila = t;
  }
  return null;
}
/** PNG de 8 bits sin entrelazar (gris, RGB, paleta con tRNS, gris+alfa, RGBA) → { w, h, rgba } o null (si motivoPngMalo dice algo) */
export function decodificarPng(buf) {
  try {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (motivoPngMalo(u)) return null;
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    let o = 8, w = 0, h = 0, bd = 0, ct = -1, il = 0, pal = null, trns = null; const idat = [];
    while (o + 8 <= u.length) {
      const len = dv.getUint32(o), tipo = String.fromCharCode(u[o + 4], u[o + 5], u[o + 6], u[o + 7]), d = u.subarray(o + 8, o + 8 + len);
      if (tipo === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); bd = d[8]; ct = d[9]; il = d[12]; }
      else if (tipo === 'PLTE') pal = d;
      else if (tipo === 'tRNS') trns = d;
      else if (tipo === 'IDAT') idat.push(d);
      else if (tipo === 'IEND') break;
      o += 12 + len;
    }
    const can = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!w || !h || w > 4096 || h > 4096 || bd !== 8 || il !== 0 || !can || (ct === 3 && !pal)) return null;
    const fila = w * can, crudo = inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))), { maxOutputLength: h * (fila + 1) });
    if (crudo.length < h * (fila + 1)) return null;
    const px = new Uint8Array(h * fila), rgba = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++) {
      const ft = crudo[j * (fila + 1)], src = j * (fila + 1) + 1, dst = j * fila;
      for (let i = 0; i < fila; i++) {
        const x = crudo[src + i], a = i >= can ? px[dst + i - can] : 0, b = j ? px[dst - fila + i] : 0, c = j && i >= can ? px[dst - fila + i - can] : 0;
        let v;
        if (ft === 0) v = x; else if (ft === 1) v = x + a; else if (ft === 2) v = x + b; else if (ft === 3) v = x + ((a + b) >> 1);
        else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        else return null;
        px[dst + i] = v & 255;
      }
    }
    for (let k = 0, n = w * h; k < n; k++) {
      const q = k * 4;
      if (ct === 6) { rgba[q] = px[k * 4]; rgba[q + 1] = px[k * 4 + 1]; rgba[q + 2] = px[k * 4 + 2]; rgba[q + 3] = px[k * 4 + 3]; }
      else if (ct === 2) { rgba[q] = px[k * 3]; rgba[q + 1] = px[k * 3 + 1]; rgba[q + 2] = px[k * 3 + 2]; rgba[q + 3] = 255; }
      else if (ct === 3) { const ix = px[k]; rgba[q] = pal[ix * 3] || 0; rgba[q + 1] = pal[ix * 3 + 1] || 0; rgba[q + 2] = pal[ix * 3 + 2] || 0; rgba[q + 3] = trns && ix < trns.length ? trns[ix] : 255; }
      else if (ct === 0) { rgba[q] = rgba[q + 1] = rgba[q + 2] = px[k]; rgba[q + 3] = 255; }
      else { rgba[q] = rgba[q + 1] = rgba[q + 2] = px[k * 2]; rgba[q + 3] = px[k * 2 + 1]; }
    }
    return { w, h, rgba };
  } catch (e) { return null; }
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function trozo(tipo, d) {
  const t = Buffer.from(tipo, 'ascii'), l = Buffer.alloc(4), c = Buffer.alloc(4);
  l.writeUInt32BE(d.length); c.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([l, t, d, c]);
}
/** RGBA → PNG (RGBA 8 bits, filtro «Sub») */
export function codificarPng(w, h, rgba) {
  const fila = w * 4, crudo = Buffer.alloc(h * (fila + 1));
  for (let j = 0; j < h; j++) {
    const o = j * (fila + 1); crudo[o] = 1;
    for (let i = 0; i < fila; i++) crudo[o + 1 + i] = (rgba[j * fila + i] - (i >= 4 ? rgba[j * fila + i - 4] : 0)) & 255;
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; ih[10] = 0; ih[11] = 0; ih[12] = 0;
  return Buffer.concat([Buffer.from(FIRMA), trozo('IHDR', ih), trozo('IDAT', deflateSync(crudo, { level: 6 })), trozo('IEND', Buffer.alloc(0))]);
}

/** reproyecta: las teselas de SLIDER (Map «f_c» → { w, h, rgba }) → la tesela z/x/y de Leaflet en RGBA.
 *  Fuera del disco: transparente. El visible con el sol bajo el horizonte: transparente (y se cuenta en `noche`). */
export function reproyectar(prod, t, z, x, y, nativas) {
  const zs = zSlider(prod, z), lado = TESELA_SLIDER * 2 ** zs, P = PRODUCTOS[prod], ms = tiempoMs(t);
  const out = new Uint8Array(TESELA * TESELA * 4);
  let noche = 0, faltan = 0, fuera = 0;
  for (let j = 0; j < TESELA; j++) {
    for (let i = 0; i < TESELA; i++) {
      const g = latLonPixel(z, x, y, i, j), ar = alfaRecorte(g.lat, g.lon);
      if (ar <= 0) { fuera++; continue; }   // [la 311c] fuera del recorte: transparente (el borde se desvanece, sin escalón de teselas)
      const p = pixelSlider(g.lat, g.lon, zs);
      if (!p || p.c < 0 || p.f < 0 || p.c >= lado || p.f >= lado) { fuera++; continue; }
      if (P.diurno && elevacionSolar(g.lat, g.lon, ms) < 0) { noche++; continue; }
      const f = Math.floor(p.f / TESELA_SLIDER), c = Math.floor(p.c / TESELA_SLIDER), n = nativas.get(f + '_' + c);
      if (!n) { faltan++; continue; }
      const pi = Math.min(n.w - 1, Math.floor(p.c - c * TESELA_SLIDER)), pj = Math.min(n.h - 1, Math.floor(p.f - f * TESELA_SLIDER));
      const s = (pj * n.w + pi) * 4, d = (j * TESELA + i) * 4;
      out[d] = n.rgba[s]; out[d + 1] = n.rgba[s + 1]; out[d + 2] = n.rgba[s + 2]; out[d + 3] = ar < 1 ? Math.round(n.rgba[s + 3] * ar) : n.rgba[s + 3];
    }
  }
  return { rgba: out, noche: noche / (TESELA * TESELA), faltan, fuera };
}

/* ── el relevo: uno por instancia ───────────────────────────────────────── */
export function crearRelevo(op) {
  op = op || {};
  const fetchF = op.fetch || ((u, i) => globalThis.fetch(u, i));
  const ahora = op.ahora || (() => Date.now());
  const dormir = op.dormir || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = op.base || BASE;
  const S = { pedidos: 0, tiempos: 0, nativas: 0, aciertos: 0, compartidas: 0, tope: 0, fallas: 0, frenos: 0, en_freno: 0, reproyectadas: 0 };
  let frenoHasta = 0, ultimo = -Infinity, cola = Promise.resolve(), enCola = 0;
  const ventana = [], enCurso = new Map(), memoT = new Map(), memoN = new Map(), tiemposMemo = new Map();
  function frenar(motivo) { frenoHasta = Math.max(frenoHasta, ahora() + FRENO_MS); S.frenos++; S.freno_motivo = motivo; }

  /** UN pedido a CIRA (por la cola: de a uno, con la pausa y el tope por minuto) → { ok, bytes | j } o { ok:false, motivo }.
   *  hasta: el fin del presupuesto de la invocación (ms del reloj); el pedido no sale si ya no llega, y su plazo nunca lo pasa. */
  function pedir(ruta, tipo, hasta) {
    if (enCola >= COLA_MAX) { S.cola_llena = (S.cola_llena || 0) + 1; return Promise.resolve({ ok: false, motivo: 'cola_llena' }); }
    enCola++;
    const p = (cola = cola.catch(() => {}).then(async () => {
      if (ahora() < frenoHasta) { S.en_freno++; return { ok: false, motivo: 'freno' }; }
      if (hasta != null && hasta - ahora() < MARGEN_MS + PAUSA_MS) { S.presupuesto = (S.presupuesto || 0) + 1; return { ok: false, motivo: 'presupuesto' }; }
      const t0 = ahora(); while (ventana.length && t0 - ventana[0] >= 60e3) ventana.shift();
      if (ventana.length >= NATIVAS_POR_MIN) { S.tope++; return { ok: false, motivo: 'tope' }; }
      const espera = ultimo + PAUSA_MS - ahora(); if (espera > 0) await dormir(espera);
      ultimo = ahora(); ventana.push(ultimo); S.pedidos++;
      const plazo = hasta != null ? Math.max(1, Math.min(PLAZO_MS, hasta - ahora() - MARGEN_MS)) : PLAZO_MS, porPresupuesto = plazo < PLAZO_MS;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const reloj = ctl ? setTimeout(() => ctl.abort(), plazo) : null;
      try {
        const r = await fetchF(base + ruta, { headers: { 'User-Agent': UA, Accept: tipo === 'json' ? 'application/json' : 'image/png' }, signal: ctl ? ctl.signal : undefined });
        if (!r || r.status === 429 || r.status >= 500) { frenar('http ' + (r ? r.status : '?')); S.fallas++; return { ok: false, motivo: 'freno' }; }
        if (r.status !== 200) { S.fallas++; return { ok: false, motivo: 'http', status: r.status }; }
        if (tipo === 'json') { const j = JSON.parse(await r.text()); return { ok: true, j }; }
        const ab = await r.arrayBuffer();
        return { ok: true, bytes: ab };
      } catch (e) {
        S.fallas++;
        /* [revisión Codex n3-311-v2 · 2] el pedido YA SALIÓ hacia CIRA y no contestó a tiempo (por su plazo o por el presupuesto que
           lo acortó): es CIRA lenta, y frena 60 s igual. Sólo lo agotado ESPERANDO TURNO (arriba, antes de pedir) no frena. */
        if (e && e.name === 'AbortError') { frenar(porPresupuesto ? 'presupuesto' : 'plazo'); return { ok: false, motivo: porPresupuesto ? 'presupuesto' : 'plazo' }; }
        if (e instanceof SyntaxError) return { ok: false, motivo: 'forma' };
        frenar('red'); return { ok: false, motivo: 'red' };
      } finally { if (reloj) clearTimeout(reloj); }
    }));
    p.then(() => { enCola--; }, () => { enCola--; });
    return p;
  }
  function compartido(clave, fn) {
    if (enCurso.has(clave)) { S.compartidas++; return enCurso.get(clave); }
    const p = Promise.resolve().then(fn).finally(() => enCurso.delete(clave));
    enCurso.set(clave, p);
    return p;
  }
  function guardar(m, k, v, tope) { m.delete(k); m.set(k, v); while (m.size > tope) m.delete(m.keys().next().value); }

  /** los tiempos de un producto (latest_times), 1 min en memoria; una falla no se guarda */
  async function tiempos(prod, hasta) {
    if (!productoValido(prod)) return { ok: false, motivo: 'pedido', error: 'Producto desconocido.' };
    const m = tiemposMemo.get(prod);
    if (m && ahora() - m.t < TIEMPOS_MS) { S.aciertos++; return m.r; }
    return compartido('t:' + prod, async () => {
      S.tiempos++;
      const r = await pedir(rutaTiempos(prod), 'json', hasta);
      if (!r.ok) return m ? Object.assign({}, m.r, { viejo: true }) : { ok: false, sin_dato: true, motivo: r.motivo, producto: prod };
      const l = normalizarTiempos(r.j);
      if (!l || !l.length) return { ok: false, sin_dato: true, motivo: 'forma', producto: prod };
      const out = { ok: true, producto: prod, tiempos: l, ultimo: l[l.length - 1], cita: prod === 'gremlin' ? CITA_GREMLIN + ' · ' + CITA : CITA,
        recorte: Object.assign({}, RECORTE), borde_grados: BORDE_GRADOS };   // [la 311c] hasta dónde llega: un DATO para la página
      tiemposMemo.set(prod, { t: ahora(), r: out });
      return out;
    });
  }
  /** una tesela de SLIDER, decodificada (memoria MEMO_NATIVAS; un pedido aunque la pidan N) */
  function nativa(prod, t, zs, f, c, hasta) {
    const ruta = rutaNativa(prod, t, zs, f, c);
    const v = memoN.get(ruta); if (v) { S.aciertos++; return Promise.resolve({ ok: true, img: v }); }
    return compartido('n:' + ruta, async () => {
      const w = memoN.get(ruta); if (w) return { ok: true, img: w };
      S.nativas++;
      const r = await pedir(ruta, 'png', hasta);
      if (!r.ok) return r;
      const img = decodificarPng(r.bytes);
      if (!img || img.w !== TESELA_SLIDER || img.h !== TESELA_SLIDER) { S.fallas++; return { ok: false, motivo: 'forma' }; }
      guardar(memoN, ruta, img, MEMO_NATIVAS);
      return { ok: true, img };
    });
  }
  /** la tesela de Leaflet, validada → { ok, bytes (PNG), noche } | { ok:false, motivo: 'pedido' (404) | 'freno' | 'tope' | … } */
  async function tesela(prod, t, z, x, y, op2) {
    const hasta = op2 && op2.hasta != null ? op2.hasta : ahora() + (op2 && op2.presupuesto_ms ? op2.presupuesto_ms : PRESUPUESTO_MS);
    const mal = validarTesela(prod, z, x, y);
    if (mal) return { ok: false, motivo: 'pedido', error: mal };
    if (!RE_TIEMPO.test(String(t))) return { ok: false, motivo: 'pedido', error: 'tiempo con forma desconocida' };
    const clave = prod + '/' + t + '/' + z + '/' + x + '/' + y;
    const m = memoT.get(clave); if (m) { S.aciertos++; return Object.assign({ ok: true, cache: true }, m); }
    return compartido('m:' + clave, async () => {
      const ti = await tiempos(prod, hasta);
      if (!ti.ok) return ti;
      if (ti.tiempos.indexOf(String(t)) < 0) return { ok: false, motivo: 'pedido', error: 'ese tiempo no está en latest_times de SLIDER' };
      /* el visible con la tesela entera de noche: transparente, SIN pedirle nada a CIRA (la página dice «sin luz solar») */
      if (PRODUCTOS[prod].diurno && enteraDeNoche(z, x, y, tiempoMs(t))) {
        const out = { bytes: codificarPng(TESELA, TESELA, new Uint8Array(TESELA * TESELA * 4)), noche: 1, nativas: 0 };
        guardar(memoT, clave, out, MEMO_TESELAS);
        return Object.assign({ ok: true, cache: false }, out);
      }
      const { zs, lista } = nativasDe(prod, z, x, y);
      const imgs = new Map();
      const rs = await Promise.all(lista.map((q) => nativa(prod, String(t), zs, q.f, q.c, hasta).then((r) => ({ q, r }))));
      for (const { q, r } of rs) { if (!r.ok) return { ok: false, motivo: r.motivo || 'falla', sin_dato: true }; imgs.set(q.f + '_' + q.c, r.img); }
      if (ahora() >= hasta) return { ok: false, motivo: 'presupuesto', sin_dato: true };
      const rp = reproyectar(prod, String(t), z, x, y, imgs);
      S.reproyectadas++;
      /* [revisión Codex n3-311 · 1] UN FALLO PARCIAL NUNCA ES UNA IMAGEN BUENA: si a un píxel le faltó su tesela de SLIDER, la tesela
         entera es «sin dato» (503 no-store, rayada en la página) y no se guarda en ningún lado */
      if (rp.faltan > 0) { S.incompletas = (S.incompletas || 0) + 1; return { ok: false, motivo: 'incompleta', sin_dato: true, faltan: rp.faltan }; }
      const out = { bytes: codificarPng(TESELA, TESELA, rp.rgba), noche: rp.noche, nativas: lista.length };
      guardar(memoT, clave, out, MEMO_TESELAS);
      return Object.assign({ ok: true, cache: false }, out);
    });
  }
  return {
    tiempos, tesela, nativa,
    estado: () => ({ freno_hasta: frenoHasta > ahora() ? new Date(frenoHasta).toISOString() : null, memo_teselas: memoT.size, memo_nativas: memoN.size, stats: Object.assign({}, S) })
  };
}
