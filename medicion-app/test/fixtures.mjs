// HN AGRO · 260 · fixtures SINTÉTICOS (ningún pedido real). Las lecturas tienen la forma compacta del crudo del
// parseo (estaciones-privadas/parseo/lib/diario.mjs: { l, temp, tmin, tmax, hum, …, m }).
import { sumarDias } from '../../estaciones-privadas/parseo/lib/hora.mjs';
import { horasVentana } from '../lib/openmeteo.mjs';

export const FECHA = '2026-11-14';          // la víspera; la noche va de 14/11 18:00 a 15/11 09:00
export const SIG = sumarDias(FECHA, 1);

const hh = (h, m = 0) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
/** Lecturas horarias de un día local, en el minuto `min` de cada hora (la de las 24:00 es la 00:00 del día siguiente). */
export function horarias(dia, { min = 0, temp = () => 15, hum = () => 60, desde = 1, hasta = 24, sin = [] } = {}) {
  const out = [];
  for (let h = desde; h <= hasta; h++) {
    if (sin.includes(h)) continue;
    const l = h === 24 ? `${sumarDias(dia, 1)}T${hh(0, min)}` : `${dia}T${hh(h, min)}`;
    const o = { l };
    const t = temp(h); if (t != null) o.temp = t;
    const u = hum(h); if (u != null) o.hum = u;
    out.push(o);
  }
  return out;
}

/** Una fila de medicion_app_obs (lo que devuelve la 0154). */
export function fila(fecha, extra = {}) {
  return { red: 'SIGA_RT', estacion_id: '100', lat: -33.9, lon: -60.6, zona: 'agricola', fecha,
    tmin_noche_c: 4.2, noche_registros: 15, noche_esperados: 15, tmax_c: 27.5, registros_validos: 24, registros_esperados: 24,
    muestreo_min: 60, lecturas: null, ...extra };
}

/** Una estación horaria completa: fila de FECHA (con lecturas de todo el día) y de SIG (00 a 10 h). */
export function estacionCompleta({ red = 'SIGA_RT', id = '100', lat = -33.9, lon = -60.6, zona = 'agricola', tmin = 4.2, tmax = 27.5, hum = 60 } = {}) {
  const lecDia = horarias(FECHA, { temp: (h) => (h === 15 ? tmax : 15), hum: () => hum });     // 01:00 … 24:00
  const lecSig = horarias(SIG, { hasta: 10, temp: (h) => (h === 6 ? tmin : 8), hum: () => hum + 10 });
  return [
    fila(FECHA, { red, estacion_id: id, lat, lon, zona, tmax_c: tmax, lecturas: lecDia }),
    fila(SIG, { red, estacion_id: id, lat, lon, zona, tmin_noche_c: tmin, lecturas: lecSig, registros_validos: 10 }),
  ];
}

/** La serie horaria de Open-Meteo de un punto (dos días locales), con valores conocidos. */
export function serieOM({ lat, lon, noche = 5, tmax = 28, hr = 55, en18 = -10, en10 = -10, falta = null, offset = -10800 } = {}) {
  const time = []; const t = []; const h = [];
  const { noche: hn, dia: hd } = horasVentana(FECHA);
  for (const d of [FECHA, SIG]) for (let i = 0; i < 24; i++) {
    const ts = `${d}T${String(i).padStart(2, '0')}:00`;
    time.push(ts);
    let v = 12;
    if (hn.includes(ts)) v = ts === `${SIG}T05:00` ? noche : 9;
    if (hd.includes(ts) && ts === `${FECHA}T15:00`) v = tmax;
    if (ts === `${FECHA}T18:00`) v = en18;      // fuera de la ventana (18, 09]: no puede ser la mínima
    if (ts === `${SIG}T10:00`) v = en10;        // fuera también
    t.push(ts === falta ? null : v);
    h.push(hd.includes(ts) ? hr : 99);
  }
  return { latitude: lat, longitude: lon, elevation: 30, utc_offset_seconds: offset, timezone: 'America/Argentina/Buenos_Aires',
    hourly: { time, temperature_2m: t, relative_humidity_2m: h } };
}

/** Un fetch falso de Open-Meteo: contesta con serieOM en cada coordenada pedida. Guarda las URLs. */
export function fetchFalso(opciones = () => ({}), { estados = [] } = {}) {
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    const st = estados.shift();
    if (st && st !== 200) return { ok: false, status: st, json: async () => ({}) };
    const u = new URL(url);
    const lats = u.searchParams.get('latitude').split(',').map(Number);
    const lons = u.searchParams.get('longitude').split(',').map(Number);
    const arr = lats.map((lat, i) => serieOM({ lat, lon: lons[i], ...opciones(lat, lons[i]) }));
    return { ok: true, status: 200, json: async () => (arr.length === 1 ? arr[0] : arr) };
  };
  f.urls = urls;
  return f;
}

/** Una base en memoria con la interfaz de crearBase (para el job sin PGlite). */
export function baseFalsa(filas) {
  const b = { escritas: [], registros: [],
    leer: async () => filas.map((f) => ({ ...f })),
    guardar: async (fs) => { b.escritas.push(...fs); return { ok: fs.length, errores: {} }; },
    registrar: async (ok, r) => { b.registros.push({ ok, r }); } };
  return b;
}
export const sinEspera = async () => {};
