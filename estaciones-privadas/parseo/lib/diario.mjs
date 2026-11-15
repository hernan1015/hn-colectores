// HN AGRO · estaciones-privadas/parseo · de las LECTURAS de una estación a las filas DIARIAS de estaciones_obs (0110 + 0147).
// Sirve para las fuentes que dan instantáneas (EEAOC, DACC, San Luis: una por vuelta) y para las que dan registros
// (SIGA cada 10 min, los .txt de Davis de Entre Ríos cada 10 min). Sin dependencias.
//
// Una lectura: { local: 'AAAA-MM-DDTHH:MM' (fin del registro, hora argentina), v: { temp, tmin, tmax, hum, lluvia,
//   lluvia_acum, eto } }. Todo lo que falta es null: NULL ES «NO HAY DATO», NUNCA 0.
//
// Las ventanas, iguales a las del SMN y el SIPAN (0110, 0147):
//   · el DÍA D: los registros que terminan en (D 00:00, D+1 00:00];
//   · la NOCHE que termina la mañana de D: (D−1 18:00, D 09:00].
// Cómo sale cada columna (según la fuente, `cfg`):
//   · extremos 'consola': tmin/tmax de las columnas Mín./Máx. de cada registro (muestreo_min NULL);
//     'muestreados': la menor/mayor de las lecturas (muestreo_min = cada cuánto se leyó: la mínima real puede ser menor);
//   · lluvia 'suma_registros' (suma la lluvia de cada registro), 'acumulado_consola' (la consola da el acumulado del
//     día: se toma el MAYOR del día; si el acumulado BAJA dentro del día, la consola no corta a las 00 y la lluvia del
//     día queda NULL con la marca), o null (la fuente no dice qué es: va sólo al crudo).
// Idempotente: la fila lleva una firma de su contenido; si la firma no cambió, no se vuelve a escribir.
import { createHash } from 'node:crypto';
import { msLocal, diaDe, sumarDias, utcDe } from './hora.mjs';

export const LIMITES = Object.freeze({
  // [local 15/11 12:53] imposibles: HR 0 o 255, 50 °C o más, presión 0. Los CHECK de la 0110 son (−40, 60).
  temp: [-39.9, 49.9], tmin: [-39.9, 49.9], tmax: [-39.9, 49.9],
  hum: [1, 100],
  lluvia: [0, 150],          // mm en UN registro (10 min o 1 h)
  lluvia_acum: [0, 450],     // mm acumulados del día (CHECK de la 0110: < 500)
  eto: [0, 3],               // mm en un registro de 10 min
});
const CAMPOS = Object.keys(LIMITES);
export const FUTURO_MS = 15 * 60e3;  // una lectura más de 15 min en el futuro no es real (reloj de la consola corrido)

const llenos = (v) => Object.values(v || {}).filter((x) => x != null).length;
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** Un valor de la fuente → número o null. −999, −9999, «---», vacío, N/D, NaN y los centinelas de la fuente → null.
 *  Un 0 medido sigue siendo 0. */
export function numero(x, { centinelas = [] } = {}) {
  if (x == null) return null;
  let n;
  if (typeof x === 'number') n = x;
  else {
    const t = String(x).trim().replace(',', '.');
    if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
    n = Number(t);
  }
  if (!Number.isFinite(n) || n <= -999 || centinelas.includes(n)) return null;
  return n;
}

/** DEDUP por instante: gana la lectura con más datos (a igualdad, la nueva). */
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

/** Marca lo imposible: fuera de rango, sensor roto (temp 0 y hum 0 a la vez), y la lectura en el futuro. */
export function controlar(lecturas, { ahoraLocal = null } = {}) {
  const tope = ahoraLocal ? msLocal(ahoraLocal) + FUTURO_MS : Infinity;
  return lecturas.map((r) => {
    const ok = {}; const marcas = [];
    for (const k of CAMPOS) {
      const x = r.v?.[k] ?? null;
      const [a, b] = LIMITES[k];
      if (x != null && (x < a || x > b)) { marcas.push(`${k}_fuera_de_rango`); ok[k] = null; } else ok[k] = x;
    }
    if (r.v?.temp === 0 && r.v?.hum === 0) { marcas.push('sensor_roto'); ok.temp = null; ok.hum = null; ok.tmin = null; ok.tmax = null; }
    if (msLocal(r.local) > tope) { marcas.push('futura'); for (const k of CAMPOS) ok[k] = null; }
    return { ...r, ok, marcas };
  });
}

