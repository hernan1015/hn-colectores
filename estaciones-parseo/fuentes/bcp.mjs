// HN AGRO · estaciones-parseo · BCP Bahía Blanca, el mapa de estaciones (MapaG_NvoBCP.asp) → red BCP_RT. INTERNO
// (decisión del maker, 13/10). La ronda guarda la parte «mapa». La página DECLARA en qué casillero va cada dato
// (iSensorTemp = 5, iEstacionUltAct = 25, …) y después llena jsDatos[i][casillero][k] con literales: se leen los
// casilleros POR ESAS CONSTANTES, nunca por posición fija. Los textos traen la unidad («18.6 &ordm;C», «12 km/h»).
// · temp: la del último dato · lluvia: «del día» (iSensorPpDia) → lluvia_dia_mm · presión (hPa) · viento y ráfaga
//   (km/h → m/s) · dirección (°). La humedad y el rocío NO se usan (Paso 0 de hn-agro del 13/10: no cierran entre sí).
// Nada de la página se ejecuta: las líneas se leen con expresiones regulares.
import { numeroConUnidad, kmhAms, enCajaAR, ID_OK, desdeLocal, parte, sumar } from '../lib/comun.mjs';

export const RED = 'BCP_RT';
const META = { fuente: 'BCP Bahía Blanca (mapa)', permiso: 'interno' };
const OBLIGATORIAS = ['iEstacionLat', 'iEstacionLong', 'iEstacionUltAct', 'iSensorTemp', 'iSensorPpDia'];
const OPCIONALES = ['iSensorPresion', 'iSensorDir_Vto', 'iSensorVel_Vto', 'iSensorRaf_Vto'];
const ENT = { nbsp: ' ', amp: '&', quot: '"', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', ordm: 'º', deg: '°' };
const entidades = (s) => String(s).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&([a-zA-Z]+\d?);/g, (m, n) => ENT[n] ?? m);
const vacio = (motivo) => ({ red: RED, estaciones: [], lecturas: [], descartadas: { [motivo]: 1 } });

/** Un literal de la página → texto / número / null. */
function literalJs(s) {
  const t = s.trim().replace(/;$/, '').trim();
  const q = /^'([\s\S]*)'$/.exec(t) || /^"([\s\S]*)"$/.exec(t);
  if (q) return entidades(q[1]);
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** «15/11/2026 13:07:00» → ms (hora argentina). */
const fecha = (x) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(x ?? ''));
  return m ? desdeLocal(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}`) : NaN;
};

export function leer(obj) {
  const c = parte(obj, 'mapa');
  if (c == null) return vacio('sin_parte');
  const txt = c.replace(/\/\*[\s\S]*?\*\//g, '');
  const C = {};
  for (const n of [...OBLIGATORIAS, ...OPCIONALES]) {
    const m = new RegExp(`^\\s*${n}\\s*=\\s*(\\d+)\\s*;?\\s*$`, 'm').exec(txt);
    if (m) C[n] = Number(m[1]);
  }
  if (OBLIGATORIAS.some((n) => C[n] == null)) return vacio('formato_cambiado');
  const rot = [], habil = [], sitio = [], datos = [];
  for (const l of txt.split(/\r?\n/)) {
    if (/^\s*\/\//.test(l)) continue;
    let m = /^\s*(htmlEstacion|habilEstacion|sitioEstacion)\[(\d+)\]\s*=\s*(.+?)\s*$/.exec(l);
    if (m) { ({ htmlEstacion: rot, habilEstacion: habil, sitioEstacion: sitio })[m[1]][Number(m[2])] = literalJs(m[3]); continue; }
    m = /^\s*jsDatos\[(\d+)\]\[(\d+)\]\[(\d+)\]\s*=\s*(.+?)\s*$/.exec(l);
    if (m) { const [i, s, k] = [m[1], m[2], m[3]].map(Number); ((datos[i] ||= [])[s] ||= [])[k] = literalJs(m[4]); }
  }
  if (!rot.length) return vacio('formato_cambiado');
  const D = (i, n, k = 0) => (C[n] == null ? undefined : datos[i]?.[C[n]]?.[k]);
  const estaciones = [], lecturas = [], descartadas = {};
  for (let i = 0; i < rot.length; i++) {
    if (rot[i] == null) continue;
    if (Number(habil[i]) !== 1) { sumar(descartadas, 'deshabilitada'); continue; }
    const id = String(sitio[i] ?? '');
    if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    const r = /^Estaci[oó]n\s+(\d+)\s+-\s+(.+?)(?:\s+\(([^()]+)\))?\s*$/i.exec(String(rot[i]));
    const lat = numeroConUnidad(D(i, 'iEstacionLat')), lon = numeroConUnidad(D(i, 'iEstacionLong'));
    const ok = enCajaAR(lat, lon);
    estaciones.push({ estacion_id: id, nombre: r ? r[2].trim() : String(rot[i]).trim().slice(0, 80), partido: r?.[3]?.trim() || null,
      lat: ok ? lat : null, lon: ok ? lon : null, fuente_ubicacion: 'BCP (MapaG_NvoBCP.asp)', precision_ubicacion: 'declarada por la red',
      metadatos: { ...META } });
    const t = fecha(D(i, 'iEstacionUltAct'));
    if (!Number.isFinite(t)) { sumar(descartadas, 'sin_instante'); continue; }
    const vel = numeroConUnidad(D(i, 'iSensorVel_Vto')), raf = numeroConUnidad(D(i, 'iSensorRaf_Vto'));
    const kmh = (v, k) => (v == null ? null : /km\/h/i.test(String(D(i, k))) ? kmhAms(v) : undefined);
    const crudo = {};
    let viento = kmh(vel, 'iSensorVel_Vto'), racha = kmh(raf, 'iSensorRaf_Vto');
    if (viento === undefined) { crudo.viento = vel; viento = null; }      // sin «km/h» escrito: la unidad no se adivina
    if (racha === undefined) { crudo.racha = raf; racha = null; }
    lecturas.push({ estacion_id: id, instante: t, tipo: 'instantanea',
      temp_c: numeroConUnidad(D(i, 'iSensorTemp')), lluvia_dia_mm: numeroConUnidad(D(i, 'iSensorPpDia')),
      presion_hpa: numeroConUnidad(D(i, 'iSensorPresion')), viento_ms: viento, racha_ms: racha,
      viento_dir_gr: numeroConUnidad(D(i, 'iSensorDir_Vto')), crudo });
  }
  return { red: RED, estaciones, lecturas, descartadas };
}

export default { id: 'bcp', red: RED, leer };
