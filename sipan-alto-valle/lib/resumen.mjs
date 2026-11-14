// HN AGRO · SIPAN Alto Valle · controles de cada registro de 10 min y resúmenes: el DÍA y la NOCHE.
// Sin dependencias.
//
// La hora: el reloj de las estaciones es la hora de Argentina (UTC−3, sin horario de verano). Se comprobó con la
// radiación de los fixtures: el sol sale a las 6:30-7:00 y el máximo cae a las 13:40-14:50, como corresponde a
// UTC−3 en el Alto Valle. Un registro marcado «0:10» es el intervalo 0:00-0:10 (hora de FIN).
//
// · EL DÍA D (como la 0110): los registros cuya hora de fin cae en (D 00:00, D+1 00:00].
//     tmin = mínimo de «Low Temp», tmax = máximo de «Hi Temp», lluvia = suma de «Rain», ET = suma de «ET».
// · LA NOCHE QUE TERMINA LA MAÑANA DE D: (D−1 18:00, D 09:00], 15 h = 90 registros de 10 min.
//     tmin_noche = mínimo de «Low Temp», con la hora (de fin) del registro donde ocurrió (si hay empate, la primera).
// · NULL es «no hay dato»: un resumen sin registros válidos es null, nunca 0. Un día con faltantes trae cuántos
//   registros válidos hubo y cuántos se esperaban; quien lo use decide (p. ej., la medición pide la noche ≥ 90 %).
// · VALORES IMPOSIBLES: se MARCAN (marcas[]) y no entran en los resúmenes; el crudo queda como vino.

export const LIMITES = {
  temp: [-30, 48], temp_min: [-30, 48], temp_max: [-30, 48],
  hum: [1, 100],
  lluvia: [0, 60],          // mm en 10 min (60 mm en 10 min ya sería un récord mundial de hecho)
  et: [0, 1.5],             // mm en 10 min
  presion: [850, 1100],
  rad: [0, 1600],
  viento: [0, 60],          // m/s
};
const SALTO_C = 8;          // °C entre un registro y el siguiente (10 min)

const ms = (local) => Date.parse(local + ':00Z');           // «hora local» como si fuera UTC: sólo para restar
const hm = (t) => new Date(t).toISOString().slice(0, 16);

/** Marca los valores imposibles de cada registro. Devuelve registros nuevos con `ok` (valores usables) y `marcas`. */
export function controlar(registros) {
  const out = registros.map((r) => ({ ...r, ok: { ...r.v }, marcas: [] }));
  for (const r of out) {
    for (const [k, [a, b]] of Object.entries(LIMITES)) {
      const x = r.v[k];
      if (x != null && (x < a || x > b)) { r.marcas.push(`${k}_fuera_de_rango`); r.ok[k] = null; }
    }
    const { temp, temp_min: lo, temp_max: hi } = r.ok;
    if (lo != null && hi != null && lo > hi + 0.05) { r.marcas.push('min_mayor_que_max'); r.ok.temp_min = null; r.ok.temp_max = null; }
    if (temp != null && lo != null && temp < lo - 0.25) { r.marcas.push('temp_bajo_min'); r.ok.temp_min = null; }
    if (temp != null && hi != null && temp > hi + 0.25) { r.marcas.push('temp_sobre_max'); r.ok.temp_max = null; }
  }
  /* saltos: un pico aislado (sube y vuelve, o baja y vuelve) de más de SALTO_C en 10 min */
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1].ok.temp, b = out[i].ok.temp, c = out[i + 1].ok.temp;
    if (a == null || b == null || c == null) continue;
    if (ms(out[i].local) - ms(out[i - 1].local) > 20 * 60e3 || ms(out[i + 1].local) - ms(out[i].local) > 20 * 60e3) continue;
    if (Math.abs(b - a) > SALTO_C && Math.abs(b - c) > SALTO_C && Math.sign(b - a) === Math.sign(b - c)) {
      out[i].marcas.push('pico_aislado');
      out[i].ok.temp = null; out[i].ok.temp_min = null; out[i].ok.temp_max = null;
    }
  }
  /* sensor trabado: la misma temperatura 6 h seguidas (36 registros) */
  let ini = 0;
  for (let i = 1; i <= out.length; i++) {
    if (i < out.length && out[i].v.temp != null && out[i].v.temp === out[ini].v.temp) continue;
    if (i - ini >= 36 && out[ini].v.temp != null) {
      for (let j = ini; j < i; j++) { out[j].marcas.push('temp_trabada'); out[j].ok.temp = null; out[j].ok.temp_min = null; out[j].ok.temp_max = null; }
    }
    ini = i;
  }
  return out;
}

