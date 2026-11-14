// HN AGRO · SMN datos abiertos · el archivo «datos horarios» (datohorarioAAAAMMDD.txt, dentro del ZIP de
// ssl.smn.gob.ar/dpd/zipopendata.php?dato=datohorario). Sin dependencias.
//
// EL FORMATO (texto de ancho fijo, latin1): una línea de encabezado con FECHA HORA TEMP HUM PNM DD FF NOMBRE, una de
// unidades ([HOA] [ºC] [%] [hPa] [gr] [km/hr]) y una fila por estación y hora:
//   FECHA = DDMMAAAA · HORA = 0..23 (HOA = hora oficial argentina, UTC−3) · TEMP °C · HUM % · PNM hPa (presión al nivel
//   del mar) · DD grados · FF km/h · NOMBRE = el nombre de la estación (sin número OMM en este archivo).
// ⚠ A VERIFICAR CON EL PRIMER ARCHIVO CON DATOS: el único pedido real (14/11/2026 03:29) trajo el ZIP con el .txt
//   VACÍO (0 bytes). Este formato sale de la documentación del catálogo y del análisis del 24/07 (columnas TEMP, HUM,
//   PNM, DD y FF verificadas; sin precipitación). Por eso el lector NO adivina: exige las 8 columnas en ese orden y,
//   si el archivo viene distinto, la corrida avisa (formato_no_se_entiende / formato_cambiado) y NO carga nada.
//
// Faltantes: un campo vacío (blancos en su columna) o «---», «N/D», «NaN» → null. NUNCA 0.
// La FIRMA del formato son las palabras del encabezado y de las unidades: si cambia, el colector no carga hasta que
// alguien la revise y la acepte (como el SIPAN).

export const COLUMNAS = ['FECHA', 'HORA', 'TEMP', 'HUM', 'PNM', 'DD', 'FF', 'NOMBRE'];
const NUMERICAS = [['TEMP', 'temp'], ['HUM', 'hum'], ['PNM', 'pnm'], ['DD', 'dd'], ['FF', 'ff']];
export const MAX_DESCARTADAS = 0.1;   // más de 1 de cada 10 filas que no se entienden = el formato cambió

