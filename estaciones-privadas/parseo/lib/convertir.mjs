// HN AGRO · parseo de estaciones internas · conversiones y limpieza COMUNES a todas las fuentes.
// (Puerto a JS de las funciones probadas de la propuesta 0152 en la nube, que quedó como referencia: rama
//  feat/138b-weatherlink-publico de hn-radar.)

export const r2d = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
export const fAc = (x) => r2d(((x - 32) * 5) / 9);
export const mphAms = (x) => r2d(x * 0.44704);
export const kmhAms = (x) => r2d(x / 3.6);
export const inAmm = (x) => r2d(x * 25.4);
export const inhgAhpa = (x) => r2d(x * 33.8639, 1);

/** Un número: 12.5, "12.5", "12,5 °F", "-3". «--», "", null, objetos → null. */
export function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(v);
  return m ? Number(m[1].replace(',', '.')) : null;
}

/** La unidad escrita en el propio valor ("12 °C", "3 km/h"), o null. */
export function unidadEnValor(v) {
  if (typeof v !== 'string') return null;
  if (/inhg/i.test(v)) return 'inHg';
  if (/(hpa|mbar|mb)\s*$/i.test(v)) return 'hPa';
  if (/km\/?h/i.test(v)) return 'kmh';
  if (/m\/s/i.test(v)) return 'ms';
  if (/mph/i.test(v)) return 'mph';
  if (/°?\s*C\s*$/i.test(v)) return 'C';
  if (/°?\s*F\s*$/i.test(v)) return 'F';
  if (/mm\s*$/i.test(v)) return 'mm';
  if (/(in|")\s*$/i.test(v)) return 'in';
  return null;
}

const RUMBOS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** Dirección del viento en grados: número o rumbo (también con O por W). */
export function dir(v) {
  const n = num(v);
  if (n != null) return n;
  if (typeof v !== 'string') return null;
  const i = RUMBOS.indexOf(v.trim().toUpperCase().replace(/O/g, 'W'));
  return i < 0 ? null : i * 22.5;
}

/** Un instante: epoch s / ms (número o dígitos) o ISO. → ms, o null. */
export function instante(v) {
  if (v == null) return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\s*\d{9,14}\s*$/.test(v))) {
    const n = Number(v);
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  if (typeof v === 'string' && /^\s*\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// cp1252 0x80-0x9F → su byte
const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
  '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Doble codificación (UTF-8 leído como latin1/cp1252: «Ã±» → «ñ»), hasta dos vueltas. Si algún carácter no puede
 *  venir de ahí o los bytes no son UTF-8 válido, queda como vino. Normaliza los espacios. */
export function arreglarNombre(t) {
  if (t == null) return null;
  let r = String(t);
  for (let vuelta = 0; vuelta < 2 && /[ÃÂâ]/.test(r); vuelta++) {
    const bytes = [];
    for (const c of r) {
      const cod = c.codePointAt(0);
      if (cod < 256) bytes.push(cod);
      else if (CP1252[c] != null) bytes.push(CP1252[c]);
      else return r.replace(/\s+/g, ' ').trim();
    }
    let nuevo;
    try { nuevo = UTF8.decode(Uint8Array.from(bytes)); } catch { break; }
    if (nuevo === r) break;
    r = nuevo;
  }
  return r.replace(/\s+/g, ' ').trim();
}

/** Los rangos posibles: fuera de ellos, null + marca. */
/*  (los mismos de los CHECK de la 0110/0147 para lo que va a estaciones_obs / estaciones_ultima_lectura) */
export const RANGOS = {
  temp_c: (x) => x > -40 && x < 60,
  hum_pct: (x) => x >= 0 && x <= 100,
  viento_ms: (x) => x >= 0 && x < 100,
  racha_ms: (x) => x >= 0 && x < 100,
  viento_dir_gr: (x) => x >= 0 && x <= 360,
  presion_hpa: (x) => x >= 850 && x <= 1100,
  lluvia_dia_mm: (x) => x >= 0 && x < 500,
};
/** Aplica RANGOS a una lectura (in place): lo imposible queda null y se marca. */
export function controlar(l) {
  for (const [k, ok] of Object.entries(RANGOS)) {
    if (l[k] != null && !ok(l[k])) { l.marcas.push(`${k}_fuera_de_rango`); l[k] = null; }
  }
  return l;
}

/** Día local de Argentina (UTC−3, sin horario de verano) y minutos desde su 00:00. */
export function local(ms) {
  const d = new Date(ms - 3 * 3600e3);
  const fecha = d.toISOString().slice(0, 10);
  return { fecha, min: d.getUTCHours() * 60 + d.getUTCMinutes(), seg: d.getUTCSeconds() };
}
export const sumarDias = (fecha, n) => new Date(Date.parse(fecha + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
