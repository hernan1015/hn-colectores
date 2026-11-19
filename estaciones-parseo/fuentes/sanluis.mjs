// HN AGRO · estaciones-parseo · San Luis, REM (clima.sanluis.gob.ar) → red REM_SL. INTERNO (Paso 0 139: no publica términos).
// La ronda guarda la parte «mapa» (InfoEstaciones.aspx): la página trae, en un literal de JavaScript,
//   vEstaciones = [[id, nombre, lat, lon, new Date(ms UTC), temperatura °C, lluvia, subred, …], …]
// · subred 'REM' (meteorológicas), 'SLA' (hidrometría) y 'PRONO' (puntos de pronóstico: NO son estaciones, afuera);
// · la lluvia no dice de qué período es → crudo; la lluvia queda NULL.
// El literal se lee como DATOS: «new Date(n)» pasa a n y se parsea como JSON. Nunca se ejecuta código de la página.
import { numero, parte, enCajaAR, ID_OK, sumar } from '../lib/comun.mjs';

export const RED = 'REM_SL';
export const MARCA = 'vEstaciones';
const META = { fuente: 'REM San Luis', permiso: 'interno' };
const vacio = (motivo) => ({ red: RED, estaciones: [], lecturas: [], descartadas: { [motivo]: 1 } });

/** El literal vEstaciones → arreglo de arreglos, o null. */
export function literal(html) {
  const i = html.indexOf(MARCA);
  if (i < 0) return null;
  const ini = html.indexOf('[', i);
  if (ini < 0) return null;
  let prof = 0, fin = -1, enTexto = false, esc = false;
  for (let k = ini; k < html.length && k < ini + 1e6; k++) {
    const c = html[k];
    if (enTexto) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') enTexto = false; continue; }
    if (c === '"') enTexto = true;
    else if (c === '[') prof++;
    else if (c === ']') { prof--; if (prof === 0) { fin = k; break; } }
  }
  if (fin < 0) return null;
  try {
    const a = JSON.parse(html.slice(ini, fin + 1).replace(/new Date\((-?\d{1,15})\)/g, '$1'));
    return Array.isArray(a) && a.every(Array.isArray) ? a : null;
  } catch { return null; }
}

export function leer(obj) {
  const c = parte(obj, 'mapa');
  if (c == null) return vacio('sin_parte');
  const a = literal(c);
  if (!a) return vacio('formato_cambiado');
  const estaciones = [], lecturas = [], descartadas = {};
  for (const x of a) {
    if (x.length < 8) { sumar(descartadas, 'fila_corta'); continue; }
    const [idN, nombre, latN, lonN, ms, temp, lluvia, subred] = x;
    if (subred === 'PRONO') { sumar(descartadas, 'pronostico'); continue; }
    const id = String(idN ?? '');
    if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    const lat = numero(latN), lon = numero(lonN);
    const ok = enCajaAR(lat, lon);
    estaciones.push({ estacion_id: id, nombre: typeof nombre === 'string' ? nombre.trim() || null : null, provincia: 'San Luis',
      lat: ok ? lat : null, lon: ok ? lon : null, fuente_ubicacion: 'REM San Luis (InfoEstaciones.aspx)',
      precision_ubicacion: 'declarada por la red', metadatos: { ...META, subred: typeof subred === 'string' ? subred.slice(0, 10) : null } });
    if (typeof ms !== 'number' || !Number.isFinite(ms)) { sumar(descartadas, 'sin_instante'); continue; }
    const crudo = {};
    const pp = numero(lluvia); if (pp != null) crudo.lluvia = pp;
    lecturas.push({ estacion_id: id, instante: ms, tipo: 'instantanea', temp_c: numero(temp), crudo });
  }
  return { red: RED, estaciones, lecturas, descartadas };
}

export default { id: 'sanluis', red: RED, leer };
