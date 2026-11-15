// HN AGRO · 260 · las MÉTRICAS del sello (m1): sesgo, MAE y % con |dif| ≥ umbral; por zona, por región y en total.
import { SELLO, ZONAS, REGIONES } from './sello.mjs';

const r2 = (x) => Math.round(x * 100) / 100;

/** difs = app − estación. Con menos de n_minimo_grupo, sólo n. */
export function metricas(difs, umbral, { nMin = SELLO.n_minimo_grupo } = {}) {
  const d = difs.filter((x) => x != null && Number.isFinite(x));
  const n = d.length;
  if (n < nMin) return { n, pocas: true };
  const sesgo = d.reduce((s, x) => s + x, 0) / n;
  const mae = d.reduce((s, x) => s + Math.abs(x), 0) / n;
  const sobre = d.filter((x) => Math.abs(x) >= umbral - 1e-9).length;
  return { n, sesgo: r2(sesgo), mae: r2(mae), pct_umbral: r2((100 * sobre) / n), umbral };
}

/** Las tres variables de un grupo de filas de medicion_app_estacion. */
export function variables(filas) {
  return {
    noche: metricas(filas.filter((f) => f.noche_ok).map((f) => f.noche_dif_c), SELLO.umbral_temp_c),
    tmax: metricas(filas.filter((f) => f.tmax_ok).map((f) => f.tmax_dif_c), SELLO.umbral_temp_c),
    hr: metricas(filas.filter((f) => f.hr_ok).map((f) => f.hr_dif_pp), SELLO.umbral_hr_pp),
  };
}

/** El resumen de la corrida: total, por zona (las 5 siempre) y por región (las 6 siempre). */
export function resumen(filas) {
  const por = (clave, lista) => Object.fromEntries(lista.map((k) => [k, variables(filas.filter((f) => f[clave] === k))]));
  return { total: variables(filas), por_zona: por('zona', ZONAS), por_region: por('region', REGIONES) };
}
