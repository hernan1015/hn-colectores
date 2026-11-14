#!/usr/bin/env node
// HN AGRO · la medición de cada mañana: la mínima que pronosticaba SATCHI HELADAS para la noche contra la observada en
// cada estación del SIPAN. Corre en Actions (medicion-heladas.workflow.yml.txt), después del colector de las 9:xx.
// ⛔ USO INTERNO. El registro de Actions es público: se imprimen sólo cantidades, nunca valores.
//
//   node sipan-alto-valle/medir.mjs [--seco] [--dias 7]
//     lee de estaciones_obs las noches de los últimos N días con ≥ 90 % de registros, pide a Open-Meteo (Previous Runs,
//     best_match, anticipación 1 y 2 días) el punto de cada estación y la localidad de SATCHI más cercana, de a un pedido,
//     y guarda una fila por noche/fuente/anticipación en pronostico_helada_medicion (0147). El resumen (sesgo, MAE,
//     detección ≤ 0 y ≤ −2) va a registro_procesos (proceso 'sipan_medicion_heladas').
import { ESTACIONES } from './lib/estaciones.mjs';
import { crearBase, RED } from './lib/base.mjs';
import { traerPronostico, localidadMasCercana, metricas } from './lib/medicion.mjs';
import { sumarDias } from './lib/resumen.mjs';

export const MIN_NOCHE = 0.9;

/** filas de estaciones_obs → pares por estación y fuente (función pura, para los tests). */
export function armarPares(obs, pronosticos, { anticipaciones = [1, 2] } = {}) {
  const filas = [];
  for (const o of obs) {
    const f = String(o.fecha).slice(0, 10);
    const completa = o.noche_registros != null && o.noche_esperados && o.noche_registros / o.noche_esperados >= MIN_NOCHE;
    if (!completa || o.tmin_noche_c == null) continue;
    for (const [fuente, pr] of Object.entries(pronosticos[o.estacion_id] || {})) {
      for (const d of anticipaciones) {
        const m = pr.minimas[f];
        filas.push({ red: RED, estacion_id: o.estacion_id, noche: f, fuente, anticipacion_dias: d,
          tmin_pron_c: m ? m['d' + d] ?? null : null, tmin_obs_noche_c: Number(o.tmin_noche_c), tmin_obs_dia_c: o.tmin_c == null ? null : Number(o.tmin_c),
          noche_registros: o.noche_registros, crudo: { celda: pr.celda, url: pr.url, localidad: pr.localidad || null } });
      }
    }
  }
  return filas;
}

export function resumir(filas) {
  const grupos = {};
  for (const x of filas) (grupos[`${x.estacion_id} | ${x.fuente} | ${x.anticipacion_dias} d`] ??= []).push({ pron: x.tmin_pron_c, obs: x.tmin_obs_noche_c });
  return Object.fromEntries(Object.entries(grupos).map(([k, v]) => [k, metricas(v)]));
}

/** Abre la base (Postgres directo, SIPAN_PG_URL, rol colector_estaciones; también en seco, porque lee) y la cierra siempre. */
export async function correr(op = {}) {
  const { env = process.env, base: baseDada = null, conectar } = op;
  const base = baseDada || await crearBase({ url: env.SIPAN_PG_URL, ...(conectar ? { conectar } : {}) });
  try { return await medirCon({ ...op, base }); }
  finally { if (!baseDada && base.cerrar) await base.cerrar(); }
}

async function medirCon({ seco = false, dias = 7, fetchFn = globalThis.fetch, base, ahoraMs = Date.now(), log = console.log, dormir = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const hoy = new Date(ahoraMs - 3 * 3600e3).toISOString().slice(0, 10);
  const desde = sumarDias(hoy, -dias);
  const obs = await base.obsDesde(desde);
  const pron = {}; let pedidos = 0; const fallas = [];
  for (const e of ESTACIONES) {
    if (!obs.some((o) => o.estacion_id === e.id)) continue;
    const loc = localidadMasCercana(e);
    pron[e.id] = {};
    for (const [fuente, p] of [['open-meteo best_match · punto', e], [`open-meteo best_match · localidad ${loc.nombre}`, loc]]) {
      try {
        if (pedidos++) await dormir(2000);
        pron[e.id][fuente] = { ...(await traerPronostico({ lat: p.lat, lon: p.lon, desde, hasta: hoy, dias: [1, 2], fetchFn })), localidad: p === loc ? loc : null };
      } catch (err) { fallas.push(`${e.id} ${fuente}`); }
    }
  }
  const filas = armarPares(obs, pron);
  if (!seco && filas.length) await base.guardarMedicion(filas);
  const resumen = { desde, hasta: hoy, noches: new Set(filas.map((f) => f.estacion_id + f.noche)).size, filas: filas.length, pedidos, fallas, metricas: resumir(filas) };
  if (!seco) { try { await base.registrar('sipan_medicion_heladas', fallas.length === 0, resumen); } catch { /* sigue */ } }
  log(JSON.stringify({ desde, hasta: hoy, noches: resumen.noches, filas: filas.length, pedidos, fallas: fallas.length }));
  return resumen;
}

const esPrincipal = import.meta.url === 'file://' + process.argv[1] || import.meta.url.endsWith(String(process.argv[1] || '').replace(/\\/g, '/'));
if (esPrincipal) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--dias');
  correr({ seco: a.includes('--seco'), dias: i >= 0 ? +a[i + 1] : 7 })
    .then((r) => { if (r.fallas.length) process.exitCode = 2; })
    .catch((e) => { console.error('medir: ' + String(e && e.message).slice(0, 160)); process.exitCode = 1; });
}
