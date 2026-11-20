// HN AGRO · estaciones-parseo · EEAOC Tucumán (agromet) → red EEAOC. INTERNO (Paso 0 139: «Todos los derechos reservados»).
// La ronda guarda la parte «estaciones» (services/estaciones.php): una lista con TODAS las estaciones y su última
// lectura: fecha_I ('AAAA-MM-DD HH:MM:SS', hora argentina), temp_af (°C), hum_af (%), RR_dia (lluvia acumulada del día,
// mm; la hora de corte no está publicada), presion (hPa; 10000 = sin dato), viento_medio / viento_max (unidad SIN
// confirmar: van a crudo, no a viento_ms). También guarda «datos» (datos-online.php): no se usa (formato no visto).
import { numero, numeroConUnidad, parte, enCajaAR, ID_OK, desdeLocal, sumar } from '../lib/comun.mjs';

export const RED = 'EEAOC';
const META = { fuente: 'EEAOC agromet', permiso: 'interno' };
const OBLIGATORIAS = ['id', 'nombre', 'lat', 'lon', 'fecha_I', 'temp_af', 'hum_af', 'RR_dia'];
const local = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || '')); return m ? `${m[1]}T${m[2]}` : null; };
const vacio = (motivo) => ({ red: RED, estaciones: [], lecturas: [], descartadas: { [motivo]: 1 } });

export function leer(obj) {
  const c = parte(obj, 'estaciones');
  if (c == null) return vacio('sin_parte');
  let a;
  try { a = JSON.parse(c); } catch { return vacio('no_es_json'); }
  // [19/11] la primera corrida real dio formato_cambiado en las 8 rondas (con la muestra del 15/11 anda). Más tolerante:
  // la lista puede venir envuelta ({ data | estaciones | rows: [...] }) y las claves se buscan en TODAS las estaciones
  // (una estación parada puede venir sin algunas). Si igual no cierra, se anotan los NOMBRES de las claves que vinieron.
  if (a && !Array.isArray(a) && typeof a === 'object') a = [a.data, a.estaciones, a.rows].find(Array.isArray) ?? a;
  const vistas = {};
  if (Array.isArray(a)) for (const x of a.slice(0, 200)) if (x && typeof x === 'object') for (const k of Object.keys(x)) vistas[k] = true;
  if (!Array.isArray(a) || !a.length || OBLIGATORIAS.some((k) => !vistas[k])) {
    const claves_vistas = {};
    const origen = Array.isArray(a) ? Object.keys(vistas) : a && typeof a === 'object' ? Object.keys(a) : ['_' + (Array.isArray(a) ? 'lista_vacia' : typeof a)];
    for (const k of origen.slice(0, 40)) if (/^[A-Za-z_]{1,40}$/.test(k)) claves_vistas[k] = 1;
    return { ...vacio('formato_cambiado'), claves_vistas };
  }
  const estaciones = [], lecturas = [], descartadas = {};
  for (const x of a) {
    const id = String(x.id ?? '').trim();
    if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    const lat = numero(x.lat), lon = numero(x.lon);
    const ok = enCajaAR(lat, lon);
    estaciones.push({ estacion_id: id, nombre: String(x.nombre || '').trim() || null, partido: x.departamento || null,
      provincia: x.provincia || null, lat: ok ? lat : null, lon: ok ? lon : null,
      fuente_ubicacion: 'EEAOC agromet (estaciones.php)', precision_ubicacion: 'declarada por la red', metadatos: { ...META } });
    const t = desdeLocal(local(x.fecha_I));
    if (!Number.isFinite(t)) { sumar(descartadas, 'sin_instante'); continue; }
    const crudo = {};
    for (const k of ['viento_medio', 'viento_max']) { const v = numeroConUnidad(x[k]); if (v != null) crudo[k] = v; }
    lecturas.push({ estacion_id: id, instante: t, tipo: 'instantanea',
      temp_c: numero(x.temp_af), hum_pct: numero(x.hum_af), lluvia_dia_mm: numero(x.RR_dia),
      presion_hpa: numero(x.presion, { centinelas: [10000] }), crudo });
  }
  return { red: RED, estaciones, lecturas, descartadas };
}

export default { id: 'eeaoc', red: RED, leer };
