// Falsos para los tests de gremlin: SLIDER de mentira (sin red), PNG sintéticos y carpeta temporal.
// GREMLIN_LIB apunta a la copia mutada de lib/ cuando corre el control negativo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/** PNG mínimo con la forma que valida el colector: firma + IHDR (ancho × alto) + IEND. */
export function pngFalso(ancho = 678, alto = 678, relleno = 'x') {
  const firma = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'latin1'); ihdr.writeUInt32BE(ancho, 8); ihdr.writeUInt32BE(alto, 12);
  ihdr[16] = 8; ihdr[17] = 3;
  const datos = Buffer.from(relleno);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([firma, ihdr, datos, iend]);
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
