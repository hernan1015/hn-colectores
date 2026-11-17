// HN AGRO · GREMLIN (CIRA) en RAMMB SLIDER: nombres, URLs, tiempos, geometría del disco y validación de teselas.
// Todo lo de acá es puro (sin red ni almacén), para poder probarlo sin nada.
//
import zlib from 'node:zlib';

// Nombres leídos el 16/11/2026 (21:58 ART) de https://slider.cira.colostate.edu/js/define-products.js:
//   satélite "goes-19" (GOES-19 East; 75.2W) · sector "full_disk" (max_zoom_level 5, tile_size 678, cada 10 min)
//   producto "gremlin": "GREMLIN (CIRA)", zoom_level_adjust 2, resolution "2 km"
//   imagery_resolutions: zoom 0 = 16 km, 1 = 8 km, 2 = 4 km, 3 = 2 km  →  zoom nativo de GREMLIN = 5 − 2 = 3
//   lat_lon_query: lon0 −75.0, sat_alt 42171.7 km, max_rad_x 0.151337, max_rad_y 0.150988
// Tiempos: https://slider.cira.colostate.edu/data/json/goes-19/full_disk/gremlin/latest_times.json
//   → { "timestamps_int": [20261117003000, …] } (100 tiempos, del más nuevo al más viejo; ~17-18 h con huecos)
// Teselas (probado: PNG 678×678 de 8 bits con paleta, ~40-60 KB, «Cache-Control: public, immutable»):
//   https://slider.cira.colostate.edu/data/imagery/AAAA/MM/DD/goes-19---full_disk/gremlin/AAAAMMDDhhmmss/03/FFF_CCC.png

export const BASE = 'https://slider.cira.colostate.edu';
export const SATELITE = 'goes-19';
export const SECTOR = 'full_disk';
export const PRODUCTO = 'gremlin';
export const ZOOM = 3;                 // 2 km, el nativo de GREMLIN
export const TESELA_PX = 678;
export const RESOLUCION = '2 km';
export const UA = 'hn-colector/1.0';

// La caja Argentina: la misma de rayos-hora (lat −56.5 a −20, lon −76.5 a −52).
export const CAJA = Object.freeze({ lat_min: -56.5, lat_max: -20, lon_min: -76.5, lon_max: -52 });

export const FUENTE = Object.freeze({
  nombre: 'CIRA/RAMMB SLIDER',
  producto: 'GREMLIN (CIRA)',
  url: `${BASE}/?sat=${SATELITE}&sec=${SECTOR}&p[0]=${PRODUCTO}`,
  cita: 'GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER · GREMLIN (CIRA)',
  aclaracion: 'Radar sintético estimado desde satélite (ABI + GLM), entrenado en EE. UU. contra MRMS: no es radar.',
});

export const urlTiempos = () => `${BASE}/data/json/${SATELITE}/${SECTOR}/${PRODUCTO}/latest_times.json`;

const p3 = (n) => String(n).padStart(3, '0');
const p2 = (n) => String(n).padStart(2, '0');

/** «AAAAMMDDhhmmss» → { a, m, d } del propio tiempo (UTC). */
export function partesTiempo(t) {
  if (!esTiempo(t)) throw new Error(`tiempo inválido: ${t}`);
  return { a: t.slice(0, 4), m: t.slice(4, 6), d: t.slice(6, 8) };
}

export function esTiempo(t) {
  if (typeof t !== 'string' || !/^\d{14}$/.test(t)) return false;
  const ms = tiempoMs(t);
  return Number.isFinite(ms) && isoTiempo(ms) === aIso(t);
}

const aIso = (t) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
export const tiempoMs = (t) => Date.parse(aIso(t));
export const isoTiempo = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function urlTesela(t, fila, col, zoom = ZOOM) {
  const { a, m, d } = partesTiempo(t);
  return `${BASE}/data/imagery/${a}/${m}/${d}/${SATELITE}---${SECTOR}/${PRODUCTO}/${t}/${p2(zoom)}/${p3(fila)}_${p3(col)}.png`;
}

/** La lista de tiempos de latest_times.json, validada, sin repetidos y del más viejo al más nuevo. */
export function parsearTiempos(json) {
  const crudos = json && Array.isArray(json.timestamps_int) ? json.timestamps_int : null;
  if (!crudos) throw new Error('latest_times.json sin timestamps_int');
  const ok = new Set();
  for (const x of crudos) {
    const t = String(x);
    if (esTiempo(t)) ok.add(t);
  }
  return [...ok].sort();
}

// ---------- geometría: proyección geoestacionaria (grilla fija de ABI), con los números de SLIDER ----------
const REQ = 6378.137, RPOL = 6356.75231414, H = 42171.7, LON0 = -75.0, MAX_X = 0.151337, MAX_Y = 0.150988;

