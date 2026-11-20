// HN AGRO · estaciones-parseo · INA, sistema de alerta (a5) → red INA_ALERTA. INTERNO (Paso 0 139: sin términos para la a5).
// La ronda guarda la parte «series» (series?var_id=53,55,57,58,60,1) y las «obs_N» (observaciones de las últimas 6 h,
// de a 150 series):
//   series:        [{ id, var: { id }, procedimiento: { id }, estacion: { id, nombre, pais, public, geom: { coordinates: [lon, lat] } } }]
//                  (o { rows: [...] })
//   observaciones: [{ series_id, timestart, timeend, valor }], con la hora en UTC («…Z»).
// · temperatura (var 53) y humedad (var 58): lecturas instantáneas en `timestart` (regla de las 12 h);
// · lluvia diaria (var 1, «precipitación diaria 12Z», de 9 a 9): lluvia_mm con período 1440 min en `timeend` (es un
//   total cerrado: entra hasta 8 días atrás);
// · viento (55, 57) y presión (60): NO, la unidad no está verificada.
// estacion_id = el id de la ESTACIÓN del INA (no el de la serie): así temperatura, humedad y lluvia van a la misma estación.
import { numero, instante, parte, enCajaAR, ID_OK, sumar } from '../lib/comun.mjs';

export const RED = 'INA_ALERTA';
const META = { fuente: 'INA alerta (a5)', permiso: 'interno' };
const VAR = { 53: 'temp_c', 58: 'hum_pct', 1: 'lluvia_diaria' };
const vacio = (motivo) => ({ red: RED, estaciones: [], lecturas: [], descartadas: { [motivo]: 1 } });

/** La parte «series» → Map(serie → { campo, estacion }). Sólo Argentina, públicas, medición directa (procedimiento 1). */
export function parsearSeries(texto) {
  let j;
  try { j = JSON.parse(texto); } catch { return null; }
  const rows = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : null;
  if (!rows) return null;
  const m = new Map();
  for (const s of rows) {
    const campo = VAR[s?.var?.id];
    if (!campo || s?.procedimiento?.id !== 1) continue;
    const e = s.estacion || {};
    if (e.public === false || e.pais !== 'Argentina' || e.id == null || !ID_OK.test(String(e.id))) continue;
    const [lon, lat] = Array.isArray(e.geom?.coordinates) ? e.geom.coordinates.map((x) => numero(x)) : [null, null];
    const ok = enCajaAR(lat, lon);
    m.set(String(s.id), { campo, estacion: { estacion_id: String(e.id), nombre: typeof e.nombre === 'string' ? e.nombre.trim() || null : null,
      lat: ok ? lat : null, lon: ok ? lon : null, fuente_ubicacion: 'INA a5 (geom de la estación)', precision_ubicacion: 'declarada por la red',
      metadatos: { ...META } } });
  }
  return m;
}

export function leer(obj) {
  const cs = parte(obj, 'series');
  if (cs == null) return vacio('sin_parte');
  const series = parsearSeries(cs);
  if (!series) return vacio('formato_cambiado');
  const usadas = new Map(); const porInst = new Map(); const descartadas = {};
  for (const nombre of Object.keys(obj.partes || {})) {
    if (!/^obs_\d+$/.test(nombre)) continue;
    const c = parte(obj, nombre);
    if (c == null) { sumar(descartadas, 'sin_parte'); continue; }
    let a;
    try { a = JSON.parse(c); } catch { sumar(descartadas, 'no_es_json'); continue; }
    if (!Array.isArray(a)) { sumar(descartadas, 'formato_cambiado'); continue; }
    for (const o of a) {
      const s = series.get(String(o?.series_id));
      if (!s) { sumar(descartadas, 'serie_desconocida'); continue; }
      const v = numero(o.valor);
      if (v == null) { sumar(descartadas, 'sin_valor'); continue; }
      const id = s.estacion.estacion_id;
      usadas.set(id, s.estacion);
      if (s.campo === 'lluvia_diaria') {
        const fin = instante(o.timeend), ini = instante(o.timestart);
        if (fin == null || ini == null || fin - ini !== 864e5) { sumar(descartadas, 'lluvia_sin_dia'); continue; }
        const k = id + '|' + fin;
        if (!porInst.has(k)) porInst.set(k, { estacion_id: id, instante: fin, tipo: 'registro', crudo: {} });
        Object.assign(porInst.get(k), { lluvia_mm: v, lluvia_periodo_min: 1440 });
        continue;
      }
      const t = instante(o.timestart);
      if (t == null) { sumar(descartadas, 'sin_instante'); continue; }
      const k = id + '|' + t;
      if (!porInst.has(k)) porInst.set(k, { estacion_id: id, instante: t, tipo: 'instantanea', crudo: {} });
      porInst.get(k)[s.campo] = v;
    }
  }
  return { red: RED, estaciones: [...usadas.values()], lecturas: [...porInst.values()], descartadas };
}

export default { id: 'ina', red: RED, leer };
