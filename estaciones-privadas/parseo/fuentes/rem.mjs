// HN AGRO · 139 interna · San Luis, Red de Estaciones Meteorológicas (REM): clima.sanluis.gob.ar. Red `REM_SL`.
// USO INTERNO (mostrar = false). Términos: no publica (Paso 0 de la 139, 13/11).
// Parser escrito desde cero mirando la fuente original; la descarga es de ronda.mjs (local), acá sólo se lee R2 (15/11: UN pedido a InfoEstaciones.aspx).
//
// Lo que guarda la ronda: la página `InfoEstaciones.aspx` trae, en un literal de JavaScript, TODAS las estaciones con su
// última lectura: vEstaciones = [[id, nombre, lat, lon, new Date(ms UTC), temperatura °C, lluvia, red, …], …].
//   · red 'REM' (las meteorológicas), 'SLA' (hidrometría de San Luis Agua: casi todas sin temperatura) y 'PRONO'
//     (puntos de pronóstico con fecha del año 2000: NO son estaciones, se descartan).
//   · el campo de lluvia no dice de qué período es: va SÓLO al crudo; la lluvia del día queda NULL hasta confirmarlo.
// El literal se lee como DATOS (se cambia «new Date(n)» por n y se parsea como JSON): nunca se ejecuta código de la
// página. Si la parte no trae el literal (una página de desafío o de error), esa ronda se salta y no se guarda nada.
// (La ronda no pide las páginas de cada estación, Estacion.aspx?Estacion=id.)
import { numero } from '../lib/diario.mjs';
import { localDe } from '../lib/hora.mjs';

export const URL_INFO = 'https://clima.sanluis.gob.ar/InfoEstaciones.aspx';
export const MARCA = 'vEstaciones';

/** El literal vEstaciones → arreglo. Lanza si no está o no es una lista de listas. */
export function literal(html) {
  const i = html.indexOf(MARCA);
  if (i < 0) throw new Error('rem: no está vEstaciones');
  const ini = html.indexOf('[', i);
  let prof = 0, fin = -1, enTexto = false, esc = false;
  for (let k = ini; k < html.length && k < ini + 500000; k++) {
    const c = html[k];
    if (enTexto) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') enTexto = false; continue; }
    if (c === '"') enTexto = true;
    else if (c === '[') prof++;
    else if (c === ']') { prof--; if (prof === 0) { fin = k; break; } }
  }
  if (ini < 0 || fin < 0) throw new Error('rem: vEstaciones sin cerrar');
  const json = html.slice(ini, fin + 1).replace(/new Date\((-?\d{1,15})\)/g, '$1');
  const a = JSON.parse(json);
  if (!Array.isArray(a) || !a.length || !a.every(Array.isArray)) throw new Error('rem: vEstaciones no es una lista de listas');
  return a;
}

export function parsear(html) {
  const a = literal(html);
  const estaciones = []; const lecturas = []; let problemas = 0; let pronostico = 0;
  for (const x of a) {
    if (x.length < 8) { problemas++; continue; }
    const [idN, nombre, latN, lonN, ms, temp, lluvia, red] = x;
    if (red === 'PRONO') { pronostico++; continue; }
    const id = String(idN ?? '');
    if (!/^\d{1,6}$/.test(id) || typeof nombre !== 'string') { problemas++; continue; }
    const lat = numero(latN), lon = numero(lonN);
    estaciones.push({
      estacion_id: id, nombre: nombre.trim(), provincia: 'San Luis',
      lat: lat != null && lat > -56 && lat < -21 ? lat : null, lon: lon != null && lon > -75 && lon < -53 ? lon : null,
      fuente_ubicacion: 'REM San Luis, InfoEstaciones.aspx',
      metadatos: { fuente: 'REM San Luis', subred: typeof red === 'string' ? red : null, licencia: 'sin términos publicados: INTERNO' },
    });
    const l = typeof ms === 'number' ? localDe(ms) : null;
    if (!l) { problemas++; continue; }
    lecturas.push({ id, local: l, v: { temp: numero(temp), x: { lluvia: numero(lluvia), subred: red } } });
  }
  return { estaciones, lecturas, problemas, pronostico };
}

import { parte } from '../lib/crudo.mjs';

/** R2 estaciones-internas/sanluis/<día>/<HHMM>.json, parte «mapa». ⚠ La ronda guarda el cuerpo con r.text() (UTF-8) y la
 *  página viene en Windows-1252: las tildes y eñes de los NOMBRES llegan como «�». Los números no se ven afectados. */
export default {
  id: 'sanluis', nombre: 'REM San Luis', proceso: 'interna_rem_sl',
  redes: { REM_SL: { pasoMin: 60, extremos: 'muestreados', lluvia: null, eto: false, fuente: 'REM San Luis', url: URL_INFO, maxEdadH: 12 } },
  leer(obj) {
    const c = parte(obj, 'mapa');
    if (c == null || !c.includes(MARCA)) return [];
    const p = parsear(c);
    return [{ red: 'REM_SL', estaciones: p.estaciones, lecturas: p.lecturas, problemas: p.problemas }];
  },
};
