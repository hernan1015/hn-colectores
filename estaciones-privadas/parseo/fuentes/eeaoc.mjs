// HN AGRO · 139 interna · EEAOC (Tucumán): agromet.eeaoc.gob.ar. Red `EEAOC`. USO INTERNO (mostrar = false).
// Términos: no publica; el pie de eeaoc.gob.ar dice «Todos los derechos reservados» (Paso 0 de la 139, 13/11).
// Parser escrito desde cero mirando la fuente original; la descarga es de ronda.mjs (local), acá sólo se lee R2 (15/11: UN pedido a services/estaciones.php).
//
// Lo que guarda la ronda: `services/estaciones.php` devuelve TODAS las estaciones (61 el 15/11) con su última lectura:
//   fecha_I ('AAAA-MM-DD HH:MM:SS', hora local), temp_af (°C), hum_af (%), RR_dia (lluvia acumulada del día, mm),
//   rr_15, rr_mes, presion (hPa; 10000.0 = sin dato), viento_medio / viento_max (unidad sin confirmar), tiempo (min
//   entre registros: 15), habilitada (0/1/2/3/6, sin documentar).
// Una lectura por ronda (cada hora): tmin/tmax son MUESTREADOS (muestreo_min = 60) y la lluvia es el mayor acumulado
// del día (RR_dia). La hora del corte de RR_dia no está publicada: si el acumulado BAJA dentro del día, la lluvia del
// día queda NULL (ver diario.mjs). Las lecturas viejas (estaciones paradas desde 2019…) y las del futuro (relojes
// corridos: el 15/11 una venía 50 min adelantada y con 1802,6 °C) se descartan.
import { numero } from '../lib/diario.mjs';

export const URL_ESTACIONES = 'https://agromet.eeaoc.gob.ar/services/estaciones.php';

const local = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || '')); return m ? `${m[1]}T${m[2]}` : null; };

/** El JSON de estaciones.php → { estaciones, lecturas, problemas }. Lanza si la forma no es la esperada. */
export function parsear(texto) {
  const a = JSON.parse(texto);
  if (!Array.isArray(a) || !a.length) throw new Error('eeaoc: no es una lista de estaciones');
  const faltan = ['id', 'nombre', 'lat', 'lon', 'fecha_I', 'temp_af', 'hum_af', 'RR_dia'].filter((k) => !(k in a[0]));
  if (faltan.length) throw new Error('eeaoc: formato cambiado, faltan ' + faltan.join(','));
  const estaciones = []; const lecturas = []; let problemas = 0;
  for (const x of a) {
    const id = String(x.id ?? '').trim();
    if (!/^\d{1,6}$/.test(id)) { problemas++; continue; }
    const lat = numero(x.lat), lon = numero(x.lon);
    estaciones.push({
      estacion_id: id, nombre: String(x.nombre || '').trim() || null, partido: x.departamento || null, provincia: x.provincia || null,
      lat: lat != null && lat > -56 && lat < -21 ? lat : null, lon: lon != null && lon > -75 && lon < -53 ? lon : null,
      fuente_ubicacion: 'EEAOC agromet, services/estaciones.php',
      metadatos: { fuente: 'EEAOC agromet', identificacion: x.Identificacion ?? null, marca: x.marca ?? null, alt_m: numero(x.alt),
        habilitada: x.habilitada ?? null, desde: x.desde ?? null, paso_min: numero(x.tiempo), localidad: x.Localidad ?? null,
        licencia: 'sin términos publicados («Todos los derechos reservados»): INTERNO' },
    });
    const l = local(x.fecha_I);
    if (!l) { problemas++; continue; }
    lecturas.push({ id, local: l, v: {
      temp: numero(x.temp_af), hum: numero(x.hum_af), lluvia_acum: numero(x.RR_dia),
      x: { presion: numero(x.presion, { centinelas: [10000] }), viento_medio: numero(x.viento_medio), viento_max: numero(x.viento_max),
        dir: x.direc ?? null, rr_15: numero(x.rr_15), rr_mes: numero(x.rr_mes) },
    } });
  }
  return { estaciones, lecturas, problemas };
}

import { parte } from '../lib/crudo.mjs';

/** Un objeto de la ronda (R2 estaciones-internas/eeaoc/<día>/<HHMM>.json) → lo que va a la base. datos-online.php queda en el crudo de R2. */
export default {
  id: 'eeaoc', nombre: 'EEAOC agromet (Tucumán)', proceso: 'interna_eeaoc',
  redes: { EEAOC: { pasoMin: 60, extremos: 'muestreados', lluvia: 'acumulado_consola', eto: false, fuente: 'EEAOC agromet', url: URL_ESTACIONES, maxEdadH: 12 } },
  leer(obj) {
    const c = parte(obj, 'estaciones');
    if (c == null) return [];
    const p = parsear(c);
    return [{ red: 'EEAOC', estaciones: p.estaciones, lecturas: p.lecturas, problemas: p.problemas }];
  },
};
