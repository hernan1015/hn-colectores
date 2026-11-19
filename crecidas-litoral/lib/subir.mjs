// HN AGRO · [r79 · 10] TODO EL LITORAL · la subida de las teselas precocidas al depósito PÚBLICO de SATCHI (satchi-slider).
// Lo que deja litoral.py en una carpeta ({carpeta}/indice.json y {carpeta}/<AAAA-MM-DD>/<z>/<x>/<y>.png) va a:
//   {prefijo}/<version>/<AAAA-MM-DD>/<z>/<x>/<y>.png   (primero TODAS las teselas)
//   {prefijo}/indice.json                              (DESPUÉS, recién con todas arriba: la página sólo ve versiones completas)
// La versión vieja NO se borra en la misma corrida: queda anotada en el índice nuevo («borrar_despues») y la borra una corrida posterior,
// pasadas ESPERA_BORRAR_MS (quien abrió la página con el índice viejo sigue encontrando sus teselas). Borrado DIFERIDO, como pidió Codex
// para el precocido satelital. Una falla en cualquier tesela corta ANTES del índice (el índice publicado sigue apuntando a la versión vieja,
// completa). Los 5xx y errores de red se reintentan con espera creciente.
// [Codex n3-litoral-colector] LA VERSIÓN ES ÚNICA DE VERDAD: fecha y hora al SEGUNDO + un sufijo (el run de Actions o 8 hex al azar), y nunca se
// escribe sobre una versión que ya figura en el índice publicado (actual o pendiente de borrar) ni sobre un prefijo que ya tiene objetos.
// LAS TESELAS SE CUENTAN: cada fecha tiene que tener exactamente las teselas que dice el índice local (mb[fecha].teselas); una salida
// incompleta no se publica. LOS PENDIENTES VENCIDOS se quitan del índice recién DESPUÉS de borrarlos (un corte en el medio no deja huérfanos).
// El registro de Actions es PÚBLICO: el log lleva sólo cantidades; las fallas, una categoría fija (categoriaError) y el código HTTP.

export const ESPERA_BORRAR_MS = 6 * 3600e3;
export const RE_TESELA = /^(\d{4}-\d{2}-\d{2})\/(\d{1,2})\/(\d+)\/(\d+)\.png$/;
export const RE_VERSION = /^v\d{8}T\d{6}Z-[0-9a-z]{4,20}$/;
const RE_VERSION_VIEJA = /^v\d{8}T\d{4,6}Z(-[0-9a-z]{4,20})?$/;   // también las del primer formato, para poder borrarlas

/** el sufijo: el run de Actions (GITHUB_RUN_ID + intento) o 8 hex al azar */
export function sufijoDe(env = process.env, azar = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')) {
  const r = String(env.GITHUB_RUN_ID || '').replace(/[^0-9]/g, ''), a = String(env.GITHUB_RUN_ATTEMPT || '1').replace(/[^0-9]/g, '') || '1';
  return (r ? r.slice(-14) + 'a' + a.slice(0, 3) : azar()).toLowerCase();
}
export function versionDe(ms, sufijo) {
  const d = new Date(ms).toISOString();
  const suf = String(sufijo || '').toLowerCase();
  if (!/^[0-9a-z]{4,20}$/.test(suf)) throw Object.assign(new Error('sufijo de versión inválido'), { interno: true });
  return 'v' + d.slice(0, 4) + d.slice(5, 7) + d.slice(8, 10) + 'T' + d.slice(11, 13) + d.slice(14, 16) + d.slice(17, 19) + 'Z-' + suf;
}

/** el índice local: v 1 y al menos una fecha con forma; si no, null */
export function indiceValido(j) {
  if (!j || j.v !== 1 || !Array.isArray(j.fechas) || !j.fechas.length) return null;
  if (!j.fechas.every((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.fecha) && (x.tipo === 'medido' || x.tipo === 'pronostico'))) return null;
  return j;
}

/** la categoría de una falla, para el registro público (nunca el mensaje) */
export function categoriaError(e) {
  if (e && e.almacen) return 'error:almacen' + (e.http ? ' http ' + e.http : '');
  if (e && (e.name === 'TypeError' || e.code === 'ECONNRESET' || e.name === 'AbortError' || e.name === 'TimeoutError')) return 'error:red';
  return 'error:interno';
}

const httpDe = (e) => { const m = /HTTP (\d{3})/.exec(String(e && e.message || '')); return m ? Number(m[1]) : null; };
const reintentable = (e) => { const h = httpDe(e); return h == null ? true : h >= 500; };

/** una operación del almacén con reintentos (5xx o red), espera creciente. Marca la falla final como del almacén. */
export async function conReintento(fn, { reintentos = 3, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), baseMs = 800 } = {}) {
  let ultima;
  for (let k = 0; k <= reintentos; k++) {
    try { return await fn(); } catch (e) {
      ultima = e;
      if (!reintentable(e) || k === reintentos) break;
      await esperar(baseMs * 2 ** k);
    }
  }
  try { ultima.almacen = true; ultima.http = httpDe(ultima); } catch { /* */ }
  throw ultima;
}

