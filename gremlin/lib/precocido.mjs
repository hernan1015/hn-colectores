// HN AGRO · [r77 · 18/11/2026] LAS TESELAS DE SATCHI YA REPROYECTADAS («PRECOCIDAS»): GeoColor, visible (banda 2) y GREMLIN de
// CIRA/RAMMB SLIDER, en el depósito PÚBLICO de SATCHI, para que la película satelital arranque en 1-2 s. Ver gremlin/LEEME-precocido.md.
//
// Una corrida, por cada producto: 1 pedido a latest_times.json; después, los tiempos que faltan dentro de la retención, DEL MÁS NUEVO
// AL MÁS VIEJO (la película arranca por el último), intercalando los productos. Para cada tiempo se piden las nativas de SLIDER que
// hacen falta para TODAS sus teselas de Leaflet de Z_MIN a Z_MAX dentro del recorte del relevo, se reproyecta cada tesela con LA MISMA
// cuenta que el relevo (lib/satelite-slider.copia.mjs, copia textual del de hn-agro) y se guarda en
//     slider/{producto}/{tiempo}/{z}/{x}/{y}.png        (inmutable: un tiempo cerrado de SLIDER no cambia)
//     slider/{producto}/indice.json                     (qué tiempos están, completos o no; lo lee el relevo de hn-agro)
// LA REGLA DE LA _v1829: un fallo parcial nunca es una imagen buena. Una tesela a la que le faltó una nativa NO SE ESCRIBE (la página y el
// relevo, al no encontrarla, van a CIRA como hoy); el tiempo queda «incompleto» con la cantidad que falta, y se reintenta.
// EL ORDEN DE LAS ESCRITURAS: primero las teselas, después el índice (el índice nunca nombra un tiempo cuyas teselas no estén). Al borrar,
// al revés: primero el índice (el tiempo deja de figurar), después las teselas.
// LA RETENCIÓN: RETENCION_H (6 h por defecto; de 1 a 24). Lo más viejo sale del índice y se borra (DELETE de R2 es gratis), con un tope
// por corrida; lo que no se llegó a borrar queda en `borrar` del índice para la próxima. Si el reloj está más de 1 día adelante de SLIDER,
// no se borra nada.
// El almacén (R2 o carpeta) y fetch vienen de afuera, para probar sin red. Se imprimen SÓLO CANTIDADES (el registro de Actions es público).
import {
  PRODUCTOS, RECORTE, TESELA, TESELA_SLIDER, CITA, CITA_GREMLIN, UA as UA_RELEVO,
  rutaTiempos, rutaNativa, normalizarTiempos, tiempoMs, validarTesela, nativasDe, enteraDeNoche, reproyectar, codificarPng,
  decodificarPng, motivoPngMalo,
} from './satelite-slider.copia.mjs';

export const BASE = 'https://slider.cira.colostate.edu/';
export const UA = UA_RELEVO;                         // 'hn-colector/1.0', el mismo del relevo y de gremlin
export const RAIZ = 'slider';
export const PRODUCTOS_PRE = Object.freeze(['geocolor', 'band_02', 'gremlin']);
export const Z_MIN = 3, Z_MAX = 5;                   // la vista continente: hasta el zoom 6 del mapa la página pide z5 como máximo
export const RETENCION_DEF_H = 6, RETENCION_MIN_H = 1, RETENCION_MAX_H = 24;
export const TOPE_DEFECTO = 120, TOPE_MIN = 20, TOPE_MAX = 400;   // pedidos a SLIDER por corrida (los latest_times incluidos)
export const PAUSA_MS = 1000;
export const MAX_INTENTOS = 4;
export const FALLAS_SEGUIDAS_CORTE = 3;
export const TOPE_BORRADOS = 3000, PARALELO = 8, PARALELO_ESCRITURA = 8;
export const ADELANTO_MAX_MS = 86400000;
export const CACHE_TESELA = 'public, max-age=86400, immutable';
export const CACHE_INDICE = 'public, max-age=30';
const HORA = 3600000;

export const claveTesela = (prod, t, z, x, y) => `${RAIZ}/${prod}/${t}/${z}/${x}/${y}.png`;
export const claveIndice = (prod) => `${RAIZ}/${prod}/indice.json`;