function ventana(registros, desdeExcl, hastaIncl) {
  const a = ms(desdeExcl), b = ms(hastaIncl);
  return registros.filter((r) => { const t = ms(r.local); return t > a && t <= b; });
}
const sumar = (rs, k) => { const v = rs.map((r) => r.ok[k]).filter((x) => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) * 100) / 100 : null; };
const extremo = (rs, k, f) => { const v = rs.map((r) => r.ok[k]).filter((x) => x != null); return v.length ? f(...v) : null; };
export const sumarDias = (fecha, n) => new Date(Date.parse(fecha + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** El día D. `controlados` = salida de controlar(). */
export function resumenDia(controlados, fecha, intervalo = 10) {
  const rs = ventana(controlados, fecha + 'T00:00', sumarDias(fecha, 1) + 'T00:00');
  const esperados = Math.round(24 * 60 / intervalo);
  const conT = rs.filter((r) => r.ok.temp_min != null || r.ok.temp_max != null).length;
  /* horas_validas (la columna de la 0110, que es de LLUVIA): las horas del día con todos sus registros de lluvia.
     La 0110 exige lluvia NULL con 0 horas: un día sin ninguna hora completa deja la lluvia en null (la suma parcial
     queda en lluvia_parcial_mm, para el crudo). */
  const porHora = new Map();
  for (const r of rs) if (r.ok.lluvia != null) { const h = Math.floor((ms(r.local) - 1) / 3600e3); porHora.set(h, (porHora.get(h) || 0) + 1); }
  const horas = [...porHora.values()].filter((n) => n >= Math.round(60 / intervalo)).length;
  const conLluvia = rs.filter((r) => r.ok.lluvia != null).length;
  const lluvia = conLluvia ? sumar(rs, 'lluvia') : null;
  return {
    fecha,
    registros: rs.length, registros_validos: conT, registros_esperados: esperados,
    horas_validas: Math.min(24, horas),
    tmin_c: extremo(rs, 'temp_min', Math.min),
    tmax_c: extremo(rs, 'temp_max', Math.max),
    lluvia_mm: horas > 0 ? lluvia : null,
    lluvia_parcial_mm: lluvia,
    lluvia_registros: conLluvia,
    eto_mm: rs.some((r) => r.ok.et != null) ? sumar(rs, 'et') : null,
    /* [138c] radiación global del día: W/m² medio de cada registro × su duración. Sólo con el día COMPLETO de
       radiación (si falta un registro de día, el total sale corto): si no, null, y rad_registros dice cuántos hubo. */
    rad_registros: rs.filter((r) => r.ok.rad != null).length,
    rad_mj_m2: rs.filter((r) => r.ok.rad != null).length === esperados
      ? Math.round(rs.reduce((s, r) => s + r.ok.rad * intervalo * 60, 0) / 1e4) / 100 : null,
    marcados: rs.filter((r) => r.marcas.length).length,
    completo: conT === esperados && conLluvia === esperados,
  };
}

/** La noche que termina la mañana de D: (D−1 18:00, D 09:00]. */
export function resumenNoche(controlados, fecha, intervalo = 10, { desde = '18:00', hasta = '09:00' } = {}) {
  const rs = ventana(controlados, sumarDias(fecha, -1) + 'T' + desde, fecha + 'T' + hasta);
  const esperados = Math.round((ms(fecha + 'T' + hasta) - ms(sumarDias(fecha, -1) + 'T' + desde)) / (intervalo * 60e3));
  let min = null;
  for (const r of rs) if (r.ok.temp_min != null && (min == null || r.ok.temp_min < min.ok.temp_min)) min = r;
  const validos = rs.filter((r) => r.ok.temp_min != null).length;
  return {
    fecha, desde: sumarDias(fecha, -1) + 'T' + desde, hasta: fecha + 'T' + hasta,
    registros_validos: validos, registros_esperados: esperados,
    tmin_noche_c: min ? min.ok.temp_min : null,
    tmin_noche_local: min ? min.local : null,                       // hora LOCAL (UTC−3) de fin del registro
    tmin_noche_en: min ? new Date(ms(min.local) + 3 * 3600e3).toISOString() : null,   // la misma, en UTC
  };
}

/** Los días y noches que toca un conjunto de registros. */
export function fechasDe(controlados) {
  const dias = new Set(), noches = new Set();
  for (const r of controlados) {
    const t = ms(r.local);
    dias.add(hm(t - 1).slice(0, 10));                        // «0:00» de D+1 es del día D
    const h = new Date(t - 1).getUTCHours();
    const d = hm(t - 1).slice(0, 10);
    if (h >= 18) noches.add(sumarDias(d, 1)); else if (ms(r.local) <= ms(d + 'T09:00')) noches.add(d);
  }
  return { dias: [...dias].sort(), noches: [...noches].sort() };
}

/** Une los registros guardados con los nuevos: una sola fila por hora local (dedup). Gana el que tiene MÁS valores;
 *  a igual cantidad, el nuevo. */
export function unir(viejos, nuevos) {
  const m = new Map();
  const llenos = (r) => Object.values(r.v || {}).filter((x) => x != null).length;
  for (const r of viejos || []) m.set(r.local, r);
  for (const r of nuevos || []) { const v = m.get(r.local); if (!v || llenos(r) >= llenos(v)) m.set(r.local, r); }
  return [...m.values()].sort((a, b) => (a.local < b.local ? -1 : 1));
}