function ventana(lecturas, desdeExcl, hastaIncl) {
  const a = msLocal(desdeExcl), b = msLocal(hastaIncl);
  return lecturas.filter((r) => { const t = msLocal(r.local); return t > a && t <= b; });
}
const horaDe = (local) => new Date(msLocal(local) - 60e3).toISOString().slice(0, 13);

/** La lluvia del día según la fuente. */
function lluviaDia(rs, cfg) {
  if (cfg.lluvia === 'suma_registros') {
    const con = rs.filter((r) => r.ok.lluvia != null);
    const horas = new Set(con.map((r) => horaDe(r.local))).size;
    return { lluvia_mm: horas ? r2(con.reduce((s, r) => s + r.ok.lluvia, 0)) : null, horas_validas: Math.min(horas, 24), lluvia_origen: 'suma_registros', marcas: [] };
  }
  if (cfg.lluvia === 'acumulado_consola') {
    const con = rs.filter((r) => r.ok.lluvia_acum != null);
    const horas = new Set(con.map((r) => horaDe(r.local))).size;
    const marcas = [];
    for (let i = 1; i < con.length; i++) if (con[i].ok.lluvia_acum < con[i - 1].ok.lluvia_acum - 0.2) marcas.push('acumulado_baja_dentro_del_dia');
    const lluvia_mm = marcas.length || !horas ? null : r2(Math.max(...con.map((r) => r.ok.lluvia_acum)));
    return { lluvia_mm, horas_validas: Math.min(horas, 24), lluvia_origen: 'acumulado_consola', marcas: [...new Set(marcas)] };
  }
  return { lluvia_mm: null, horas_validas: null, lluvia_origen: null, marcas: [] };
}

/** La lectura compacta que va al crudo (sólo lo que vino; null no se guarda). */
const compacta = (r) => {
  const o = { l: r.local };
  for (const [k, x] of Object.entries(r.v || {})) if (x != null) o[k] = x;
  if (r.marcas?.length) o.m = r.marcas;
  return o;
};
export const deCompacta = (o) => {
  const v = {};
  for (const [k, x] of Object.entries(o || {})) if (k !== 'l' && k !== 'm') v[k] = x;
  return { local: o.l, v };
};

/**
 * La fila del día `fecha` (sin red ni estacion_id). `controladas` = salida de controlar() con TODAS las lecturas de la
 * estación que se tengan (el día anterior hace falta para la noche). null si el día no tiene ninguna lectura.
 * cfg: { pasoMin, extremos: 'consola'|'muestreados', lluvia, eto: bool, fuente, url }
 */