export const acotar = (v, def, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
export const acotarTope = (v) => acotar(v, TOPE_DEFECTO, TOPE_MIN, TOPE_MAX);
export const acotarRetencion = (v) => acotar(v, RETENCION_DEF_H, RETENCION_MIN_H, RETENCION_MAX_H);

// ---------- la geometría: qué teselas y qué nativas (no depende del tiempo: se calcula una vez) ----------
const latMerc = (k, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * k / n))) * 180 / Math.PI;
const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const memoTes = new Map(), memoNat = new Map();
/** las teselas [x, y] de Leaflet del zoom z que el relevo sirve (validarTesela) y que tocan algo que ve el GOES-19 */
export function teselasDe(prod, z) {
  const k = prod + '/' + z; if (memoTes.has(k)) return memoTes.get(k);
  const out = [];
  for (let x = tx(RECORTE.oeste, z); x <= tx(RECORTE.este - 1e-9, z); x++)
    for (let y = ty(RECORTE.norte, z); y <= ty(RECORTE.sur, z); y++)
      if (!validarTesela(prod, z, x, y) && nativasDe(prod, z, x, y).lista.length) out.push([x, y]);
  memoTes.set(k, out); return out;
}
export function nativasTesela(prod, z, x, y) {
  const k = prod + '/' + z + '/' + x + '/' + y; if (memoNat.has(k)) return memoNat.get(k);
  const r = nativasDe(prod, z, x, y); memoNat.set(k, r); return r;
}
/** todas las claves de las teselas de un tiempo (para borrar sin listar) */
export function clavesTiempo(prod, t, zMin = Z_MIN, zMax = Z_MAX) {
  const out = [];
  for (let z = zMin; z <= zMax; z++) for (const [x, y] of teselasDe(prod, z)) out.push(claveTesela(prod, t, z, x, y));
  return out;
}
/** el plan de un tiempo: las teselas (con su zs y sus nativas, o «noche» entera) y el conjunto de nativas a pedir */
export function planTiempo(prod, t, zMin = Z_MIN, zMax = Z_MAX) {
  const ms = tiempoMs(t), teselas = [], nativas = new Map();
  for (let z = zMin; z <= zMax; z++) for (const [x, y] of teselasDe(prod, z)) {
    if (PRODUCTOS[prod].diurno && enteraDeNoche(z, x, y, ms)) { teselas.push({ z, x, y, noche: true, nat: [] }); continue; }
    const { zs, lista } = nativasTesela(prod, z, x, y), nat = lista.map((q) => zs + ':' + q.f + '_' + q.c);
    nat.forEach((k, i) => { if (!nativas.has(k)) nativas.set(k, { zs, f: lista[i].f, c: lista[i].c }); });
    teselas.push({ z, x, y, noche: false, nat });
  }
  return { teselas, nativas };
}

const cabecera = (prod) => ({
  v: 1, producto: prod, titulo: PRODUCTOS[prod].titulo, z_min: Z_MIN, z_max: Z_MAX, tesela_px: TESELA, recorte: { ...RECORTE },
  ruta: `${RAIZ}/${prod}/{tiempo}/{z}/{x}/{y}.png`,
  cita: prod === 'gremlin' ? CITA_GREMLIN + ' · ' + CITA : CITA,
  nota: 'Teselas de Leaflet reproyectadas desde CIRA/RAMMB SLIDER con la misma cuenta que el relevo de SATCHI. Una tesela que falta no es «despejado»: es sin dato.',
});
const leerJSON = async (almacen, clave) => {
  const b = await almacen.leer(clave); if (!b) return null;
  try { return JSON.parse(b.toString('utf8')); } catch { return null; }
};
/** el índice leído, si tiene la forma; si no, uno nuevo (un índice roto no se usa para borrar: `roto`) */
function indiceDe(j, prod) {
  if (j && j.v === 1 && j.producto === prod && j.tiempos && typeof j.tiempos === 'object' && Array.isArray(j.borrar || [])) return { ind: { ...cabecera(prod), tiempos: { ...j.tiempos }, borrar: [...(j.borrar || [])] }, roto: false };
  return { ind: { ...cabecera(prod), tiempos: {}, borrar: [] }, roto: j != null };
}
async function enParalelo(lista, n, fn) {
  const out = new Array(lista.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => { while (i < lista.length) { const k = i++; out[k] = await fn(lista[k], k); } }));
  return out;
}

/**
 * Una corrida. Devuelve el resumen (cantidades). @param {object} o
 * @param {object} o.almacen   leer / escribir / borrar (rayos-hora/lib/almacen.mjs): el depósito PÚBLICO
 * @param {string} o.llave     PRECOCIDO_ON: sólo «si» hace algo
 * @param {'real'|'seco'} [o.modo]
 */
