#!/usr/bin/env node
// HN AGRO · colector del SMN, DATOS ABIERTOS («datos horarios»). Primer conector de la red nacional (139).
// Red `SMN_ABIERTO`, marcada MOSTRAR (CC BY 2.5 AR, citando al SMN: ver lib/licencia.mjs).
//
//   node smn-abierto/smn.mjs [--seco] [--ultimo] [--aceptar-formato <firma>] [--archivo ruta.zip] [--ahora ISO]
//     --seco      baja y calcula, pero no escribe en la base ni en los releases (imprime sólo cantidades)
//     --ultimo    es el último intento del día: si el archivo sigue vacío, avisa
//     --archivo   no baja nada: lee el ZIP de un archivo (pruebas con el fixture real)
//
// QUÉ BAJA: UN pedido por corrida a ssl.smn.gob.ar/dpd/zipopendata.php?dato=datohorario (el ZIP del catálogo de datos
// abiertos; trae datohorarioAAAAMMDD.txt, las lecturas horarias del DÍA ANTERIOR de todas las estaciones). El SMN lo
// publica UNA vez por día: el colector corre dos veces (10:17 y 16:17 de Argentina, pg_cron, 0149b) y la segunda NO
// pide nada si el archivo de ayer ya se cargó. Nunca más seguido que eso.
// ⛔ POLÍTICA DEL SMN (§4.C): la demanda periódica CON garantía de servicio se cobra. Acá no se pide ninguna: se lee el
//    archivo público tal como está, sin clave, sin acuerdo, sin reintentos agresivos.
// ⛔ CLOUDFLARE: smn.gob.ar pone un desafío a los programas (402/403). ssl.smn.gob.ar/dpd respondió 200 sin desafío
//    (14/11/2026 03:29, un solo pedido). Si algún día responde un desafío (HTML «Just a moment», 403, 429, 5xx), la corrida
//    se CORTA y avisa (smn_corto). NO se evade: ni otro User-Agent, ni cookies, ni navegador.
// User-Agent genérico (sin datos de nadie).
//
// Controles (como el SIPAN y su PR #4): dedup por estación e instante (dentro del archivo y contra lo guardado);
// faltante = null (nunca 0; el archivo no trae lluvia: lluvia siempre null); valores imposibles marcados (no entran en
// los resúmenes); formato cambiado → aviso y NO se carga; estación sin datos nuevos hace más de 48 h → aviso
// (estacion_quieta); a los 30 días → INACTIVA en el catálogo, con UN aviso al cambiar de estado (y otro si revive).
// Con avisos o errores el proceso sale con código 2 (Actions lo marca). El registro de Actions es PÚBLICO: se
// imprimen sólo cantidades, nunca valores ni claves.
import { leerZip } from './lib/zip.mjs';
import { leerDatoHorario } from './lib/datohorario.mjs';
import { unir, controlar, resumenDia, resumenNoche, sumarDias, diaDe, ESPERADAS_DIA, ESPERADAS_NOCHE } from './lib/resumen.mjs';
import { metaLicencia, LICENCIA_SMN } from './lib/licencia.mjs';
import { crearBase, RED } from './lib/base.mjs';
import { clienteReleases, selloUTC } from '../lib/releases.mjs';

export const URL_SMN = 'https://ssl.smn.gob.ar/dpd/zipopendata.php?dato=datohorario';
export const USER_AGENT = 'Mozilla/5.0 (compatible; colector-agrometeorologico/1.0)';
export const TOPE_PEDIDOS = 1;          // UN pedido por corrida
export const QUIETA_H = 48;             // el archivo es del día anterior: más de 48 h sin datos ya es raro
export const INACTIVA_DIAS = 30;
const PROCESO = 'smn_abierto';

const msLocal = (local) => Date.parse(local + ':00Z') + 3 * 3600e3;                  // local (UTC−3) → UTC real
const hoyLocal = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);

