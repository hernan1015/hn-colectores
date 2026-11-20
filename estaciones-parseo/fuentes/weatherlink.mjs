// HN AGRO · estaciones-parseo · WeatherLink público (Davis) → red WEATHERLINK_PUB. INTERNO por CHECK en la base: los
// términos de Davis prohíben los robots (Paso 0 139, fila 14); la bajada la autorizó el maker el 15/11 para uso interno.
// Lo que guarda la ronda (estaciones-privadas/ronda.mjs):
//   estaciones-internas/weatherlink/<día ARG>/<HHMM UTC>.jsonl   un renglón por estación: { id, leido: ISO, d: <detalle> }
//   estaciones-internas/weatherlink/indices/<día ARG>.json       [{ id, lat, lng, tb, … }] (sólo AR; tb = −1 = inactiva)
// ⚠ [0152 obs. 6, 20/11] EL FORMATO DEL DETALLE NO ESTÁ VERIFICADO (no hay una muestra real a la vista): por eso
// FORMATO.verificado = false y, mientras siga así, se guardan las ESTACIONES (id, lat/lon y activa, del índice) pero
// NINGUNA LECTURA: cada detalle se cuenta como `formato_sin_verificar`, y los NOMBRES de sus claves van a claves_vistas
// (parsear.mjs los guarda sólo en registro_procesos, nunca en el log público). Es el mismo cierre que Weathercloud.
// Para prenderlo, local mira un detalle de R2, fija CLAVES (y el subobjeto, si hace falta) y pone verificado: true.
// Aun verificado, NO SE CONVIERTE A CIEGAS: °F/°C, mph/km/h/m/s, in/mm e inHg/hPa sólo con la unidad ESCRITA en el
// valor. Un valor sin unidad no va a la lectura: queda en `crudo` y se cuenta `sin_unidad`.
import { numero, numeroConUnidad, instante, enCajaAR, ID_OK, fAc, mphAms, kmhAms, inAmm, inhgAhpa, rumbo, sumar } from '../lib/comun.mjs';

export const RED = 'WEATHERLINK_PUB';
export const PREF = 'estaciones-internas/weatherlink/';
const META = { fuente: 'WeatherLink público (Davis)', permiso: 'interno' };
export const FORMATO = {
  verificado: false,
  /* null = las claves sólo arriba; un nombre = arriba o dentro de ESE subobjeto (nunca «cualquier subobjeto») */
  subobjeto: null,
};
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

/** El primer valor no nulo de `claves`, arriba o (si se nombra) dentro del subobjeto `sub`. */
export function valor(o, claves, sub = null) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  for (const k of claves) if (o[k] != null) return o[k];
  const v = sub ? o[sub] : null;
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of claves) if (v[k] != null) return v[k];
  return undefined;
}

/** La unidad ESCRITA en el valor: «68.0 °F» → 'F', «29.92 inHg» → 'inHg'. Un número suelto («68.0», 68) → null. */
const UNIDADES = { c: 'C', '°c': 'C', 'ºc': 'C', f: 'F', '°f': 'F', 'ºf': 'F', mph: 'mph', 'km/h': 'kmh', kmh: 'kmh', 'm/s': 'ms',
  in: 'in', '"': 'in', mm: 'mm', inhg: 'inHg', hpa: 'hPa', mb: 'hPa' };
export function unidad(v) {
  if (typeof v !== 'string') return null;
  const m = /^\s*-?\d+(?:[.,]\d+)?\s*([^\d\s].*?)\s*$/.exec(v);
  return m ? UNIDADES[m[1].toLowerCase().replace(/\s+/g, '')] ?? null : null;
}
const CONV = {
  temp_c: { C: (x) => x, F: fAc },
  viento_ms: { ms: (x) => x, kmh: kmhAms, mph: mphAms },
  presion_hpa: { hPa: (x) => x, inHg: inhgAhpa },
  lluvia_dia_mm: { mm: (x) => x, in: inAmm },
};
CONV.racha_ms = CONV.viento_ms;
/** Un valor → { valor } en la unidad de la base SÓLO si trae su unidad escrita (y es de esa variable); si no,
 *  { valor: null, sin_unidad: <el número tal cual> }. Nunca se supone °F, mph, in ni inHg. */
export function convertir(v, variable) {
  const x = numeroConUnidad(v);
  if (x == null) return { valor: null };
  const f = CONV[variable][unidad(v)];
  return f ? { valor: f(x) } : { valor: null, sin_unidad: x };
}

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

const CONVERTIDAS = [['temp_c', 'temp'], ['viento_ms', 'viento'], ['racha_ms', 'racha'], ['presion_hpa', 'presion'], ['lluvia_dia_mm', 'lluvia_dia']];

export function crear(formato = FORMATO) {
  const sub = formato.subobjeto || null;
  const val = (d, k) => valor(d, CLAVES[k], sub);
  function leer(obj, ctx = {}) {
    const indice = ctx.indice || new Map();
    const descartadas = {}; const claves_vistas = {};
    const lecturas = []; const nombres = new Map(); const vistas = new Set();
    /* sólo NOMBRES de claves hechos de letras (nunca valores ni algo que pueda ser un id), para completar CLAVES */
    const anotar = (d) => { for (const k of Object.keys(d).slice(0, 30)) if (/^[A-Za-z_]{1,40}$/.test(k)) sumar(claves_vistas, k); };
    for (const o of obj?.renglones || []) {
      if (o.roto) { sumar(descartadas, 'no_es_json'); continue; }
      const id = o && o.id != null ? String(o.id) : '';
      if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
      const d = o.d;
      if (!d || typeof d !== 'object' || Array.isArray(d)) { sumar(descartadas, 'sin_detalle'); continue; }
      vistas.add(id);
      if (!formato.verificado) { sumar(descartadas, 'formato_sin_verificar'); anotar(d); continue; }
      const leido = instante(o.leido);
      let t = instante(val(d, 'instante'));
      const edad = numero(val(d, 'edad'));
      if (t == null && edad != null && leido != null) t = leido - edad * 1000;
      if (t == null) { sumar(descartadas, 'sin_instante'); anotar(d); continue; }
      const n = val(d, 'nombre');
      if (typeof n === 'string' && n.trim()) nombres.set(id, n.trim().slice(0, 80));
      const l = { estacion_id: id, instante: t, tipo: 'instantanea', hum_pct: numeroConUnidad(val(d, 'hum')),
        viento_dir_gr: rumbo(val(d, 'dir')), crudo: {} };
      for (const [v, k] of CONVERTIDAS) {
        const c = convertir(val(d, k), v);
        l[v] = c.valor;
        if (c.sin_unidad != null) { l.crudo[v + '_sin_unidad'] = c.sin_unidad; sumar(descartadas, 'sin_unidad'); }
      }
      lecturas.push(l);
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
  return { id: 'weatherlink', red: RED, ext: /\.jsonl$/, abrir, contexto, leer };
}

export default crear();
