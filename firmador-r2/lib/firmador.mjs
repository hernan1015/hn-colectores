// HN AGRO · firmador-r2 · el núcleo: qué claves se firman, cómo se verifica y qué se escribe.
// LAS CLAVES SON LAS QUE BUSCAN LAS FUNCTIONS DE hn-agro (select url, vence from public.r2_enlaces where clave = …):
//   tormentas  · proyeccion-tormentas.js           'tormentas/proyeccion_tormentas.json'                  (1)
//   escenarios · escenarios-rio.js                 'escenarios/' + indice|brasil|parana|paraguay + '.json' (4)
//   opera      · _lib/satchi-opera-fecha.js        'opera/cog/pasadas.json' y 'opera/cog/cuenca-del-plata/AAAA-MM-DD.tif'
//                (los mosaicos esperados: un día por fecha entre «desde» y «hasta» de pasadas.json; hoy 91)
//   rayos-hora · lib/rayos-previos.mjs (rama feat/satchi-p3-filtros-rayos) 'rayos-hora/AAAA/MM/DD/HH.json', las horas
//                de los últimos DIAS_RAYOS días (3 por defecto: las 24 h de la ficha + 48 h de margen para focos de hasta
//                2 días atrás). Lo que sobra en R2 (candado.json, alertas.txt, _subida/, crudo/…) no se firma.
// 2.ª vuelta (8/11, revisión Codex n3):
//   - CADA objeto se verifica por su enlace recién firmado, uno por uno: los JSON se bajan enteros y tienen que
//     leerse y parsear; los .tif y las horas, 1 byte (Range, 206). Un objeto que no pasa NO se escribe (queda el
//     enlace que había); los demás del grupo sí.
//   - Las horas de rayos que faltan se cuentan como faltantes: el resultado no es OK.
//   - Nunca se imprime e.message: sólo códigos (errores.mjs).
// Nada se inventa: lo que falta se dice en el resumen.
import { codigoDe } from './errores.mjs';

export const TORMENTAS = ['tormentas/proyeccion_tormentas.json'];
export const ESCENARIOS = ['indice', 'brasil', 'parana', 'paraguay'].map((a) => 'escenarios/' + a + '.json');
export const OPERA_INDICE = 'opera/cog/pasadas.json';
export const OPERA_MOSAICO = /^opera\/cog\/cuenca-del-plata\/(\d{4}-\d{2}-\d{2})\.tif$/;
export const RAYOS_HORA = /^rayos-hora\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\.json$/;
export const OPERA_ESPERADOS = 91;
export const DIAS_RAYOS = 3;
export const MAX_DIAS_RAYOS = 7;
const PARALELO = 8;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const H = 3600e3;
const dd = (n) => String(n).padStart(2, '0');
const isoDia = (ms) => new Date(ms).toISOString().slice(0, 10);

/** PURA. La clave de la hora que empieza en ms (igual que claveDe de rayos-previos y claveHora de rayos-hora) */
export function claveHora(ms) {
  const d = new Date(ms);
  return `rayos-hora/${d.getUTCFullYear()}/${dd(d.getUTCMonth() + 1)}/${dd(d.getUTCDate())}/${dd(d.getUTCHours())}.json`;
}
/** PURA. Las horas CERRADAS de los últimos `dias` días: [ahora - dias·24 h, última hora en punto) → claves */
export function horasVentana(ahoraMs, dias) {
  const fin = Math.floor(ahoraMs / H) * H;
  const out = [];
  for (let h = fin - dias * 24 * H; h < fin; h += H) out.push(claveHora(h));
  return out;
}
/** PURA. Los prefijos de día que tocan esas claves ('rayos-hora/AAAA/MM/DD/') */
export function diasDe(claves) { return [...new Set(claves.map((k) => k.slice(0, -'HH.json'.length)))]; }
/** PURA. Los días entre desde y hasta (inclusive), 'AAAA-MM-DD'. Tope 400 días. */
export function diasEntre(desde, hasta) {
  if (!ISO.test(String(desde || '')) || !ISO.test(String(hasta || ''))) return [];
  const a = Date.parse(desde + 'T00:00:00Z'), b = Date.parse(hasta + 'T00:00:00Z');
  if (!(b >= a) || b - a > 400 * 864e5) return [];
  const out = [];
  for (let t = a; t <= b; t += 864e5) out.push(isoDia(t));
  return out;
}
/** PURA. El «emitido» de un JSON de tormentas/escenarios (el índice: el más nuevo de sus renglones) */
export function emitidoDe(clave, j) {
  if (!j || typeof j !== 'object') return null;
  if (clave === 'escenarios/indice.json') {
    const L = Array.isArray(j) ? j : Array.isArray(j.cuencas) ? j.cuencas : [];
    const m = L.map((x) => String((x && x.emitido) || '')).filter((s) => ISO.test(s)).sort().pop();
    return m || null;
  }
  if (clave === OPERA_INDICE) return ISO.test(String(j.hasta || '')) ? j.hasta : null;
  return ISO.test(String(j.emitido || '')) ? j.emitido : null;
}

