// LIB FALSA con la interfaz de netlify/functions/lib/granizo-vivo.mjs que usa medir-caso.mjs (armar, _vaciarCache,
// H0_LATS, H0_LONS). Pide por dep.fetch lo mismo que la de verdad (listado y ACHAF t y t−20, ACTPF t y t−20, H0) y el GLM
// por dep.flashesVentana. Las celdas: una destacada fija y la celda A, de 2 patas (altura + rayos si tiene ≥ 17 flashes),
// COMPLETA sólo si la fase se leyó (sin fase su G queda null: incompleta, como en la lib real).
import { ZONA_A } from '../falsos.mjs';
export const H0_LATS = [-38, -22];
export const H0_LONS = [-66, -56];
export let llamadas = 0;
export function _vaciarCache() {}
const B = 'https://noaa-goes19.s3.amazonaws.com';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const doy = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
const pref = (ms, p) => { const d = new Date(ms); return p + '/' + d.getUTCFullYear() + '/' + pad(doy(d), 3) + '/' + pad(d.getUTCHours()) + '/'; };
const tDe = (k) => { const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/.exec(k); return Date.UTC(+m[1], 0, 1, +m[3], +m[4], +m[5]) + (+m[2] - 1) * 864e5; };
async function clave(f, ms, p) {
  const r = await f(B + '/?list-type=2&prefix=' + encodeURIComponent(pref(ms, p)) + '&max-keys=1000');
  if (!r.ok) return null;
  const ks = ((await r.text()).match(/<Key>[^<]+<\/Key>/g) || []).map((x) => x.slice(5, -6));
  return ks.find((k) => Math.abs(tDe(k) - ms) <= 60000) || null;
}
async function bajar(f, k) { const r = await f(B + '/' + k); if (!r.ok) throw new Error('http ' + r.status); const b = new Uint8Array(await r.arrayBuffer()); if (+r.headers.get('content-length') !== b.length) throw new Error('largo'); return b; }
export async function armar(dep) {
  llamadas++;
  const f = dep.fetch, ahora = dep.ahora;
  const tMs = Math.floor((ahora - 20000) / 600000) * 600000 + 20000;
  const kT = await clave(f, tMs, 'ABI-L2-ACHAF'), kT20 = await clave(f, tMs - 1200000, 'ABI-L2-ACHAF');
  if (!kT) return { ok: false, parcial: false, faltantes: ['achaf'], motivo: 'sin_scan_reciente', celdas: [] };
  const faltantes = [];
  await bajar(f, kT);
  let t20 = true; try { await bajar(f, kT20); } catch { t20 = false; faltantes.push('achaf_t20'); }
  let fase = false;
  const kF = await clave(f, tMs, 'ABI-L2-ACTPF'), kF20 = await clave(f, tMs - 1200000, 'ABI-L2-ACTPF');
  if (kF && kF20) { await bajar(f, kF); await bajar(f, kF20); fase = true; } else faltantes.push('actp_t');
  const hh = new Date(Math.round(tMs / 3600000) * 3600000).toISOString().slice(0, 13) + ':00';
  const rh = await f('https://api.open-meteo.com/v1/forecast?latitude=-38&longitude=-66&hourly=freezing_level_height&start_hour=' + hh + '&end_hour=' + hh);
  const h0ok = rh.ok && Array.isArray(await rh.json());
  if (!h0ok) faltantes.push('h0');
  const g = await dep.flashesVentana({ desde: tMs - 600000, hasta: tMs });
  const glmOk = !!(g && g.ok && g.completo);
  if (!glmOk) faltantes.push('glm');
  const nA = glmOk ? g.flashes.filter((x) => Math.abs(x.lat - ZONA_A.lat) < 0.1 && Math.abs(x.lon - ZONA_A.lon) < 0.1).length : null;
  const cuales = ['altura'].concat(nA != null && nA >= 17 ? ['rayos'] : []);
  const A = fase ? { lat: ZONA_A.lat, lon: ZONA_A.lon, I: 40, P: 1, T: 1, G: 0, L: 1, patas: cuales.length, patas_cuales: cuales, destacada: false, h_km: 14, rayos: nA }
    : { lat: ZONA_A.lat, lon: ZONA_A.lon, I: null, P: 1, T: 1, G: null, L: 1, patas: null, patas_cuales: cuales, destacada: false, h_km: 14, rayos: nA, incompleta: true, I_min: 30, patas_min: cuales.length };
  const D = { lat: -35.5, lon: -58.5, I: 70, patas: 3, patas_cuales: ['altura', 'crece', 'rayos'], destacada: true, h_km: 15, rayos: 30 };
  const ok = true;
  return { ok, parcial: !t20 || !glmOk || !fase, scan_t: new Date(tMs + 700).toISOString(), scan_t20: new Date(tMs - 1200000 + 700).toISOString(), faltantes,
    h0_fuente: h0ok ? 'open-meteo' : 'fijo_4km', rayos_ventana: g ? { ok: !!g.ok, completo: !!g.completo, minutos_cubiertos: 10, archivos: { esperados: 10, leidos: 10 } } : null,
    celdas: [D, A, { lat: -30.1, lon: -59.1, I: 6, patas: 1, patas_cuales: ['altura'], destacada: false, h_km: 9, rayos: 0 }], resumen: { celdas: 3 } };
}
export default { armar, _vaciarCache };
