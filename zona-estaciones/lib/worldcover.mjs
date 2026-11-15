// 257 · la lectura de ESA WorldCover 2021 v200 por rangos HTTP del COG (sin bajar el tile entero).
//
// Cada tile es un GeoTIFF «cloud optimized» de 36000×36000 píxeles en bloques de 1024×1024 comprimidos: geotiff.js
// pide el encabezado y después sólo los bloques que toca la ventana de cada estación (≈ 1 bloque por estación).
// Reglas de la bajada (pedido 257): un tile por vez, en orden, con pausa entre tiles; cero pedidos en paralelo; lo ya
// leído no se vuelve a pedir (caché por punto en disco, si se pasa `cache`).
import { ventana, centroPixel, distM } from './grilla.mjs';
import { urlTile } from './grilla.mjs';

export const RADIOS_M = [100, 250, 500];

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Los conteos de clases de una ventana ya leída.
 * `caja` = { gx0, gy0, gx1, gy1 } (píxeles globales, x1/y1 exclusivos) y `datos` = Uint8Array fila por fila.
 * Devuelve { pixel: clase del píxel del punto, conteos: { [radio]: { [clase]: n } } }.
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
      if (gx === gxP && gy === gyP) pixel = v;
      const c = centroPixel(gx, gy);
      const d = distM(lat, lon, c.lat, c.lon);
      for (const r of radios) if (d <= r) conteos[r][v] = (conteos[r][v] || 0) + 1;
    }
  }
  return { pixel, conteos };
}

/** Abre un tile remoto con geotiff.js (import perezoso, así los tests de la regla no necesitan la dependencia). */
export async function abrirRemoto(nombre) {
  const { fromUrl } = await import('geotiff');
  // geotiff.js no dice el código HTTP («Request failed»): un pedido de 1 byte antes distingue el tile que no existe
  // (S3 contesta 403/404 para una clave ausente) de una falla de verdad (5xx, red), que tiene que cortar.
  const sonda = await fetch(urlTile(nombre), { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) });
  await sonda.arrayBuffer().catch(() => {});
  if (sonda.status === 404 || sonda.status === 403) throw new Error(`${sonda.status} Not Found`);
  if (!sonda.ok) throw new Error(`HTTP ${sonda.status}`);
  const tif = await fromUrl(urlTile(nombre), { allowFullFile: false });
  const img = await tif.getImage(0);
  if (img.getWidth() !== 36000 || img.getHeight() !== 36000) throw new Error(`tile ${nombre}: tamaño inesperado`);
  return {
    async leer(x0, y0, x1, y1) {
      const r = await img.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
      return r instanceof Uint8Array ? r : Uint8Array.from(r);
    },
    cerrar() { try { tif.close?.(); } catch { /* nada */ } },
  };
}

/** Un tile que no existe (mar abierto, fuera de la cobertura) → 404/403 de S3. */
const esFaltante = (e) => /\b(404|403)\b|Not Found|Forbidden/i.test(String(e?.message || e));

/**
 * Lee las ventanas de todos los puntos. `puntos` = [{ clave, lat, lon }].
 * Opciones: radios, abrir (inyectable para tests), cache ({ get(clave), set(clave, valor) }), pausaTileMs,
 * pausaLecturaMs, log (sólo cantidades).
 * Devuelve Map clave → { pixel, conteos, tiles, faltantes } (faltantes = tiles inexistentes que tocaba la ventana).
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
    pendientes.push({ ...p, v, buf: new Uint8Array(ancho * alto), ancho, faltantes: [] });
  }
  // Agrupar las partes por tile: cada tile se abre UNA vez y se lee entero lo que haga falta de él.
  const porTile = new Map();
  for (const p of pendientes) for (const parte of p.v.partes) {
    if (!porTile.has(parte.nombre)) porTile.set(parte.nombre, []);
    porTile.get(parte.nombre).push({ p, parte });
  }
  const nombres = [...porTile.keys()].sort();
  log(`ventanas: ${puntos.length} puntos, ${puntos.length - pendientes.length} en caché, ${pendientes.length} a leer en ${nombres.length} tiles`);
  let i = 0;
  for (const nombre of nombres) {
    i++;
    let tile = null;
    try { tile = await abrir(nombre); } catch (e) {
      if (!esFaltante(e)) throw new Error(`tile ${nombre}: no se pudo abrir (${String(e?.message || e).slice(0, 80)})`);
    }
    for (const { p, parte } of porTile.get(nombre)) {
      if (!tile) { p.faltantes.push(nombre); continue; } // queda en 0 = sin dato
      const datos = await tile.leer(parte.x0, parte.y0, parte.x1, parte.y1);
      const w = parte.x1 - parte.x0;
      for (let y = 0; y < parte.y1 - parte.y0; y++) {
        const gy = parte.gy0 + parte.y0 + y, gx = parte.gx0 + parte.x0;
        p.buf.set(datos.subarray(y * w, (y + 1) * w), (gy - p.v.caja.gy0) * p.ancho + (gx - p.v.caja.gx0));
      }
      if (pausaLectura) await espera(pausaLectura);
    }
    tile?.cerrar?.();
    log(`tile ${i}/${nombres.length} listo (${porTile.get(nombre).length} ventanas)${tile ? '' : ' · no existe: sin dato'}`);
    if (pausaTile && i < nombres.length) await espera(pausaTile);
  }
  for (const p of pendientes) {
    const r = contarVentana(p.lat, p.lon, p.v.caja, p.buf, radios);
    const valor = { ...r, tiles: p.v.partes.map((x) => x.nombre), faltantes: p.faltantes };
    out.set(p.clave, valor);
    op.cache?.set(p.clave, valor);
  }
  return out;
}