const nuevoGrupo = (nombre) => ({ nombre, encontrados: 0, firmados: 0, verificados: 0, rechazados: 0, ignorados: 0, faltan: [], avisos: [], errores: [], filas: [] });

/** corre fn sobre la lista con `n` a la vez */
async function enParalelo(lista, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => { while (i < lista.length) { const j = i++; await fn(lista[j], j); } }));
}

/**
 * dep: { listar(prefijo) → [{clave, bytes}], presignar(clave, fecha) → {url, vence}, fetchFn, upsert(filas) → {nuevas, actualizadas, sinCambio} }
 * → resumen { fecha, grupos:{…}, base, errores, faltan, ok, codigo }
 */
export async function correr(dep, { ahora = new Date(), diasRayos = DIAS_RAYOS, operaEsperados = OPERA_ESPERADOS } = {}) {
  const { listar, presignar, fetchFn, upsert } = dep;
  const fecha = new Date(Math.floor(ahora.getTime() / 1000) * 1000);
  diasRayos = Math.max(1, Math.min(MAX_DIAS_RAYOS, Math.trunc(Number(diasRayos)) || DIAS_RAYOS));
  const g = { tormentas: nuevoGrupo('tormentas'), escenarios: nuevoGrupo('escenarios'), opera: nuevoGrupo('opera'), rayos: nuevoGrupo('rayos-hora') };

  /** firma el objeto → {url, vence} | null (un fallo al firmar es un rechazo) */
  const firmarObj = (grupo, o) => {
    try { const x = presignar(o.clave, fecha); grupo.firmados++; return x; }
    catch (e) { grupo.errores.push(`${o.clave}: no se pudo firmar (${codigoDe(e)})`); grupo.rechazados++; return null; }
  };
  const rechazar = (grupo, clave, motivo) => { grupo.errores.push(`${clave}: ${motivo}; queda el enlace que había`); grupo.rechazados++; };
  const aceptar = (grupo, o, f, emitido) => { grupo.filas.push({ clave: o.clave, url: f.url, vence: f.vence, emitido: emitido || null, bytes: o.bytes }); grupo.verificados++; };

  /** JSON: GET entero por el enlace recién firmado; 2xx, cuerpo leído y JSON que parsea. → { j, f } | null (rechazado) */
  const verificarJson = async (grupo, o) => {
    const f = firmarObj(grupo, o);
    if (!f) return null;
    let r, texto, j;
    try { r = await fetchFn(f.url, { method: 'GET', signal: AbortSignal.timeout(60000) }); }
    catch (e) { rechazar(grupo, o.clave, `el GET firmado no respondió (${codigoDe(e)})`); return null; }
    if (!r.ok) { try { await r.body?.cancel(); } catch { /* nada */ } rechazar(grupo, o.clave, `el GET firmado contestó HTTP ${Number(r.status) || 0}`); return null; }
    try { texto = await r.text(); }
    catch (e) { rechazar(grupo, o.clave, `no se pudo leer el cuerpo (${codigoDe(e)})`); return null; }
    try { j = JSON.parse(texto); } catch { rechazar(grupo, o.clave, 'no es JSON válido'); return null; }
    if (!j || typeof j !== 'object') { rechazar(grupo, o.clave, 'el JSON no es un objeto ni una lista'); return null; }
    return { j, f };
  };
  /** .tif y horas: 1 byte (Range) por el enlace recién firmado: 206 y el byte leído (o 200 si el objeto está vacío) */
  const verificarByte = async (grupo, o, emitido) => {
    const f = firmarObj(grupo, o);
    if (!f) return;
    let r;
    try { r = await fetchFn(f.url, { method: 'GET', headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { rechazar(grupo, o.clave, `el GET firmado no respondió (${codigoDe(e)})`); return; }
    const vacio = r.status === 200 && o.bytes === 0;
    if (r.status !== 206 && !vacio) {
      try { await r.body?.cancel(); } catch { /* nada */ }
      rechazar(grupo, o.clave, `el GET firmado contestó HTTP ${Number(r.status) || 0}`);
      return;
    }
    try { await r.arrayBuffer(); } catch (e) { rechazar(grupo, o.clave, `no se pudo leer el cuerpo (${codigoDe(e)})`); return; }
    aceptar(grupo, o, f, emitido);
  };
  const listado = async (grupo, prefijo) => {
    try { return await listar(prefijo); }
    catch (e) { grupo.errores.push(`listar ${prefijo}: ${codigoDe(e)}`); return null; }
  };

  // ── tormentas y escenarios: claves fijas, JSON chicos (se leen enteros para sacar «emitido») ──
  for (const [grupo, prefijo, esperadas] of [[g.tormentas, 'tormentas/', TORMENTAS], [g.escenarios, 'escenarios/', ESCENARIOS]]) {
    const L = await listado(grupo, prefijo);
    if (!L) { grupo.faltan.push(...esperadas.map((k) => k + ' (sin listado)')); continue; }
    const por = new Map(L.map((o) => [o.clave, o]));
    grupo.encontrados = L.length;
    for (const k of esperadas) {
      const o = por.get(k);
      if (!o) { grupo.faltan.push(k); continue; }
      const v = await verificarJson(grupo, o);
      if (!v) continue;
      const e = emitidoDe(k, v.j);
      if (!e) grupo.avisos.push(`${k}: sin «emitido» legible (queda el que había)`);
      aceptar(grupo, o, v.f, e);
    }
    grupo.ignorados = L.length - (esperadas.length - grupo.faltan.length);
  }

  // ── OPERA: pasadas.json + un mosaico por día entre desde y hasta ──
  {
    const grupo = g.opera;
    const L = await listado(grupo, 'opera/cog/');
    if (!L) grupo.faltan.push(OPERA_INDICE + ' (sin listado)', `los ${operaEsperados} mosaicos (sin listado)`);
    else {
      grupo.encontrados = L.length;
      const indice = L.find((o) => o.clave === OPERA_INDICE);
      let esperadas = null;
      if (!indice) grupo.faltan.push(OPERA_INDICE);
      else {
        const v = await verificarJson(grupo, indice);
        if (v) {
          aceptar(grupo, indice, v.f, emitidoDe(OPERA_INDICE, v.j));
          esperadas = diasEntre(v.j.desde, v.j.hasta);
          if (!esperadas.length) grupo.avisos.push(`${OPERA_INDICE}: sin «desde»/«hasta» legibles (no se puede decir qué mosaicos faltan)`);
        } else grupo.avisos.push(`${OPERA_INDICE} no pasó la verificación: no se puede decir qué mosaicos faltan`);
      }
      const mosaicos = L.filter((o) => OPERA_MOSAICO.test(o.clave));
      await enParalelo(mosaicos, PARALELO, (o) => verificarByte(grupo, o, OPERA_MOSAICO.exec(o.clave)[1]));
      if (esperadas && esperadas.length) {
        const hay = new Set(mosaicos.map((o) => OPERA_MOSAICO.exec(o.clave)[1]));
        for (const d of esperadas) if (!hay.has(d)) grupo.faltan.push(`opera/cog/cuenca-del-plata/${d}.tif`);
      }
      if (mosaicos.length !== operaEsperados) grupo.avisos.push(`mosaicos: ${mosaicos.length} (se esperaban ${operaEsperados})`);
      grupo.ignorados = L.length - mosaicos.length - (indice ? 1 : 0);
    }
  }

  // ── rayos-hora: las horas cerradas de los últimos diasRayos días; las que faltan SE CUENTAN como faltantes ──
  {
    const grupo = g.rayos;
    const ventana = horasVentana(fecha.getTime(), diasRayos);
    const enVentana = new Set(ventana);
    const hay = new Map();
    const sinListado = new Set();
    for (const p of diasDe(ventana)) {
      const L = await listado(grupo, p);
      if (!L) { sinListado.add(p); continue; }
      grupo.encontrados += L.length;
      for (const o of L) if (RAYOS_HORA.test(o.clave) && enVentana.has(o.clave)) hay.set(o.clave, o);
    }
    const presentes = ventana.filter((k) => hay.has(k)).map((k) => hay.get(k));
    await enParalelo(presentes, PARALELO, (o) => verificarByte(grupo, o, o.clave.slice(11, 21).replace(/\//g, '-')));
    for (const k of ventana) if (!hay.has(k)) grupo.faltan.push(k + (sinListado.has(k.slice(0, -'HH.json'.length)) ? ' (sin listado)' : ''));
    grupo.ignorados = grupo.encontrados - presentes.length;
    grupo.ventana = ventana.length;
  }

  // ── la base: un solo upsert con lo que pasó la verificación, objeto por objeto ──
  const filas = Object.values(g).flatMap((x) => x.filas);
  let base = { nuevas: 0, actualizadas: 0, sinCambio: 0, filas: filas.length, error: null };
  try { if (filas.length) base = { ...base, ...(await upsert(filas)) }; }
  catch (e) { base.error = `upsert: ${codigoDe(e)}`; }

  const errores = Object.values(g).reduce((n, x) => n + x.errores.length, 0) + (base.error ? 1 : 0);
  const faltan = Object.values(g).reduce((n, x) => n + x.faltan.length, 0);
  const ok = errores === 0 && faltan === 0;
  for (const grupo of Object.values(g)) delete grupo.filas;
  return { fecha: fecha.toISOString(), diasRayos, grupos: g, base, errores, faltan, ok, codigo: ok ? 0 : 1 };
}

/** PURA. Resumen en Markdown (para la consola y $GITHUB_STEP_SUMMARY). Sin URL ni llaves: sólo claves y códigos. */
export function resumenMd(r) {
  const L = [`## firmador-r2 · ${r.fecha} · ${r.ok ? 'OK' : `CON PROBLEMAS (${r.faltan} faltan, ${r.errores} errores)`}`, '',
    '| prefijo | en R2 | firmados | verificados y escritos | rechazados | ignorados | faltan | errores |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const x of Object.values(r.grupos)) L.push(`| ${x.nombre}${x.ventana ? ` (ventana ${x.ventana} h, ${r.diasRayos} d)` : ''} | ${x.encontrados} | ${x.firmados} | ${x.verificados} | ${x.rechazados} | ${x.ignorados} | ${x.faltan.length} | ${x.errores.length} |`);
  L.push('', `**r2_enlaces:** ${r.base.filas} filas enviadas · ${r.base.nuevas} nuevas · ${r.base.actualizadas} actualizadas · ${r.base.sinCambio} sin cambio (ya tenían un enlace que vence igual o después)` + (r.base.error ? ` · **${r.base.error}**` : ''));
  for (const x of Object.values(r.grupos)) {
    if (x.ventana && x.faltan.length) L.push(`- **faltan ${x.faltan.length} de ${x.ventana} horas** de rayos-hora`);
    for (const f of x.faltan.slice(0, 20)) L.push(`- **falta** ${f}`);
    if (x.faltan.length > 20) L.push(`- **faltan** ${x.faltan.length - 20} más en ${x.nombre}`);
    for (const a of x.avisos) L.push(`- aviso ${x.nombre}: ${a}`);
    for (const e of x.errores.slice(0, 30)) L.push(`- **error** ${x.nombre}: ${e}`);
    if (x.errores.length > 30) L.push(`- **errores** ${x.errores.length - 30} más en ${x.nombre}`);
  }
  return L.join('\n') + '\n';
}
