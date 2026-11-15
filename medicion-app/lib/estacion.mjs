// HN AGRO · 260 · el LADO DE LA ESTACIÓN: de las filas de estaciones_obs de `fecha` y `fecha + 1` a los tres valores
// (mínima nocturna, máxima, HR media), cada uno con su «¿alcanza?» según el sello (regla m1). Sin dependencias de red.
//
// Una fila (lo que devuelve medicion_app_obs, 0154): { fecha, tmin_noche_c, noche_registros, noche_esperados, tmax_c,
//   registros_validos, registros_esperados, muestreo_min, lecturas: [compactas del parseo] | null }.
// Las lecturas compactas son las del crudo del parseo ({ l: 'AAAA-MM-DDTHH:MM', temp, tmin, hum, …, m: [marcas] }) y se
// controlan con LA MISMA regla de imposibles del parseo (diario.controlar / LIMITES): una sola regla para todo.
import { controlar, deCompacta } from '../../estaciones-privadas/parseo/lib/diario.mjs';
import { msLocal, sumarDias } from '../../estaciones-privadas/parseo/lib/hora.mjs';
import { SELLO } from './sello.mjs';

const num = (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);
export const minimo = (esperados, frac = SELLO.fraccion_minima) => Math.ceil(frac * esperados - 1e-9);

/** Las lecturas de una fila, controladas. null si la fila no trae lecturas (otra forma de crudo). */
function controladas(fila) {
  if (!fila || !Array.isArray(fila.lecturas)) return null;
  const crudas = fila.lecturas.filter((o) => o && typeof o.l === 'string');
  // una lectura que el parseo ya marcó (fuera de rango, futura, sensor roto) tampoco cuenta acá
  return controlar(crudas.map(deCompacta)).map((r, i) => ({ ...r, marcasParseo: crudas[i].m || [] }));
}

/** En (desde, hasta] (locales): los instantes válidos ordenados y el hueco más largo, con los bordes. */
export function hueco(tiempos, desde, hasta) {
  const a = msLocal(desde), b = msLocal(hasta);
  const ts = tiempos.filter((t) => t > a && t <= b).sort((x, y) => x - y);
  if (!ts.length) return { n: 0, hueco_min: Infinity };
  let h = ts[0] - a;
  for (let i = 1; i < ts.length; i++) h = Math.max(h, ts[i] - ts[i - 1]);
  h = Math.max(h, b - ts[ts.length - 1]);
  return { n: ts.length, hueco_min: Math.round(h / 60e3) };
}

/**
 * El lado de la estación. `dia` = fila de `fecha` (máxima, HR y la parte de la noche de 18 a 24), `manana` = fila de
 * `fecha + 1` (la mínima nocturna, que el parseo guarda en la fila de la mañana en que termina la noche).
 */
export function ladoEstacion({ red, fecha, dia = null, manana = null }) {
  const motivos = [];
  const sinExtremos = SELLO.redes_sin_extremos.includes(red);
  const muestreo = num(manana?.muestreo_min ?? dia?.muestreo_min);
  const grueso = (m) => m != null && m > SELLO.muestreo_max_min;
  const lecDia = controladas(dia);
  const lecManana = controladas(manana);
  const bajo = (r, fila) => (num(fila?.muestreo_min) == null ? (r.ok.tmin ?? r.ok.temp) : r.ok.temp);
  const alto = (r, fila) => (num(fila?.muestreo_min) == null ? (r.ok.tmax ?? r.ok.temp) : r.ok.temp);
  const valida = (r) => !(r.marcasParseo || []).length;
  const hasta = sumarDias(fecha, 1);

  /* ── la noche: (fecha 18:00, fecha+1 09:00] ── */
  let noche = { est: null, ok: false, registros: null, esperados: null };
  if (!manana) motivos.push('noche_sin_fila');
  else {
    noche.est = num(manana.tmin_noche_c);
    noche.registros = num(manana.noche_registros);
    noche.esperados = num(manana.noche_esperados);
    const m = [];
    if (sinExtremos) m.push('noche_red_sin_extremos');
    if (noche.est == null) m.push('noche_sin_valor');
    if (grueso(num(manana.muestreo_min))) m.push('noche_muestreo_grueso');
    if (!(noche.esperados > 0)) m.push('noche_sin_esperados');
    else if (!(noche.registros >= minimo(noche.esperados))) m.push('noche_pocas_lecturas');
    if (lecDia || lecManana) {
      const ts = [
        ...(lecDia || []).filter((r) => valida(r) && bajo(r, dia) != null),
        ...(lecManana || []).filter((r) => valida(r) && bajo(r, manana) != null),
      ].map((r) => msLocal(r.local));
      const h = hueco(ts, fecha + 'T18:00', hasta + 'T09:00');
      if (h.hueco_min > SELLO.hueco_noche_min) m.push('noche_hueco');
      const mad = hueco(ts, hasta + 'T' + SELLO.madrugada[0], hasta + 'T' + SELLO.madrugada[1]);
      if (!mad.n) m.push('noche_sin_madrugada');
    } else motivos.push('noche_huecos_sin_verificar');
    noche.ok = m.length === 0;
    motivos.push(...m);
  }

  /* ── el día: (fecha 00:00, fecha+1 00:00] ── */
  let tmax = { est: null, ok: false, registros: null, esperados: null };
  let hr = { est: null, ok: false, lecturas: null };
  if (!dia) motivos.push('dia_sin_fila');
  else {
    tmax.est = num(dia.tmax_c);
    tmax.registros = num(dia.registros_validos);
    tmax.esperados = num(dia.registros_esperados);
    const m = [];
    if (sinExtremos) m.push('tmax_red_sin_extremos');
    if (tmax.est == null) m.push('tmax_sin_valor');
    if (grueso(num(dia.muestreo_min))) m.push('tmax_muestreo_grueso');
    if (!(tmax.esperados > 0)) m.push('tmax_sin_esperados');
    else if (!(tmax.registros >= minimo(tmax.esperados))) m.push('tmax_pocas_lecturas');
    if (lecDia) {
      const ts = lecDia.filter((r) => valida(r) && alto(r, dia) != null).map((r) => msLocal(r.local));
      if (hueco(ts, fecha + 'T00:00', hasta + 'T00:00').hueco_min > SELLO.hueco_dia_min) m.push('tmax_hueco');
    }
    tmax.ok = m.length === 0;
    motivos.push(...m);

    /* HR media: sólo de las lecturas del crudo */
    const mh = [];
    if (!lecDia) mh.push('hr_sin_lecturas');
    else {
      const enDia = lecDia.filter((r) => valida(r) && r.ok.hum != null
        && msLocal(r.local) > msLocal(fecha + 'T00:00') && msLocal(r.local) <= msLocal(hasta + 'T00:00'));
      hr.lecturas = enDia.length;
      if (enDia.length) hr.est = Math.round((enDia.reduce((s, r) => s + r.ok.hum, 0) / enDia.length) * 100) / 100;
      if (!(tmax.esperados > 0)) mh.push('hr_sin_esperados');
      else if (!(enDia.length >= minimo(tmax.esperados))) mh.push('hr_pocas_lecturas');
      if (hueco(enDia.map((r) => msLocal(r.local)), fecha + 'T00:00', hasta + 'T00:00').hueco_min > SELLO.hueco_dia_min) mh.push('hr_hueco');
    }
    hr.ok = mh.length === 0;
    motivos.push(...mh);
  }
  return { noche, tmax, hr, muestreo_min: muestreo, motivos };
}
