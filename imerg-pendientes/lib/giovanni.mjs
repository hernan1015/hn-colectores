// HN AGRO · la serie diaria de IMERG-Final de UN punto, de Giovanni (NASA), con el token de Earthdata.
// Es el mismo pedido que hace hn-agro tools/imerg/backfill.py (serie_giovanni, _v1242): Harmony pide el login por
// redirect y Giovanni acepta el token directo. Un pedido por celda: trae ~9.250 días (desde 2000-06-01) en ~20-30 min.
//
// La respuesta es un CSV de filas «fecha,valor» con un encabezado. Se descartan el relleno (−9999,9) y los negativos:
// sin dato, NO 0 (como imerg_late.py). Una fecha repetida queda con el último valor.

export const GIOVANNI = 'https://api.giovanni.earthdata.nasa.gov/timeseries';
export const DATAFIELD = 'GPM_3IMERGDF_07_precipitation';   // el id de Giovanni (no «precipitation»)
export const DESDE = '2000-06-01T00:00:00';                  // IMERG-Final desde junio de 2000
export const MS_PEDIDO = 40 * 60 * 1000;                     // corte del pedido: 40 min (hoy tarda 19-29)

/** Un error de la NASA: lleva sólo el código (estado HTTP, «timeout», «red», «sin_filas»), nunca el cuerpo. */
export class ErrorNasa extends Error {
  constructor(codigo) { super('nasa: ' + codigo); this.codigo = String(codigo); }
}

/** CSV de Giovanni → [[AAAA-MM-DD, mm], …] ordenado por fecha, sin relleno, sin negativos y sin fechas repetidas. */
export function parsearCsv(texto) {
  const porFecha = new Map();
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const c = linea.split(',');
    if (c.length < 2) continue;
    const fecha = c[0].trim().slice(0, 10), val = c[1].trim();
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(val)) continue;          // encabezado u otra fila no numérica
    const mm = Number(val);
    if (!Number.isFinite(mm) || mm < 0) continue;                       // −9999,9 (relleno) y negativos: sin dato
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    porFecha.set(fecha, Math.round(mm * 1000) / 1000);
  }
  return [...porFecha.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** El día de hoy (UTC) como fin del rango, igual que backfill.py. */
export const hastaHoy = (ahora = new Date()) => ahora.toISOString().slice(0, 10) + 'T23:59:59';

/** Pide la serie de la celda (su centro). Tira ErrorNasa ante cualquier cosa que no sea un 200 con filas. */
export async function pedirSerie({ lat, lon, token, desde = DESDE, hasta = hastaHoy(), fetch = globalThis.fetch, ms = MS_PEDIDO }) {
  if (!token) throw new ErrorNasa('sin_token');
  const url = GIOVANNI + '?' + new URLSearchParams({ data: DATAFIELD, location: `[${Number(lat)},${Number(lon)}]`, time: `${desde}/${hasta}` });
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'hn-colectores-imerg-pendientes' },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    throw new ErrorNasa(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'red');
  }
  if (r.status !== 200) throw new ErrorNasa(r.status);
  const filas = parsearCsv(await r.text());
  if (!filas.length) throw new ErrorNasa('sin_filas');
  return filas;
}