/** (lat, lon) → píxel (columna, fila) de la imagen del disco entero al zoom dado (ancho 678·2^zoom). null = fuera del disco. */
export function pixel(lat, lon, zoom = ZOOM) {
  const f = (lat * Math.PI) / 180, l = ((lon - LON0) * Math.PI) / 180;
  const e2 = 1 - (RPOL * RPOL) / (REQ * REQ);
  const fc = Math.atan(((RPOL * RPOL) / (REQ * REQ)) * Math.tan(f));
  const rc = RPOL / Math.sqrt(1 - e2 * Math.cos(fc) ** 2);
  const sx = H - rc * Math.cos(fc) * Math.cos(l), sy = -rc * Math.cos(fc) * Math.sin(l), sz = rc * Math.sin(fc);
  if (sx * (H - sx) < sy * sy + (REQ * REQ / (RPOL * RPOL)) * sz * sz) return null;   // del otro lado de la Tierra
  const x = Math.asin(-sy / Math.hypot(sx, sy, sz)), y = Math.atan(sz / sx);
  const ancho = TESELA_PX * 2 ** zoom;
  return { col: ((x + MAX_X) / (2 * MAX_X)) * ancho, fila: ((MAX_Y - y) / (2 * MAX_Y)) * ancho };
}

/** La tesela que contiene un punto: { fila, col } o null. */
export function teselaDe(lat, lon, zoom = ZOOM) {
  const p = pixel(lat, lon, zoom);
  if (!p) return null;
  const n = 2 ** zoom;
  const fila = Math.floor(p.fila / TESELA_PX), col = Math.floor(p.col / TESELA_PX);
  if (fila < 0 || col < 0 || fila >= n || col >= n) return null;
  return { fila, col };
}

/** Las teselas que toca la caja (barrido de la caja cada 0,05°, bordes incluidos), ordenadas por fila y columna. */
export function teselasCaja(caja = CAJA, zoom = ZOOM, paso = 0.05) {
  const vistas = new Map();
  const nLat = Math.round((caja.lat_max - caja.lat_min) / paso), nLon = Math.round((caja.lon_max - caja.lon_min) / paso);
  for (let i = 0; i <= nLat; i++) {
    const lat = caja.lat_min + ((caja.lat_max - caja.lat_min) * i) / nLat;
    for (let j = 0; j <= nLon; j++) {
      const lon = caja.lon_min + ((caja.lon_max - caja.lon_min) * j) / nLon;
      const t = teselaDe(lat, lon, zoom);
      if (t) vistas.set(`${t.fila}_${t.col}`, t);
    }
  }
  return [...vistas.values()].sort((a, b) => a.fila - b.fila || a.col - b.col);
}

// ---------- validación: nunca se guarda algo que no sea un PNG entero de 678×678 ----------
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIN_PNG = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);   // «IEND» + su CRC

// CRC-32 de PNG (el de zlib), con tabla propia: no depende de la versión de Node.
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Profundidades válidas por tipo de color (especificación PNG, tabla 11.1).
export const PROFUNDIDADES = Object.freeze({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] });

/**
 * null si sirve; si no, el motivo. Se valida el PNG según la especificación, para lo que trae SLIDER: color con PALETA
 * (tipo 3; las teselas de GREMLIN son de 8 bits). 311b, 2.ª y 3.ª vuelta de Codex:
 *  - firma; cada chunk entero, con nombre legible y su CRC; un chunk crítico desconocido es inválido;
 *  - IHDR primero, uno solo, de 13 bytes, 678×678, tipo 3 con profundidad válida para el tipo (1, 2, 4 u 8),
 *    compresión 0, filtro 0, sin entrelazado;
 *  - PLTE: una sola, ANTES del IDAT, largo múltiplo de 3, entre 1 y min(256, 2^profundidad) entradas;
 *  - tRNS (si está): después de PLTE y antes del IDAT, una sola, con no más entradas que la PLTE;
 *  - IDAT: al menos uno, todos seguidos; se descomprime entero con zlib y da justo alto × (1 + bytes por fila);
 *  - cada fila con filtro 0 a 4; se deshace el filtro y TODOS los índices de píxel son menores que las entradas de la PLTE;
 *  - IEND último, vacío, y nada después.
 */
