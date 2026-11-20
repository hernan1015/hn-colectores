// HN AGRO · estaciones-parseo · INTA SIGA, tiempo real → red SIGA_RT. INTERNO (Paso 0 139: términos no leídos).
// La ronda guarda la parte «estaciones»: la respuesta de URL_MYSQL_ESTACION_AUTOMATICA (js/urlserver.js). Es una lista
// de estaciones con id, nombre, provincia, latitud, longitud, idTipo, visible y, las automáticas, su última lectura:
// fecha (ISO en UTC, con «Z[UTC]»), temperatura (°C), humedad (%) y precipitacion (no dice de qué período → crudo).
import { numero, parte, enCajaAR, ID_OK, instante, sumar } from '../lib/comun.mjs';

export const RED = 'SIGA_RT';
const META = { fuente: 'INTA SIGA', permiso: 'interno' };
const vacio = (motivo) => ({ red: RED, estaciones: [], lecturas: [], descartadas: { [motivo]: 1 } });

export function leer(obj) {
  const c = parte(obj, 'estaciones');
  if (c == null) return vacio('sin_parte');
  let a;
  try { a = JSON.parse(c); } catch { return vacio('no_es_json'); }
  if (!Array.isArray(a) || (a.length && !(a[0] && 'id' in a[0] && 'latitud' in a[0]))) return vacio('formato_cambiado');
  const estaciones = [], lecturas = [], descartadas = {};
  for (const x of a) {
    const id = String(x?.id ?? '').trim();
    if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    if (x.visible === false) { sumar(descartadas, 'no_visible'); continue; }
    const lat = numero(x.latitud), lon = numero(x.longitud);
    const ok = enCajaAR(lat, lon);
    estaciones.push({ estacion_id: id, nombre: x.nombre || null, provincia: x.provincia || null, lat: ok ? lat : null, lon: ok ? lon : null,
      fuente_ubicacion: 'INTA SIGA (listado de automáticas)', precision_ubicacion: 'declarada por la red',
      metadatos: { ...META, tipo: typeof x.tipo === 'string' ? x.tipo.slice(0, 40) : null } });
    if (x.fecha == null) continue;                     // las convencionales no traen lectura
    const t = instante(x.fecha);
    if (t == null) { sumar(descartadas, 'sin_instante'); continue; }
    const crudo = {};
    const pp = numero(x.precipitacion); if (pp != null) crudo.precipitacion = pp;
    lecturas.push({ estacion_id: id, instante: t, tipo: 'instantanea', temp_c: numero(x.temperatura), hum_pct: numero(x.humedad), crudo });
  }
  return { red: RED, estaciones, lecturas, descartadas };
}

export default { id: 'siga', red: RED, leer };