/** Un pedidor educado: tope de pedidos y se corta ante la primera señal de bloqueo o desafío. */
export function crearPedidor({ fetchFn = globalThis.fetch, tope = TOPE_PEDIDOS } = {}) {
  let pedidos = 0, cortado = null;
  return {
    get pedidos() { return pedidos; }, get cortado() { return cortado; },
    async pedir(url) {
      if (cortado) return { estado: 'cortado' };
      if (pedidos >= tope) return { estado: 'tope' };
      pedidos++;
      let r;
      try { r = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/zip,application/octet-stream;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(60000) }); }
      catch { cortado = 'corte de conexión'; return { estado: 'cortado' }; }
      if (r.status === 402 || r.status === 403 || r.status === 429 || r.status >= 500) { cortado = 'HTTP ' + r.status; return { estado: 'cortado', status: r.status }; }
      if (r.status >= 300 && r.status < 400) { cortado = 'redirección ' + r.status + ' (¿desafío?)'; return { estado: 'cortado', status: r.status }; }
      if (!r.ok) return { estado: 'no', status: r.status };
      const buf = Buffer.from(await r.arrayBuffer());
      const tipo = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
      /* un desafío de Cloudflare viene como HTML con 200 o 403: si no es un ZIP y parece HTML, se corta (no se evade) */
      if (/text\/html/i.test(tipo) || /^\s*</.test(buf.subarray(0, 64).toString('latin1'))) { cortado = 'respuesta HTML (¿desafío de Cloudflare?)'; return { estado: 'cortado', status: r.status }; }
      return { estado: 'ok', status: r.status, buf, nombre: nombreDeDisposicion(r.headers && r.headers.get && r.headers.get('content-disposition')) };
    },
  };
}
const nombreDeDisposicion = (cd) => ((/filename="?([^";]+)"?/i.exec(String(cd || '')) || [])[1] || null);

/** La fila de `estaciones` (0110). La licencia va AL FINAL: lo guardado de corridas anteriores no la pisa. */
export function filaEstacion({ id, nombre, estado = 'activa' }, metadatos = {}) {
  return {
    red: RED, estacion_id: id, nombre, partido: null, provincia: null,
    lat: null, lon: null, precision_ubicacion: null, fuente_ubicacion: null,   // el datohorario no trae coordenadas (PRENDER)
    activa: estado !== 'inactiva',
    metadatos: {
      ...metadatos,
      red_interna: 'SMN · datos abiertos (datos horarios)', url: URL_SMN, nombre_smn: nombre,
      tipo: 'estación del SMN: lecturas horarias de TEMP, HUM, PNM, DD y FF (sin lluvia)', hora: 'HOA (UTC−3)',
      ...metaLicencia(LICENCIA_SMN),
    },
    actualizado_en: new Date().toISOString(),
  };
}

/** El estado de una estación según su último registro (hora local) y el estado guardado (como el PR #4 del SIPAN). */
export function estadoDe({ ultimoLocal = null, metaPrevia = {}, ahoraMs = Date.now() }) {
  const previo = metaPrevia.estado === 'inactiva' ? 'inactiva' : 'activa';
  if (!ultimoLocal) return { estado: previo, cambio: null, horas: null };
  const horas = (ahoraMs - msLocal(ultimoLocal)) / 3600e3;
  const estado = horas > INACTIVA_DIAS * 24 ? 'inactiva' : 'activa';
  const cambio = estado === previo ? null : estado === 'inactiva' ? 'estacion_inactiva' : 'estacion_revivio';
  return { estado, cambio, horas };
}
const metaDeEstado = (st, previa, ahoraMs) => ({
  estado: st.estado, activa: st.estado === 'activa',
  estado_desde: st.cambio || !previa.estado_desde ? new Date(ahoraMs).toISOString() : previa.estado_desde,
});

