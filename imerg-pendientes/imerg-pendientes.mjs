#!/usr/bin/env node
// HN AGRO · imerg-pendientes · rellena la lluvia satelital (IMERG-Final, desde 2000-06-01) de las celdas que la app
// tiene pendientes, de a UNA por vez y como mucho 2 por corrida. Ver lib/barrido.mjs y migracion/imerg_colector.sql.
//
// env: IMERG_PG_URL (rol colector_imerg) · EARTHDATA_TOKEN · MODO (real | seco) · TOPE (1-2) · IMERG_LAZY_ESPERA_MIN
//   seco: conecta y dice cuántas celdas hay para tomar. No toma nada ni llama a la NASA.
// Salida: 0 bien (también «nada pendiente») · 2 si una celda falló (la NASA o la base) · 1 si no se pudo arrancar.
// El registro de Actions es PÚBLICO: sólo cantidades, nunca coordenadas, claves ni direcciones.
import { crearBase } from './lib/base.mjs';
import { pedirSerie } from './lib/giovanni.mjs';
import { barrer, tope } from './lib/barrido.mjs';

/** La espera sobre la reserva de la app. Nunca menos de 180: es el mínimo FIJO de la base (2.ª vuelta, P1.3); la
 *  variable sólo puede alargarla. Se recorta acá también para que el registro diga la espera de verdad. */
export const ESPERA_MIN = 180;
export function esperaLazy(v) {
  const n = Math.floor(Number(v));
  return v === undefined || v === '' || !Number.isFinite(n) ? ESPERA_MIN : Math.min(Math.max(n, ESPERA_MIN), 7 * 24 * 60);
}

export async function main(env = process.env, { crear = crearBase, pedir = pedirSerie, log = console.log } = {}) {
  const espera = esperaLazy(env.IMERG_LAZY_ESPERA_MIN);
  const real = env.MODO === 'real';
  if (real && !String(env.EARTHDATA_TOKEN || '').trim()) { log('::error::falta EARTHDATA_TOKEN'); return 1; }
  let base;
  try { base = await crear({ url: env.IMERG_PG_URL }); }
  catch (e) { log('::error::' + e.message); return 1; }
  try {
    const n = await base.contar(espera);
    log(`celdas para tomar: ${n} (espera de la reserva de la app: ${espera} min)`);
    if (!real) { log('modo seco: no se toma nada'); return 0; }
    if (!n) return 0;
    const token = String(env.EARTHDATA_TOKEN).trim();
    const r = await barrer({ base, tope: tope(env.TOPE), esperaLazyMin: espera, log,
      serie: (c) => pedir({ lat: c.lat, lon: c.lon, token }) });
    log(`resumen: tomadas ${r.tomadas} · guardadas ${r.guardadas} · filas ${r.filas} · fallos ${r.fallos} · fin: ${r.motivo}`);
    if (r.fallos) { log('::warning::' + (r.error || 'una celda falló')); return 2; }
    return 0;
  } catch (e) {
    log('::error::' + ((e && e.message) || 'error'));
    return 2;
  } finally {
    await base.cerrar().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().then((c) => { process.exitCode = c; });
}
