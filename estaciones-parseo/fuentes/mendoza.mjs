// HN AGRO · estaciones-parseo · Mendoza, DACC (agrometeo) → red DACC_MZA. INTERNO (Paso 0 139: no publica términos).
// La ronda guarda la parte «instantaneas» (api/todas_instantaneas.json): una lista con la última lectura de cada
// estación: estacion (id), Nombre, lat, lng, fechaIngles ('AAAA-MM-DD HH:MM:SS', hora argentina), tempAire (°C),
// humedad (%), direccionViento (°; 999.9 = sin dato), velocidadViento (unidad SIN confirmar → crudo) y precipitacion
// (no dice de qué período es → crudo; la lluvia queda NULL).
import { numero, parte, enCajaAR, ID_OK, desdeLocal, sumar } from '../lib/comun.mjs';

export const RED = 'DACC_MZA';
const META = { fuente: 'DACC Mendoza agrometeo', permiso: 'interno' };
const OBLIGATORIAS = ['estacion', 'Nombre', 'lat', 'lng', 'fechaIngles', 'tempAire', 'humedad'];
const local = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || '')); return m ? `${m[1]}T${m[2]}` : null; };
const vacio = (motivo) => ({ red: RED, estaciones: [], lecturas: [], descartadas: { [motivo]: 1 } });

export function leer(obj) {
  const c = parte(obj, 'instantaneas');
  if (c == null) return vacio('sin_parte');
  let a;
  try { a = JSON.parse(c); } catch { return vacio('no_es_json'); }
  if (!Array.isArray(a) || !a.length || OBLIGATORIAS.some((k) => !(k in a[0]))) return vacio('formato_cambiado');
  const estaciones = [], lecturas = [], descartadas = {};
  for (const x of a) {
    const id = String(x.estacion ?? '').trim();
    if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    const lat = numero(x.lat), lon = numero(x.lng);
    const ok = enCajaAR(lat, lon);
    estaciones.push({ estacion_id: id, nombre: String(x.Nombre || '').trim() || null, provincia: 'Mendoza',
      lat: ok ? lat : null, lon: ok ? lon : null, fuente_ubicacion: 'DACC agrometeo (todas_instantaneas.json)',
      precision_ubicacion: 'declarada por la red', metadatos: { ...META } });
    const t = desdeLocal(local(x.fechaIngles));
    if (!Number.isFinite(t)) { sumar(descartadas, 'sin_instante'); continue; }
    const crudo = {};
    const vel = numero(x.velocidadViento, { centinelas: [999.9] }); if (vel != null) crudo.velocidadViento = vel;
    const pp = numero(x.precipitacion); if (pp != null) crudo.precipitacion = pp;
    lecturas.push({ estacion_id: id, instante: t, tipo: 'instantanea', temp_c: numero(x.tempAire), hum_pct: numero(x.humedad),
      viento_dir_gr: numero(x.direccionViento, { centinelas: [999.9] }), crudo });
  }
  return { red: RED, estaciones, lecturas, descartadas };
}

export default { id: 'mendoza', red: RED, leer };