/** La firma aceptada: la que tiene la mayoría de las estaciones guardadas (null si no hay ninguna). */
export function firmaPrevia(estado) {
  const c = new Map();
  for (const m of estado.values()) if (m.formato_firma) c.set(m.formato_firma, (c.get(m.formato_firma) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** Las lecturas guardadas de una fila (crudo.temp_horaria) → lecturas con sólo la temperatura. */
const deFila = (fila) => Object.entries((fila && fila.crudo && fila.crudo.temp_horaria) || {}).map(([local, temp]) => ({ local, v: { temp } }));

/** La fila de estaciones_obs para D: lo nuevo junto con lo guardado; por parte, gana lo más completo. */
export function filaObs({ id, fecha, controladas, firma, archivo, viejo = null }) {
  const dia = resumenDia(controladas, fecha), noche = resumenNoche(controladas, fecha);
  const usarDia = !viejo || dia.registros_validos >= (viejo.registros_validos ?? -1);
  const usarNoche = !viejo || noche.registros_validos >= (viejo.noche_registros ?? -1);
  const vc = (viejo && viejo.crudo) || {};
  const enDia = controladas.filter((r) => diaDe(r.local) === fecha);
  return {
    red: RED, estacion_id: id, fecha, hora_corte: '00:00', url: URL_SMN,
    muestreo_min: 60, lluvia_origen: null, lluvia_mm: null, horas_validas: null,      // sin lluvia en el datohorario
    ...(usarDia
      ? { tmin_c: dia.tmin_c, tmax_c: dia.tmax_c, registros_validos: dia.registros_validos, registros_esperados: ESPERADAS_DIA }
      : { tmin_c: viejo.tmin_c, tmax_c: viejo.tmax_c, registros_validos: viejo.registros_validos, registros_esperados: viejo.registros_esperados }),
    ...(usarNoche
      ? { tmin_noche_c: noche.tmin_noche_c, tmin_noche_en: noche.tmin_noche_en, noche_registros: noche.registros_validos, noche_esperados: ESPERADAS_NOCHE }
      : { tmin_noche_c: viejo.tmin_noche_c, tmin_noche_en: viejo.tmin_noche_en, noche_registros: viejo.noche_registros, noche_esperados: viejo.noche_esperados }),
    crudo: {
      fuente: LICENCIA_SMN.cita, licencia: LICENCIA_SMN.licencia, toma: 'github-actions', formato_firma: firma, archivo,
      /* las lecturas de temperatura del día (0110), TAL COMO VINIERON (también las marcadas): con esto se rearma el día
         y la noche cuando llega el archivo siguiente. ~24 números por fila. */
      temp_horaria: usarDia ? Object.fromEntries(enDia.map((r) => [r.local, r.v.temp])) : vc.temp_horaria || {},
      marcas: usarDia ? Object.fromEntries(enDia.filter((r) => r.marcas.length).map((r) => [r.local, r.marcas])) : vc.marcas || {},
      dia: usarDia ? dia : vc.dia || null, noche: usarNoche ? noche : vc.noche || null,
    },
    leido_en: new Date().toISOString(),
  };
}

/** El ZIP → el archivo leído y controlado (formato, firma, fecha), o el motivo por el que NO se carga. Función pura. */
export function abrirArchivo({ buf, estado = new Map(), aceptar = null, ultimo = false }) {
  const z = leerZip(buf);
  if (!z.ok) return { estado: 'formato', aviso: { tipo: 'formato_no_se_entiende', motivo: z.motivo } };
  const txts = z.entradas.filter((e) => /^datohorario\d{8}\.txt$/i.test(e.nombre));
  if (z.entradas.length !== 1 || txts.length !== 1) return { estado: 'formato', aviso: { tipo: 'formato_no_se_entiende', motivo: 'zip_con_otras_entradas', entradas: z.entradas.length } };
  const archivo = txts[0].nombre;
  const fechaNombre = archivo.replace(/^datohorario(\d{4})(\d{2})(\d{2})\.txt$/i, '$1-$2-$3');
  const p = leerDatoHorario(txts[0].datos.toString('latin1'));
  if (!p.ok && p.motivo === 'vacio') {
    return { estado: 'vacio', archivo, aviso: ultimo ? { tipo: 'archivo_vacio', archivo, fecha: fechaNombre } : null };
  }
  if (!p.ok) return { estado: 'formato', archivo, aviso: { tipo: 'formato_no_se_entiende', motivo: p.motivo, detalle: p.detalle, columnas: p.columnas } };
  const previa = firmaPrevia(estado);
  if (previa && previa !== p.firma && aceptar !== p.firma) {
    return { estado: 'formato', archivo, aviso: { tipo: 'formato_cambiado', firma_previa: previa, firma_nueva: p.firma } };
  }
  if (p.fecha_archivo !== fechaNombre) return { estado: 'formato', archivo, aviso: { tipo: 'formato_no_se_entiende', motivo: 'fecha_distinta_del_nombre', fecha_filas: p.fecha_archivo, fecha_nombre: fechaNombre } };
  return { estado: 'ok', archivo, p, fecha: p.fecha_archivo };
}

/** Las fechas de estaciones_obs que hay que leer para un archivo del día F. */
export const fechasALeer = (F) => [sumarDias(F, -2), sumarDias(F, -1), F];

/** Un archivo ya bajado (el ZIP) → lo que se escribiría. No escribe. */
export function procesarArchivo({ buf, nombreDescarga = null, estado = new Map(), viejas = [], aceptar = null, ahoraMs = Date.now(), ultimo = false }) {
  const ab = abrirArchivo({ buf, estado, aceptar, ultimo });
  if (ab.estado !== 'ok') return ab;
  const { archivo, p } = ab;
  const avisos = [];
  const F = p.fecha_archivo, ayer = sumarDias(hoyLocal(ahoraMs), -1);
  if (F < ayer) avisos.push({ tipo: 'archivo_viejo', fecha: F, ayer });
  /* sólo las filas del día del archivo; las de otra fecha se cuentan y no entran */
  const delDia = p.registros.filter((r) => r.fecha === F);
  const otraFecha = p.registros.length - delDia.length;

  /* las filas guardadas de F−2, F−1 y F, por estación */
  const fechas = fechasALeer(F);
  const guardadas = new Map();
  for (const f of viejas) (guardadas.get(f.estacion_id) || guardadas.set(f.estacion_id, []).get(f.estacion_id)).push(f);
  const porEst = new Map();
  for (const r of delDia) (porEst.get(r.id) || porEst.set(r.id, { nombre: r.nombre, lecturas: [] }).get(r.id)).lecturas.push(r);

  const filasObs = [], estaciones = [], marcas = {};
  let repetidasArchivo = 0, repetidasGuardadas = 0;
  for (const [id, { nombre, lecturas }] of porEst) {
    const u0 = unir([], lecturas); repetidasArchivo += u0.repetidas;            // la misma estación y hora dos veces en el archivo
    const filasViejas = guardadas.get(id) || [];
    const previas = filasViejas.flatMap(deFila);
    const u = unir(previas, u0.lecturas);
    repetidasGuardadas += u.repetidas;
    const ctrl = controlar(u.lecturas);
    for (const r of ctrl) if (diaDe(r.local) >= sumarDias(F, -1)) for (const m of r.marcas) marcas[m] = (marcas[m] || 0) + 1;
    const viejoDe = new Map(filasViejas.map((f) => [String(f.fecha).slice(0, 10), f]));
    for (const D of [sumarDias(F, -1), F]) {
      if (!ctrl.some((r) => diaDe(r.local) === D || (r.local > sumarDias(D, -1) + 'T18:00' && r.local <= D + 'T09:00'))) continue;
      filasObs.push(filaObs({ id, fecha: D, controladas: ctrl, firma: p.firma, archivo, viejo: viejoDe.get(D) || null }));
    }
    /* el último registro con ALGÚN valor válido (una estación que manda sólo vacíos envejece y queda inactiva) */
    const conDato = ctrl.filter((r) => Object.values(r.ok).some((x) => x != null)).map((r) => r.local).sort();
    const metaPrevia = estado.get(id) || {};
    const ultimoReg = [conDato.at(-1), metaPrevia.ultimo_registro].filter(Boolean).sort().at(-1) || null;
    const st = estadoDe({ ultimoLocal: ultimoReg, metaPrevia, ahoraMs });
    if (st.cambio) avisos.push({ tipo: st.cambio, id, dias: Math.round(st.horas / 24), ultimo_registro: ultimoReg });
    else if (st.estado === 'activa' && st.horas != null && st.horas > QUIETA_H) avisos.push({ tipo: 'estacion_quieta', id, horas: Math.round(st.horas), ultimo_registro: ultimoReg });
    estaciones.push({ id, nombre, estado: st.estado, meta: { ...metaPrevia, formato_firma: p.firma, ultimo_registro: ultimoReg, ultimo_archivo: F, ultima_lectura: new Date(ahoraMs).toISOString(), ...metaDeEstado(st, metaPrevia, ahoraMs) } });
  }
  /* las del catálogo que NO vinieron en el archivo: el estado según lo guardado */
  const ausentes = [];
  for (const [id, meta] of estado) {
    if (porEst.has(id)) continue;
    const st = estadoDe({ ultimoLocal: meta.ultimo_registro || null, metaPrevia: meta, ahoraMs });
    if (st.cambio) { avisos.push({ tipo: st.cambio, id, dias: Math.round(st.horas / 24), ultimo_registro: meta.ultimo_registro }); ausentes.push({ id, nombre: meta.nombre_smn || id, estado: st.estado, meta: { ...meta, ...metaDeEstado(st, meta, ahoraMs) } }); }
    else if (st.estado === 'activa' && st.horas != null && st.horas > QUIETA_H) avisos.push({ tipo: 'estacion_quieta', id, horas: Math.round(st.horas), ultimo_registro: meta.ultimo_registro });
  }
  return {
    estado: 'ok', archivo, fecha: F, firma: p.firma, filasObs, estaciones, ausentes, avisos, marcas,
    cuentas: { filas: p.filas, lecturas: p.registros.length, descartadas: p.descartadas.length, otra_fecha: otraFecha, repetidas_en_archivo: repetidasArchivo, repetidas_con_lo_guardado: repetidasGuardadas, estaciones: porEst.size, nuevas: [...porEst.keys()].filter((id) => !estado.has(id)).length, ausentes: [...estado.keys()].filter((id) => !porEst.has(id)).length },
    nombreDescarga, fechasLeidas: fechas,
  };
}

/** Dónde va la copia del ZIP: un release por día (`smn-AAAA-MM-DD`) en el repo privado (SMN_CRUDOS_REPO + _TOKEN).
 *  Sin las variables, no se guarda la copia (el resumen diario igual se guarda). */
export function almacenDeEntorno(env, fetchFn = globalThis.fetch) {
  if (!env.SMN_CRUDOS_REPO) return null;
  const c = clienteReleases({ token: env.SMN_CRUDOS_TOKEN, repo: env.SMN_CRUDOS_REPO, fetchFn, userAgent: 'colector-agrometeorologico' });
  return {
    tipo: 'releases',
    async guardarZip(fecha, buf) {
      const rel = await c.release('smn-' + fecha, { crear: true, nombre: `SMN datos abiertos · ${fecha}`,
        notas: 'Copia del archivo «datos horarios» del SMN (ssl.smn.gob.ar/dpd), tal como se bajó. Fuente: Servicio Meteorológico Nacional, licencia CC BY 2.5 AR (https://creativecommons.org/licenses/by/2.5/ar/).' });
      const viejos = (await c.assets(rel)).filter((a) => a.name.startsWith('datohorario__') && a.name.endsWith('.zip'));
      return c.reemplazar(rel, { nombre: `datohorario__${selloUTC()}.zip`, cuerpo: buf, tipo: 'application/zip', viejos });
    },
  };
}

async function correrInterno({ seco = true, ultimo = false, aceptar = null, archivo = null, env = process.env, fetchFn = globalThis.fetch,
  ahoraMs = Date.now(), log = console.log, base = null, almacen: almacenDado = null } = {}) {
  const almacen = seco ? null : almacenDado || almacenDeEntorno(env, fetchFn);
  const estado = base ? new Map((await base.estaciones()).map((f) => [f.estacion_id, { ...(f.metadatos || {}) }])) : new Map();
  const avisos = [], errores = [];
  const resumen = { modo: seco ? 'seco' : 'real', pedidos: 0, ultimo_intento: ultimo, crudos: almacen ? almacen.tipo : 'sin destino (sólo el resumen diario)' };
  const fin = async (extra = {}) => {
    Object.assign(resumen, extra, { avisos, errores: errores.length });
    if (!seco && base) { try { await base.registrar(PROCESO, avisos.length === 0 && errores.length === 0, { ...resumen, errores_detalle: errores.slice(0, 20) }); } catch { resumen.registro = 'no se pudo anotar'; } }
    log(JSON.stringify({ ...resumen, avisos: avisos.map((a) => `${a.tipo}${a.id ? ' ' + a.id : ''}`) }));
    return { resumen, avisos, errores };
  };

  /* LA FRECUENCIA: si el archivo de AYER ya está cargado, no se pide nada (el SMN lo publica una vez por día) */
  const ayer = sumarDias(hoyLocal(ahoraMs), -1);
  const cargado = [...estado.values()].map((m) => m.ultimo_archivo).filter(Boolean).sort().at(-1) || null;
  if (!archivo && cargado && cargado >= ayer) return fin({ estado: 'ya_cargado', ultimo_archivo: cargado });

  let buf, nombreDescarga = null;
  if (archivo) buf = archivo;
  else {
    const ped = crearPedidor({ fetchFn });
    const r = await ped.pedir(URL_SMN);
    resumen.pedidos = ped.pedidos;
    if (r.estado !== 'ok') {
      if (ped.cortado) avisos.push({ tipo: 'smn_corto', motivo: ped.cortado });
      else avisos.push({ tipo: 'no_responde', status: r.status });
      return fin({ estado: r.estado + (r.status ? ' ' + r.status : '') });
    }
    buf = r.buf; nombreDescarga = r.nombre;
  }
  const pre = abrirArchivo({ buf, estado, aceptar, ultimo });
  const viejas = base && pre.estado === 'ok' ? await base.obsFechas(fechasALeer(pre.fecha)) : [];
  const x = procesarArchivo({ buf, nombreDescarga, estado, viejas, aceptar, ahoraMs, ultimo });
  if (x.aviso) avisos.push(x.aviso);
  if (x.estado !== 'ok') return fin({ estado: x.estado, archivo: x.archivo || null });
  avisos.push(...x.avisos);
  const out = { estado: 'ok', archivo: x.archivo, fecha: x.fecha, ...x.cuentas, filas_obs: x.filasObs.length, marcas: x.marcas, filas_guardadas: 0, estaciones_guardadas: 0 };
  if (seco) return fin(out);

  /* la fila de `estaciones` va ANTES que sus datos (FK de la 0110). Si no se pudo guardar, no se intentan sus datos. */
  const guardadas = new Set();
  for (const e of [...x.estaciones, ...x.ausentes]) {
    try { await base.guardarEstaciones([filaEstacion(e, e.meta)]); guardadas.add(e.id); out.estaciones_guardadas++; }
    catch (err) { errores.push(`${e.id} estaciones: ${String(err && err.message).slice(0, 80)}`); }
  }
  /* las inactivas: sólo el catálogo (sus datos viejos no se vuelven a escribir) */
  const inactivas = new Set(x.estaciones.filter((e) => e.estado === 'inactiva').map((e) => e.id));
  const g = await base.guardarObs(x.filasObs.filter((f) => guardadas.has(f.estacion_id) && !inactivas.has(f.estacion_id)));
  out.filas_guardadas = g.ok; errores.push(...g.errores);
  if (almacen) {
    try { await almacen.guardarZip(x.fecha, buf); out.copia_zip = 'ok'; }
    catch (err) { errores.push(`copia del zip: ${String(err && err.message).slice(0, 80)}`); }
  }
  return fin(out);
}

/** La corrida: abre la base (SMN_PG_URL, rol colector_estaciones) sólo en modo real y la cierra siempre al final. */
export async function correr(op = {}) {
  const { seco = true, env = process.env, base: baseDada = null, conectar } = op;
  const base = seco ? null : baseDada || await crearBase({ url: env.SMN_PG_URL, ...(conectar ? { conectar } : {}) });
  try { return await correrInterno({ ...op, base }); }
  finally { if (base && !baseDada && base.cerrar) await base.cerrar(); }
}

const esPrincipal = !!process.argv[1] && (import.meta.url === 'file://' + process.argv[1] || import.meta.url.endsWith(String(process.argv[1]).replace(/\\/g, '/')));
if (esPrincipal) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const fs = await import('node:fs');
  const archivo = val('--archivo') ? fs.readFileSync(val('--archivo')) : null;
  const ahoraMs = val('--ahora') ? Date.parse(val('--ahora')) : Date.now();
  correr({ seco: a.includes('--seco'), ultimo: a.includes('--ultimo') || process.env.SMN_ULTIMO === 'si', aceptar: val('--aceptar-formato') || process.env.SMN_ACEPTAR_FORMATO || null, archivo, ahoraMs })
    .then((r) => { if (r.avisos.length || r.errores.length) { console.log('::warning::SMN: ' + r.avisos.map((x) => x.tipo + (x.id ? ' ' + x.id : '')).join(', ') + (r.errores.length ? ` · ${r.errores.length} errores` : '')); process.exitCode = 2; } })
    .catch((e) => { console.error('smn: ' + String(e && e.message).slice(0, 160)); process.exitCode = 1; });
}
