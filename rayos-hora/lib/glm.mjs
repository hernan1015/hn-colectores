// HN AGRO · lectura del GLM L2 LCFA (GOES) para la caché horaria de rayos.
// ─────────────────────────────────────────────────────────────────────────────
// Fuente: bucket público de NOAA, sin cuenta: https://noaa-goes19.s3.amazonaws.com/GLM-L2-LCFA/AAAA/DDD/HH/
// (DDD = día juliano). Un archivo cada 20 s: 180 por hora, de ~300-900 KB.
//
// ⛔ NUNCA SE LEE POR RANGOS. Un HDF5 leído a pedazos o cortado da números inventados: se baja el archivo
//    ENTERO y se comprueba el tamaño contra el del listado (y contra content-length). Si no coincide, ese
//    archivo cuenta como fallido y la hora queda «incompleta».
// ⛔ _Unsigned: h5wasm entrega los int16 CON SIGNO y sin escalar. Acá se decodifica a mano, igual que netCDF4:
//    1) relleno (_FillValue, comparado en crudo), 2) si _Unsigned=true y el valor es negativo, +65536,
//    3) × scale_factor + add_offset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PRODUCTO = 'GLM-L2-LCFA';
// Caja Argentina + margen (la misma del análisis A: lat_min, lat_max, lon_min, lon_max).
export const CAJA_AR = { latMin: -56.5, latMax: -20.0, lonMin: -76.5, lonMax: -52.0 };
// GOES-19 pasa a ser GOES-East operativo el 7/4/2025 (NOAA). Las horas anteriores se leen de GOES-16.
// Se usa la misma fecha que el análisis A (A-rayos/scripts/glm.py): 2025-04-07 00:00 UTC.
export const CAMBIO_SATELITE_MS = Date.UTC(2025, 3, 7, 0, 0, 0);
export const ARCHIVOS_POR_HORA = 180;   // uno cada 20 s

export function satelitePara(horaMs) {
  return horaMs >= CAMBIO_SATELITE_MS ? 'goes19' : 'goes16';
}
export const nombreSatelite = (s) => (s === 'goes19' ? 'GOES-19' : 'GOES-16');

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function diaJuliano(d) {
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}
export function prefijoHora(horaMs) {
  const d = new Date(horaMs);
  return `${PRODUCTO}/${d.getUTCFullYear()}/${pad(diaJuliano(d), 3)}/${pad(d.getUTCHours())}/`;
}

/** Instantes (ms) de inicio, fin y creación que trae el NOMBRE (_sAAAADDDHHMMSSd_eAAAADDDHHMMSSd_cAAAADDDHHMMSSd). */
export function instantesDe(clave) {
  const leer = (tag) => {
    const m = clave.match(new RegExp('_' + tag + '(\\d{4})(\\d{3})(\\d{2})(\\d{2})(\\d{2})(\\d)'));
    if (!m) return null;
    return Date.UTC(+m[1], 0, 1, +m[3], +m[4], +m[5]) + (+m[2] - 1) * 86400000 + (+m[6]) * 100;
  };
  const t0 = leer('s'), t1 = leer('e'), c = leer('c');
  return t0 == null ? null : { t0, t1, c };
}

/** Lista los archivos de una hora. Devuelve [{clave, tam}] o lanza Error (HTTP o red). */
export async function listarHora(horaMs, { fetchFn = fetch, base } = {}) {
  const sat = satelitePara(horaMs);
  const url = base || `https://noaa-${sat}.s3.amazonaws.com`;
  const pref = prefijoHora(horaMs);
  const out = [];
  let token = null;
  for (let pag = 0; pag < 20; pag++) {
    const q = new URLSearchParams({ 'list-type': '2', prefix: pref });
    if (token) q.set('continuation-token', token);
    const r = await fetchFn(`${url}/?${q}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`listado NOAA HTTP ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1];
      const t = (m[1].match(/<Size>(\d+)<\/Size>/) || [])[1];
      if (k && k.endsWith('.nc')) out.push({ clave: k, tam: Number(t) });
    }
    if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) {
      token = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1];
      if (!token) break;
    } else break;
  }
  return { url, sat, archivos: out };
}

