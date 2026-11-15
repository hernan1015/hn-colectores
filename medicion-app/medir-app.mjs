#!/usr/bin/env node
// HN AGRO · 260 · LA MEDICIÓN DE CADA MAÑANA: cuánto se equivoca el clima de la app (Open-Meteo best_match, el mismo
// pedido que hace la app para el punto del lote) contra las estaciones, de noche primero.
// Corre en Actions (medicion-app.workflow.yml.txt) a las 13:00 UTC = 10:00 ARG, sobre la víspera. USO INTERNO.
// El criterio está SELLADO antes de medir: hn-cortex docs/mejora-continua/260-medicion/SELLO.json (regla m1).
//
//   MEDICION_PG_URL=… MEDICION_PG_CA=… node medicion-app/medir-app.mjs [--real] [--fecha AAAA-MM-DD]
//     sin --real (SECO): lee la base y pide a Open-Meteo, cuenta, y NO escribe nada.
//     --real: guarda una fila por estación y día en medicion_app_estacion y el resumen en registro_procesos.
//     --fecha: la víspera por defecto (hora ARG). Open-Meteo guarda ~3 meses: no más atrás que eso.
// ⛔ El registro de Actions es PÚBLICO: se imprime UNA línea con cantidades. Ningún valor medido, ni ids, ni
//   coordenadas. Los resultados van a la base.
import { fileURLToPath } from 'node:url';
import { ladoEstacion } from './lib/estacion.mjs';
import { puntosUnicos, armarLotes, traerLotes, ladoApp, clavePunto, pesoPunto } from './lib/openmeteo.mjs';
import { region, zonaDe } from './lib/region.mjs';
import { resumen as resumir } from './lib/metricas.mjs';
import { REGLA, OM, SELLO } from './lib/sello.mjs';
import { sumarDias } from '../estaciones-privadas/parseo/lib/hora.mjs';

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** La víspera en hora argentina (UTC−3 fija). */
export const vispera = (ahora = Date.now()) => sumarDias(new Date(ahora - 3 * 3600e3).toISOString().slice(0, 10), -1);

/** Agrupa las filas de medicion_app_obs por estación: { red, estacion_id, lat, lon, zona, dia, manana }. */
export function agrupar(filas, fecha) {
  const m = new Map();
  const sig = sumarDias(fecha, 1);
  for (const f of filas) {
    const k = f.red + '\u0000' + f.estacion_id;
    const e = m.get(k) || { red: f.red, estacion_id: f.estacion_id, lat: f.lat, lon: f.lon, zona: f.zona, dia: null, manana: null };
    if (f.fecha === fecha) e.dia = f; else if (f.fecha === sig) e.manana = f;
    m.set(k, e);
  }
  return [...m.values()];
}

/** La fila de medicion_app_estacion de una estación (función pura). */
export function armarFila(e, est, app, fecha) {
  const motivos = [...est.motivos];
  const lado = (ok, vEst, vApp, falta) => {
    if (ok && vApp == null) motivos.push(falta);
    const vale = ok && vEst != null && vApp != null;
    return { vale, dif: vale ? r2(vApp - vEst) : null };
  };
  const n = lado(est.noche.ok, est.noche.est, app?.noche ?? null, 'noche_sin_app');
  const t = lado(est.tmax.ok, est.tmax.est, app?.tmax ?? null, 'tmax_sin_app');
  const h = lado(est.hr.ok, est.hr.est, app?.hr ?? null, 'hr_sin_app');
  return {
    red: e.red, estacion_id: String(e.estacion_id), fecha, regla: REGLA,
    zona: zonaDe(e.zona), region: region(e.lat, e.lon),
    lat: Number(e.lat.toFixed(OM.decimales)), lon: Number(e.lon.toFixed(OM.decimales)),
    noche_est_c: est.noche.est, noche_app_c: app?.noche ?? null, noche_dif_c: n.dif,
    noche_registros: est.noche.registros, noche_esperados: est.noche.esperados, noche_ok: n.vale,
    tmax_est_c: est.tmax.est, tmax_app_c: app?.tmax ?? null, tmax_dif_c: t.dif,
    dia_registros: est.tmax.registros, dia_esperados: est.tmax.esperados, tmax_ok: t.vale,
    hr_est_pct: est.hr.est, hr_app_pct: app?.hr ?? null, hr_dif_pp: h.dif, hr_lecturas: est.hr.lecturas, hr_ok: h.vale,
    muestreo_min: est.muestreo_min,
    motivos: [...new Set(motivos)].sort(),
    app: { modelo: OM.modelo, celda: app?.celda ?? null },
  };
}

