// Falsos para los tests de gremlin: SLIDER de mentira (sin red), PNG sintéticos y carpeta temporal.
// GREMLIN_LIB apunta a la copia mutada de lib/ cuando corre el control negativo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const LIB = process.env.GREMLIN_LIB || new URL('../lib/', import.meta.url).href;
export const S = await import(LIB + 'slider.mjs');
export const C = await import(LIB + 'colector.mjs');
export const ALM = await import(new URL('../../rayos-hora/lib/almacen.mjs', import.meta.url).href);

export const DATOS = path.join(AQUI, 'datos');
export const leerDato = (n) => fs.readFileSync(path.join(DATOS, n));

export function carpetaTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-test-'));
}

/** PNG VÁLIDO (chunks con CRC e IDAT que se descomprime entero), 8 bits con paleta, como los de SLIDER. */
export function pngFalso(ancho = 678, alto = 678, semilla = 'x') {
  const chunk = (tipo, datos) => {
    const t = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const l = Buffer.alloc(4); l.writeUInt32BE(datos.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(S.crc32(t));
    return Buffer.concat([l, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4); ihdr[8] = 8; ihdr[9] = 3;
  const filas = Buffer.alloc(alto * (1 + ancho));
  const v = [...String(semilla)].reduce((x, ch) => (x + ch.charCodeAt(0)) % 4, 0);
  for (let i = 0; i < alto; i++) filas[i * (1 + ancho) + 1] = v;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', Buffer.alloc(12)), chunk('IDAT', zlib.deflateSync(filas)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** El fixture real con un byte del IDAT cambiado y su CRC recalculado: mismo largo, mismo IEND, pero no descomprime (311b). */
export function idatCorrupto(png) {
  const b = Buffer.from(png);
  let pos = 8;
  while (b.toString('latin1', pos + 4, pos + 8) !== 'IDAT') pos += 12 + b.readUInt32BE(pos);
  const largo = b.readUInt32BE(pos);
  for (let i = 0; i < 64; i++) b[pos + 8 + Math.floor(largo / 2) + i] ^= 0xff;
  b.writeUInt32BE(S.crc32(b.subarray(pos + 4, pos + 8 + largo)), pos + 8 + largo);
  return b;
}

/** Igual, pero con el CRC viejo (el IDAT tocado no coincide con su CRC). */
export function crcMal(png) {
  const b = Buffer.from(png);
  let pos = 8;
  while (b.toString('latin1', pos + 4, pos + 8) !== 'IDAT') pos += 12 + b.readUInt32BE(pos);
  b[pos + 8 + 10] ^= 0x01;
  return b;
}

const respuesta = (cuerpo, status = 200, tipo = 'image/png', largo) => {
  const buf = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo);
  return new Response(buf, { status, headers: { 'content-type': tipo, 'content-length': String(largo ?? buf.length) } });
};

/**
 * SLIDER de mentira. `tiempos`: lista de AAAAMMDDhhmmss. `tesela(t, fila, col, n)` decide la respuesta de cada tesela
 * (n = cuántas veces se pidió esa misma URL): devuelve un Buffer (200 PNG), { status }, { cuerpo, tipo }, { largo } o 'red'.
 */
export function sliderFalso({ tiempos = [], tiempoStatus = 200, tesela = () => null } = {}) {
  const pedidos = [];
  const veces = new Map();
  const fetchFn = async (url, opciones = {}) => {
    pedidos.push({ url, ua: opciones.headers?.['user-agent'] });
    const n = (veces.get(url) || 0) + 1;
    veces.set(url, n);
    if (url.endsWith('/latest_times.json')) {
      if (tiempoStatus === 'red') throw new TypeError('fetch failed');
      if (tiempoStatus !== 200) return respuesta('error', tiempoStatus, 'text/html');
      return respuesta(JSON.stringify({ timestamps_int: [...tiempos].reverse().map(Number) }), 200, 'application/json');
    }
    const m = url.match(/\/(\d{14})\/(\d{2})\/(\d{3})_(\d{3})\.png$/);
    if (!m) return respuesta('no', 404, 'text/html');
    const r = tesela(m[1], Number(m[3]), Number(m[4]), n);
    if (r === 'red') throw new TypeError('fetch failed');
    if (r == null) return respuesta(pngFalso(678, 678, `${m[1]}-${m[3]}-${m[4]}`));
    if (Buffer.isBuffer(r)) return respuesta(r);
    if (r.cuerpo !== undefined) return respuesta(r.cuerpo, r.status || 200, r.tipo || 'image/png', r.largo);
    return respuesta('error', r.status, 'text/html');
  };
  return { fetchFn, pedidos, teselasPedidas: () => pedidos.filter((p) => p.url.endsWith('.png')) };
}

/** Tiempos cada 10 min que terminan en `ultimoMs`, del más viejo al más nuevo. */
export function tiemposHasta(ultimoMs, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(ultimoMs - i * 600000);
    out.push(d.toISOString().replace(/[-:T]/g, '').slice(0, 14));
  }
  return out;
}

export const sinEspera = async () => {};
export const callado = () => {};
