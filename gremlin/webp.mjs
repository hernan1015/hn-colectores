// HN AGRO · [r79 · 1-bis] el codificador WebP de los cuadros enteros y las metateselas del precocido (gremlin/lib/precocido.mjs).
// Va FUERA de lib/ a propósito: es lo único que usa una dependencia (sharp, con versión fija en package-lock.json); la lib queda sin
// dependencias y el control negativo la copia a una carpeta temporal sin node_modules.
// LA ETIQUETA: cada WebP lleva un chunk XMP con <hn-slider>producto/tiempo/c/z</hn-slider> (o …/m/z/mx/my); la página la exige exacta.
// LA CALIDAD: GeoColor y el visible van con pérdida (q 82, el alfa casi sin pérdida: el borde que se esfuma y la noche del visible);
// GREMLIN va SIN PÉRDIDA, porque es una paleta de reflectividad: un artefacto de compresión cambiaría el color, es decir, el dBZ estimado.
import sharp from 'sharp';
import { xmpDe } from './lib/precocido.mjs';

export const AJUSTE_WEBP = Object.freeze({
  geocolor: Object.freeze({ quality: 82, alphaQuality: 90, effort: 4, smartSubsample: true }),
  band_02: Object.freeze({ quality: 82, alphaQuality: 90, effort: 4, smartSubsample: true }),
  gremlin: Object.freeze({ lossless: true, effort: 4 }),
});

/** rgba (Uint8Array w × h × 4) → Buffer WebP con la etiqueta en su XMP (xmp: el texto ya armado por lib/precocido.mjs, xmpDe) */
export async function codificarWebp(rgba, w, h, etiqueta, prod, xmp) {
  const ajuste = AJUSTE_WEBP[prod] || AJUSTE_WEBP.geocolor;
  const crudo = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return sharp(crudo, { raw: { width: w, height: h, channels: 4 } }).webp(ajuste).withXmp(xmp || xmpDe(etiqueta)).toBuffer();
}
