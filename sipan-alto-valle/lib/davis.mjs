// HN AGRO · SIPAN Alto Valle · lector del export de Davis WeatherLink («downld02.txt», ancho fijo, un registro cada 10 min).
// Sin dependencias. Las columnas NO son fijas: cambian por estación y con los años (33 o 40 columnas, «Dew» o «Dew Pt.»,
// «Leaf Wet 1» o «Soil 1 Moist.»; reloj de 24 h o de 12 h con a/p). Por eso se leen del encabezado de dos renglones y se
// exige un mínimo de columnas conocidas.
//
// Reglas:
//   · Un faltante («---», «------», vacío) es null. NUNCA 0.
//   · El registro de las «0:10» cubre de 0:00 a 0:10 (hora de FIN del intervalo), en la hora del reloj de la estación.
//   · Si el encabezado no se entiende, faltan columnas obligatorias, las filas no tienen la cantidad de campos del
//     encabezado o las unidades no son métricas, el resultado es { ok:false, motivo } y NO se carga nada.
import crypto from 'node:crypto';

/** nombre de la columna en el encabezado → clave nuestra */
export const COLUMNAS = {
  'Date': 'fecha', 'Time': 'hora',
  'Temp Out': 'temp', 'Hi Temp': 'temp_max', 'Low Temp': 'temp_min',
  'Out Hum': 'hum', 'Dew': 'rocio', 'Dew Pt.': 'rocio',
  'Wind Speed': 'viento', 'Wind Dir': 'viento_dir', 'Dir': 'viento_dir' /* Guerrico 2026: un solo «Wind» sobre «Speed Dir» */, 'Wind Run': 'viento_recorrido', 'Hi Speed': 'racha', 'Hi Dir': 'racha_dir',
  'Wind Chill': 'sensacion_viento', 'Heat Index': 'indice_calor', 'THW Index': 'thw', 'THW': 'thw', 'THSW Index': 'thsw',
  'Bar': 'presion', 'Rain': 'lluvia', 'Rain Rate': 'lluvia_intensidad',
  'Solar Rad.': 'rad', 'Solar Energy': 'rad_energia', 'Hi Solar Rad.': 'rad_max',
  'UV Index': 'uv', 'UV': 'uv', 'UV Dose': 'uv_dosis', 'Hi UV': 'uv_max',
  'Heat D-D': 'grados_dia_calor', 'Cool D-D': 'grados_dia_frio',
  'In Temp': 'int_temp', 'In Hum': 'int_hum', 'In Dew': 'int_rocio', 'In Heat': 'int_calor', 'In EMC': 'int_emc', 'In Air Density': 'int_densidad',
  'ET': 'et', 'Soil 1 Moist.': 'suelo_humedad_1', 'Leaf Wet 1': 'hoja_mojada_1', 'Leaf Temp 1': 'hoja_temp_1',
  'Wind Samp': 'viento_muestras', 'Wind Tx': 'viento_tx', 'ISS Recept': 'iss_recepcion', 'Arc. Int.': 'intervalo_min',
};
export const OBLIGATORIAS = ['fecha', 'hora', 'temp', 'temp_max', 'temp_min', 'hum', 'lluvia'];
const TEXTO = new Set(['fecha', 'hora', 'viento_dir', 'racha_dir']);

/** tokens de un renglón con su posición de fin */
function tokens(linea) {
  const out = [];
  for (const m of linea.matchAll(/\S+/g)) out.push({ t: m[0], ini: m.index, fin: m.index + m[0].length });
  return out;
}

/** Junta «Wet» «1» → «Wet 1» (las columnas con espacio interno terminan en un dígito suelto). */
function juntarNumeros(ts) {
  const out = [];
  for (const k of ts) {
    const prev = out[out.length - 1];
    if (prev && /^\d$/.test(k.t) && k.ini - prev.fin === 1) { prev.t += ' ' + k.t; prev.fin = k.fin; } else out.push({ ...k });
  }
  return out;
}

/** Encabezado de 2 renglones → nombres de columna (en orden). Cada palabra de arriba va a la columna de abajo con la que
 *  más se superpone (WeatherLink no las alinea siempre igual: «Hi Solar» sobre «Rad.», «In Air» sobre «Density»).
 *  Si no se superpone con ninguna, va a la más cercana por el centro. */
export function columnasDe(l1, l2) {
  const abajo = juntarNumeros(tokens(l2));
  const arriba = juntarNumeros(tokens(l1));
  const sobre = abajo.map(() => []);
  const sobran = [];
  for (const x of arriba) {
    let mejor = -1, solape = 0;
    abajo.forEach((a, i) => {
      const s = Math.min(a.fin, x.fin) - Math.max(a.ini, x.ini);
      if (s > solape) { solape = s; mejor = i; }
    });
    if (mejor < 0) {
      let dist = Infinity;
      abajo.forEach((a, i) => { const d = Math.abs((a.ini + a.fin) / 2 - (x.ini + x.fin) / 2); if (d < dist) { dist = d; mejor = i; } });
      if (dist > 6) { sobran.push(x.t); continue; }
    }
    sobre[mejor].push(x.t);
  }
  return { cols: abajo.map((a, i) => [...sobre[i], a.t].join(' ')), sobran };
}

export function firmaDe(cols) {
  return crypto.createHash('sha256').update(cols.join('|')).digest('hex').slice(0, 16);
}

