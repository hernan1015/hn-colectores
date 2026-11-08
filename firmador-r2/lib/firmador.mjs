// HN AGRO · firmador-r2 · el núcleo: qué claves se firman, cómo se verifica y qué se escribe.
// LAS CLAVES SON LAS QUE BUSCAN LAS FUNCTIONS DE hn-agro (select url, vence from public.r2_enlaces where clave = …):
//   tormentas  · proyeccion-tormentas.js           'tormentas/proyeccion_tormentas.json'                  (1)
//   escenarios · escenarios-rio.js                 'escenarios/' + indice|brasil|parana|paraguay + '.json' (4)
//   opera      · _lib/satchi-opera-fecha.js        'opera/cog/pasadas.json' y 'opera/cog/cuenca-del-plata/AAAA-MM-DD.tif'
//                (los mosaicos esperados: un día por fecha entre «desde» y «hasta» de pasadas.json; hoy 91)
//   rayos-hora · lib/rayos-previos.mjs (rama feat/satchi-p3-filtros-rayos) 'rayos-hora/AAAA/MM/DD/HH.json', las horas
//                de los últimos DIAS_RAYOS días (3 por defecto: las 24 h de la ficha + 48 h de margen para focos de hasta
//                2 días atrás). Lo que sobra en R2 (candado.json, alertas.txt, _subida/, crudo/…) no se firma.
// Nada se inventa: lo que falta se dice en el resumen. Si la verificación del enlace recién firmado falla en un
// prefijo, ese prefijo NO se escribe (no se pisa un enlace bueno de la PC con uno malo).

export const TORMENTAS = ['tormentas/proyeccion_tormentas.json'];
export const ESCENARIOS = ['indice', 'brasil', 'parana', 'paraguay'].map((a) => 'escenarios/' + a + '.json');
export const OPERA_INDICE = 'opera/cog/pasadas.json';
export const OPERA_MOSAICO = /^opera\/cog\/cuenca-del-plata\/(\d{4}-\d{2}-\d{2})\.tif$/;
export const RAYOS_HORA = /^rayos-hora\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\.json$/;
export const OPERA_ESPERADOS = 91;
export const DIAS_RAYOS = 3;
export const MAX_DIAS_RAYOS = 7;

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

const nuevoGrupo = (nombre) => ({ nombre, encontrados: 0, firmados: 0, ignorados: 0, faltan: [], avisos: [], errores: [], filas: [], bloqueado: false });

/**
 * dep: { listar(prefijo) → [{clave, bytes}], presignar(clave, fecha) → {url, vence}, fetchFn, upsert(filas) → {nuevas, actualizadas, sinCambio} }
 * → resumen { fecha, grupos:{…}, base, ok, codigo }
 */
