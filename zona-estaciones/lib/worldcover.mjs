// 257 · la lectura de ESA WorldCover 2021 v200 por rangos HTTP del COG (sin bajar el tile entero).
//
// Cada tile es un GeoTIFF «cloud optimized» de 36000×36000 píxeles en bloques de 1024×1024 comprimidos: geotiff.js
// pide el encabezado y después sólo los bloques que toca la ventana de cada estación (≈ 1 bloque por estación).
// Reglas de la bajada (pedido 257): un tile por vez, en orden, con pausa entre tiles; cero pedidos en paralelo; lo ya
// leído no se vuelve a pedir (caché por punto en disco, si se pasa `cache`).
// El log y los errores llevan sólo cantidades y mensajes nuestros: nada de nombres de tile ni el texto de un error ajeno.
import { ventana, centroPixel, distM } from './grilla.mjs';
import { urlTile } from './grilla.mjs';
import { NO_LEIDO } from './regla.mjs';

export const RADIOS_M = [100, 250, 500];

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Los conteos de clases de una ventana ya leída.
 * `caja` = { gx0, gy0, gx1, gy1 } (píxeles globales, x1/y1 exclusivos) y `datos` = Uint8Array fila por fila.
 * Devuelve { pixel: clase del píxel del punto (null si no se leyó), conteos: { [radio]: { [clase]: n } } }.
 * Los píxeles no leídos (NO_LEIDO = 255) se cuentan aparte, con su clave 255: son parte del círculo, no dato.
 */
export function contarVentana(lat, lon, caja, datos, radios = RADIOS_M) {
  const ancho = caja.gx1 - caja.gx0, alto = caja.gy1 - caja.gy0;
  if (datos.length !== ancho * alto) throw new Error('ventana: el tamaño de los datos no coincide con la caja');
  const conteos = Object.fromEntries(radios.map((r) => [r, {}]));
  const gxP = Math.floor((lon + 180) * 12000), gyP = Math.floor((90 - lat) * 12000);
  let pixel = null;
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const gx = caja.gx0 + x, gy = caja.gy0 + y;
      const v = datos[y * ancho + x];
      if (gx === gxP && gy === gyP) pixel = v === NO_LEIDO ? null : v;
      const c = centroPixel(gx, gy);
      const d = distM(lat, lon, c.lat, c.lon);
      for (const r of radios) if (d <= r) conteos[r][v] = (conteos[r][v] || 0) + 1;
    }
  }
  return { pixel, conteos };
}

/** Un tile que NO existe: S3 contestó 404 (y sólo 404). Lo marca nuestro código, no el texto de un error ajeno. */
export class TileInexistente extends Error {
  constructor() { super('el tile no existe (404)'); this.tileInexistente = true; }
}
/** Una falla de la lectura, con un mensaje NUESTRO (sin el nombre del tile ni el texto original del error). */
export class FallaLectura extends Error {
  constructor(que, status) { super(`${que}${status ? ` (HTTP ${status})` : ''}`); this.propio = true; this.status = status || null; }
}

/**
 * Abre un tile remoto con geotiff.js (import perezoso, así los tests de la regla no necesitan la dependencia).
 * `fetch` y `fromUrl` se inyectan en los tests (nunca hay red).
 */
export async function abrirRemoto(nombre, { fetch: pedir = globalThis.fetch, fromUrl = null } = {}) {
  // geotiff.js no dice el código HTTP («Request failed»): un pedido de 1 byte antes distingue el tile que no existe
  // (404: la clave no está en el bucket público, que permite listar) de cualquier otra cosa. Un 403 NO es «no
  // existe»: es un rechazo de acceso (el bucket cambió de permisos, una política, un proxy) y corta, igual que un
  // 5xx, un 3xx o una falla de red. Sólo el 404 se toma como ausencia.
  let sonda;
  try { sonda = await pedir(urlTile(nombre), { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) }); }
  catch { throw new FallaLectura('un tile no se pudo pedir'); }
  try { await sonda.arrayBuffer(); } catch { /* el cuerpo de la sonda no importa */ }
  if (sonda.status === 404) throw new TileInexistente();
  if (sonda.status !== 200 && sonda.status !== 206) throw new FallaLectura('un tile no se pudo abrir', sonda.status);
  if (!fromUrl) ({ fromUrl } = await import('geotiff'));
  let tif, img;
  try {
    tif = await fromUrl(urlTile(nombre), { allowFullFile: false });
    img = await tif.getImage(0);
  } catch { throw new FallaLectura('un tile no se pudo abrir'); }
  if (img.getWidth() !== 36000 || img.getHeight() !== 36000) throw new FallaLectura('un tile tiene un tamaño inesperado');
  return {
    async leer(x0, y0, x1, y1) {
      const r = await img.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
      return r instanceof Uint8Array ? r : Uint8Array.from(r);
    },
    cerrar() { try { tif.close?.(); } catch { /* nada */ } },
  };
}

