// HN AGRO · parseo de estaciones internas · lecturas sueltas → filas de estaciones_obs (COMÚN a todas las fuentes).
//
// IDEMPOTENTE por construcción: cada corrida vuelve a armar los días objetivo desde TODO el crudo de R2 de esos días,
// y deduplica por (estación, instante). Correrlo dos veces, o con archivos repetidos, da las mismas filas.
//
// Una lectura: { id, instante (ms), temp_c, hum_pct, viento_ms, racha_ms, viento_dir_gr, presion_hpa, lluvia_dia_mm,
//                marcas: [] }.
// El día (0110/0147): `fecha` = día local de Argentina (UTC−3), corte 00:00.
//   tmin_c / tmax_c       el menor / mayor MUESTREADO (muestreo_min = cada cuánto se lee: la mínima real puede ser menor)
//   registros_validos     lecturas con temperatura · registros_esperados = 1440 / muestreo (se estira si hay más)
//   tmin_noche_c / _en    la mínima de (fecha−1 18:00, fecha 09:00] y cuándo fue · noche_registros / noche_esperados
//   lluvia_mm             la lluvia del día como la acumula la consola: la de la ÚLTIMA lectura del día con dato
//                         (lluvia_origen 'acumulado_consola'). Sin dato → null (nunca 0).
import { local, sumarDias } from './convertir.mjs';

/** Dedup por (estación, instante): gana la que trae más variables (y, a igualdad, la primera). */
export function deduplicar(lecturas) {
  const m = new Map();
  const llenas = (l) => ['temp_c', 'hum_pct', 'viento_ms', 'presion_hpa', 'lluvia_dia_mm'].filter((k) => l[k] != null).length;
  let repetidas = 0;
  for (const l of lecturas) {
    if (l == null || l.id == null || !Number.isFinite(l.instante)) continue;
    const k = `${l.id}|${l.instante}`;
    const v = m.get(k);
    if (v) { repetidas++; if (llenas(l) > llenas(v)) m.set(k, l); } else m.set(k, l);
  }
  return { lecturas: [...m.values()], repetidas };
}

/** Las filas de estaciones_obs de `fechas` (días locales) para una red. */
export function armarDias(lecturas, { red, fechas, muestreo_min, fuente, url = null }) {
  const objetivo = new Set(fechas);
  const esp = Math.round(1440 / muestreo_min), espN = Math.round(900 / muestreo_min);
  const filas = new Map();
  const fila = (id, fecha) => {
    const k = `${id}|${fecha}`;
    if (!filas.has(k)) filas.set(k, { red, estacion_id: String(id), fecha, hora_corte: '00:00', url, tmin_c: null, tmax_c: null,
      registros_validos: 0, registros_esperados: esp, tmin_noche_c: null, tmin_noche_en: null, noche_registros: 0,
      noche_esperados: espN, muestreo_min, lluvia_mm: null, lluvia_origen: 'acumulado_consola', horas_validas: null,
      _lecturas: 0, _marcas: {} });
    return filas.get(k);
  };
  const orden = [...lecturas].sort((a, b) => a.instante - b.instante || String(a.id).localeCompare(String(b.id)));
  for (const l of orden) {
    const { fecha, min, seg } = local(l.instante);
    const t = l.temp_c;
    if (objetivo.has(fecha)) {
      const f = fila(l.id, fecha);
      f._lecturas++;
      for (const mk of l.marcas || []) f._marcas[mk] = (f._marcas[mk] || 0) + 1;
      if (t != null) {
        f.tmin_c = f.tmin_c == null ? t : Math.min(f.tmin_c, t);
        f.tmax_c = f.tmax_c == null ? t : Math.max(f.tmax_c, t);
        f.registros_validos++;
      }
      if (l.lluvia_dia_mm != null) f.lluvia_mm = l.lluvia_dia_mm;           // en orden de instante: queda la última
    }
    if (t == null) continue;
    // la noche: > 18:00 → la de mañana; ≤ 09:00 → la de hoy
    const pasada18 = min > 18 * 60 || (min === 18 * 60 && seg > 0);
    const hasta9 = min < 9 * 60 || (min === 9 * 60 && seg === 0);
    const n = pasada18 ? sumarDias(fecha, 1) : hasta9 ? fecha : null;
    if (n && objetivo.has(n)) {
      const f = fila(l.id, n);
      if (f.tmin_noche_c == null || t < f.tmin_noche_c) { f.tmin_noche_c = t; f.tmin_noche_en = new Date(l.instante).toISOString(); }
      f.noche_registros++;
    }
  }
  const out = [];
  for (const f of filas.values()) {
    f.registros_esperados = Math.max(f.registros_esperados, f.registros_validos);
    f.noche_esperados = Math.max(f.noche_esperados, f.noche_registros);
    if (f.noche_registros === 0) { f.tmin_noche_c = null; f.tmin_noche_en = null; }
    f.crudo = { fuente, lecturas: f._lecturas, marcas: f._marcas, armado: 'parseo desde R2; deduplicado por estación e instante' };
    delete f._lecturas; delete f._marcas;
    out.push(f);
  }
  return out.sort((a, b) => a.estacion_id.localeCompare(b.estacion_id) || a.fecha.localeCompare(b.fecha));
}

/** Lo guardado contra lo nuevo: cada parte (el día y la noche) queda con la versión que tiene MÁS registros.
 *  Así una corrida con menos crudo (un archivo que faltó) nunca pisa un día más completo. Idempotente. */
export function combinar(viejo, nuevo) {
  if (!viejo) return nuevo;
  const r = { ...nuevo };
  if ((viejo.registros_validos ?? 0) > (nuevo.registros_validos ?? 0)) {
    for (const k of ['tmin_c', 'tmax_c', 'registros_validos', 'registros_esperados', 'lluvia_mm']) r[k] = viejo[k];
  }
  if ((viejo.noche_registros ?? 0) > (nuevo.noche_registros ?? 0)) {
    for (const k of ['tmin_noche_c', 'tmin_noche_en', 'noche_registros', 'noche_esperados']) r[k] = viejo[k];
  }
  return r;
}

/** La última lectura por estación (la de instante mayor). */
export function ultimas(lecturas) {
  const m = new Map();
  for (const l of lecturas) { const v = m.get(l.id); if (!v || l.instante > v.instante) m.set(l.id, l); }
  return [...m.values()];
}
