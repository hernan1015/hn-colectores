// HN AGRO · goes-serie · las claves en R2 y las reglas puras (sin red): nombres, ventanas, rotación y qué se firma.
//
// LA IMAGEN ES LA MISMA QUE LEE SATCHI HOY: GOES-19 ABI-L2-FDCF (focos de calor, disco completo, NetCDF4/HDF5, una
// cada 10 min, ~1,9 MB). La leen hn-agro netlify/functions/lib/goes-focos.mjs (focosCerca) → focos-litoral → fuego-grupos
// (procedencia.goes = t_scan) → «Lo vimos antes» (satchi/lo-vimos-antes.js) y la constancia del evento.
// Se guarda el archivo ENTERO y sin tocar: goes-focos lo baja entero y ventanea adentro (leer un HDF5 cortado o recortado
// da números inventados), así que cualquier lector de hoy abre la copia de R2 igual que el original de NOAA.
//
//   goes-serie/AAAA/MM/DD/HHMM.nc        la imagen del turno de 10 min que empieza a HH:MM UTC (inicio del barrido)
//   goes-serie/AAAA/MM/DD/indice.json    el índice del día (imágenes, faltantes)
//   goes-eventos/<evento>/AAAA/MM/DD/HHMM.nc · goes-eventos/<evento>/manifiesto.json   (sin rotación, nunca se borra)

export const PREFIJO_SERIE = 'goes-serie/';
export const PREFIJO_EVENTOS = 'goes-eventos/';
export const RETENCION_DIAS = 30;
export const PASO_MS = 10 * 60e3;
export const VENTANA_EVENTO_H = 6;
// Un turno se da por «cerrado» (si no está en NOAA, falta) 30 min después de empezar. NOAA publica el FDCF ~10 min
// después del inicio del barrido (medido: s 18:10:21 → LastModified 18:20:08).
export const MARGEN_CIERRE_MS = 30 * 60e3;
export const EXT = 'nc';
export const TIPO = 'application/x-netcdf';

const DIA_MS = 864e5;
const dd = (n) => String(n).padStart(2, '0');

export const RE_IMAGEN = /^goes-serie\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})\.nc$/;
export const RE_INDICE = /^goes-serie\/(\d{4})\/(\d{2})\/(\d{2})\/indice\.json$/;
export const RE_EVENTO = /^[a-z0-9][a-z0-9-]{2,59}$/;
export const RE_EVENTO_IMAGEN = /^goes-eventos\/([a-z0-9][a-z0-9-]{2,59})\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})\.nc$/;
export const RE_EVENTO_MANIFIESTO = /^goes-eventos\/([a-z0-9][a-z0-9-]{2,59})\/manifiesto\.json$/;

/** PURA. El turno de 10 min que contiene ms (inicio, en ms) */
export const turno = (ms) => Math.floor(ms / PASO_MS) * PASO_MS;
/** PURA. 'AAAA/MM/DD' y 'HHMM' (UTC) */
export function partes(ms) {
  const d = new Date(ms);
  return { dia: `${d.getUTCFullYear()}/${dd(d.getUTCMonth() + 1)}/${dd(d.getUTCDate())}`, hhmm: dd(d.getUTCHours()) + dd(d.getUTCMinutes()) };
}
export const isoTurno = (ms) => new Date(turno(ms)).toISOString().slice(0, 16) + 'Z';

export const claveImagen = (ms) => { const p = partes(turno(ms)); return `${PREFIJO_SERIE}${p.dia}/${p.hhmm}.${EXT}`; };
export const claveIndice = (ms) => `${PREFIJO_SERIE}${partes(ms).dia}/indice.json`;
export const prefijoDia = (ms) => `${PREFIJO_SERIE}${partes(ms).dia}/`;
export const claveEventoImagen = (evento, ms) => { const p = partes(turno(ms)); return `${PREFIJO_EVENTOS}${evento}/${p.dia}/${p.hhmm}.${EXT}`; };
export const claveManifiesto = (evento) => `${PREFIJO_EVENTOS}${evento}/manifiesto.json`;

