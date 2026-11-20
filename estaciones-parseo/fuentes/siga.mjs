// HN AGRO · estaciones-parseo · INTA SIGA, tiempo real → red SIGA_RT. INTERNO (Paso 0 139: términos no leídos).
// La ronda guarda la parte «estaciones»: la respuesta de URL_MYSQL_ESTACION_AUTOMATICA (js/urlserver.js). Es una lista
// de estaciones con id, nombre, provincia, latitud, longitud, idTipo, visible y, las automáticas, su última lectura:
// fecha (ISO en UTC, con «Z[UTC]»), temperatura (°C), humedad (%) y precipitacion (no dice de qué período → crudo).
import { numero, parte, enCajaAR, ID_OK, instante, sumar } from '../lib/comun.mjs';

export const RED = 'SIGA_RT';
const META = { fuente: 'INTA SIGA', permiso: 'interno' };
/* la hora de la última lectura: «fecha» en la muestra del 15/11; las otras, por si el listado la nombra distinto */
const CAMPO_FECHA = ['fecha', 'fechaHora', 'fecha_hora', 'ultimaFecha', 'ultimoDato'];
const vacio = (motivo) => ({ red: RED, estaciones: [], lecturas: [], descartadas: { [motivo]: 1 } });

export function leer(obj) {
  const c = parte(obj, 'estaciones');
  if (c == null) return vacio('sin_parte');
  let a;
  try { a = JSON.parse(c); } catch { return vacio('no_es_json'); }
  if (!Array.isArray(a) || (a.length && !(a[0] && 'id' in a[0] && 'latitud' in a[0]))) return vacio('formato_cambiado');
  const estaciones = [], lecturas = [], descartadas = {}, claves_vistas = {};
  for (const x of a) {
    const id = String(x?.id ?? '').trim();
    if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    // [19/11] `visible` es la marca del MAPA del SIGA, no de si la estación mide: en la primera corrida real las 141
    // visibles no trajeron ninguna lectura y se descartaron 253 «no visibles» por ronda. Se guardan todas (son de uso
    // interno igual) y se anota la marca; sólo quedan afuera las de prueba (localidad «loc_prueba»).
    if (x.localidad === 'loc_prueba') { sumar(descartadas, 'de_prueba'); continue; }
    const lat = numero(x.latitud), lon = numero(x.longitud);
    const ok = enCajaAR(lat, lon);
    estaciones.push({ estacion_id: id, nombre: x.nombre || null, provincia: x.provincia || null, lat: ok ? lat : null, lon: ok ? lon : null,
      fuente_ubicacion: 'INTA SIGA (listado de automáticas)', precision_ubicacion: 'declarada por la red',
      metadatos: { ...META, tipo: typeof x.tipo === 'string' ? x.tipo.slice(0, 40) : null, visible_en_siga: x.visible !== false } });
    const f = CAMPO_FECHA.map((k) => x[k]).find((v) => v != null);
    if (f == null) {                                   // las convencionales no traen lectura: se cuenta y se anotan las claves
      sumar(descartadas, 'sin_fecha');
      for (const k of Object.keys(x).slice(0, 30)) if (/^[A-Za-z_]{1,40}$/.test(k)) sumar(claves_vistas, k);
      continue;
    }
    const t = instante(f);
    if (t == null) { sumar(descartadas, 'sin_instante'); continue; }
    const crudo = {};
    const pp = numero(x.precipitacion); if (pp != null) crudo.precipitacion = pp;
    lecturas.push({ estacion_id: id, instante: t, tipo: 'instantanea', temp_c: numero(x.temperatura), hum_pct: numero(x.humedad), crudo });
  }
  return { red: RED, estaciones, lecturas, descartadas, claves_vistas };
}

export default { id: 'siga', red: RED, leer };