export function motivoTeselaMala(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 25 + 12) return 'muy corta';
  if (!buf.subarray(0, 8).equals(FIRMA_PNG)) return 'no es PNG';
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return 'PNG sin IHDR';
  const ancho = buf.readUInt32BE(16), alto = buf.readUInt32BE(20);
  if (ancho !== TESELA_PX || alto !== TESELA_PX) return `PNG de ${ancho}×${alto}`;
  if (!buf.subarray(buf.length - 8).equals(FIN_PNG)) return 'PNG cortado (sin IEND)';
  const idat = [];
  let pos = 8, ihdr = null, entradas = 0, trns = false, idatCerrado = false, fin = false, previo = '';
  while (pos < buf.length) {
    if (pos + 12 > buf.length) return 'PNG con un chunk cortado';
    const largo = buf.readUInt32BE(pos);
    const tipo = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(tipo)) return 'PNG con un chunk ilegible';
    if (pos + 12 + largo > buf.length) return `PNG con el chunk ${tipo} cortado`;
    const datos = buf.subarray(pos + 8, pos + 8 + largo);
    if (crc32(buf.subarray(pos + 4, pos + 8 + largo)) !== buf.readUInt32BE(pos + 8 + largo)) return `PNG con el CRC de ${tipo} mal`;
    if (pos === 8 && tipo !== 'IHDR') return 'PNG sin IHDR';
    if (idat.length && previo === 'IDAT' && tipo !== 'IDAT') idatCerrado = true;
    if (tipo === 'IHDR') {
      if (ihdr || largo !== 13) return 'PNG con IHDR raro';
      ihdr = datos;
      const prof = ihdr[8], color = ihdr[9];
      if (color !== 3) return `PNG de tipo de color ${color} (se espera paleta, tipo 3)`;
      if (!PROFUNDIDADES[color].includes(prof)) return `PNG con profundidad ${prof} inválida para el tipo ${color}`;
      if (ihdr[10] !== 0 || ihdr[11] !== 0) return 'PNG con compresión o filtro desconocidos';
      if (ihdr[12] !== 0) return 'PNG entrelazado (no se espera)';
    } else if (tipo === 'PLTE') {
      if (entradas) return 'PNG con dos PLTE';
      if (largo === 0 || largo % 3 !== 0) return 'PNG con una PLTE de largo inválido';
      entradas = largo / 3;
      if (entradas > Math.min(256, 2 ** ihdr[8])) return `PNG con una PLTE de ${entradas} entradas (de más)`;
    } else if (tipo === 'tRNS') {
      if (trns) return 'PNG con dos tRNS';
      if (!entradas) return 'PNG con tRNS antes de la PLTE';
      if (idat.length) return 'PNG con tRNS después del IDAT';
      if (largo > entradas) return 'PNG con más tRNS que entradas de PLTE';
      trns = true;
    } else if (tipo === 'IDAT') {
      if (idatCerrado) return 'PNG con IDAT no consecutivos';
      if (!entradas) return 'PNG con paleta sin PLTE antes del IDAT';
      idat.push(datos);
    } else if (tipo === 'IEND') {
      if (largo !== 0) return 'PNG con IEND no vacío';
      fin = true; pos += 12 + largo; break;
    } else if (tipo.charCodeAt(0) < 97) {
      return `PNG con un chunk crítico desconocido (${tipo})`;   // mayúscula inicial = crítico
    }
    previo = tipo;
    pos += 12 + largo;
  }
  if (!fin || pos !== buf.length) return 'PNG con datos después de IEND';
  if (!idat.length) return 'PNG sin IDAT';
  let crudo;
  try { crudo = zlib.inflateSync(Buffer.concat(idat)); } catch { return 'PNG con el IDAT corrupto'; }
  const prof = ihdr[8];
  const bytesFila = Math.ceil((ancho * prof) / 8);
  const porFila = 1 + bytesFila;
  if (crudo.length !== alto * porFila) return 'PNG con el IDAT de otro largo';
  // deshacer los filtros (con paleta, la unidad del filtro es 1 byte) y mirar cada índice
  let arriba = Buffer.alloc(bytesFila);
  const fila = Buffer.alloc(bytesFila);
  const mascara = (1 << prof) - 1;
  for (let f = 0; f < alto; f++) {
    const filtro = crudo[f * porFila];
    if (filtro > 4) return 'PNG con un filtro de fila inválido';
    const ent = crudo.subarray(f * porFila + 1, (f + 1) * porFila);
    for (let i = 0; i < bytesFila; i++) {
      const a = i > 0 ? fila[i - 1] : 0, b = arriba[i], c = i > 0 ? arriba[i - 1] : 0;
      let pred = 0;
      if (filtro === 1) pred = a;
      else if (filtro === 2) pred = b;
      else if (filtro === 3) pred = (a + b) >> 1;
      else if (filtro === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      fila[i] = (ent[i] + pred) & 0xff;
    }
    for (let x = 0; x < ancho; x++) {
      const bit = x * prof;
      const indice = prof === 8 ? fila[x] : (fila[bit >> 3] >> (8 - prof - (bit & 7))) & mascara;
      if (indice >= entradas) return `PNG con un índice de píxel (${indice}) fuera de la PLTE de ${entradas}`;
    }
    arriba = Buffer.from(fila);
  }
  return null;
}
