// HN AGRO · goes-serie · NOAA: el bucket público de GOES-19 (sin cuenta). El mismo producto y el mismo bucket que
// hn-agro netlify/functions/lib/goes-focos.mjs: ABI-L2-FDCF/<año>/<díaJuliano>/<hora>/OR_ABI-L2-FDCF-M6_G19_s….nc
// ⛔ Se baja ENTERO y se verifica: el tamaño contra el listado y contra content-length, y la firma HDF5 al principio.
//    Nunca por rangos (un HDF5 cortado no falla: da números inventados).
import { instanteDe, turno } from './claves.mjs';
import { errorCodigo } from './r2.mjs';

export const BUCKET = 'https://noaa-goes19.s3.amazonaws.com';
export const PRODUCTO = 'ABI-L2-FDCF';
export const SATELITE = 'GOES-19';
export const FIRMA_HDF5 = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
const INTENTOS = 2;

const dd = (n, k = 2) => String(n).padStart(k, '0');
export function diaJuliano(ms) {
  const d = new Date(ms);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
}
/** PURA. El prefijo de NOAA de la hora UTC que contiene ms */
export const prefijoHora = (ms) => { const d = new Date(ms); return `${PRODUCTO}/${d.getUTCFullYear()}/${dd(diaJuliano(ms), 3)}/${dd(d.getUTCHours())}/`; };

/** Los archivos de una hora → [{ruta, archivo, bytes, t_scan (ms), turno (ms)}] */
export async function listarHora(ms, fetchFn = fetch) {
  const r = await fetchFn(`${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefijoHora(ms))}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw errorCodigo('noaa_listar_http_' + (Number.isInteger(r.status) ? r.status : 0));
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const k = (/<Key>([^<]+)<\/Key>/.exec(m[1]) || [])[1];
    const b = (/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1];
    if (!k || !/\.nc$/.test(k)) continue;
    const t = instanteDe(k);
    if (t == null) continue;
    out.push({ ruta: k, archivo: k.split('/').pop(), bytes: b ? Number(b) : null, t_scan: t, turno: turno(t) });
  }
  return out.sort((a, b) => a.t_scan - b.t_scan);
}

/** Baja un archivo entero y lo verifica → Buffer. Falla con un código (noaa_http_NNN, noaa_incompleto, noaa_no_hdf5). */
export async function bajar(obj, fetchFn = fetch) {
  let ultimo = null;
  for (let intento = 0; intento < INTENTOS; intento++) {
    try {
      const r = await fetchFn(`${BUCKET}/${obj.ruta}`, { signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw errorCodigo('noaa_http_' + (Number.isInteger(r.status) ? r.status : 0));
      const buf = Buffer.from(await r.arrayBuffer());
      const largo = Number(r.headers.get('content-length') || 0);
      if ((largo && buf.length !== largo) || (obj.bytes && buf.length !== obj.bytes)) throw errorCodigo('noaa_incompleto');
      if (buf.length < 8 || !buf.subarray(0, 8).equals(FIRMA_HDF5)) throw errorCodigo('noaa_no_hdf5');
      return buf;
    } catch (e) { ultimo = e; }
  }
  throw ultimo;
}