/** Texto de un campo → número o null (faltante). */
export function numero(s) {
  const t = String(s ?? '').trim();
  if (t === '' || /^-+$/.test(t) || /^n\/?d$/i.test(t) || /^nan$/i.test(t)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined;   // no es un número: la fila no se entiende
  return Number(t);
}

/** El id de la estación: el nombre sin tildes, en mayúsculas, con «_» (el archivo no trae número OMM). */
export function idDeNombre(nombre) {
  return String(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

const p2 = (n) => String(n).padStart(2, '0');
function fechaDe(ddmmaaaa) {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(ddmmaaaa);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Las palabras de una línea con su posición de fin. */
function palabras(linea) {
  return [...linea.matchAll(/\S+/g)].map((m) => ({ t: m[0], ini: m.index, fin: m.index + m[0].length }));
}

/** texto → { ok, firma, columnas, unidades, hora, registros, descartadas, fecha_archivo } | { ok: false, motivo, detalle } */
export function leerDatoHorario(texto) {
  const lineas = String(texto ?? '').replace(/\r/g, '').split('\n');
  if (!lineas.some((l) => l.trim())) return { ok: false, motivo: 'vacio' };
  const iEnc = lineas.findIndex((l) => /\bFECHA\b/i.test(l) && /\bNOMBRE\b/i.test(l));
  if (iEnc < 0) return { ok: false, motivo: 'sin_encabezado' };
  const enc = palabras(lineas[iEnc]);
  const columnas = enc.map((w) => w.t.toUpperCase());
  const faltan = COLUMNAS.filter((c) => !columnas.includes(c));
  if (faltan.length) return { ok: false, motivo: 'faltan_columnas', detalle: faltan.join(','), columnas };
  if (columnas.join(' ') !== COLUMNAS.join(' ')) return { ok: false, motivo: 'columnas_en_otro_orden', detalle: columnas.join(' '), columnas };
  /* las unidades (la línea siguiente, si tiene corchetes) */
  const lu = lineas[iEnc + 1] || '';
  const unidades = /\[/.test(lu) ? palabras(lu).map((w) => w.t) : [];
  const hora = unidades.some((u) => /UTC|GMT/i.test(u)) ? 'UTC' : 'HOA';
  if (hora !== 'HOA') return { ok: false, motivo: 'hora_no_es_hoa', detalle: unidades.join(' '), columnas };
  const firma = columnas.join(' ') + ' | ' + unidades.join(' ');
  const finCol = Object.fromEntries(enc.map((w) => [w.t.toUpperCase(), w.fin]));
  const iniNombre = enc.find((w) => w.t.toUpperCase() === 'NOMBRE').ini;

  const registros = [], descartadas = [];
  let filas = 0;
  for (let i = iEnc + (unidades.length ? 2 : 1); i < lineas.length; i++) {
    const l = lineas[i];
    if (!l.trim()) continue;
    filas++;
    const ws = palabras(l);
    const f = ws[0] && fechaDe(ws[0].t);
    const h = ws[1] && /^\d{1,2}$/.test(ws[1].t) ? Number(ws[1].t) : null;
    if (!f) { descartadas.push({ n: i + 1, motivo: 'fecha' }); continue; }
    if (h == null || h > 23) { descartadas.push({ n: i + 1, motivo: 'hora' }); continue; }
    /* los números van hasta donde empieza el nombre; el nombre, desde su columna (o desde la primera palabra que no
       es un número, si la fila viene corrida). Más de 5 números antes del nombre: los 5 primeros son los valores
       («25 DE MAYO» empieza con un número). */
    const resto = ws.slice(2);
    let k = 0;
    while (k < NUMERICAS.length && k < resto.length && numero(resto[k].t) !== undefined && resto[k].ini < iniNombre - 1) k++;
    const nums = resto.slice(0, k);
    const nombre = l.slice(resto[nums.length] ? resto[nums.length].ini : l.length).trim();
    if (!nombre) { descartadas.push({ n: i + 1, motivo: 'sin_nombre' }); continue; }
    const v = { temp: null, hum: null, pnm: null, dd: null, ff: null };
    if (nums.length === NUMERICAS.length) NUMERICAS.forEach(([, k2], j) => { v[k2] = numero(nums[j].t); });
    else {
      /* faltan campos (blancos): cada número va a la columna cuyo fin está más cerca; dos en la misma = no se entiende */
      const usadas = new Set(); let ambigua = false;
      for (const w of nums) {
        let mejor = null, dist = Infinity;
        for (const [col, k2] of NUMERICAS) { const d = Math.abs(finCol[col] - w.fin); if (d < dist) { dist = d; mejor = k2; } }
        if (usadas.has(mejor) || dist > 4) { ambigua = true; break; }
        usadas.add(mejor); v[mejor] = numero(w.t);
      }
      if (ambigua) { descartadas.push({ n: i + 1, motivo: 'columnas_ambiguas' }); continue; }
    }
    registros.push({ id: idDeNombre(nombre), nombre, fecha: f, local: `${f}T${p2(h)}:00`, v });
  }
  if (filas && descartadas.length / filas > MAX_DESCARTADAS) {
    return { ok: false, motivo: 'filas_rotas', detalle: `${descartadas.length} de ${filas}`, columnas };
  }
  if (!registros.length) return { ok: false, motivo: 'sin_filas', columnas };
  /* la fecha del archivo: la más repetida (un archivo trae un día) */
  const cuenta = new Map();
  for (const r of registros) cuenta.set(r.fecha, (cuenta.get(r.fecha) || 0) + 1);
  const fecha_archivo = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { ok: true, firma, columnas, unidades, hora, registros, descartadas, filas, fecha_archivo, fechas: [...cuenta.keys()].sort() };
}
