// HN AGRO · SMN datos abiertos · controles de cada lectura HORARIA y resúmenes: el DÍA y la NOCHE. Sin dependencias.
//
// Las lecturas del datohorario son INSTANTÁNEAS, una por hora (HOA = UTC−3). Igual que la 0110 y el SIPAN:
// · EL DÍA D: las lecturas de (D 00:00, D+1 00:00] = D 01:00 … D+1 00:00, 24 esperadas. La de las 00:00 de D+1 llega
//   con el archivo de D+1: el día D se completa al día siguiente (el colector vuelve a armar la fila).
//     tmin/tmax = la menor/mayor de las 24 lecturas: son MUESTREADAS (muestreo_min = 60). La mínima verdadera entre
//     dos lecturas puede ser más baja: no se mezcla con los extremos de consola del SIPAN sin decirlo (0147).
// · LA NOCHE QUE TERMINA LA MAÑANA DE D: (D−1 18:00, D 09:00] = D−1 19:00 … D 09:00, 15 esperadas.
// · NULL es «no hay dato»: sin lecturas válidas, el resumen es null, nunca 0. El datohorario NO trae lluvia: la lluvia
//   queda SIEMPRE null (y horas_validas, que en la 0110 es de lluvia, también).
// · VALORES IMPOSIBLES: se MARCAN (marcas[]) y no entran en los resúmenes; el crudo queda como vino.
export const LIMITES = {
  temp: [-39.9, 50],        // los récords del país rondan −35 °C y 49 °C; −40 es el CHECK de la 0110
  hum: [1, 100],
  pnm: [870, 1085],         // hPa al nivel del mar
  dd: [0, 360],             // grados (0 con FF 0 = calma)
  ff: [0, 250],             // km/h
};
const SALTO_C = 15;          // °C entre una hora y la siguiente: un pico aislado de más de esto no es real
const TRABADA_H = 12;        // la misma temperatura 12 horas seguidas = sensor trabado
export const ESPERADAS_DIA = 24;
export const ESPERADAS_NOCHE = 15;

const ms = (local) => Date.parse(local + ':00Z');           // «hora local» como si fuera UTC: sólo para restar
export const sumarDias = (fecha, n) => new Date(Date.parse(fecha + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/** El día (0110) al que pertenece una lectura: la de las 00:00 es del día anterior. */
export const diaDe = (local) => new Date(ms(local) - 60e3).toISOString().slice(0, 10);

/** Cuántos campos trae una lectura. */
const llenos = (v) => Object.values(v || {}).filter((x) => x != null).length;

/** DEDUP: por instante, gana la lectura más completa (a igualdad, la nueva). Devuelve { lecturas (ordenadas), repetidas }. */
export function unir(viejas, nuevas) {
  const m = new Map(); let repetidas = 0;
  for (const r of viejas || []) m.set(r.local, r);
  for (const r of nuevas || []) {
    const v = m.get(r.local);
    if (v) repetidas++;
    if (!v || llenos(r.v) >= llenos(v.v)) m.set(r.local, r);
  }
  return { lecturas: [...m.values()].sort((a, b) => (a.local < b.local ? -1 : 1)), repetidas };
}

/** Marca los valores imposibles. Devuelve lecturas nuevas con `ok` (valores usables) y `marcas`. */
export function controlar(lecturas) {
  const out = lecturas.map((r) => ({ ...r, ok: { ...r.v }, marcas: [] }));
  for (const r of out) {
    for (const [k, [a, b]] of Object.entries(LIMITES)) {
      const x = r.v[k];
      if (x != null && (x < a || x > b)) { r.marcas.push(`${k}_fuera_de_rango`); r.ok[k] = null; }
    }
  }
  /* pico aislado: sube (o baja) más de SALTO_C en una hora y vuelve a la siguiente */
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1].ok.temp, b = out[i].ok.temp, c = out[i + 1].ok.temp;
    if (a == null || b == null || c == null) continue;
    if (ms(out[i].local) - ms(out[i - 1].local) !== 3600e3 || ms(out[i + 1].local) - ms(out[i].local) !== 3600e3) continue;
    if (Math.abs(b - a) > SALTO_C && Math.abs(b - c) > SALTO_C && Math.sign(b - a) === Math.sign(b - c)) {
      out[i].marcas.push('pico_aislado'); out[i].ok.temp = null;
    }
  }
  /* sensor trabado: la misma temperatura TRABADA_H lecturas seguidas, horas consecutivas */
  let ini = 0;
  for (let i = 1; i <= out.length; i++) {
    const sigue = i < out.length && out[i].v.temp != null && out[i].v.temp === out[ini].v.temp && ms(out[i].local) - ms(out[i - 1].local) === 3600e3;
    if (sigue) continue;
    if (i - ini >= TRABADA_H && out[ini].v.temp != null) for (let j = ini; j < i; j++) { out[j].marcas.push('temp_trabada'); out[j].ok.temp = null; }
    ini = i;
  }
  return out;
}

function ventana(lecturas, desdeExcl, hastaIncl) {
  const a = ms(desdeExcl), b = ms(hastaIncl);
  return lecturas.filter((r) => { const t = ms(r.local); return t > a && t <= b; });
}

/** El día D. `controladas` = salida de controlar(). */
export function resumenDia(controladas, fecha) {
  const rs = ventana(controladas, fecha + 'T00:00', sumarDias(fecha, 1) + 'T00:00');
  const t = rs.map((r) => r.ok.temp).filter((x) => x != null);
  return {
    fecha, lecturas: rs.length, registros_validos: t.length, registros_esperados: ESPERADAS_DIA,
    tmin_c: t.length ? Math.min(...t) : null,
    tmax_c: t.length ? Math.max(...t) : null,
    marcadas: rs.filter((r) => r.marcas.length).length,
    completo: t.length === ESPERADAS_DIA,
  };
}

/** La noche que termina la mañana de D: (D−1 18:00, D 09:00]. */
export function resumenNoche(controladas, fecha) {
  const rs = ventana(controladas, sumarDias(fecha, -1) + 'T18:00', fecha + 'T09:00');
  let min = null;
  for (const r of rs) if (r.ok.temp != null && (min == null || r.ok.temp < min.ok.temp)) min = r;
  return {
    fecha, desde: sumarDias(fecha, -1) + 'T18:00', hasta: fecha + 'T09:00',
    registros_validos: rs.filter((r) => r.ok.temp != null).length, registros_esperados: ESPERADAS_NOCHE,
    tmin_noche_c: min ? min.ok.temp : null,
    tmin_noche_local: min ? min.local : null,
    tmin_noche_en: min ? new Date(ms(min.local) + 3 * 3600e3).toISOString() : null,   // la misma, en UTC
  };
}
