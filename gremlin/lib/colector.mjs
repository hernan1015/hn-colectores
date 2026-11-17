// HN AGRO · colector de GREMLIN (CIRA/RAMMB SLIDER, GOES-19, full_disk) recortado a la Argentina, en R2. Ver gremlin/LEEME.md.
// Una corrida: 1 pedido a latest_times.json, y las teselas de la caja (zoom 3 = 2 km) de los tiempos que faltan,
// del más viejo al más nuevo (los viejos son los primeros que SLIDER borra). Nada se baja dos veces.
// El almacén (R2 o carpeta) y fetch vienen de afuera, para probar sin red.
import crypto from 'node:crypto';
import {
  BASE, PRODUCTO, SATELITE, SECTOR, ZOOM, TESELA_PX, RESOLUCION, CAJA, FUENTE, UA,
  urlTiempos, urlTesela, parsearTiempos, partesTiempo, tiempoMs, isoTiempo, teselasCaja, motivoTeselaMala,
} from './slider.mjs';

export const RAIZ = 'gremlin';
export const VENTANA_H = 18;            // SLIDER guarda ~17 h: más atrás no se pide nada
export const TOPE_DEFECTO = 60;         // pedidos por corrida (latest_times incluido)
export const TOPE_MIN = 1 + 9;          // con menos, un tiempo entero no entra nunca
export const TOPE_MAX = 300;
export const PAUSA_MS = 1000;           // entre pedido y pedido
export const MAX_INTENTOS = 4;          // corridas que intentan un tiempo incompleto; después queda incompleto
export const FALLAS_SEGUIDAS_CORTE = 3; // red caída o 5xx seguidos: se corta la corrida
const HORA = 3600000;

const p3 = (n) => String(n).padStart(3, '0');
export const nombreTesela = ({ fila, col }) => `${p3(fila)}_${p3(col)}`;
const dirTiempo = (t) => { const { a, m, d } = partesTiempo(t); return `${RAIZ}/${a}/${m}/${d}/${t}`; };
export const claveTesela = (t, tes) => `${dirTiempo(t)}/${String(ZOOM).padStart(2, '0')}/${nombreTesela(tes)}.png`;
export const claveSobre = (t) => `${dirTiempo(t)}/sobre.json`;
export const claveIndiceDia = (t) => { const { a, m, d } = partesTiempo(t); return `${RAIZ}/${a}/${m}/${d}/indice.json`; };
export const CLAVE_ALERTAS = `${RAIZ}/alertas.txt`;

export const acotarTope = (x) => {
  const n = Number.parseInt(x, 10);
  if (!Number.isFinite(n)) return TOPE_DEFECTO;
  return Math.min(TOPE_MAX, Math.max(TOPE_MIN, n));
};

const cabecera = () => ({
  v: 1, producto: PRODUCTO, titulo: FUENTE.producto, satelite: SATELITE, sector: SECTOR,
  zoom: ZOOM, resolucion: RESOLUCION, tesela_px: TESELA_PX, caja: { ...CAJA },
  teselas_esperadas: teselasCaja().map(nombreTesela),
  fuente: { ...FUENTE, url_tiempos: urlTiempos(), url_teselas: `${BASE}/data/imagery/AAAA/MM/DD/${SATELITE}---${SECTOR}/${PRODUCTO}/AAAAMMDDhhmmss/${String(ZOOM).padStart(2, '0')}/FFF_CCC.png` },
});

const leerJSON = async (almacen, clave) => {
  const b = await almacen.leer(clave);
  if (!b) return null;
  try { return JSON.parse(b.toString('utf8')); } catch { return null; }
};

async function alertar(almacen, texto, ahoraMs) {
  const previo = (await almacen.leer(CLAVE_ALERTAS))?.toString('utf8') || '';
  const lineas = previo.split('\n').filter(Boolean);
  lineas.push(`${isoTiempo(ahoraMs)} ${texto}`);
  await almacen.escribir(CLAVE_ALERTAS, lineas.slice(-500).join('\n') + '\n', { tipo: 'text/plain; charset=utf-8' });
}