/** PURA. El turno (ms) de una clave de imagen de la serie, o null */
export function tDeClave(k) {
  const m = RE_IMAGEN.exec(k);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(t) && t % PASO_MS === 0 ? t : null;
}
/** PURA. El inicio del día (ms) de un índice, o null */
export function diaDeIndice(k) {
  const m = RE_INDICE.exec(k);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/** PURA. Inicio del barrido desde el nombre de NOAA ('…_s20263111810215_…' = año, día juliano, hh, mm, ss, décima) */
export function instanteDe(nombre) {
  const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)/.exec(String(nombre));
  if (!m) return null;
  const [, yy, ddd, hh, mm, ss] = m;
  return Date.UTC(+yy, 0, 1, +hh, +mm, +ss) + (+ddd - 1) * DIA_MS;
}

/** PURA. Los turnos de [desde, hasta] (ambos se redondean al turno), en orden */
export function turnosEntre(desdeMs, hastaMs) {
  const out = [];
  for (let t = turno(desdeMs); t <= turno(hastaMs); t += PASO_MS) out.push(t);
  return out;
}
/** PURA. Los turnos de la ventana de un evento: t0 ± 6 h (73 turnos) */
export const turnosEvento = (t0Ms, horas = VENTANA_EVENTO_H) => turnosEntre(t0Ms - horas * 3600e3, t0Ms + horas * 3600e3);

/**
 * PURA. ROTACIÓN: qué claves borrar. Sólo bajo goes-serie/ (nunca goes-eventos/ ni nada más):
 *  - una imagen, si su turno empezó hace MÁS de 30 días;
 *  - un índice de día, cuando el día entero quedó fuera (su fin, hace más de 30 días).
 * Lo que no tiene forma de imagen o de índice no se toca.
 */
export function aRotar(claves, ahoraMs, dias = RETENCION_DIAS) {
  const corte = ahoraMs - dias * DIA_MS;
  const out = [];
  for (const k of claves) {
    if (typeof k !== 'string' || !k.startsWith(PREFIJO_SERIE)) continue;
    const t = tDeClave(k);
    if (t != null) { if (t < corte) out.push(k); continue; }
    const d = diaDeIndice(k);
    if (d != null && d + DIA_MS <= corte) out.push(k);
  }
  return out;
}

/**
 * PURA. Para el consumidor (fuego-grupos → procedencia.goes_desde): el turno más viejo de la serie SIN CORTES que termina
 * en la imagen más nueva. turnos = ms de las imágenes que hay (en cualquier orden). null si no hay ninguna.
 */
export function goesDesde(turnos) {
  const s = [...new Set(turnos.filter(Number.isFinite))].sort((a, b) => b - a);
  if (!s.length) return null;
  let desde = s[0];
  for (let i = 1; i < s.length; i++) { if (desde - s[i] !== PASO_MS) break; desde = s[i]; }
  return desde;
}

/**
 * PURA. EL PREFIJO LISTO PARA EL FIRMADOR (propuesta en LISTO-goes-serie.md; el firmador no se tocó).
 * listado = [{clave, bytes}] de goes-serie/ y goes-eventos/ → qué firmar:
 *  - serie_indices: los índices de los últimos `diasIndices` días (JSON: se verifican enteros);
 *  - serie_imagenes: las imágenes de las últimas `horasImagenes` h (1 byte);
 *  - eventos_manifiestos y eventos_imagenes: todos (los eventos no rotan).
 */
export const FIRMA_DIAS_INDICES = 30;
export const FIRMA_HORAS_IMAGENES = 24;
export function clavesAFirmar(listado, ahoraMs, { diasIndices = FIRMA_DIAS_INDICES, horasImagenes = FIRMA_HORAS_IMAGENES } = {}) {
  const r = { serie_indices: [], serie_imagenes: [], eventos_manifiestos: [], eventos_imagenes: [] };
  const hoy = Date.UTC(new Date(ahoraMs).getUTCFullYear(), new Date(ahoraMs).getUTCMonth(), new Date(ahoraMs).getUTCDate());
  for (const o of listado) {
    const k = o && o.clave;
    if (typeof k !== 'string') continue;
    const d = diaDeIndice(k);
    if (d != null) { if (d > hoy - diasIndices * DIA_MS) r.serie_indices.push(o); continue; }
    const t = tDeClave(k);
    if (t != null) { if (t >= ahoraMs - horasImagenes * 3600e3 && t <= ahoraMs) r.serie_imagenes.push(o); continue; }
    if (RE_EVENTO_MANIFIESTO.test(k)) { r.eventos_manifiestos.push(o); continue; }
    if (RE_EVENTO_IMAGEN.test(k)) r.eventos_imagenes.push(o);
  }
  return r;
}
