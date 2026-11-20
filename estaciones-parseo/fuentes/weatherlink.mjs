// HN AGRO · estaciones-parseo · WeatherLink público (Davis) → red WEATHERLINK_PUB. INTERNO por CHECK en la base: los
// términos de Davis prohíben los robots (Paso 0 139, fila 14); la bajada la autorizó el maker el 15/11 para uso interno.
// Lo que guarda la ronda (estaciones-privadas/ronda.mjs):
//   estaciones-internas/weatherlink/<día ARG>/<HHMM UTC>.jsonl   un renglón por estación: { id, leido: ISO, d: <detalle> }
//   estaciones-internas/weatherlink/indices/<día ARG>.json       [{ id, lat, lng, tb, … }] (sólo AR; tb = −1 = inactiva)
// ⚠ LAS CLAVES DEL DETALLE NO ESTÁN VERIFICADAS (no hay una muestra a la vista): se buscan las de CLAVES, arriba o un nivel
// adentro, y las unidades son °F, mph, in e inHg (lo dijo local el 13/11) salvo que el valor traiga la suya escrita.
// Lo que no se entiende se descarta CONTADO (sólo los nombres de las claves, nunca los valores), no se adivina.
import { numero, numeroConUnidad, instante, enCajaAR, ID_OK, fAc, mphAms, kmhAms, inAmm, inhgAhpa, rumbo, sumar } from '../lib/comun.mjs';

export const RED = 'WEATHERLINK_PUB';
export const PREF = 'estaciones-internas/weatherlink/';
const META = { fuente: 'WeatherLink público (Davis)', permiso: 'interno' };
export const CLAVES = {
  instante: ['lastTimestamp', 'lastReceived', 'timestamp', 'ts'],
  edad: ['ageInSeconds', 'age'],
  nombre: ['stationName', 'name'],
  temp: ['temperature', 'temp', 'tempOut'],
  hum: ['humidity', 'hum', 'humOut'],
  viento: ['windSpeed', 'wind'],
  racha: ['windGust', 'gust'],
  dir: ['windDirection', 'windDir'],
  presion: ['barometer', 'pressure', 'bar'],
  lluvia_dia: ['rainDay', 'dailyRain', 'rainDaily'],
};

/** El primer valor no nulo de `claves`, arriba o un nivel adentro. */
export function valor(o, claves) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  for (const k of claves) if (o[k] != null) return o[k];
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of claves) if (v[k] != null) return v[k];
  return undefined;
}
const unidad = (v) => (typeof v !== 'string' ? null : /inhg/i.test(v) ? 'inHg' : /(hpa|mb)\s*$/i.test(v) ? 'hPa' : /km\/?h/i.test(v) ? 'kmh'
  : /m\/s/i.test(v) ? 'ms' : /mph/i.test(v) ? 'mph' : /°?\s*C\s*$/.test(v) ? 'C' : /°?\s*F\s*$/.test(v) ? 'F' : /mm\s*$/i.test(v) ? 'mm'
  : /(in|")\s*$/i.test(v) ? 'in' : null);
const temp = (v) => { const x = numeroConUnidad(v); return x == null ? null : unidad(v) === 'C' ? x : fAc(x); };
const vel = (v) => { const x = numeroConUnidad(v); const u = unidad(v); return x == null ? null : u === 'ms' ? x : u === 'kmh' ? kmhAms(x) : mphAms(x); };
const pres = (v) => { const x = numeroConUnidad(v); return x == null ? null : unidad(v) === 'hPa' || x > 100 ? x : inhgAhpa(x); };
const lluvia = (v) => { const x = numeroConUnidad(v); return x == null ? null : unidad(v) === 'mm' ? x : inAmm(x); };

/** El índice de los días de la ventana → Map(id → { lat, lon, tb }) (el día más nuevo manda). */
export async function contexto({ almacen, dias }) {
  const indice = new Map();
  for (const dia of [...dias].sort()) {
    const b = await almacen.leer(`${PREF}indices/${dia}.json`);
    if (!b) continue;
    let lista;
    try { lista = JSON.parse(b.toString('utf8')); } catch { continue; }
    for (const s of Array.isArray(lista) ? lista : []) {
      if (s && s.id != null && ID_OK.test(String(s.id))) indice.set(String(s.id), { lat: numero(s.lat), lon: numero(s.lng ?? s.lon), tb: s.tb });
    }
  }
  return { indice };
}

/** El texto de un .jsonl → { leido (el mayor de los renglones), renglones }. */
export function abrir(texto) {
  const renglones = []; let leido = null;
  for (const linea of String(texto).split(/\r?\n/)) {
    if (!linea.trim()) continue;
    try {
      const o = JSON.parse(linea);
      const t = instante(o?.leido);
      if (t != null && (leido == null || t > leido)) leido = t;
      renglones.push(o);
    } catch { renglones.push({ roto: true }); }
  }
  return { leido: leido == null ? null : new Date(leido).toISOString(), renglones };
}

export function leer(obj, ctx = {}) {
  const indice = ctx.indice || new Map();
  const descartadas = {}; const claves_vistas = {};
  const lecturas = []; const nombres = new Map(); const vistas = new Set();
  for (const o of obj?.renglones || []) {
    if (o.roto) { sumar(descartadas, 'no_es_json'); continue; }
    const id = o && o.id != null ? String(o.id) : '';
    if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    const d = o.d;
    if (!d || typeof d !== 'object' || Array.isArray(d)) { sumar(descartadas, 'sin_detalle'); continue; }
    vistas.add(id);
    const leido = instante(o.leido);
    let t = instante(valor(d, CLAVES.instante));
    const edad = numero(valor(d, CLAVES.edad));
    if (t == null && edad != null && leido != null) t = leido - edad * 1000;
    if (t == null) {
      sumar(descartadas, 'sin_instante');
      /* sólo NOMBRES de claves hechos de letras (nunca valores ni algo que pueda ser un id), para completar CLAVES */
      for (const k of Object.keys(d).slice(0, 30)) if (/^[A-Za-z_]{1,40}$/.test(k)) sumar(claves_vistas, k);
      continue;
    }
    const n = valor(d, CLAVES.nombre);
    if (typeof n === 'string' && n.trim()) nombres.set(id, n.trim().slice(0, 80));
    lecturas.push({ estacion_id: id, instante: t, tipo: 'instantanea',
      temp_c: temp(valor(d, CLAVES.temp)), hum_pct: numeroConUnidad(valor(d, CLAVES.hum)),
      viento_ms: vel(valor(d, CLAVES.viento)), racha_ms: vel(valor(d, CLAVES.racha)), viento_dir_gr: rumbo(valor(d, CLAVES.dir)),
      presion_hpa: pres(valor(d, CLAVES.presion)), lluvia_dia_mm: lluvia(valor(d, CLAVES.lluvia_dia)), crudo: {} });
  }
  const ids = new Set([...indice.keys(), ...vistas]);
  const estaciones = [...ids].sort().map((id) => {
    const i = indice.get(id);
    const ok = i && enCajaAR(i.lat, i.lon);
    return { estacion_id: id, nombre: nombres.get(id) ?? null, lat: ok ? i.lat : null, lon: ok ? i.lon : null,
      fuente_ubicacion: i ? 'índice del mapa de WeatherLink' : null, precision_ubicacion: i ? 'declarada por el dueño' : null,
      activa: i ? i.tb !== -1 : true, metadatos: { ...META } };
  });
  return { red: RED, estaciones, lecturas, descartadas, claves_vistas };
}

export default { id: 'weatherlink', red: RED, ext: /\.jsonl$/, abrir, contexto, leer };