/** Qué tiempos hay que trabajar: los de SLIDER dentro de la ventana que no están completos ni agotados. */
export function pendientes(tiempos, indices, ahoraMs) {
  const out = [];
  for (const t of tiempos) {
    const ms = tiempoMs(t);
    if (ms < ahoraMs - VENTANA_H * HORA || ms > ahoraMs + 15 * 60000) continue;
    const e = indices.get(claveIndiceDia(t))?.tiempos?.[t];
    if (e && e.estado === 'completo') continue;
    if (e && (e.intentos || 0) >= MAX_INTENTOS) continue;
    out.push(t);
  }
  return out;
}

/**
 * Una corrida. Devuelve un resumen con cantidades (es lo único que se imprime: el registro de Actions es público).
 * @param {object} o
 * @param {object} o.almacen        leer / escribir / listar (rayos-hora/lib/almacen.mjs)
 * @param {Function} [o.fetchFn]
 * @param {string} o.llave          GREMLIN_ON: sólo «si» hace algo
 * @param {'real'|'seco'} [o.modo]  seco = sólo pide latest_times y cuenta
 */
export async function correr({
  almacen, fetchFn = fetch, ahoraMs = Date.now(), llave, modo = 'real', tope = TOPE_DEFECTO,
  pausaMs = PAUSA_MS, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log,
}) {
  const res = { estado: 'ok', pedidos: 0, tiempos_slider: 0, pendientes: 0, guardados: 0, recuperadas: 0, completos: 0, incompletos: 0, teselas: 0, faltantes: 0, bytes: 0 };
  if (llave !== 'si') {
    log('gremlin: llave apagada (GREMLIN_ON no vale «si»): no hago nada');
    return { ...res, estado: 'apagado' };
  }
  const maxPedidos = acotarTope(tope);
  const pedir = async (url) => {
    if (res.pedidos > 0 && pausaMs > 0) await esperar(pausaMs);
    res.pedidos++;
    try {
      const r = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'image/png,application/json' }, signal: AbortSignal.timeout(30000) });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, buf, largo: Number(r.headers.get('content-length')) || null, tipo: r.headers.get('content-type') || '' };
    } catch (e) {
      return { status: 0, error: String(e?.name || e) };
    }
  };

  // 1) qué tiempos tiene SLIDER
  const lt = await pedir(urlTiempos());
  let tiempos;
  try {
    if (lt.status !== 200) throw new Error(`HTTP ${lt.status}${lt.error ? ' ' + lt.error : ''}`);
    tiempos = parsearTiempos(JSON.parse(lt.buf.toString('utf8')));
  } catch (e) {
    await alertar(almacen, `SLIDER latest_times: ${e.message}. No se bajó nada; la próxima corrida vuelve a probar.`, ahoraMs);
    log(`gremlin: SLIDER no dio la lista de tiempos (${e.message}); anotado, corto`);
    return { ...res, estado: 'slider-caido' };
  }
  res.tiempos_slider = tiempos.length;

  // 2) qué falta (índices de los días que tocan)
  const indices = new Map();
  for (const t of tiempos) {
    const k = claveIndiceDia(t);
    if (!indices.has(k)) indices.set(k, await leerJSON(almacen, k));
  }
  const cola = pendientes(tiempos, indices, ahoraMs);
  res.pendientes = cola.length;
  if (modo === 'seco') {
    log(`gremlin (SECO): ${tiempos.length} tiempos en SLIDER · ${cola.length} por bajar · ${teselasCaja().length} teselas por tiempo · no bajo ni guardo nada`);
    return { ...res, estado: 'seco' };
  }

  // 3) cada tiempo, entero o nada (si no entra en el tope, queda para la corrida siguiente)
  const esperadas = teselasCaja();
  let fallasSeguidas = 0, cortar = null;
  for (const t of cola) {
    if (cortar) break;
    const previo = await leerJSON(almacen, claveSobre(t));
    const guardadas = new Map((previo?.teselas || []).map((x) => [nombreTesela(x), x]));
    // [311b · P1 de Codex] una corrida que se cortó a mitad (R2 o GitHub) deja teselas guardadas sin sobre: se listan,
    // se leen, se validan y se adoptan con su sha256, para no volver a bajarlas. Una que no valida se vuelve a pedir.
    const enR2 = new Set(await almacen.listar(`${dirTiempo(t)}/`));
    for (const tes of esperadas) {
      const clave = claveTesela(t, tes);
      if (guardadas.has(nombreTesela(tes)) || !enR2.has(clave)) continue;
      const b = await almacen.leer(clave);
      if (!b || motivoTeselaMala(b)) continue;
      guardadas.set(nombreTesela(tes), { fila: tes.fila, col: tes.col, clave, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') });
      res.recuperadas++;
    }
    const aPedir = esperadas.filter((x) => !guardadas.has(nombreTesela(x)));
    if (res.pedidos + aPedir.length > maxPedidos) { log(`gremlin: tope de ${maxPedidos} pedidos; lo que falta queda para la próxima corrida`); break; }
    const faltantes = [];
    for (const tes of aPedir) {
      if (cortar) { faltantes.push({ fila: tes.fila, col: tes.col, motivo: 'corrida cortada' }); continue; }
      const r = await pedir(urlTesela(t, tes.fila, tes.col));
      let motivo = null;
      if (r.status !== 200) motivo = r.status ? `HTTP ${r.status}` : `red: ${r.error}`;
      else if (r.largo && r.buf.length !== r.largo) motivo = 'tamaño distinto del anunciado';
      else motivo = motivoTeselaMala(r.buf);
      if (r.status === 0 || r.status >= 500) fallasSeguidas++; else fallasSeguidas = 0;
      if (r.status === 429 || r.status === 403) cortar = `SLIDER respondió ${r.status}`;
      else if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;
      if (motivo) { faltantes.push({ fila: tes.fila, col: tes.col, motivo }); continue; }
      const clave = claveTesela(t, tes);
      await almacen.escribir(clave, r.buf, { tipo: 'image/png' });
      guardadas.set(nombreTesela(tes), { fila: tes.fila, col: tes.col, clave, bytes: r.buf.length, sha256: crypto.createHash('sha256').update(r.buf).digest('hex') });
      res.teselas++; res.bytes += r.buf.length;
    }
    const teselas = esperadas.filter((x) => guardadas.has(nombreTesela(x))).map((x) => guardadas.get(nombreTesela(x)));
    const estado = faltantes.length === 0 && teselas.length === esperadas.length ? 'completo' : 'incompleto';
    const intentos = (previo?.intentos || 0) + 1;
    const sobre = {
      ...cabecera(), tiempo: isoTiempo(tiempoMs(t)), tiempo_slider: t, estado, intentos,
      teselas, faltantes, generado: isoTiempo(ahoraMs),
      nota: estado === 'completo' ? 'Tiempo completo.'
        : `Faltan ${faltantes.length} teselas: en esas zonas no se sabe nada (no es «sin ecos»). Se reintenta en otra corrida mientras SLIDER lo tenga, hasta ${MAX_INTENTOS} intentos.`,
    };
    await almacen.escribir(claveSobre(t), JSON.stringify(sobre, null, 1));
    const ki = claveIndiceDia(t);
    const ind = indices.get(ki) || { ...cabecera(), tiempos: {} };
    ind.tiempos = { ...(ind.tiempos || {}), [t]: { estado, n: teselas.length, faltantes: faltantes.map(nombreTesela), intentos, sobre: claveSobre(t) } };
    ind.actualizado = isoTiempo(ahoraMs);
    await almacen.escribir(ki, JSON.stringify(ind, null, 1));
    indices.set(ki, ind);
    res.guardados++; res.faltantes += faltantes.length;
    if (estado === 'completo') res.completos++; else res.incompletos++;
  }
  if (cortar) {
    await alertar(almacen, `SLIDER: ${cortar}. Se cortó la corrida; las teselas que faltan se reintentan en la próxima.`, ahoraMs);
    res.estado = 'cortada';
  }
  log(`gremlin: ${res.pedidos} pedidos · ${res.tiempos_slider} tiempos en SLIDER · ${res.pendientes} pendientes · ${res.guardados} guardados (${res.completos} completos, ${res.incompletos} incompletos) · ${res.teselas} teselas · ${res.faltantes} faltantes · ${(res.bytes / 1e6).toFixed(2)} MB${cortar ? ' · CORTADA: ' + cortar : ''}`);
  return res;
}
