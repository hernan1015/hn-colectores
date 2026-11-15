// HN AGRO · 139 interna · INA, sistema de alerta (a5). Dos redes, USO INTERNO (mostrar = false):
//   · `INA_METEO`: temperatura (var 53) y humedad (var 58) → el día (D 00, D+1 00], tmin/tmax MUESTREADOS;
//   · `INA_ALERTA`: la lluvia diaria de 9 a 9 (var 1, «precipitación diaria 12Z») → hora_corte 09:00.
//   Son dos redes porque una fila de estaciones_obs tiene UNA hora de corte: el día de la temperatura (00) y el de la
//   lluvia (09) no se pueden mezclar en la misma fila.
// Lee lo que guarda ronda.mjs (estaciones-internas/ina/<día>/<HHMM>.json): la parte «series» (series?var_id=53,55,57,
// 58,60,1) y las «obs_N» (observaciones?tipo=puntual&series_id=…, de a 150, las últimas 6 h).
// Formato verificado el 15/11 con un pedido a observaciones (series 31971 y 7013): [{ series_id, timestart
// '…T12:00:00.000Z', timeend, valor, … }]. La hora viene en UTC (12Z = 09:00 en Argentina).
// estacion_id = el id de la ESTACIÓN del INA (no el de la serie): así la temperatura y la humedad van a la misma fila.
// Viento (55, 57) y presión (60) quedan sólo en el crudo de R2.
import { createHash } from 'node:crypto';
import { numero } from '../lib/diario.mjs';
import { localDe } from '../lib/hora.mjs';
import { parte } from '../lib/crudo.mjs';

export const A5 = 'https://alerta.ina.gob.ar/a5/obs/puntual/';
const VAR = { 53: 'temp', 58: 'hum', 1: 'lluvia_diaria' };

/** La parte «series» → Map(serie_id → { campo, estacion }). Sólo Argentina, públicas, con medición directa. */
export function parsearSeries(texto) {
  const j = JSON.parse(texto);
  const rows = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : null;
  if (!rows) throw new Error('ina: el listado de series no trae rows');
  const m = new Map();
  for (const s of rows) {
    const campo = VAR[s?.var?.id];
    if (!campo || s?.procedimiento?.id !== 1) continue;
    const e = s.estacion || {};
    if (e.public === false || e.pais !== 'Argentina' || e.id == null) continue;
    const [lon, lat] = Array.isArray(e.geom?.coordinates) ? e.geom.coordinates.map((x) => numero(x)) : [null, null];
    m.set(String(s.id), { campo, estacion: {
      estacion_id: String(e.id), nombre: e.nombre || null,
      lat: lat != null && lat > -56 && lat < -21 ? lat : null, lon: lon != null && lon > -75 && lon < -53 ? lon : null,
      fuente_ubicacion: 'INA a5, geom de la estación',
      metadatos: { fuente: 'INA alerta (a5)', red_ina: e.red?.nombre ?? null, propietario: e.propietario ?? null, automatica: e.automatica ?? null,
        licencia: 'sin términos publicados para la a5: INTERNO' } } });
  }
  return m;
}

/** Las filas de INA_ALERTA (lluvia diaria) de una estación; sólo las que cambiaron (firma). */
export function filasLluvia({ nuevas, viejas = [] }) {
  const firmas = new Map(viejas.map((f) => [f.fecha, f.crudo?.firma]));
  const filas = [];
  for (const o of nuevas) {
    const base = { fecha: o.fecha, hora_corte: '09:00', lluvia_mm: o.lluvia_mm, horas_validas: 24, lluvia_origen: null, url: A5 + 'series/' + o.serie_id };
    const firma = createHash('sha256').update(JSON.stringify({ ...base, timestart: o.timestart })).digest('hex').slice(0, 16);
    if (firmas.get(o.fecha) === firma) continue;
    filas.push({ ...base, crudo: { fuente: 'INA alerta (a5)', uso: 'interno', serie_id: o.serie_id, timestart: o.timestart, valor: o.lluvia_mm, firma } });
  }
  return filas;
}

export default {
  id: 'ina', nombre: 'INA alerta (a5)', proceso: 'interna_ina',
  redes: {
    INA_METEO: { pasoMin: 60, extremos: 'muestreados', lluvia: null, eto: false, fuente: 'INA alerta (a5)', url: A5, maxEdadH: 12 },
    INA_ALERTA: { diaria: true, armar: filasLluvia },
  },
  leer(obj) {
    const cs = parte(obj, 'series');
    if (cs == null) return [];
    const series = parsearSeries(cs);
    const porInst = new Map();   // estacion|local → lectura (temp y hum de la misma hora juntas)
    const diarias = []; const usadas = new Map(); const conLluvia = new Set(); let problemas = 0;
    for (const nombre of Object.keys(obj.partes || {})) {
      if (!/^obs_\d+$/.test(nombre)) continue;
      const c = parte(obj, nombre);
      if (c == null) continue;
      let a;
      try { a = JSON.parse(c); } catch { problemas++; continue; }
      if (!Array.isArray(a)) { problemas++; continue; }
      for (const o of a) {
        const s = series.get(String(o?.series_id));
        if (!s) continue;
        const v = numero(o.valor);
        const local = localDe(o.timestart);
        if (!local || v == null) { problemas++; continue; }
        usadas.set(s.estacion.estacion_id, s.estacion);
        if (s.campo === 'lluvia_diaria') {
          if (local.slice(11) !== '09:00' || v < 0 || v >= 450) { problemas++; continue; }   // el total de 9 a 9 arranca a las 09
          conLluvia.add(s.estacion.estacion_id);
          diarias.push({ id: s.estacion.estacion_id, obs: [{ fecha: local.slice(0, 10), lluvia_mm: Math.round(v * 100) / 100, timestart: o.timestart, serie_id: String(o.series_id) }] });
          continue;
        }
        const k = s.estacion.estacion_id + '|' + local;
        if (!porInst.has(k)) porInst.set(k, { id: s.estacion.estacion_id, local, v: {} });
        porInst.get(k).v[s.campo] = v;
      }
    }
    const lecturas = [...porInst.values()];
    const conMeteo = new Set(lecturas.map((l) => l.id));
    return [
      { red: 'INA_METEO', estaciones: [...usadas.values()].filter((e) => conMeteo.has(e.estacion_id)), lecturas, problemas },
      { red: 'INA_ALERTA', estaciones: [...usadas.values()].filter((e) => conLluvia.has(e.estacion_id)), lecturas: [], diarias, problemas: 0 },
    ];
  },
};
