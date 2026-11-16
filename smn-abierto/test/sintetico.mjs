// Archivos «datos horarios» SINTÉTICOS con el formato documentado del SMN (ver lib/datohorario.mjs) y un ZIP mínimo
// (sin dependencias) para meterlos. El único archivo real que se bajó (14/11/2026) vino vacío: está en el cortex,
// docs/red-nacional-139/fixtures/, y lo usa test/smn.test.mjs si encuentra la carpeta (SMN_FIXTURES).
import zlib from 'node:zlib';

const p2 = (n) => String(n).padStart(2, '0');
/* columnas: FECHA(0-8) · HORA fin 14 · TEMP fin 20 · HUM fin 26 · PNM fin 34 · DD fin 40 · FF fin 46 · NOMBRE desde 48 */
const FINES = [14, 20, 26, 34, 40, 46];
const alinear = (primero, rotulos, ultimo) => { let l = primero; rotulos.forEach((s, i) => { l = l.padEnd(FINES[i] - s.length) + s; }); return (l.padEnd(48) + ultimo).trimEnd(); };
export const ENCABEZADO = alinear('FECHA', ['HORA', 'TEMP', 'HUM', 'PNM', 'DD', 'FF'], 'NOMBRE');
export const UNIDADES = alinear('', ['[HOA]', '[ºC]', '[%]', '[hPa]', '[gr]', '[km/hr]'], '');

/** Una fila. `v` = { temp, hum, pnm, dd, ff }; null = campo en blanco; un texto se pone tal cual («---»). */
export function fila({ fecha, hora, v = {}, nombre }) {
  const [y, m, d] = fecha.split('-');
  let l = `${d}${m}${y}`;
  const vals = [String(hora), ...['temp', 'hum', 'pnm', 'dd', 'ff'].map((k) => (v[k] == null ? '' : typeof v[k] === 'string' ? v[k] : k === 'temp' || k === 'pnm' ? Number(v[k]).toFixed(1) : String(v[k])))];
  vals.forEach((s, i) => { l = l.padEnd(FINES[i] - s.length) + s; });
  return l.padEnd(48) + nombre;
}

/** Las 24 lecturas de un día para una estación: temp(h) da la temperatura de la hora h. */
export function dia(fecha, nombre, temp = (h) => 10 + h / 2, extra = {}) {
  return Array.from({ length: 24 }, (_, h) => ({ fecha, hora: h, nombre, v: { temp: temp(h), hum: 70, pnm: 1012.3, dd: 180, ff: 9, ...extra } }));
}

export function texto(filas, { encabezado = ENCABEZADO, unidades = UNIDADES } = {}) {
  return [encabezado, unidades, ...filas.map((f) => (typeof f === 'string' ? f : fila(f)))].join('\r\n') + '\r\n';
}

/** Un ZIP con una (o más) entradas, comprimidas con deflate. */
export function zip(entradas) {
  const locales = [], centrales = [];
  let of = 0;
  for (const [nombre, contenido] of entradas) {
    const datos = Buffer.from(contenido, 'latin1');
    const comp = zlib.deflateRawSync(datos);
    const n = Buffer.from(nombre, 'latin1');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(datos.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(datos.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(of, 42);
    locales.push(lh, n, comp); centrales.push(ch, n);
    of += 30 + n.length + comp.length;
  }
  const central = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(entradas.length, 8); fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(central.length, 12); fin.writeUInt32LE(of, 16);
  return Buffer.concat([...locales, central, fin]);
}

/** El ZIP de un día, como lo entrega el SMN (datohorarioAAAAMMDD.txt). */
export const zipDelDia = (fecha, filas, op) => zip([[`datohorario${fecha.replace(/-/g, '')}.txt`, texto(filas, op)]]);
export const hora = (fecha, h) => `${fecha}T${p2(h)}:00`;
