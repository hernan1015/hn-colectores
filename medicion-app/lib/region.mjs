// HN AGRO · 260 · las REGIONES del sello (m1): cajas por la coordenada, la primera que cumple. Sin polígonos ni bajadas.
import { ZONAS } from './sello.mjs';

export function region(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'sin_dato';
  if (lat <= -39 || (lat <= -36 && lon <= -68)) return 'patagonia';
  if (lat > -30 && lon <= -63) return 'noa';
  if (lat > -30) return 'nea';
  if (lon <= -65.5) return 'cuyo';
  if (lat > -35) return 'pampa_norte';
  return 'pampa_sur';
}

/** La zona de la 257 (metadatos.zona): lo que no está en la lista cuenta como sin_dato. */
export const zonaDe = (z) => (ZONAS.includes(z) ? z : 'sin_dato');
