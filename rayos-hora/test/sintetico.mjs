// Archivos GLM L2 LCFA SINTÉTICOS con la misma estructura que los reales (nombres de variables, int16 empaquetados
// con _Unsigned, scale_factor/add_offset y _FillValue tomados de un archivo real de GOES-16 del 16/12/2024),
// y un «NOAA» de mentira para los tests. No baja nada de internet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIB = process.env.RAYOS_LIB || new URL('../lib/', import.meta.url).href;
export const GLM = await import(new URL('glm.mjs', LIB.endsWith('/') ? LIB : LIB + '/').href);
export const CACHE = await import(new URL('cache.mjs', LIB.endsWith('/') ? LIB : LIB + '/').href);
export const ALM = await import(new URL('almacen.mjs', LIB.endsWith('/') ? LIB : LIB + '/').href);

// empaquetado del archivo real (flash_energy, flash_area, flash_time_offset_of_first_event)
const EN = { sf: 9.999959802209943e-16, of: 2.8514998886357517e-16 };
const AR = { sf: 152601.859375, of: 0 };
const TT = { sf: 0.00038147560553625226, of: -5 };
const comoInt16 = (u) => (u > 32767 ? u - 65536 : u);   // lo que guarda el archivo para un valor sin signo
const empacar = (v, p) => comoInt16(Math.round((v - p.of) / p.sf));

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** Nombre real de un archivo de 20 s que empieza en t0 (ms). */
export function nombre(t0, sat = 'G19') {
  const f = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad(GLM.diaJuliano(d), 3)}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${Math.floor(d.getUTCMilliseconds() / 100)}`;
  };
  return `OR_GLM-L2-LCFA_${sat}_s${f(t0)}_e${f(t0 + 20000)}_c${f(t0 + 21000)}.nc`;
}

let _n = 0;
/**
 * Arma los bytes de un archivo GLM con estos flashes: [{dt_s (desde el inicio del archivo), lat, lon, energia_J, area_m2, calidad|null}]
 * calidad null = relleno (_FillValue).
 */
export async function archivoGLM(t0, flashes) {
  const H = await GLM.h5();
  const ruta = path.join(os.tmpdir(), `glm-sint-${process.pid}-${_n++}.nc`).split(path.sep).join('/');
  const f = new H.File(ruta, 'w');
  const d = new Date(t0);
  const desde = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000`;
  const n = flashes.length;
  const ds = (name, arr, dtype) => f.create_dataset({ name, data: arr, shape: [n], dtype });
  ds('flash_lat', new Float32Array(flashes.map((x) => x.lat)), '<f');
  ds('flash_lon', new Float32Array(flashes.map((x) => x.lon)), '<f');
  const t = ds('flash_time_offset_of_first_event', new Int16Array(flashes.map((x) => empacar(x.dt_s, TT))), '<h');
  t.create_attribute('_Unsigned', 'true');
  t.create_attribute('scale_factor', new Float32Array([TT.sf]), [1], '<f');
  t.create_attribute('add_offset', new Float32Array([TT.of]), [1], '<f');
  t.create_attribute('units', `seconds since ${desde}`);
  for (const [name, campo, p] of [['flash_energy', 'energia_J', EN], ['flash_area', 'area_m2', AR]]) {
    const v = ds(name, new Int16Array(flashes.map((x) => empacar(x[campo], p))), '<h');
    v.create_attribute('_FillValue', new Int16Array([-1]), [1], '<h');
    v.create_attribute('_Unsigned', 'true');
    v.create_attribute('scale_factor', new Float32Array([p.sf]), [1], '<f');
    v.create_attribute('add_offset', new Float32Array([p.of]), [1], '<f');
  }
  const q = ds('flash_quality_flag', new Int16Array(flashes.map((x) => (x.calidad == null ? -1 : x.calidad))), '<h');
  q.create_attribute('_FillValue', new Int16Array([-1]), [1], '<h');
  q.create_attribute('_Unsigned', 'true');
  f.close();
  const buf = new Uint8Array(fs.readFileSync(ruta));
  fs.unlinkSync(ruta);
  return buf;
}

/**
 * NOAA de mentira. `porHora(horaMs)` → {slots: [índices 0..179 publicados], flashes(slot) → [...], falla(slot) → bool}
 * o lanza para simular que el listado falla. Cuenta pedidos.
 */
export function noaaFalso({ porHora, sat = 'G19' }) {
  const bytes = new Map();
  let vacio = null;
  const cuenta = { listados: 0, bajadas: 0 };
  const glm = {
    ...GLM,
    async listarHora(horaMs) {
      cuenta.listados++;
      const p = porHora(horaMs);
      if (p.errorListado) throw new Error(p.errorListado);
      const archivos = [];
      for (const s of p.slots) {
        const t0 = horaMs + s * 20000;
        const clave = `${GLM.prefijoHora(horaMs)}${nombre(t0, sat)}`;
        if (!bytes.has(clave)) {
          const fl = (p.flashes && p.flashes(s)) || [];
          // sin flashes el contenido no depende de la hora: se reusa un solo archivo vacío (los tests van más rápido)
          const buf = fl.length ? await archivoGLM(t0, fl) : (vacio ||= await archivoGLM(t0, []));
          bytes.set(clave, { buf, falla: p.falla ? p.falla(s) : false });
        }
        archivos.push({ clave, tam: bytes.get(clave).buf.length });
      }
      return { url: 'https://noaa-falso', sat: GLM.satelitePara(horaMs), archivos };
    },
    async bajarEntero(url, clave, tam) {
      cuenta.bajadas++;
      const b = bytes.get(clave);
      if (!b || b.falla) throw new Error('HTTP 503');
      if (b.buf.length !== tam) throw new Error('archivo cortado');
      return b.buf;
    },
  };
  return { glm, cuenta };
}

export const todos = () => Array.from({ length: 180 }, (_, i) => i);
export function carpetaTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rayos-hora-test-'));
}