const contar = (filas, k) => filas.filter((f) => f[k]).length;
/** La línea pública: SÓLO cantidades. */
export const lineaLog = (r) => `medicion-app ${r.modo}: fecha=${r.fecha} estaciones=${r.estaciones} candidatas=${r.candidatas} puntos=${r.puntos}`
  + ` pedidos=${r.pedidos} noche=${r.validas.noche} tmax=${r.validas.tmax} hr=${r.validas.hr} escritas=${r.escritas} errores=${r.errores}`
  + `${r.cortado ? ' cortado=si' : ''}${r.fuera_de_tope ? ' fuera_de_tope=' + r.fuera_de_tope : ''}`;

/**
 * La corrida. base = crearBase(ejecutor) (o null en seco sin base). Devuelve el resumen (con métricas) para los tests;
 * el log recibe sólo la línea de cantidades.
 */
export async function correr({ base, fecha, real = false, fetchFn, esperar, log = console.log }) {
  if (!FECHA.test(String(fecha))) throw Object.assign(new Error('fecha inválida (AAAA-MM-DD)'), { propio: true });
  const obs = await base.leer(fecha);
  const estaciones = agrupar(obs, fecha);
  const lados = estaciones.map((e) => ({ e, est: ladoEstacion({ red: e.red, fecha, dia: e.dia, manana: e.manana }) }));
  // sólo se le pide a Open-Meteo el punto de las estaciones que valen en al menos una variable
  const candidatas = lados.filter(({ est }) => est.noche.ok || est.tmax.ok || est.hr.ok);
  const puntos = puntosUnicos(candidatas.map(({ e }) => e));
  const { lotes, fuera_de_tope } = armarLotes(puntos);
  const { series, cuenta } = lotes.length ? await traerLotes(lotes, fecha, { fetchFn, esperar }) : { series: new Map(), cuenta: { pedidos: 0, reintentos: 0, descartados: 0, cortado: false } };
  const filas = lados.map(({ e, est }) => {
    const s = series.get(clavePunto(e.lat, e.lon));
    return armarFila(e, est, s ? ladoApp(s, fecha) : null, fecha);
  });
  let escritas = 0; let errores = {};
  if (real) ({ ok: escritas, errores } = await base.guardar(filas));
  const nErrores = Object.values(errores).reduce((s, x) => s + x, 0);
  const motivos = {};
  for (const f of filas) for (const m of f.motivos) motivos[m] = (motivos[m] || 0) + 1;
  const ok = !cuenta.cortado && nErrores === 0;
  const res = {
    fecha, regla: REGLA, sello: 'hn-cortex docs/mejora-continua/260-medicion/SELLO.json', modo: real ? 'real' : 'seco',
    estaciones: estaciones.length, candidatas: candidatas.length, puntos: puntos.length, fuera_de_tope,
    pedidos: cuenta.pedidos, reintentos: cuenta.reintentos, descartados_app: cuenta.descartados, cortado: cuenta.cortado,
    error_app: cuenta.error ?? null, peso_por_punto: pesoPunto(OM.hourly.length, 2),
    validas: { noche: contar(filas, 'noche_ok'), tmax: contar(filas, 'tmax_ok'), hr: contar(filas, 'hr_ok') },
    escritas, errores: nErrores, errores_por_codigo: errores, motivos,
    umbrales: { temp_c: SELLO.umbral_temp_c, hr_pp: SELLO.umbral_hr_pp, n_minimo_grupo: SELLO.n_minimo_grupo },
    ...resumir(filas),
  };
  if (real) await base.registrar(ok, res);
  log(lineaLog(res));
  return { ...res, ok, filas };
}

/** El mensaje de un error para el log público: el nuestro tal cual; uno ajeno, sólo su tipo. */
export const mensajeError = (e) => (e?.propio ? e.message : `error ${e?.name || 'desconocido'}`);

async function main(argv) {
  const real = argv.includes('--real');
  const i = argv.indexOf('--fecha');
  const fecha = i >= 0 ? argv[i + 1] : vispera();
  const { conectar, crearBase } = await import('./lib/base.mjs');
  const ej = await conectar(process.env.MEDICION_PG_URL);
  try {
    const r = await correr({ base: crearBase(ej), fecha, real });
    if (!r.ok) process.exitCode = 1;
  } finally { await ej.cerrar(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.log('medicion-app: ' + mensajeError(e)); process.exitCode = 1; });
}
