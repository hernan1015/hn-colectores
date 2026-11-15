// Fixtures SINTÉTICOS con el formato EXACTO que escribe ronda.mjs (main 7a3d3af) en R2:
//   estaciones-internas/weatherlink/indices/<día>.json   [{ id, lat, lng, tb }]
//   estaciones-internas/weatherlink/<día>/<HHMM>.jsonl   { id, leido, d: <detalle> } por renglón
//   estaciones-internas/weathercloud/<día>/<HHMM>.json   { leido, devices: [[…], …] }   ([2] lat, [3] lon, [4] estado)
// ⚠ Lo que ronda.mjs NO fija (las claves de `d` y las otras posiciones de los devices) va con lo SUPUESTO en
// formato.mjs: no hay muestras reales en pc-nanci y no se hizo ningún pedido (ni a R2).
// Van en una carpeta temporal y se leen con almacenCarpeta (sipan-alto-valle/lib/almacen.mjs), sin red.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));        // estaciones-privadas/parseo
const REPO = path.resolve(RAIZ, '..', '..');
export const { almacenCarpeta } = await import(pathToFileURL(path.join(REPO, 'sipan-alto-valle', 'lib', 'almacen.mjs')).href);

export const ep = (iso) => Math.round(Date.parse(iso) / 1000);
const diaARG = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16).replace(':', '');

/** Un detalle de WeatherLink con las claves supuestas (°F, mph, in, inHg). */
export function detalleWL({ t, edad = 120, f = 50, hum = 60, mph = 5, rainIn = 0, nombre = 'Chacra 03', ...resto } = {}) {
  return { stationName: nombre, temperature: f, humidity: hum, windSpeed: mph, windDirection: 'NNE', barometer: 29.92,
    rainDay: rainIn, lastTimestamp: ep(t), ageInSeconds: edad, ...resto };
}

/** Una carpeta-R2 nueva. */
export function carpeta() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseo-r2-'));
  return { dir, r2: almacenCarpeta(dir) };
}

/** Una ronda de WeatherLink a la hora `ms` (UTC) con estas lecturas: [{ id, ...detalle }]. */
export async function rondaWL(r2, ms, filas) {
  const lineas = filas.map(({ id, leido, d }) => JSON.stringify({ id, leido: leido || new Date(ms + 60e3).toISOString(), d }));
  await r2.escribir(`estaciones-internas/weatherlink/${diaARG(ms)}/${hhmm(ms)}.jsonl`, lineas.join('\n') + '\n');
}
export async function indiceWL(r2, dia, lista) {
  await r2.escribir(`estaciones-internas/weatherlink/indices/${dia}.json`, JSON.stringify(lista));
}
/** Una ronda de Weathercloud: devices = arrays. */
export async function rondaWC(r2, ms, devices) {
  await r2.escribir(`estaciones-internas/weathercloud/${diaARG(ms)}/${hhmm(ms)}.json`, JSON.stringify({ leido: new Date(ms).toISOString(), devices }));
}

/** Un formato de Weathercloud «verificado» SÓLO para los tests (posiciones inventadas: [5] temp, [6] hum, [7] viento, [8] lluvia). */
export const WC_PRUEBA = {
  verificado: true,
  posiciones: { id: 0, nombre: 1, lat: 2, lon: 3, estado: 4, instante: null, temp_c: 5, hum_pct: 6, viento_ms: 7, racha_ms: null,
    viento_dir_gr: null, presion_hpa: null, lluvia_dia_mm: 8 },
  escala: { temp_c: 0.1, viento_ms: 0.1, racha_ms: 0.1, presion_hpa: 0.1, lluvia_dia_mm: 0.1, hum_pct: 1, viento_dir_gr: 1 },
  unidad: { viento_ms: 'kmh', racha_ms: 'kmh' },
  en_linea: 2,
};
export const devWC = (id, { t = 215, hum = 40, kmh10 = 360, lluvia10 = 12, estado = 2, nombre = 'CÃ³rdoba Centro', lat = -31.4, lon = -64.2 } = {}) =>
  [id, nombre, lat, lon, estado, t, hum, kmh10, lluvia10];

/* ── los LOTES de la notebook (local.jsonl.gz): SINTÉTICOS, con las formas que acepta formato.mjs (LOTE_WL / LOTE_WC).
   ⚠ El formato real de colector-wl.mjs / colector-wc.mjs no lo vi: estas son las formas supuestas. */
import zlib from 'node:zlib';
/** El lote de WeatherLink: un renglón por lectura, { id, leido, d } (o con otras claves de LOTE_WL). */
export async function loteWL(r2, dia, renglones) {
  await r2.escribir(`estaciones-internas/weatherlink/${dia}/local.jsonl.gz`, zlib.gzipSync(renglones.map((o) => JSON.stringify(o)).join('\n') + '\n'));
}
/** El lote de Weathercloud: un renglón por pasada { leido, devices } o por device { leido, d: [...] }. */
export async function loteWC(r2, dia, renglones) {
  await r2.escribir(`estaciones-internas/weathercloud/${dia}/local.jsonl.gz`, zlib.gzipSync(renglones.map((o) => JSON.stringify(o)).join('\n') + '\n'));
}

/** Las políticas de la 0147b (el archivo REAL del repo), sin la parte del rol, para PGlite. */
export function politicas0147b() {
  const t = fs.readFileSync(path.join(REPO, 'sipan-alto-valle', 'migracion', '0147b_rol_colector_estaciones.sql'), 'utf8').replace(/\r\n/g, '\n');
  const a = t.indexOf('grant usage on schema public to colector_estaciones;');
  const b = t.indexOf('-- (Una política «for all» no da DELETE');
  if (!(a > 0 && b > a)) throw new Error('la 0147b cambió');
  return t.slice(a, b) + '\nalter table public.registro_procesos enable row level security;\n';
}
