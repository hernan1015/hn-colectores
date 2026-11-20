// HN AGRO · estaciones-parseo · lo común a las fuentes: números (NULL nunca es 0), unidades, rumbos, la hora argentina y
// los instantes. Sin dependencias.

/** Un valor de la fuente → número o null. «---», «N/D», vacío, NaN, −999/−9999 y los centinelas de la fuente → null.
 *  Un 0 medido sigue siendo 0: NUNCA se inventa un 0 por falta de dato. */
export function numero(x, { centinelas = [] } = {}) {
  if (x == null || typeof x === 'boolean') return null;
  let n;
  if (typeof x === 'number') n = x;
  else {
    const t = String(x).trim().replace(',', '.');
    if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
    n = Number(t);
  }
  if (!Number.isFinite(n) || n <= -999 || centinelas.includes(n)) return null;
  return n;
}

/** El número del principio de un texto con unidad: «18.6 ºC» → 18.6, «3 km/h» → 3, «N/D» → null. */
export function numeroConUnidad(x) {
  if (typeof x === 'number') return numero(x);
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(String(x ?? ''));
  return m ? numero(m[1]) : null;
}

export const redondear = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
export const fAc = (x) => (x == null ? null : ((x - 32) * 5) / 9);
export const mphAms = (x) => (x == null ? null : x * 0.44704);
export const kmhAms = (x) => (x == null ? null : x / 3.6);
export const inAmm = (x) => (x == null ? null : x * 25.4);
export const inhgAhpa = (x) => (x == null ? null : x * 33.8639);

const RUMBOS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** Rumbo en grados: un número, o un rumbo de 16 puntos en inglés o castellano («OSO» = WSW). */
export function rumbo(v) {
  const n = numeroConUnidad(v);
  if (n != null) return n;
  if (typeof v !== 'string') return null;
  const i = RUMBOS.indexOf(v.trim().toUpperCase().replace(/O/g, 'W'));
  return i < 0 ? null : i * 22.5;
}

// ── La hora: Argentina es UTC−3 fija (sin horario de verano desde 2009). ──
export const OFFSET_MS = 3 * 3600e3;
/** 'AAAA-MM-DDTHH:MM' (hora argentina) → ms UTC. NaN si no tiene la forma. */
export function desdeLocal(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local));
  if (!m) return NaN;
  const [, a, mes, d, h, mi] = m.map(Number);
  if (mes < 1 || mes > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return NaN;
  return Date.UTC(a, mes - 1, d, h, mi) + OFFSET_MS;
}
/** ms → el día argentino 'AAAA-MM-DD'. */
export const diaArg = (ms) => new Date(ms - OFFSET_MS).toISOString().slice(0, 10);

/** Un instante: epoch s / ms (número o dígitos), o ISO con zona (también con el «[UTC]» del SIGA). → ms, o null.
 *  Un ISO SIN zona no se acepta: no se adivina si es UTC o local. */
export function instante(v) {
  if (v == null) return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\s*\d{9,14}\s*$/.test(v))) {
    const n = Number(v);
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  if (typeof v === 'string') {
    const t = v.trim().replace(/\[UTC\]$/, '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) return null;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Dentro de la caja de Argentina (para descartar coordenadas rotas; no es el contorno). */
export const enCajaAR = (lat, lon) => lat != null && lon != null && lat > -56 && lat < -21 && lon > -75 && lon < -53;

/** El cuerpo de una parte que guardó ronda.mjs ({ leido, partes: { nombre: { status, tipo, cuerpo } } }): sólo si vino con 200. */
export function parte(obj, nombre) {
  const p = obj?.partes?.[nombre];
  if (!p || p.status !== 200 || typeof p.cuerpo !== 'string') return null;
  return p.cuerpo;
}

/** Un id de estación que se acepta: corto y sin caracteres raros. */
export const ID_OK = /^[A-Za-z0-9_.-]{1,64}$/;

export const sumar = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
