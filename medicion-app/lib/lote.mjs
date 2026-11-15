// HN AGRO · 260 · PROPUESTA (no la usa el job, no se muestra nada): de la estación al LOTE.
// Sello m1, «del_estacion_al_lote»: la estación más cercana dentro de 25 km, de la misma zona (257) y región, con la
// noche válida; si no hay, agricola y pastizal valen como vecinas (marca zona_vecina); si tampoco, sin estación.
// Con las dos alturas conocidas, |Δ altura| ≤ 100 m.
import { region } from './region.mjs';

export const RADIO_KM = 25;
export const DELTA_ALTURA_M = 100;
const VECINAS = { agricola: ['pastizal'], pastizal: ['agricola'] };

export function distanciaKm(a, b) {
  const r = Math.PI / 180, R = 6371;
  const dlat = (b.lat - a.lat) * r, dlon = (b.lon - a.lon) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * lote: { lat, lon, zona?, altura_m? } · estaciones: filas de medicion_app_estacion de UNA fecha con lat, lon, zona,
 * region, noche_ok, noche_dif_c y, si se sabe, altura_m. → { estacion, km, marca } o { estacion: null, marca: 'sin_estacion' }.
 */
export function estacionParaLote(lote, estaciones, { radioKm = RADIO_KM, deltaAlturaM = DELTA_ALTURA_M } = {}) {
  const zona = lote.zona || 'agricola';
  const reg = region(lote.lat, lote.lon);
  const candidatas = estaciones
    .filter((e) => e.noche_ok && e.region === reg)
    .filter((e) => !(Number.isFinite(lote.altura_m) && Number.isFinite(e.altura_m)) || Math.abs(lote.altura_m - e.altura_m) <= deltaAlturaM)
    .map((e) => ({ e, km: distanciaKm(lote, e) }))
    .filter((x) => x.km <= radioKm)
    .sort((a, b) => a.km - b.km || (a.e.red + a.e.estacion_id < b.e.red + b.e.estacion_id ? -1 : 1));
  const misma = candidatas.find((x) => x.e.zona === zona);
  if (misma) return { estacion: misma.e, km: Math.round(misma.km * 10) / 10, marca: 'misma_zona', dif_noche_c: misma.e.noche_dif_c };
  const vecina = candidatas.find((x) => (VECINAS[zona] || []).includes(x.e.zona));
  if (vecina) return { estacion: vecina.e, km: Math.round(vecina.km * 10) / 10, marca: 'zona_vecina', dif_noche_c: vecina.e.noche_dif_c };
  return { estacion: null, km: null, marca: 'sin_estacion', dif_noche_c: null };
}