export async function correr(dep, { ahora = new Date(), diasRayos = DIAS_RAYOS, operaEsperados = OPERA_ESPERADOS } = {}) {
  const { listar, presignar, fetchFn, upsert } = dep;
  const fecha = new Date(Math.floor(ahora.getTime() / 1000) * 1000);
  diasRayos = Math.max(1, Math.min(MAX_DIAS_RAYOS, Math.trunc(Number(diasRayos)) || DIAS_RAYOS));
  const g = { tormentas: nuevoGrupo('tormentas'), escenarios: nuevoGrupo('escenarios'), opera: nuevoGrupo('opera'), rayos: nuevoGrupo('rayos-hora') };

  const firmarObj = (grupo, o, emitido) => {
    const { url, vence } = presignar(o.clave, fecha);
    grupo.filas.push({ clave: o.clave, url, vence, emitido: emitido || null, bytes: o.bytes });
    grupo.firmados++;
    return url;
  };
  /** GET entero por el enlace recién firmado (los JSON chicos): → objeto JSON | null; marca bloqueado si no es 2xx */
  const leerJson = async (grupo, clave, url) => {
    let r;
    try { r = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(60000) }); }
    catch (e) { grupo.errores.push(`${clave}: el GET firmado no respondió (${e.name || 'error'})`); grupo.bloqueado = true; return null; }
    if (!r.ok) { grupo.errores.push(`${clave}: el GET firmado contestó HTTP ${r.status}`); grupo.bloqueado = true; return null; }
    try { return JSON.parse(await r.text()); } catch { grupo.avisos.push(`${clave}: no es JSON válido (emitido queda como estaba)`); return null; }
  };
  /** GET de 1 byte (Range) por el enlace recién firmado: para los .tif y las horas, que no se bajan */
  const probar = async (grupo, clave, url) => {
    let r;
    try { r = await fetchFn(url, { method: 'GET', headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { grupo.errores.push(`${clave}: el GET firmado no respondió (${e.name || 'error'})`); grupo.bloqueado = true; return; }
    if (r.status !== 206 && r.status !== 200) { grupo.errores.push(`${clave}: el GET firmado contestó HTTP ${r.status}`); grupo.bloqueado = true; }
    try { await r.arrayBuffer(); } catch { /* sólo se descarta el cuerpo */ }
  };
  const listado = async (grupo, prefijo) => {
    try { return await listar(prefijo); }
    catch (e) { grupo.errores.push(`listar ${prefijo}: ${e.message}`); grupo.bloqueado = true; return null; }
  };

  // ── tormentas y escenarios: claves fijas, JSON chicos (se leen enteros para sacar «emitido») ──
  for (const [grupo, prefijo, esperadas] of [[g.tormentas, 'tormentas/', TORMENTAS], [g.escenarios, 'escenarios/', ESCENARIOS]]) {
    const L = await listado(grupo, prefijo);
    if (!L) continue;
    const por = new Map(L.map((o) => [o.clave, o]));
    grupo.encontrados = L.length;
    for (const k of esperadas) {
      const o = por.get(k);
      if (!o) { grupo.faltan.push(k); continue; }
      const url = firmarObj(grupo, o, null);
      const j = await leerJson(grupo, k, url);
      const e = emitidoDe(k, j);
      if (j && !e) grupo.avisos.push(`${k}: sin «emitido» legible (queda el que había)`);
      grupo.filas[grupo.filas.length - 1].emitido = e;
    }
    grupo.ignorados = L.length - (esperadas.length - grupo.faltan.length);
  }

  // ── OPERA: pasadas.json + un mosaico por día entre desde y hasta ──
  {
    const grupo = g.opera;
    const L = await listado(grupo, 'opera/cog/');
    if (L) {
      grupo.encontrados = L.length;
      const indice = L.find((o) => o.clave === OPERA_INDICE);
      let esperadas = null;
      if (!indice) grupo.faltan.push(OPERA_INDICE);
      else {
        const url = firmarObj(grupo, indice, null);
        const j = await leerJson(grupo, OPERA_INDICE, url);
        grupo.filas[grupo.filas.length - 1].emitido = emitidoDe(OPERA_INDICE, j);
        if (j) {
          esperadas = diasEntre(j.desde, j.hasta);
          if (!esperadas.length) grupo.avisos.push(`${OPERA_INDICE}: sin «desde»/«hasta» legibles (no se puede decir qué mosaicos faltan)`);
        }
      }
      const mosaicos = L.filter((o) => OPERA_MOSAICO.test(o.clave));
      for (const o of mosaicos) firmarObj(grupo, o, OPERA_MOSAICO.exec(o.clave)[1]);
      if (mosaicos.length) await probar(grupo, mosaicos[0].clave, grupo.filas.find((f) => f.clave === mosaicos[0].clave).url);
      if (esperadas && esperadas.length) {
        const hay = new Set(mosaicos.map((o) => OPERA_MOSAICO.exec(o.clave)[1]));
        for (const d of esperadas) if (!hay.has(d)) grupo.faltan.push(`opera/cog/cuenca-del-plata/${d}.tif`);
      }
      if (mosaicos.length !== operaEsperados) grupo.avisos.push(`mosaicos: ${mosaicos.length} (se esperaban ${operaEsperados})`);
      grupo.ignorados = L.length - mosaicos.length - (indice ? 1 : 0);
    }
  }

  // ── rayos-hora: las horas cerradas de los últimos diasRayos días ──
  {
    const grupo = g.rayos;
    const ventana = horasVentana(fecha.getTime(), diasRayos);
    const enVentana = new Set(ventana);
    const hay = new Map();
    for (const p of diasDe(ventana)) {
      const L = await listado(grupo, p);
      if (!L) continue;
      grupo.encontrados += L.length;
      for (const o of L) if (RAYOS_HORA.test(o.clave) && enVentana.has(o.clave)) hay.set(o.clave, o);
    }
    for (const k of ventana) {
      const o = hay.get(k);
      if (o) firmarObj(grupo, o, k.slice(11, 21).replace(/\//g, '-'));
    }
    const faltan = ventana.filter((k) => !hay.has(k));
    // horas que faltan: aviso, no falla (el colector rayos-hora puede no estar activo, o la hora no tener archivo todavía)
    if (faltan.length) grupo.avisos.push(`horas sin archivo: ${faltan.length} de ${ventana.length}` + (faltan.length <= 6 ? ` (${faltan.join(', ')})` : ` (la primera ${faltan[0]}, la última ${faltan[faltan.length - 1]})`));
    if (grupo.filas.length) await probar(grupo, grupo.filas[0].clave, grupo.filas[0].url);
    grupo.ignorados = grupo.encontrados - grupo.filas.length;
    grupo.ventana = ventana.length;
  }

  // ── la base: un solo upsert con todo lo que pasó la verificación ──
  const filas = [];
  for (const grupo of Object.values(g)) {
    if (grupo.bloqueado && grupo.filas.length) grupo.avisos.push(`NO se escribió: ${grupo.filas.length} enlaces descartados porque la verificación falló`);
    else filas.push(...grupo.filas);
  }
  let base = { nuevas: 0, actualizadas: 0, sinCambio: 0, filas: filas.length, error: null };
  try { if (filas.length) base = { ...base, ...(await upsert(filas)) }; }
  catch (e) { base.error = `upsert: ${String(e.message || e).slice(0, 200)}`; }

  const errores = Object.values(g).reduce((n, x) => n + x.errores.length, 0) + (base.error ? 1 : 0);
  const faltan = g.tormentas.faltan.length + g.escenarios.faltan.length + g.opera.faltan.length;
  const ok = errores === 0 && faltan === 0;
  for (const grupo of Object.values(g)) delete grupo.filas;
  return { fecha: fecha.toISOString(), diasRayos, grupos: g, base, errores, faltan, ok, codigo: ok ? 0 : 1 };
}

/** PURA. Resumen en Markdown (para la consola y $GITHUB_STEP_SUMMARY). Sin URL ni llaves. */
export function resumenMd(r) {
  const L = [`## firmador-r2 · ${r.fecha} · ${r.ok ? 'OK' : 'CON PROBLEMAS'}`, '',
    '| prefijo | en R2 | firmados | ignorados | faltan | errores |', '|---|---:|---:|---:|---:|---:|'];
  for (const x of Object.values(r.grupos)) L.push(`| ${x.nombre}${x.ventana ? ` (ventana ${x.ventana} h, ${r.diasRayos} d)` : ''} | ${x.encontrados} | ${x.firmados} | ${x.ignorados} | ${x.faltan.length} | ${x.errores.length} |`);
  L.push('', `**r2_enlaces:** ${r.base.filas} filas enviadas · ${r.base.nuevas} nuevas · ${r.base.actualizadas} actualizadas · ${r.base.sinCambio} sin cambio (ya tenían un enlace que vence igual o después)` + (r.base.error ? ` · **${r.base.error}**` : ''));
  for (const x of Object.values(r.grupos)) {
    for (const f of x.faltan.slice(0, 20)) L.push(`- **falta** ${f}`);
    if (x.faltan.length > 20) L.push(`- **faltan** ${x.faltan.length - 20} más en ${x.nombre}`);
    for (const a of x.avisos) L.push(`- aviso ${x.nombre}: ${a}`);
    for (const e of x.errores) L.push(`- **error** ${x.nombre}: ${e}`);
  }
  return L.join('\n') + '\n';
}
