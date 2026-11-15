// 257 · la grilla de ESA WorldCover 2021 v200 (10 m): tiles de 3×3° y píxeles de 1/12000°.
//
// Cada tile se llama por su esquina SUROESTE (p. ej. S36W063 cubre lat −36…−33 y lon −63…−60) y tiene
// 36000×36000 píxeles con el origen (esquina superior izquierda) en (lon −63, lat −33). Los bordes de los
// píxeles caen en múltiplos exactos de 1/12000°, así que se puede usar una grilla GLOBAL de píxeles y
// partirla en tiles sin errores de redondeo.

export const PX_POR_GRADO = 12000;
export const PX_POR_TILE = 36000; // 3° × 12000
export const M_POR_GRADO_LAT = 111320;

export const URL_BASE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/';
export const urlTile = (nombre) => `${URL_BASE}ESA_WorldCover_10m_2021_v200_${nombre}_Map.tif`;

/** Columna y fila GLOBALES del píxel que contiene (lat, lon). */
export function pixelGlobal(lat, lon) {
  return { gx: Math.floor((lon + 180) * PX_POR_GRADO), gy: Math.floor((90 - lat) * PX_POR_GRADO) };
}

/** Centro geográfico del píxel global (gx, gy). */
export function centroPixel(gx, gy) {
  return { lon: (gx + 0.5) / PX_POR_GRADO - 180, lat: 90 - (gy + 0.5) / PX_POR_GRADO };
}

/** Nombre del tile (y su origen en píxeles globales) que contiene el píxel global (gx, gy). */
export function tileDePixel(gx, gy) {
  const tx = Math.floor(gx / PX_POR_TILE), ty = Math.floor(gy / PX_POR_TILE);
  const lonO = tx * 3 - 180;          // borde oeste
  const latS = 90 - (ty + 1) * 3;     // borde sur
  const ns = latS < 0 ? 'S' : 'N', ew = lonO < 0 ? 'W' : 'E';
  const nombre = `${ns}${String(Math.abs(latS)).padStart(2, '0')}${ew}${String(Math.abs(lonO)).padStart(3, '0')}`;
  return { nombre, gx0: tx * PX_POR_TILE, gy0: ty * PX_POR_TILE };
}

export const tileDe = (lat, lon) => { const { gx, gy } = pixelGlobal(lat, lon); return tileDePixel(gx, gy).nombre; };

/**
 * La ventana rectangular (en píxeles globales) que encierra el círculo de `radioM` metros alrededor del punto,
 * partida por tile. Devuelve [{ nombre, x0, y0, x1, y1 }] en píxeles LOCALES del tile (x1/y1 exclusivos) y la
 * caja global { gx0, gy0, gx1, gy1 }.
 */
export function ventana(lat, lon, radioM) {
  const mPx = M_POR_GRADO_LAT / PX_POR_GRADO;                 // ≈ 9,28 m por píxel en latitud
  const ry = Math.ceil(radioM / mPx) + 1;
  const rx = Math.ceil(radioM / (mPx * Math.cos(lat * Math.PI / 180))) + 1;
  const { gx, gy } = pixelGlobal(lat, lon);
  const caja = { gx0: gx - rx, gy0: gy - ry, gx1: gx + rx + 1, gy1: gy + ry + 1 };
  const partes = [];
  for (let ty = Math.floor(caja.gy0 / PX_POR_TILE); ty <= Math.floor((caja.gy1 - 1) / PX_POR_TILE); ty++) {
    for (let tx = Math.floor(caja.gx0 / PX_POR_TILE); tx <= Math.floor((caja.gx1 - 1) / PX_POR_TILE); tx++) {
      const t = tileDePixel(tx * PX_POR_TILE, ty * PX_POR_TILE);
      const x0 = Math.max(caja.gx0, t.gx0) - t.gx0, x1 = Math.min(caja.gx1, t.gx0 + PX_POR_TILE) - t.gx0;
      const y0 = Math.max(caja.gy0, t.gy0) - t.gy0, y1 = Math.min(caja.gy1, t.gy0 + PX_POR_TILE) - t.gy0;
      partes.push({ nombre: t.nombre, gx0: t.gx0, gy0: t.gy0, x0, y0, x1, y1 });
    }
  }
  return { centro: { gx, gy }, caja, partes };
}

/** Distancia en metros (equirrectangular; sobra para 500 m). */
export function distM(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * M_POR_GRADO_LAT;
  const dx = (lon2 - lon1) * M_POR_GRADO_LAT * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}
