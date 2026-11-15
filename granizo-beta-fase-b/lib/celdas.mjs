// HN AGRO · 226 · GRANIZO β · Fase B · LO QUE QUEDA DE CADA INSTANTE (el sello: métricas por celda y por instante).
// Puro. Los umbrales del salto NO se aplican acá: se guardan N(t) y N(t−10) y el salto se cuenta en evaluar.mjs.
export const R_KM = 6371, RADIO_N_KM = 25, RADIO_CERCA_KM = 55;
const rad = Math.PI / 180;
export function dist(a1, o1, a2, o2) {
  const dA = (a2 - a1) * rad, dO = (o2 - o1) * rad;
  const s = Math.sin(dA / 2) ** 2 + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dO / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}
/** flashes a ≤ radio km de (lat, lon); fl = [{lat, lon}] o [[lat, lon]] */
export function cuentaCerca(fl, lat, lon, radio = RADIO_N_KM) {
  let n = 0;
  const dLat = radio / 111.0, dLon = radio / (111.0 * Math.cos(lat * rad));
  for (const f of fl) {
    const la = f.lat ?? f[0], lo = f.lon ?? f[1];
    if (Math.abs(la - lat) > dLat || Math.abs(lo - lon) > dLon) continue;
    if (dist(lat, lon, la, lo) <= radio) n++;
  }
  return n;
}
/** las celdas que guarda el sello: completas con ≥ 2 patas o incompletas con patas_min ≥ 2 */
export const seGuarda = (c) => (!c.incompleta && c.patas >= 2) || (c.incompleta && c.patas_min >= 2);
/**
 * @param r       la respuesta de armar() (modo con_fase)
 * @param flT     flashes de [t−10, t) (null si el GLM no estuvo completo)
 * @param flT10   flashes de [t−20, t−10) del barrido anterior (null si no hay o no estuvo completo)
 */
export function celdasDe(r, flT, flT10) {
  return (r.celdas || []).filter(seGuarda).map((c) => ({
    lat: c.lat, lon: c.lon, patas: c.patas ?? null, patas_cuales: c.patas_cuales || [], destacada: !!c.destacada,
    incompleta: !!c.incompleta, patas_min: c.incompleta ? c.patas_min : null, I: c.I ?? null, h_km: c.h_km ?? null, G: c.G ?? null,
    rayos: c.rayos ?? null,
    n25_t: flT ? cuentaCerca(flT, c.lat, c.lon) : null,
    n25_t10: flT10 ? cuentaCerca(flT10, c.lat, c.lon) : null
  }));
}
/** las destacadas como las guardó la 19 */
export const destacadasDe = (r) => (r.celdas || []).filter((c) => c.destacada).map((c) => ({ lat: c.lat, lon: c.lon, I: c.I, h_km: c.h_km, rayos: c.rayos }));
/** los flashes [lat, lon, t] a ≤ 55 km de algún lugar de la muestra (para auditar el salto) */
export function flashesCerca(fl, lugares, radio = RADIO_CERCA_KM) {
  const out = [];
  for (const f of fl || []) {
    const la = f.lat, lo = f.lon;
    if (lugares.some(([a, b]) => Math.abs(a - la) < 0.6 && Math.abs(b - lo) < 0.75 && dist(a, b, la, lo) <= radio)) {
      out.push([Math.round(la * 1e4) / 1e4, Math.round(lo * 1e4) / 1e4, f.t ?? null]);
    }
  }
  return out;
}
/** validez del barrido */
export const validoConFase = (r) => !!(r && r.ok && !r.parcial);
export const validoComo19 = (r) => !!(r && r.ok && !(r.faltantes || []).some((f) => f === 'glm' || f === 'achaf_t' || f === 'achaf_t20'));
