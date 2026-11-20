// HN AGRO · estaciones-parseo · Weathercloud público → red WEATHERCLOUD_PUB. INTERNO por CHECK en la base: sus términos
// prohíben el scraping (Paso 0 139, fila 8); la bajada la autorizó el maker el 15/11 para uso interno.
// Lo que guarda la ronda: estaciones-internas/weathercloud/<día ARG>/<HHMM UTC>.json = { leido: ISO, devices: [ [ … ], … ] }
// (ya sólo Argentina). Cada device es un ARRAY. Lo VERIFICADO (por ronda.mjs, que filtra con ellas): [2] = lat,
// [3] = lon, [4] = estado (2 = en línea). Lo demás (id, nombre, instante y variables, en décimas según local) NO está
// visto: por eso FORMATO.verificado = false y, mientras siga así, NO SE GUARDA NADA de Weathercloud: sólo se cuentan los
// devices. Para prenderlo, local mira un device de R2, completa `posiciones` y pone verificado: true.
import { numero, ID_OK, enCajaAR, instante, kmhAms, sumar } from '../lib/comun.mjs';

export const RED = 'WEATHERCLOUD_PUB';
const META = { fuente: 'Weathercloud público', permiso: 'interno' };
export const FORMATO = {
  verificado: false,
  posiciones: { lat: 2, lon: 3, estado: 4,
    /* SIN VERIFICAR (null = no se lee): */ id: null, nombre: null, instante: null,
    temp_c: null, hum_pct: null, viento_ms: null, racha_ms: null, viento_dir_gr: null, presion_hpa: null, lluvia_dia_mm: null },
  escala: { temp_c: 0.1, hum_pct: 1, viento_ms: 0.1, racha_ms: 0.1, viento_dir_gr: 1, presion_hpa: 0.1, lluvia_dia_mm: 0.1 },
  viento_en: 'ms',        // la unidad del viento DESPUÉS de la escala: 'ms' o 'kmh'
  en_linea: 2,
};
const VARS = ['temp_c', 'hum_pct', 'viento_ms', 'racha_ms', 'viento_dir_gr', 'presion_hpa', 'lluvia_dia_mm'];

export function crear(formato = FORMATO) {
  const p = formato.posiciones;
  return {
    id: 'weathercloud', red: RED,
    leer(obj) {
      const descartadas = {}; const estaciones = [], lecturas = [];
      const devs = Array.isArray(obj?.devices) ? obj.devices : [];
      const leido = instante(obj?.leido);
      for (const dev of devs) {
        if (!Array.isArray(dev)) { sumar(descartadas, 'no_es_device'); continue; }
        if (!formato.verificado || p.id == null) { sumar(descartadas, 'formato_sin_verificar'); continue; }
        const id = dev[p.id] == null ? '' : String(dev[p.id]);
        if (!ID_OK.test(id)) { sumar(descartadas, 'sin_id'); continue; }
        const lat = numero(dev[p.lat]), lon = numero(dev[p.lon]);
        const ok = enCajaAR(lat, lon);
        estaciones.push({ estacion_id: id, nombre: p.nombre != null && typeof dev[p.nombre] === 'string' ? dev[p.nombre].trim().slice(0, 80) || null : null,
          lat: ok ? lat : null, lon: ok ? lon : null, fuente_ubicacion: 'mapa de Weathercloud', precision_ubicacion: 'declarada por el dueño',
          activa: dev[p.estado] === formato.en_linea, metadatos: { ...META } });
        if (dev[p.estado] !== formato.en_linea) { sumar(descartadas, 'fuera_de_linea'); continue; }
        /* sin la posición del instante, la hora es la de la ronda (el mapa da el último dato) */
        const t = p.instante != null ? instante(dev[p.instante]) : leido;
        if (t == null) { sumar(descartadas, 'sin_instante'); continue; }
        const l = { estacion_id: id, instante: t, tipo: 'instantanea', crudo: {} };
        for (const k of VARS) {
          const x = p[k] == null ? null : numero(dev[p[k]]);
          let v = x == null ? null : x * (formato.escala[k] ?? 1);
          if (v != null && (k === 'viento_ms' || k === 'racha_ms') && formato.viento_en === 'kmh') v = kmhAms(v);
          l[k] = v;
        }
        lecturas.push(l);
      }
      return { red: RED, estaciones, lecturas, descartadas };
    },
  };
}

export default crear();