/** de a N a la vez */
async function enParalelo(items, n, fn) {
  let i = 0, error = null;
  const obreros = Array.from({ length: Math.max(1, n) }, async () => {
    while (!error && i < items.length) { const x = items[i++]; try { await fn(x); } catch (e) { error = error || e; } }
  });
  await Promise.all(obreros);
  if (error) throw error;
}

/**
 * La subida. archivos: [{ ruta: 'AAAA-MM-DD/z/x/y.png', leer: () => Buffer }]; indice: el JSON de litoral.py.
 * → { version, teselas, bytes, borradas, versiones_borradas }
 */
export async function subir({ almacen, indice, archivos, prefijo = 'crecidas-litoral', ahoraMs = Date.now(), concurrencia = 8, log = () => {}, esperar, sufijo } = {}) {
  if (!almacen) throw Object.assign(new Error('sin almacén'), { interno: true });
  const I = indiceValido(indice); if (!I) throw Object.assign(new Error('índice local inválido'), { interno: true });
  const fechas = new Set(I.fechas.map((x) => x.fecha));
  const lista = archivos.filter((a) => { const m = RE_TESELA.exec(a.ruta); return m && fechas.has(m[1]); });
  if (!lista.length) throw Object.assign(new Error('sin teselas'), { interno: true });
  /* las teselas se cuentan por fecha contra el índice local: una salida incompleta no se publica como completa */
  const porFecha = {}; for (const a of lista) { const k = RE_TESELA.exec(a.ruta)[1]; porFecha[k] = (porFecha[k] || 0) + 1; }
  for (const x of I.fechas) {
    const esperadas = I.mb && I.mb[x.fecha] ? Number(I.mb[x.fecha].teselas) : NaN;
    if (!Number.isInteger(esperadas) || esperadas < 1 || porFecha[x.fecha] !== esperadas) throw Object.assign(new Error('teselas incompletas'), { interno: true });
  }
  const version = versionDe(ahoraMs, sufijo || sufijoDe());
  const op = (fn) => conReintento(fn, esperar ? { esperar } : {});
  let anterior = null;
  try { const b = await op(() => almacen.leer(prefijo + '/indice.json')); anterior = b ? JSON.parse(Buffer.from(b).toString('utf8')) : null; } catch (e) { if (e.almacen) throw e; anterior = null; }
  /* nunca sobre una versión que ya existe: la del índice, una pendiente de borrar, o un prefijo con objetos */
  const usadas = new Set([anterior && anterior.version, ...((anterior && Array.isArray(anterior.borrar_despues)) ? anterior.borrar_despues.map((p) => p && p.version) : [])].filter(Boolean));
  if (usadas.has(version)) throw Object.assign(new Error('versión ya usada'), { interno: true });
  if ((await op(() => almacen.listar(prefijo + '/' + version + '/'))).length) throw Object.assign(new Error('versión ya usada'), { interno: true });
  /* 1) TODAS las teselas de la versión nueva */
  let bytes = 0;
  await enParalelo(lista, concurrencia, async (a) => {
    const cuerpo = a.leer(); bytes += cuerpo.length;
    await op(() => almacen.escribir(prefijo + '/' + version + '/' + a.ruta, cuerpo, { tipo: 'image/png', cache: 'public, max-age=86400' }));
  });
  log('teselas: ' + lista.length + ' · ' + (bytes / 1e6).toFixed(2) + ' MB');
  /* 2) el índice nuevo, con lo que queda por borrar más tarde */
  const pendientes = [];
  const vieja = anterior && typeof anterior.version === 'string' && RE_VERSION_VIEJA.test(anterior.version) && anterior.version !== version ? anterior.version : null;
  if (vieja) pendientes.push({ version: vieja, desde: ahoraMs });
  const aBorrar = [];
  for (const p of (anterior && Array.isArray(anterior.borrar_despues) ? anterior.borrar_despues : [])) {
    if (!p || !RE_VERSION_VIEJA.test(String(p.version)) || p.version === version) continue;
    pendientes.push(p);   // TODOS siguen anotados hasta que estén borrados de verdad
    if (ahoraMs - Number(p.desde) >= ESPERA_BORRAR_MS) aBorrar.push(p.version);
  }
  const escribirIndice = (pend) => op(() => almacen.escribir(prefijo + '/indice.json', Buffer.from(JSON.stringify({ ...I, version, subido: new Date(ahoraMs).toISOString(), borrar_despues: pend })),
    { tipo: 'application/json', cache: 'public, max-age=300' }));
  await escribirIndice(pendientes);
  log('índice: ' + I.fechas.length + ' fechas');
  /* 3) recién ahora, las versiones viejas vencidas; y DESPUÉS de borrarlas, se quitan del índice */
  let borradas = 0;
  for (const v of aBorrar) {
    const claves = await op(() => almacen.listar(prefijo + '/' + v + '/'));
    await enParalelo(claves, concurrencia, async (k) => { await op(() => almacen.borrar(k)); borradas++; });
  }
  const quedan = pendientes.filter((p) => !aBorrar.includes(p.version));
  if (aBorrar.length) await escribirIndice(quedan);
  log('borradas: ' + borradas + ' teselas de ' + aBorrar.length + ' versiones viejas · pendientes: ' + quedan.length);
  return { version, teselas: lista.length, bytes, borradas, versiones_borradas: aBorrar, pendientes: quedan.length };
}