/** «13/02/26» y «0:10» | «12:10a» | «8:50p» → { fecha:'2026-02-13', hm:'00:10' } o null */
export function fechaHora(f, h) {
  const mf = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(f || '');
  const mh = /^(\d{1,2}):(\d{2})([ap])?$/.exec(h || '');
  if (!mf || !mh) return null;
  const d = +mf[1], m = +mf[2], y = 2000 + +mf[3];
  let hh = +mh[1]; const mm = +mh[2];
  if (mh[3]) {
    if (hh < 1 || hh > 12) return null;
    hh = mh[3] === 'a' ? (hh === 12 ? 0 : hh) : (hh === 12 ? 12 : hh + 12);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCDate() !== d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return { fecha: `${y}-${p(m)}-${p(d)}`, hm: `${p(hh)}:${p(mm)}` };
}

/** texto → número | null (faltante) | undefined (basura: ni número ni faltante) */
export function numero(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '' || /^-+$/.test(t) || /^n\/?d$/i.test(t) || /^nan$/i.test(t)) return null;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Lee el texto completo. Devuelve
 *   { ok:true, columnas, firma, intervalo_min, registros:[{ fecha, hm, local:'AAAA-MM-DDTHH:MM', v:{clave:número|null}, texto }], descartadas }
 *   { ok:false, motivo, detalle, columnas? }
 */
export function leerDavis(texto) {
  if (typeof texto !== 'string' || !texto.trim()) return { ok: false, motivo: 'vacio' };
  if (/<html|<!doctype/i.test(texto.slice(0, 500))) return { ok: false, motivo: 'no_es_davis', detalle: 'llegó una página HTML' };
  const lineas = texto.replace(/\r/g, '').split('\n');
  const i2 = lineas.findIndex((l) => /^\s*Date\s+Time\b/.test(l));
  if (i2 < 1) return { ok: false, motivo: 'encabezado', detalle: 'no hay renglón «Date Time»' };
  const { cols, sobran } = columnasDe(lineas[i2 - 1], lineas[i2]);
  if (sobran.length) return { ok: false, motivo: 'encabezado', detalle: 'sobra arriba: ' + sobran.join(' '), columnas: cols };
  const claves = cols.map((c) => COLUMNAS[c] || null);
  const desconocidas = cols.filter((c, i) => !claves[i]);
  const faltan = OBLIGATORIAS.filter((k) => !claves.includes(k));
  if (faltan.length) return { ok: false, motivo: 'faltan_columnas', detalle: faltan.join(','), columnas: cols };
  const conocidas = claves.filter(Boolean);
  if (new Set(conocidas).size !== conocidas.length) return { ok: false, motivo: 'columnas_repetidas', columnas: cols };
  const datos = lineas.slice(i2 + 1).filter((l) => l.trim() && !/^\s*-{5,}\s*$/.test(l));
  const registros = []; const descartadas = [];
  for (const l of datos) {
    const c = l.trim().split(/\s+/);
    if (c.length !== cols.length) { descartadas.push({ motivo: 'campos', n: c.length }); continue; }
    const fh = fechaHora(c[0], c[1]);
    if (!fh) { descartadas.push({ motivo: 'fecha_hora' }); continue; }
    const v = {}; const texto = {}; let basura = false;
    claves.forEach((k, i) => {
      if (!k || k === 'fecha' || k === 'hora') return;
      if (TEXTO.has(k)) { texto[k] = /^-+$/.test(c[i]) ? null : c[i]; return; }
      const n = numero(c[i]);
      if (n === undefined) basura = true;
      v[k] = n === undefined ? null : n;
    });
    if (basura) { descartadas.push({ motivo: 'valor_no_numerico' }); continue; }
    registros.push({ fecha: fh.fecha, hm: fh.hm, local: fh.fecha + 'T' + fh.hm, v, texto });
  }
  if (descartadas.length > Math.max(3, 0.1 * datos.length)) {
    return { ok: false, motivo: 'filas_rotas', detalle: `${descartadas.length} de ${datos.length} filas no coinciden con el encabezado`, columnas: cols };
  }
  if (!registros.length) return { ok: false, motivo: 'sin_registros', detalle: `descartadas ${descartadas.length}`, columnas: cols };
  /* unidades: la estación tiene que exportar en métrico (°C, mm, hPa). En °F / in / inHg es otro formato. */
  const mediana = (k) => {
    const a = registros.map((r) => r.v[k]).filter((x) => x != null).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };
  const bar = claves.includes('presion') ? mediana('presion') : null;
  if (bar != null && (bar < 850 || bar > 1100)) return { ok: false, motivo: 'unidades', detalle: 'presión mediana ' + bar + ' (no es hPa)', columnas: cols };
  const tmed = mediana('temp');
  if (tmed != null && (tmed > 45 || tmed < -30)) return { ok: false, motivo: 'unidades', detalle: 'temperatura mediana ' + tmed + ' (no es °C)', columnas: cols };
  /* orden y duplicados dentro del mismo archivo: gana el primero que aparece */
  const vistos = new Set(); const unicos = [];
  for (const r of registros.slice().sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0))) {
    if (vistos.has(r.local)) { descartadas.push({ motivo: 'duplicado' }); continue; }
    vistos.add(r.local); unicos.push(r);
  }
  const ints = unicos.map((r) => r.v.intervalo_min).filter((x) => x != null).sort((a, b) => a - b);
  const intervalo = ints.length ? ints[Math.floor(ints.length / 2)] : 10;
  return { ok: true, columnas: cols, desconocidas, firma: firmaDe(cols), intervalo_min: intervalo, registros: unicos, descartadas };
}
