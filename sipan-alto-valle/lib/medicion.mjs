// HN AGRO · SIPAN Alto Valle · LA MEDICIÓN: la mínima pronosticada para una noche contra la observada en la estación.
// Sin dependencias.
//
// Qué pronóstico: el MISMO que pinta SATCHI HELADAS. SATCHI pide a Open-Meteo /v1/forecast con el modelo por defecto
// (best_match) `daily=temperature_2m_min` en la hora de Argentina, para sus localidades (hn-agro:
// netlify/functions/lib/clima/tiempo-puntos.mjs; la clase: helada ≤ 0 °C, riesgo ≤ 3 °C, satchi/index.html HELADA_C y
// RIESGO_C). Open-Meteo saca la mínima diaria de los valores horarios.
// Para medirlo DESPUÉS sin haberlo guardado antes se usa la Previous Runs API de Open-Meteo (mismo modelo por
// defecto): `temperature_2m_previous_dayN` es el valor horario que daba la corrida de N días antes. La mínima del día
// local D con previous_day1 es la mínima que se veía para D el día anterior (anticipación de 1 día).
// Hay datos desde 2022 (2020 viene vacío: comprobado el 13/11/2026).
//
// Qué se mide, por estación:
//   · sesgo = media(pronóstico − observado) y MAE = media(|pronóstico − observado|), en °C;
//   · la detección de helada ≤ 0 °C y ≤ −2 °C: aciertos (los dos ≤ u), falsas alarmas (pronóstico ≤ u, observado > u),
//     perdidas (pronóstico > u, observado ≤ u) y noches tranquilas bien dadas;
//   · la detección de la clase «riesgo» de SATCHI (pronóstico ≤ 3 °C) sobre las heladas observadas ≤ 0 °C.
// El observado es la mínima de la NOCHE (18 a 9 h) cuando hay crudos de 10 min; con series diarias, la mínima del día.

export const PREVIOUS_RUNS = 'https://previous-runs-api.open-meteo.com/v1/forecast';
export const ZONA = 'America/Argentina/Buenos_Aires';

/** Las localidades de SATCHI más cerca del Alto Valle (copiadas de tendencia-v2.mjs, región Patagonia). */
export const LOCALIDADES_SATCHI = [
  { nombre: 'Neuquén', lat: -38.95, lon: -68.06 },
  { nombre: 'Choele Choel', lat: -39.29, lon: -65.66 },
];

export function distanciaKm(a, b) {
  const r = Math.PI / 180, R = 6371;
  const dlat = (b.lat - a.lat) * r, dlon = (b.lon - a.lon) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function localidadMasCercana(p) {
  return LOCALIDADES_SATCHI.map((l) => ({ ...l, km: Math.round(distanciaKm(p, l)) })).sort((a, b) => a.km - b.km)[0];
}

/** URL de la Previous Runs API para un punto y un rango de días locales. */
export function urlPronostico({ lat, lon, desde, hasta, dias = [1] }) {
  const vars = dias.map((d) => 'temperature_2m_previous_day' + d).join(',');
  return `${PREVIOUS_RUNS}?latitude=${lat}&longitude=${lon}&hourly=${vars}&timezone=${encodeURIComponent(ZONA)}&start_date=${desde}&end_date=${hasta}`;
}

/** Respuesta horaria → { 'AAAA-MM-DD': { d1: mínima del día local | null, horas_d1: n } }. Un día sin las 24 horas es null. */
export function minimasDiarias(json, dias = [1]) {
  const out = {};
  const h = (json && json.hourly) || {};
  const t = h.time || [];
  for (const d of dias) {
    const serie = h['temperature_2m_previous_day' + d] || [];
    const porDia = {};
    t.forEach((ts, i) => { const f = String(ts).slice(0, 10); (porDia[f] ??= []).push(serie[i]); });
    for (const [f, vs] of Object.entries(porDia)) {
      const ok = vs.filter((x) => x != null && Number.isFinite(x));
      (out[f] ??= {})['d' + d] = ok.length === 24 ? Math.min(...ok) : null;
      out[f]['horas_d' + d] = ok.length;
    }
  }
  return out;
}

/** Pide el pronóstico (de a un pedido, sin reintentos agresivos). */
export async function traerPronostico({ lat, lon, desde, hasta, dias = [1], fetchFn = globalThis.fetch }) {
  const url = urlPronostico({ lat, lon, desde, hasta, dias });
  const r = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; colector-agrometeorologico/1.0)' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
  const j = await r.json();
  return { url, celda: { lat: j.latitude, lon: j.longitude, elevacion: j.elevation }, minimas: minimasDiarias(j, dias) };
}

const r1 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** pares: [{ pron, obs }] (los null se saltean). */
export function metricas(pares, { umbrales = [0, -2], riesgo = 3 } = {}) {
  const p = pares.filter((x) => x.pron != null && x.obs != null && Number.isFinite(x.pron) && Number.isFinite(x.obs));
  const n = p.length;
  const out = { n };
  if (!n) return { ...out, sesgo: null, mae: null, rmse: null, umbrales: {} };
  const e = p.map((x) => x.pron - x.obs);
  out.sesgo = r1(e.reduce((s, x) => s + x, 0) / n);
  out.mae = r1(e.reduce((s, x) => s + Math.abs(x), 0) / n);
  out.rmse = r1(Math.sqrt(e.reduce((s, x) => s + x * x, 0) / n));
  out.umbrales = {};
  for (const u of umbrales) {
    const t = { aciertos: 0, falsas_alarmas: 0, perdidas: 0, tranquilas: 0 };
    for (const x of p) {
      const po = x.pron <= u, ob = x.obs <= u;
      if (po && ob) t.aciertos++; else if (po) t.falsas_alarmas++; else if (ob) t.perdidas++; else t.tranquilas++;
    }
    const obs = t.aciertos + t.perdidas, dadas = t.aciertos + t.falsas_alarmas;
    t.observadas = obs;
    t.deteccion = obs ? r1(t.aciertos / obs) : null;                 // POD
    t.falsas_sobre_avisos = dadas ? r1(t.falsas_alarmas / dadas) : null;   // FAR
    out.umbrales[String(u)] = t;
  }
  /* la clase «riesgo» de SATCHI (pronóstico ≤ 3 °C) contra las heladas observadas ≤ 0 °C */
  const hel = p.filter((x) => x.obs <= 0);
  const avisos = p.filter((x) => x.pron <= riesgo);
  out.riesgo_satchi = {
    umbral_pron: riesgo,
    heladas_observadas: hel.length,
    vistas_como_riesgo: hel.filter((x) => x.pron <= riesgo).length,
    deteccion: hel.length ? r1(hel.filter((x) => x.pron <= riesgo).length / hel.length) : null,
    avisos_riesgo: avisos.length,
    avisos_sin_helada: avisos.filter((x) => x.obs > 0).length,
  };
  return out;
}
