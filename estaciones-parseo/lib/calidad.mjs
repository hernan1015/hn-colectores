// HN AGRO · estaciones-parseo · LAS REGLAS DE CALIDAD de la 139, iguales para las 9 fuentes:
//   · LA REGLA DE LAS 12 H: una lectura instantánea de más de 12 h antes de cuando la leyó la ronda no entra (una consola
//     parada repite su último dato). Los REGISTROS de un archivo de consola (Entre Ríos) o los totales diarios (INA)
//     traen historia: para ellos el tope es de 8 días (lo que hace falta para la serie de 7).
//   · Ninguna lectura de más de 15 min DESPUÉS de cuando se leyó (relojes corridos).
//   · LOS IMPOSIBLES: HR 0 o 255 (o > 100), 50 °C o más, −40 °C o menos, y el viento, la presión y la lluvia fuera de
//     rango → NULL con una marca, y el valor tal como vino a `crudo`. Así no entran en los extremos.
//   · NULL NUNCA ES 0: lo que falta queda null; una lectura sin ninguna variable no se guarda.
//   · IDEMPOTENTE: cada lectura lleva la firma de su contenido; la base no reescribe una fila con la misma firma.
// La base repite las mismas reglas con CHECK (migración 0161): si algo se escapa acá, la fila no entra.
import { createHash } from 'node:crypto';
import { redondear, sumar } from './comun.mjs';

export const HORAS_INSTANTANEA = 12;
export const DIAS_REGISTRO = 8;
export const FUTURO_MS = 15 * 60e3;

export const VARIABLES = ['temp_c', 'hum_pct', 'lluvia_mm', 'lluvia_dia_mm', 'viento_ms', 'racha_ms', 'viento_dir_gr', 'presion_hpa'];
/** Lo posible de cada variable (los extremos, excluidos donde dice). */
export const POSIBLE = Object.freeze({
  temp_c: (x) => x > -40 && x < 50,
  hum_pct: (x) => x > 0 && x <= 100,
  lluvia_mm: (x) => x >= 0 && x < 500,
  lluvia_dia_mm: (x) => x >= 0 && x < 500,
  viento_ms: (x) => x >= 0 && x < 100,
  racha_ms: (x) => x >= 0 && x < 100,
  viento_dir_gr: (x) => x >= 0 && x <= 360,
  presion_hpa: (x) => x >= 850 && x <= 1100,
});
const DECIMALES = { presion_hpa: 1, viento_dir_gr: 1 };
const MARCA = { temp_c: 'temp_imposible', hum_pct: 'hum_imposible', lluvia_mm: 'lluvia_imposible', lluvia_dia_mm: 'lluvia_dia_imposible',
  viento_ms: 'viento_imposible', racha_ms: 'racha_imposible', viento_dir_gr: 'dir_imposible', presion_hpa: 'presion_imposible' };

/** La edad: ¿entra la lectura? → null si entra, o el motivo ('futura', 'vieja_12h', 'vieja_8d', 'sin_instante'). */
export function motivoEdad(l, leidoMs) {
  if (!Number.isFinite(l.instante)) return 'sin_instante';
  if (!Number.isFinite(leidoMs)) return 'ronda_sin_hora';
  if (l.instante > leidoMs + FUTURO_MS) return 'futura';
  const tope = l.tipo === 'registro' ? DIAS_REGISTRO * 864e5 : HORAS_INSTANTANEA * 3600e3;
  if (l.instante < leidoMs - tope) return l.tipo === 'registro' ? 'vieja_8d' : 'vieja_12h';
  return null;
}

/** Los imposibles → null + marca + crudo. Redondea. Devuelve la lectura limpia (copia) y cuántos imposibles hubo. */
export function controlar(l) {
  const out = { ...l, marcas: [...(l.marcas || [])], crudo: { ...(l.crudo || {}) } };
  let imposibles = 0;
  for (const k of VARIABLES) {
    const v = out[k];
    if (v == null) { out[k] = null; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || !POSIBLE[k](v)) {
      out.marcas.push(MARCA[k]);
      out.crudo[k] = typeof v === 'number' && Number.isFinite(v) ? v : String(v).slice(0, 20);
      out[k] = null;
      imposibles++;
      continue;
    }
    out[k] = redondear(v, DECIMALES[k] ?? 2);
  }
  if (out.lluvia_mm == null) out.lluvia_periodo_min = null;
  else if (!(Number.isInteger(out.lluvia_periodo_min) && out.lluvia_periodo_min >= 1 && out.lluvia_periodo_min <= 1440)) {
    out.marcas.push('lluvia_sin_periodo');
    out.crudo.lluvia_mm = out.lluvia_mm;
    out.lluvia_mm = null;
    out.lluvia_periodo_min = null;
  }
  out.marcas = [...new Set(out.marcas)].sort();
  return { lectura: out, imposibles };
}

export const conDatos = (l) => VARIABLES.some((k) => l[k] != null);

/** La firma del CONTENIDO de una lectura (no cuenta cuándo se leyó). */
export function firmaLectura(l) {
  const base = { i: l.instante, m: l.marcas, c: l.crudo, p: l.lluvia_periodo_min ?? null };
  for (const k of VARIABLES) base[k] = l[k] ?? null;
  return createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 32);
}
export function firmaEstacion(e) {
  const { estacion_id, nombre, partido, provincia, lat, lon, precision_ubicacion, fuente_ubicacion, activa, metadatos } = e;
  return createHash('sha256').update(JSON.stringify({ estacion_id, nombre, partido, provincia, lat, lon, precision_ubicacion,
    fuente_ubicacion, activa, metadatos })).digest('hex').slice(0, 32);
}

/** Todas las reglas sobre las lecturas de una red. `leidoMs` es el `leido` de la ronda.
 *  → { lecturas (limpias, con firma, deduplicadas por estación e instante), descartadas: { motivo: n }, imposibles } */
export function limpiar(lecturas, leidoMs, descartadas = {}) {
  const buenas = new Map(); let imposibles = 0;
  for (const l0 of lecturas) {
    const motivo = motivoEdad(l0, leidoMs);
    if (motivo) { sumar(descartadas, motivo); continue; }
    const { lectura: l, imposibles: n } = controlar(l0);
    imposibles += n;
    if (!conDatos(l)) { sumar(descartadas, 'sin_variables'); continue; }
    l.leido_en = leidoMs;
    l.firma = firmaLectura(l);
    const k = l.estacion_id + '|' + l.instante;
    const v = buenas.get(k);
    if (v) sumar(descartadas, 'repetida');
    if (!v || VARIABLES.filter((x) => l[x] != null).length >= VARIABLES.filter((x) => v[x] != null).length) buenas.set(k, l);
  }
  return { lecturas: [...buenas.values()], descartadas, imposibles };
}