/** Baja un archivo ENTERO y verifica el tamaño. Un reintento como mucho (no hay bucles). */
export async function bajarEntero(url, clave, tam, { fetchFn = fetch, esperaMs = 2000 } = {}) {
  let ultimo = null;
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetchFn(`${url}/${clave}`, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      const largo = Number(r.headers.get('content-length') || 0);
      if ((largo && buf.length !== largo) || (tam && buf.length !== tam)) throw new Error(`archivo cortado ${buf.length}/${tam || largo}`);
      return buf;
    } catch (e) {
      ultimo = e;
      if (intento === 0 && esperaMs) await new Promise((res) => setTimeout(res, esperaMs));
    }
  }
  throw ultimo;
}

// ---------- HDF5 ----------
let _h5 = null;
export async function h5() {
  if (_h5) return _h5;
  const mod = await import('h5wasm/node');
  await mod.ready;
  _h5 = mod;
  return mod;
}

function atributo(ds, nombre) {
  try {
    const a = ds.attrs[nombre];
    if (!a) return null;
    const v = a.value;
    return (v != null && typeof v !== 'string' && v.length !== undefined) ? v[0] : v;
  } catch { return null; }
}

/** Valores de una variable CF ya decodificados (relleno → NaN, _Unsigned, scale/offset). */
export function decodificar(ds) {
  if (!ds) return null;
  let crudo;
  try { crudo = ds.value; } catch { crudo = null; }
  if (crudo == null) return new Float64Array(0);
  if (typeof crudo === 'number') crudo = [crudo];
  const fa = atributo(ds, '_FillValue');
  const fill = fa == null ? null : Number(fa);
  const sinSigno = String(atributo(ds, '_Unsigned') || '').toLowerCase() === 'true';
  const sf = atributo(ds, 'scale_factor'), of = atributo(ds, 'add_offset');
  const esc = sf == null ? 1 : Number(sf), off = of == null ? 0 : Number(of);
  const out = new Float64Array(crudo.length);
  for (let i = 0; i < crudo.length; i++) {
    let v = Number(crudo[i]);
    if (fill != null && v === fill) { out[i] = NaN; continue; }
    if (sinSigno && v < 0) v += 65536;
    out[i] = v * esc + off;
  }
  return out;
}

function baseTiempo(ds, clave) {
  const u = String(atributo(ds, 'units') || '');
  const m = u.match(/since (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + Math.round(parseFloat(m[6]) * 1000);
  const t = instantesDe(clave);
  return t ? t.t0 : null;
}

let _sec = 0;
/**
 * Lee UN archivo GLM (bytes completos) y devuelve los flashes dentro de la caja:
 * [{t (ms UTC), lat, lon, energia_J, area_m2, calidad}] y cuántos había en todo el disco.
 * Se usan FLASHES (no grupos ni eventos): ver LEEME.
 */
export async function leerArchivo(buf, clave, caja = CAJA_AR) {
  const H = await h5();
  const ruta = path.join(os.tmpdir(), `glm-${process.pid}-${Date.now().toString(36)}-${_sec++}.nc`).split(path.sep).join('/');
  fs.writeFileSync(ruta, buf);
  let f = null;
  try {
    f = new H.File(ruta, 'r');
    const lat = decodificar(f.get('flash_lat'));
    const lon = decodificar(f.get('flash_lon'));
    const dT = f.get('flash_time_offset_of_first_event');
    if (!dT || !lat || !lon) throw new Error('archivo sin variables de flash');
    const tt = decodificar(dT);
    const en = decodificar(f.get('flash_energy'));
    const ar = decodificar(f.get('flash_area'));
    const qq = decodificar(f.get('flash_quality_flag'));
    const base = baseTiempo(dT, clave);
    const flashes = [];
    for (let i = 0; i < lat.length; i++) {
      const la = lat[i], lo = lon[i];
      if (!(la >= caja.latMin && la <= caja.latMax && lo >= caja.lonMin && lo <= caja.lonMax)) continue;
      flashes.push({
        t: (base != null && Number.isFinite(tt[i])) ? base + Math.round(tt[i] * 1000) : null,
        lat: la, lon: lo,
        energia_J: en && Number.isFinite(en[i]) ? en[i] : null,
        area_m2: ar && Number.isFinite(ar[i]) ? ar[i] : null,
        calidad: qq && Number.isFinite(qq[i]) ? qq[i] : -1,     // −1 = relleno (sin marca), NUNCA 0 («bueno»)
      });
    }
    return { flashes, n_disco: lat.length };
  } finally {
    try { if (f) f.close(); } catch {}
    try { fs.unlinkSync(ruta); } catch {}
  }
}