/** Sólo un TileInexistente (404) es un faltante. Nada de buscar «403» o «Not Found» en el texto de un error. */
export const esFaltante = (e) => e?.tileInexistente === true;

/**
 * Lee las ventanas de todos los puntos. `puntos` = [{ clave, lat, lon }].
 * Opciones: radios, abrir (inyectable para tests), cache ({ get(clave), set(clave, valor) }), pausaTileMs,
 * pausaLecturaMs, log (sólo cantidades).
 * Devuelve Map clave → { pixel, conteos, tiles, faltantes } (tiles = cuántos tiles toca la ventana; faltantes =
 * cuántos de ellos no existen). Los píxeles de un tile inexistente quedan como NO_LEIDO (255): la regla los cuenta
 * en el círculo pero no como dato, y así sabe qué fracción de la ventana está cubierta.
 */
export async function leerVentanas(puntos, op = {}) {
  const radios = op.radios || RADIOS_M;
  const abrir = op.abrir || abrirRemoto;
  const pausaTile = op.pausaTileMs ?? 2000, pausaLectura = op.pausaLecturaMs ?? 100;
  const log = op.log || (() => {});
  const radioMax = Math.max(...radios);
  const out = new Map();
  const pendientes = [];
  for (const p of puntos) {
    const enCache = op.cache?.get(p.clave);
    if (enCache) { out.set(p.clave, enCache); continue; }
    const v = ventana(p.lat, p.lon, radioMax);
    const ancho = v.caja.gx1 - v.caja.gx0, alto = v.caja.gy1 - v.caja.gy0;
    pendientes.push({ ...p, v, buf: new Uint8Array(ancho * alto).fill(NO_LEIDO), ancho, faltantes: 0 });
  }
  // Agrupar las partes por tile: cada tile se abre UNA vez y se lee entero lo que haga falta de él.
  const porTile = new Map();
  for (const p of pendientes) for (const parte of p.v.partes) {
    if (!porTile.has(parte.nombre)) porTile.set(parte.nombre, []);
    porTile.get(parte.nombre).push({ p, parte });
  }
  const nombres = [...porTile.keys()].sort();
  log(`ventanas: ${puntos.length} puntos, ${puntos.length - pendientes.length} en caché, ${pendientes.length} a leer en ${nombres.length} tiles`);
  let i = 0, inexistentes = 0;
  for (const nombre of nombres) {
    i++;
    let tile = null;
    try { tile = await abrir(nombre); } catch (e) {
      // sin el nombre del tile ni el texto del error original
      if (!esFaltante(e)) throw (e?.propio ? e : new FallaLectura('un tile no se pudo abrir'));
      inexistentes++;
    }
    for (const { p, parte } of porTile.get(nombre)) {
      if (!tile) { p.faltantes++; continue; } // queda en NO_LEIDO: la regla lo ve como faltante
      let datos;
      try { datos = await tile.leer(parte.x0, parte.y0, parte.x1, parte.y1); }
      catch (e) { throw (e?.propio ? e : new FallaLectura('una ventana no se pudo leer')); }
      const w = parte.x1 - parte.x0;
      if (!(datos instanceof Uint8Array) || datos.length !== w * (parte.y1 - parte.y0)) throw new FallaLectura('una ventana vino de otro tamaño');
      for (let y = 0; y < parte.y1 - parte.y0; y++) {
        const gy = parte.gy0 + parte.y0 + y, gx = parte.gx0 + parte.x0;
        p.buf.set(datos.subarray(y * w, (y + 1) * w), (gy - p.v.caja.gy0) * p.ancho + (gx - p.v.caja.gx0));
      }
      if (pausaLectura) await espera(pausaLectura);
    }
    tile?.cerrar?.();
    log(`tile ${i}/${nombres.length} listo (${porTile.get(nombre).length} ventanas)${tile ? '' : ' · no existe (404): sin dato'}`);
    if (pausaTile && i < nombres.length) await espera(pausaTile);
  }
  if (inexistentes) log(`tiles inexistentes (404): ${inexistentes}`);
  for (const p of pendientes) {
    const r = contarVentana(p.lat, p.lon, p.v.caja, p.buf, radios);
    const valor = { ...r, tiles: p.v.partes.length, faltantes: p.faltantes };
    out.set(p.clave, valor);
    op.cache?.set(p.clave, valor);
  }
  return out;
}