export function filaDia(controladas, fecha, cfg) {
  const rs = ventana(controladas, fecha + 'T00:00', sumarDias(fecha, 1) + 'T00:00');
  if (!rs.length) return null;
  const esperados = Math.round(1440 / cfg.pasoMin);
  const consola = cfg.extremos === 'consola';
  const bajo = (r) => (consola ? r.ok.tmin ?? r.ok.temp : r.ok.temp);
  const alto = (r) => (consola ? r.ok.tmax ?? r.ok.temp : r.ok.temp);
  const conT = rs.filter((r) => bajo(r) != null || alto(r) != null);
  const mins = conT.map(bajo).filter((x) => x != null);
  const maxs = conT.map(alto).filter((x) => x != null);
  const ll = lluviaDia(rs, cfg);
  const et = cfg.eto ? rs.map((r) => r.ok.eto).filter((x) => x != null) : [];
  /* la noche que termina la mañana de `fecha` */
  const nn = ventana(controladas, sumarDias(fecha, -1) + 'T18:00', fecha + 'T09:00');
  const nEsp = Math.round(900 / cfg.pasoMin);
  let min = null;
  for (const r of nn) { const x = bajo(r); if (x != null && (min == null || x < min.x)) min = { x, local: r.local }; }
  const nVal = nn.filter((r) => bajo(r) != null).length;
  const fila = {
    fecha,
    hora_corte: '00:00',
    tmin_c: mins.length ? Math.min(...mins) : null,
    tmax_c: maxs.length ? Math.max(...maxs) : null,
    lluvia_mm: ll.lluvia_mm, horas_validas: ll.horas_validas, lluvia_origen: ll.lluvia_origen,
    eto_mm: et.length ? r2(et.reduce((s, x) => s + x, 0)) : null,
    tmin_noche_c: min ? min.x : null,
    tmin_noche_en: min ? utcDe(min.local) : null,
    noche_registros: Math.min(nVal, nEsp), noche_esperados: nEsp,
    registros_validos: Math.min(conT.length, esperados), registros_esperados: esperados,
    muestreo_min: consola ? null : cfg.pasoMin,
    url: cfg.url || null,
  };
  const marcas = [...new Set([...ll.marcas, ...rs.flatMap((r) => r.marcas)])].sort();
  const contenido = { ...fila, lecturas: rs.map(compacta), marcas };
  const firma = createHash('sha256').update(JSON.stringify(contenido)).digest('hex').slice(0, 16);
  fila.crudo = { fuente: cfg.fuente, uso: 'interno', lecturas: contenido.lecturas, marcas, firma };
  return fila;
}

/**
 * Las filas que hay que escribir para UNA estación: une lo guardado (filas viejas, con su crudo) con las lecturas
 * nuevas, controla, y arma los días que tocan las nuevas (y la mañana siguiente, por la noche). Sólo devuelve las
 * filas cuya firma cambió. Las lecturas más viejas que `cfg.maxEdadH` o futuras se descartan y se cuentan.
 */
export function filasEstacion({ nuevas, viejas = [], cfg, ahoraLocal }) {
  const edadMax = (cfg.maxEdadH ?? 48) * 3600e3;
  const ahora = msLocal(ahoraLocal);
  const aceptadas = []; let descartadas = 0;
  for (const r of nuevas) {
    const t = msLocal(r.local);
    if (!Number.isFinite(t) || ahora - t > edadMax || t - ahora > FUTURO_MS) { descartadas++; continue; }
    aceptadas.push(r);
  }
  const guardadas = viejas.flatMap((f) => (f.crudo?.lecturas || []).map(deCompacta));
  const { lecturas, repetidas } = unir(guardadas, aceptadas);
  const ctrl = controlar(lecturas, { ahoraLocal });
  const fechas = new Set();
  for (const r of aceptadas) {
    const d = diaDe(r.local);
    fechas.add(d);
    if (msLocal(r.local) > msLocal(d + 'T18:00')) fechas.add(sumarDias(d, 1));
  }
  const firmas = new Map(viejas.map((f) => [f.fecha, f.crudo?.firma]));
  const filas = [];
  for (const fecha of [...fechas].sort()) {
    const f = filaDia(ctrl, fecha, cfg);
    if (f && firmas.get(fecha) !== f.crudo.firma) filas.push(f);
  }
  return { filas, aceptadas: aceptadas.length, descartadas, repetidas };
}

/** Las fechas de las filas viejas que hay que leer para unir: los días de las lecturas nuevas, el anterior y el siguiente. */
export function fechasALeer(nuevas) {
  const s = new Set();
  for (const r of nuevas) {
    if (!Number.isFinite(msLocal(r.local))) continue;
    const d = diaDe(r.local);
    s.add(sumarDias(d, -1)); s.add(d); s.add(sumarDias(d, 1));
  }
  return [...s].sort();
}