export async function correr({
  almacen, fetchFn = fetch, ahoraMs = Date.now(), llave, modo = 'real', tope = TOPE_DEFECTO, retencionH = RETENCION_DEF_H,
  productos = PRODUCTOS_PRE, pausaMs = PAUSA_MS, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, zMax = Z_MAX,
}) {
  const res = { estado: 'ok', pedidos: 0, nativas: 0, nativas_malas: 0, tiempos_slider: 0, pendientes: 0, guardados: 0, completos: 0, incompletos: 0,
    teselas: 0, teselas_noche: 0, teselas_faltantes: 0, bytes: 0, sacados: 0, borrados: 0, productos_caidos: 0 };
  if (llave !== 'si') { log('precocido: llave apagada (PRECOCIDO_ON no vale «si»): no hago nada'); return { ...res, estado: 'apagado' }; }
  if (!almacen) throw new Error('precocido: sin almacén (faltan las llaves del depósito público o PUBLICO_CARPETA)');
  const maxPedidos = acotarTope(tope), ret = acotarRetencion(retencionH), zM = Math.max(Z_MIN, Math.min(6, Number(zMax) || Z_MAX));
  let fallasSeguidas = 0, cortar = null;
  const pedir = async (ruta, tipo) => {
    if (res.pedidos > 0 && pausaMs > 0) await esperar(pausaMs);
    res.pedidos++;
    try {
      const r = await fetchFn(BASE + ruta, { headers: { 'user-agent': UA, accept: tipo === 'json' ? 'application/json' : 'image/png' }, signal: AbortSignal.timeout(30000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.status === 0 || r.status >= 500) fallasSeguidas++; else fallasSeguidas = 0;
      if (r.status === 429 || r.status === 403) cortar = `SLIDER respondió ${r.status}`;
      else if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;
      return { status: r.status, buf };
    } catch (e) {
      fallasSeguidas++; if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;
      return { status: 0, error: String(e?.name || e) };
    }
  };

  // 1) los tiempos de cada producto y su índice
  const est = {};
  let masNuevoMs = -Infinity;
  for (const prod of productos) {
    if (!PRODUCTOS[prod]) continue;
    if (cortar) break;
    const lt = await pedir(rutaTiempos(prod), 'json');
    let tiempos = null;
    try { if (lt.status === 200) tiempos = normalizarTiempos(JSON.parse(lt.buf.toString('utf8'))); } catch { tiempos = null; }
    if (!tiempos || !tiempos.length) { res.productos_caidos++; log(`precocido: ${prod}: SLIDER no dio la lista de tiempos; sigo con los otros`); continue; }
    res.tiempos_slider += tiempos.length;
    masNuevoMs = Math.max(masNuevoMs, tiempoMs(tiempos.at(-1)));
    est[prod] = { tiempos, ...indiceDe(await leerJSON(almacen, claveIndice(prod)), prod) };
  }
  // 2) qué falta: dentro de la retención, sin completar y sin agotar los intentos; del más nuevo al más viejo, intercalando productos
  const desde = ahoraMs - ret * HORA, cola = [];
  for (const [prod, e] of Object.entries(est)) for (const t of e.tiempos) {
    const ms = tiempoMs(t); if (ms < desde || ms > ahoraMs + 15 * 60000) continue;
    const q = e.ind.tiempos[t]; if (q && (q.estado === 'completo' || (q.intentos || 0) >= MAX_INTENTOS)) continue;
    if (e.ind.borrar.includes(t)) continue;
    cola.push({ prod, t, ms });
  }
  cola.sort((a, b) => b.ms - a.ms || productos.indexOf(a.prod) - productos.indexOf(b.prod));
  res.pendientes = cola.length;
  if (modo === 'seco') {
    const nat = cola.reduce((a, q) => a + planTiempo(q.prod, q.t, Z_MIN, zM).nativas.size, 0);
    log(`precocido (SECO): ${Object.keys(est).length} productos · ${res.tiempos_slider} tiempos en SLIDER · ${cola.length} por hacer (${nat} nativas) · retención ${ret} h · z${Z_MIN}-${zM} · no bajo ni guardo nada`);
    return { ...res, estado: 'seco' };
  }

  // 3) cada tiempo: sus nativas (si no entran en el tope, queda para la próxima), la reproyección y las teselas
  for (const { prod, t } of cola) {
    if (cortar) break;
    const e = est[prod], plan = planTiempo(prod, t, Z_MIN, zM);
    if (res.pedidos + plan.nativas.size > maxPedidos) { log(`precocido: tope de ${maxPedidos} pedidos; lo que falta queda para la próxima corrida`); break; }
    const imgs = new Map();
    for (const [k, q] of plan.nativas) {
      if (cortar) break;
      const r = await pedir(rutaNativa(prod, t, q.zs, q.f, q.c), 'png');
      res.nativas++;
      const img = r.status === 200 && !motivoPngMalo(r.buf) ? decodificarPng(r.buf) : null;
      if (!img || img.w !== TESELA_SLIDER || img.h !== TESELA_SLIDER) { res.nativas_malas++; continue; }
      imgs.set(k, img);
    }
    let faltan = 0, escritas = 0;
    const transparente = codificarPng(TESELA, TESELA, new Uint8Array(TESELA * TESELA * 4));
    const aEscribir = [];
    for (const s of plan.teselas) {
      if (s.noche) { aEscribir.push({ s, png: transparente }); res.teselas_noche++; continue; }
      const m = new Map(s.nat.map((k) => [k.slice(k.indexOf(':') + 1), imgs.get(k)]));
      const rp = reproyectar(prod, t, s.z, s.x, s.y, m);
      if (rp.faltan > 0) { faltan++; continue; }   // a un píxel le faltó su nativa: NO se escribe (la regla de la _v1829)
      aEscribir.push({ s, png: codificarPng(TESELA, TESELA, rp.rgba) });
    }
    await enParalelo(aEscribir, PARALELO_ESCRITURA, async ({ s, png }) => {
      await almacen.escribir(claveTesela(prod, t, s.z, s.x, s.y), png, { tipo: 'image/png', cache: CACHE_TESELA });
      escritas++; res.bytes += png.length;
    });
    res.teselas += escritas; res.teselas_faltantes += faltan;
    const estado = faltan === 0 ? 'completo' : 'incompleto', previo = e.ind.tiempos[t];
    e.ind.tiempos[t] = { estado, n: escritas, faltan, intentos: (previo?.intentos || 0) + 1, z: [Z_MIN, zM] };
    e.ind.actualizado = new Date(ahoraMs).toISOString();
    await almacen.escribir(claveIndice(prod), JSON.stringify(e.ind), { tipo: 'application/json', cache: CACHE_INDICE });   // después de las teselas
    res.guardados++; if (estado === 'completo') res.completos++; else res.incompletos++;
  }

  // 4) la retención: primero el índice (el tiempo deja de figurar), después las teselas; nunca con el reloj adelantado
  if (!Number.isFinite(masNuevoMs) || ahoraMs - masNuevoMs > ADELANTO_MAX_MS) {
    log('precocido · retención: el reloj no coincide con SLIDER (o no hay tiempos); no borro nada');
  } else {
    let presupuesto = TOPE_BORRADOS, fallas = 0;
    for (const [prod, e] of Object.entries(est)) {
      if (e.roto) { log(`precocido · retención: el índice de ${prod} no tiene la forma; no borro nada de ${prod}`); continue; }
      const viejos = Object.keys(e.ind.tiempos).filter((t) => !(tiempoMs(t) >= desde));
      if (viejos.length) {
        viejos.forEach((t) => { delete e.ind.tiempos[t]; if (!e.ind.borrar.includes(t)) e.ind.borrar.push(t); });
        res.sacados += viejos.length;
        await almacen.escribir(claveIndice(prod), JSON.stringify(e.ind), { tipo: 'application/json', cache: CACHE_INDICE });
      }
      let cambio = false;
      for (const t of [...e.ind.borrar]) {
        const claves = clavesTiempo(prod, t, Z_MIN, Math.max(zM, Number(e.ind.z_max) || Z_MAX));
        if (claves.length > presupuesto) break;
        const r = await enParalelo(claves, PARALELO, (k) => almacen.borrar(k).then(() => true, () => false));
        const mal = r.filter((x) => !x).length;
        presupuesto -= claves.length; res.borrados += claves.length - mal;
        if (mal) { fallas += mal; continue; }   // queda en `borrar`: la próxima vuelve a probar
        e.ind.borrar = e.ind.borrar.filter((x) => x !== t); cambio = true;
      }
      if (cambio) await almacen.escribir(claveIndice(prod), JSON.stringify(e.ind), { tipo: 'application/json', cache: CACHE_INDICE });
    }
    if (fallas) { res.estado = 'borrado-con-fallas'; log(`precocido · retención: ${fallas} borrados fallaron; quedan para la próxima`); }
  }
  if (cortar) { res.estado = 'cortada'; }
  log(`precocido: ${res.pedidos} pedidos (${res.nativas} nativas, ${res.nativas_malas} malas) · ${res.pendientes} pendientes · ${res.guardados} tiempos guardados (${res.completos} completos, ${res.incompletos} incompletos) · ${res.teselas} teselas (${res.teselas_noche} de noche, ${res.teselas_faltantes} sin escribir) · ${(res.bytes / 1e6).toFixed(2)} MB · ${res.sacados} tiempos vencidos · ${res.borrados} borradas${cortar ? ' · CORTADA: ' + cortar : ''}`);
  if (res.estado === 'borrado-con-fallas') throw new Error('R2 borrar: hubo fallas (quedan en el índice para la próxima)');
  return res;
}
