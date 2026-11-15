// HN AGRO · 260 · el LADO DE LA APP: Open-Meteo /v1/forecast, best_match (sin `models`), las mismas variables horarias
// que pide la app para el punto del lote (temperature_2m, relative_humidity_2m) y la hora de Argentina.
// Pedidos en LOTES de varias coordenadas (latitude/longitude como listas), de a uno, con pausa. Ver el sello (m1).
import { OM, SELLO } from './sello.mjs';
import { sumarDias } from '../../estaciones-privadas/parseo/lib/hora.mjs';

export const UA = 'Mozilla/5.0 (compatible; colector-agrometeorologico/1.0)';
const red4 = (x) => Number(Number(x).toFixed(OM.decimales));
export const clavePunto = (lat, lon) => `${red4(lat).toFixed(OM.decimales)},${red4(lon).toFixed(OM.decimales)}`;

/** El peso de UNA coordenada para la cuota (Open-Meteo, calculateQueryWeight): max(1, V/10 × max(1, días/14)). */
export const pesoPunto = (variables, dias) => Math.max(1, (variables / 10) * Math.max(1, dias / 14));

/** Los puntos únicos (la misma coordenada en dos redes se pide una vez), en orden estable. */
export function puntosUnicos(estaciones) {
  const m = new Map();
  for (const e of estaciones) {
    if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    const k = clavePunto(e.lat, e.lon);
    if (!m.has(k)) m.set(k, { clave: k, lat: red4(e.lat), lon: red4(e.lon) });
  }
  return [...m.values()].sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
}

/** Parte en lotes de `n` y aplica el tope. */
export function armarLotes(puntos, { n = OM.por_pedido, tope = OM.tope_puntos } = {}) {
  const usados = puntos.slice(0, tope);
  const lotes = [];
  for (let i = 0; i < usados.length; i += n) lotes.push(usados.slice(i, i + n));
  return { lotes, fuera_de_tope: Math.max(0, puntos.length - usados.length) };
}

export function urlLote(lote, fecha) {
  const lat = lote.map((p) => p.lat.toFixed(OM.decimales)).join(',');
  const lon = lote.map((p) => p.lon.toFixed(OM.decimales)).join(',');
  return `${OM.base}?latitude=${lat}&longitude=${lon}&hourly=${OM.hourly.join(',')}`
    + `&timezone=${encodeURIComponent(OM.timezone)}&start_date=${fecha}&end_date=${sumarDias(fecha, 1)}`;
}

/** Las horas (instantes locales) de cada ventana, como las escribe Open-Meteo ('AAAA-MM-DDTHH:00'). */
export function horasVentana(fecha) {
  const sig = sumarDias(fecha, 1);
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  const noche = [19, 20, 21, 22, 23].map((h) => `${fecha}T${hh(h)}`).concat([...Array(10).keys()].map((h) => `${sig}T${hh(h)}`));
  const dia = [...Array(23).keys()].map((h) => `${fecha}T${hh(h + 1)}`).concat([`${sig}T00:00`]);
  return { noche, dia };
}

/** Una respuesta de un lote → un mapa clave → serie. Valida el orden (la celda cerca del punto) y el huso. */
export function leerRespuesta(json, lote) {
  const arr = Array.isArray(json) ? json : [json];
  if (arr.length !== lote.length) throw Object.assign(new Error('open-meteo: la respuesta no trae un punto por coordenada'), { propio: true });
  const out = new Map(); let descartados = 0;
  arr.forEach((o, i) => {
    const p = lote[i];
    const cerca = o && Math.abs(o.latitude - p.lat) <= OM.tolerancia_celda_gr && Math.abs(o.longitude - p.lon) <= OM.tolerancia_celda_gr;
    if (!cerca || o.utc_offset_seconds !== OM.offset_s || !o.hourly || !Array.isArray(o.hourly.time)) { descartados++; return; }
    out.set(p.clave, { celda: { lat: o.latitude, lon: o.longitude, elevacion: o.elevation ?? null }, hourly: o.hourly });
  });
  return { series: out, descartados };
}

/** El lado de la app para una serie: la mínima de la noche, la máxima y la HR media del día (o null si falta una hora). */
export function ladoApp(serie, fecha) {
  const { noche, dia } = horasVentana(fecha);
  const idx = new Map((serie?.hourly?.time || []).map((t, i) => [t, i]));
  const valores = (horas, v) => {
    const xs = horas.map((h) => (idx.has(h) ? serie.hourly[v]?.[idx.get(h)] : null));
    return xs.every((x) => x != null && Number.isFinite(x)) ? xs : null;
  };
  const tn = valores(noche, 'temperature_2m');
  const td = valores(dia, 'temperature_2m');
  const hd = valores(dia, 'relative_humidity_2m');
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    noche: tn && tn.length === SELLO.horas_noche ? Math.min(...tn) : null,
    tmax: td && td.length === SELLO.horas_dia ? Math.max(...td) : null,
    hr: hd && hd.length === SELLO.horas_dia ? r2(hd.reduce((s, x) => s + x, 0) / hd.length) : null,
    celda: serie?.celda ?? null,
  };
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const reintentable = (s) => s === 429 || (s >= 500 && s <= 599);

/**
 * Pide los lotes de a uno, con pausa entre pedidos. Un 429, un 5xx o una falla de red: un reintento a los 60 s; si
 * vuelve a fallar, CORTA (lo que falta queda sin app). Nunca imprime URLs ni coordenadas.
 */
export async function traerLotes(lotes, fecha, { fetchFn = globalThis.fetch, esperar = espera, pausaMs = OM.pausa_ms, reintentoMs = OM.reintento_ms } = {}) {
  const series = new Map();
  const cuenta = { pedidos: 0, reintentos: 0, puntos_pedidos: 0, descartados: 0, cortado: false, error: null };
  for (let i = 0; i < lotes.length; i++) {
    if (i > 0) await esperar(pausaMs);
    const url = urlLote(lotes[i], fecha);
    let json = null;
    for (let intento = 0; intento < 2 && json == null; intento++) {
      if (intento) { cuenta.reintentos++; await esperar(reintentoMs); }
      cuenta.pedidos++;
      let r;
      try { r = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(OM.timeout_ms) }); }
      catch { cuenta.error = 'red'; continue; }
      if (r.ok) {
        try { json = await r.json(); } catch { cuenta.error = 'json'; json = null; }
        if (json == null) continue;
        cuenta.error = null;
      } else {
        cuenta.error = 'http_' + r.status;
        if (!reintentable(r.status)) break;
      }
    }
    if (json == null) { cuenta.cortado = true; break; }
    cuenta.puntos_pedidos += lotes[i].length;
    let leida;
    try { leida = leerRespuesta(json, lotes[i]); }
    catch { cuenta.descartados += lotes[i].length; cuenta.error = 'forma'; continue; }
    const { series: s, descartados } = leida;
    cuenta.descartados += descartados;
    for (const [k, v] of s) series.set(k, v);
  }
  return { series, cuenta };
}
