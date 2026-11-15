// HN AGRO · 139 interna · BCP, Bolsa de Cereales y Productos de Bahía Blanca: el mapa de estaciones
// (info.bcp.org.ar/Estaciones/MapaG_NvoBCP.asp). Red `BCP_RT` (la red `BCP` queda para cuando se pase bcp_lecturas, la
// foto diaria de las 23:50, a estaciones_obs: así no chocan las claves). USO INTERNO (mostrar = false).
// Lee lo que guarda ronda.mjs (estaciones-internas/bcp/<día>/<HHMM>.json, parte «mapa»). Escrito desde cero mirando la
// página (un pedido manual el 15/11): la página DECLARA en qué casillero va cada dato (iSensorTemp = 5, iSensorPpDia =
// 10, iEstacionUltAct = 25…) y después llena jsDatos[i][casillero][k] con literales: se leen los casilleros por esas
// constantes, nunca por posición fija. Los textos vienen con entidades HTML («18.6 &ordm;C»).
// · temp: la del último dato; tmin / tmax: las extremas que publica la Bolsa (con su hora) → extremos de CONSOLA.
//   ⚠ No dice desde qué hora cuenta su mínima y su máxima: se toman como «del día» y la fila lo marca.
// · lluvia: «lluvia del día» (iSensorPpDia), acumulado de la consola → el mayor del día.
// · humedad y rocío NO se usan (hn-agro, Paso 0 del 13/10: no cierran entre sí en ninguna estación): quedan en el crudo.
// · Los acumulados de 7 días, del mes y del año terminan AYER: al crudo.
import { numero } from '../lib/diario.mjs';
import { parte } from '../lib/crudo.mjs';

export const URL_MAPA = 'https://info.bcp.org.ar/Estaciones/MapaG_NvoBCP.asp';
const OBLIGATORIAS = ['iEstacionLat', 'iEstacionLong', 'iEstacionUltAct', 'iSensorTemp', 'iSensorPpDia'];
const OPCIONALES = ['iSensorTpMin', 'iSensorTpMax', 'iSensorHum_Rel', 'iSensorPto_Rocio', 'iSensorPresion', 'iSensorPp7d', 'iSensorPpMes', 'iSensorPpAno'];
const ENT = { nbsp: ' ', amp: '&', quot: '"', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', ordm: 'º', deg: '°', sup2: '²' };
const entidades = (s) => String(s).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&([a-z]+\d?);/gi, (m, n) => ENT[n] ?? m);

/** Un literal JS de la página → string / número / null. Nunca se evalúa. */
function literal(s) {
  const t = s.trim().replace(/;$/, '').trim();
  const q = /^'([\s\S]*)'$/.exec(t) || /^"([\s\S]*)"$/.exec(t);
  if (q) return entidades(q[1]);
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** «18.6 ºC» → 18.6 · «0.3 mm» → 0.3 · «N/D» → null. */
const valor = (x) => { if (typeof x === 'number') return numero(x); const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:º\s*C|°\s*C|mm|%|hPa)?\s*$/i.exec(String(x ?? '')); return m ? numero(m[1]) : null; };
/** «15/11/2026 13:07:00» → '2026-11-15T13:07' (hora argentina). */
const fechaLocal = (x) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(x ?? '')); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}` : null; };

export function parsearMapa(html) {
  const txt = String(html).replace(/\/\*[\s\S]*?\*\//g, '');
  const C = {};
  for (const n of [...OBLIGATORIAS, ...OPCIONALES]) { const m = new RegExp(`^\\s*${n}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(txt); if (m) C[n] = Number(m[1]); }
  const faltan = OBLIGATORIAS.filter((n) => C[n] == null);
  if (faltan.length) throw new Error('bcp: la página cambió, no declara ' + faltan.join(','));
  const rot = [], habil = [], sitio = [], datos = [];
  for (const l of txt.split(/\r?\n/)) {
    if (/^\s*\/\//.test(l)) continue;
    let m = /^\s*(htmlEstacion|habilEstacion|sitioEstacion)\[(\d+)\]\s*=\s*(.+?)\s*$/.exec(l);
    if (m) { ({ htmlEstacion: rot, habilEstacion: habil, sitioEstacion: sitio })[m[1]][Number(m[2])] = literal(m[3]); continue; }
    m = /^\s*jsDatos\[(\d+)\]\[(\d+)\]\[(\d+)\]\s*=\s*(.+?)\s*$/.exec(l);
    if (m) { const [i, s, k] = [m[1], m[2], m[3]].map(Number); ((datos[i] ||= [])[s] ||= [])[k] = literal(m[4]); }
  }
  if (!rot.length) throw new Error('bcp: la página no trae htmlEstacion');
  const D = (i, n, k = 0) => (C[n] == null ? undefined : datos[i]?.[C[n]]?.[k]);
  const estaciones = [], lecturas = []; let problemas = 0;
  for (let i = 0; i < rot.length; i++) {
    if (rot[i] == null || Number(habil[i]) !== 1) continue;
    const id = String(sitio[i] ?? '');
    if (!/^\d{1,6}$/.test(id)) { problemas++; continue; }
    const r = /^Estaci[oó]n\s+(\d+)\s+-\s+(.+?)\s+\(([^()]+)\)/i.exec(String(rot[i]));
    const lat = numero(D(i, 'iEstacionLat')), lon = numero(D(i, 'iEstacionLong'));
    estaciones.push({ estacion_id: id, nombre: r ? r[2].trim() : String(rot[i]).trim(), partido: r ? r[3].trim() : null,
      lat: lat != null && lat > -56 && lat < -21 ? lat : null, lon: lon != null && lon > -75 && lon < -53 ? lon : null,
      fuente_ubicacion: 'BCP, MapaG_NvoBCP.asp',
      metadatos: { fuente: 'Bolsa de Cereales y Productos de Bahía Blanca', numero: r ? Number(r[1]) : null,
        licencia: 'INTERNO (decisión del maker 13/10/2026)' } });
    const local = fechaLocal(D(i, 'iEstacionUltAct'));
    if (!local) { problemas++; continue; }
    lecturas.push({ id, local, v: {
      temp: valor(D(i, 'iSensorTemp')), tmin: valor(D(i, 'iSensorTpMin')), tmax: valor(D(i, 'iSensorTpMax')),
      lluvia_acum: valor(D(i, 'iSensorPpDia')),
      x: { hum: valor(D(i, 'iSensorHum_Rel')), rocio: valor(D(i, 'iSensorPto_Rocio')), presion: valor(D(i, 'iSensorPresion')),
        tmin_en: fechaLocal(D(i, 'iSensorTpMin', 1)), tmax_en: fechaLocal(D(i, 'iSensorTpMax', 1)),
        pp7d: valor(D(i, 'iSensorPp7d')), pp_mes: valor(D(i, 'iSensorPpMes')), pp_anio: valor(D(i, 'iSensorPpAno')) },
    } });
  }
  return { estaciones, lecturas, problemas };
}

export default {
  id: 'bcp', nombre: 'BCP Bahía Blanca (mapa)', proceso: 'interna_bcp_rt',
  redes: { BCP_RT: { pasoMin: 60, extremos: 'consola', lluvia: 'acumulado_consola', eto: false, fuente: 'BCP, MapaG_NvoBCP.asp', url: URL_MAPA, maxEdadH: 12 } },
  leer(obj) {
    const c = parte(obj, 'mapa');
    if (c == null) return [];
    const p = parsearMapa(c);
    return [{ red: 'BCP_RT', estaciones: p.estaciones, lecturas: p.lecturas, problemas: p.problemas }];
  },
};
