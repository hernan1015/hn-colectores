// HN AGRO · 139 interna · Mendoza, Dirección de Agricultura y Contingencias Climáticas (DACC): agrometeo.mendoza.gov.ar.
// Red `DACC_MZA`. USO INTERNO (mostrar = false). Términos: no publica (Paso 0 de la 139, 13/11).
// Parser escrito desde cero mirando la fuente original; la descarga es de ronda.mjs (local), acá sólo se lee R2 (15/11: UN pedido a api/todas_instantaneas.json).
//
// Lo que guarda la ronda: `api/todas_instantaneas.json` trae las 60 estaciones con su última lectura:
//   fechaIngles ('AAAA-MM-DD HH:MM:SS', hora local), tempAire (°C), humedad (%), precipitacion, velocidadViento,
//   direccionViento (°), puntoRocio, bateria, atraso / atraso_max (min). El archivo se rehace todo el tiempo
//   (Last-Modified = la hora del pedido), pero cada estación transmite cada ~15 min: con una vuelta por hora alcanza.
// tmin/tmax MUESTREADOS (muestreo_min = 60). La «precipitacion» no dice si es del registro, de la hora o del día:
// va SÓLO al crudo y la lluvia del día queda NULL hasta confirmarlo. Viento: 999.9 = sin dato; unidad sin confirmar.
import { numero } from '../lib/diario.mjs';

export const URL_INSTANTANEAS = 'https://agrometeo.mendoza.gov.ar/api/todas_instantaneas.json';

const local = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || '')); return m ? `${m[1]}T${m[2]}` : null; };

export function parsear(texto) {
  const a = JSON.parse(texto);
  if (!Array.isArray(a) || !a.length) throw new Error('dacc: no es una lista de estaciones');
  const faltan = ['estacion', 'Nombre', 'lat', 'lng', 'fechaIngles', 'tempAire', 'humedad'].filter((k) => !(k in a[0]));
  if (faltan.length) throw new Error('dacc: formato cambiado, faltan ' + faltan.join(','));
  const estaciones = []; const lecturas = []; let problemas = 0;
  for (const x of a) {
    const id = String(x.estacion ?? '').trim();
    if (!/^\d{1,6}$/.test(id)) { problemas++; continue; }
    const lat = numero(x.lat), lon = numero(x.lng);
    estaciones.push({
      estacion_id: id, nombre: String(x.Nombre || '').trim() || null, provincia: 'Mendoza',
      lat: lat != null && lat > -56 && lat < -21 ? lat : null, lon: lon != null && lon > -75 && lon < -53 ? lon : null,
      fuente_ubicacion: 'DACC agrometeo, api/todas_instantaneas.json',
      metadatos: { fuente: 'DACC Mendoza agrometeo', alt_m: numero(x.Altura), web: x.web ?? null, atraso_max_min: numero(x.atraso_max),
        licencia: 'sin términos publicados: INTERNO' },
    });
    const l = local(x.fechaIngles);
    if (!l) { problemas++; continue; }
    lecturas.push({ id, local: l, v: {
      temp: numero(x.tempAire), hum: numero(x.humedad),
      x: { precipitacion: numero(x.precipitacion), viento: numero(x.velocidadViento, { centinelas: [999.9] }),
        dir: numero(x.direccionViento, { centinelas: [999.9] }), rocio: numero(x.puntoRocio), bateria: numero(x.bateria), atraso_min: numero(x.atraso) },
    } });
  }
  return { estaciones, lecturas, problemas };
}

import { parte } from '../lib/crudo.mjs';

/** R2 estaciones-internas/mendoza/<día>/<HHMM>.json, parte «instantaneas». */
export default {
  id: 'mendoza', nombre: 'DACC Mendoza (agrometeo)', proceso: 'interna_dacc_mza',
  redes: { DACC_MZA: { pasoMin: 60, extremos: 'muestreados', lluvia: null, eto: false, fuente: 'DACC Mendoza agrometeo', url: URL_INSTANTANEAS, maxEdadH: 12 } },
  leer(obj) {
    const c = parte(obj, 'instantaneas');
    if (c == null) return [];
    const p = parsear(c);
    return [{ red: 'DACC_MZA', estaciones: p.estaciones, lecturas: p.lecturas, problemas: p.problemas }];
  },
};
