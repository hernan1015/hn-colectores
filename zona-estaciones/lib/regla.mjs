// 257 · la regla de la zona de una estación, a partir de los conteos de clases de ESA WorldCover 2021 v200
// en una ventana circular alrededor del punto.
//
// Clases de WorldCover (Zanaga et al. 2022): 10 árboles · 20 arbustos · 30 pastizal · 40 cultivo · 50 construido ·
// 60 suelo desnudo o vegetación rala · 70 nieve y hielo · 80 agua permanente · 90 humedal herbáceo · 95 manglar ·
// 100 musgo y líquenes · 0 = sin dato (no cuenta).
//
// REGLA r1 (propuesta; los umbrales salen de la tanda del 15/11 y se recalibran con los porcentajes guardados):
//   1. Se mira el círculo de 250 m de radio (≈ 2.300 píxeles de 10 m).
//   2. `urbana` si lo construido (50) es ≥ 30 % de los píxeles con dato.
//      (Una estación agrícola al lado de un galpón, una casa y un camino rara vez llega al 15 %; el patio de una casa
//      en un pueblo suele pasar del 40 %.)
//   3. Si no, se suman tres grupos sobre lo NO construido: agricola = 40; pastizal = 30; natural = todo lo demás
//      (10, 20, 60, 70, 80, 90, 95, 100). Gana el grupo mayor. Empate: agricola > pastizal > natural.
//   4. Sin píxeles con dato (fuera de los tiles, todo 0) → `sin_dato`.
//   Además se devuelve `margen` (puntos entre el primero y el segundo grupo): con margen < 10 la zona es dudosa.

export const REGLA = 'r1';
export const RADIO_REGLA_M = 250;
export const UMBRAL_URBANA = 30; // % de construido

export const CLASES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
export const NOMBRE_CLASE = { 10: 'arboles', 20: 'arbustos', 30: 'pastizal', 40: 'cultivo', 50: 'construido', 60: 'desnudo',
  70: 'nieve', 80: 'agua', 90: 'humedal', 95: 'manglar', 100: 'musgo' };
export const ZONAS = ['agricola', 'pastizal', 'urbana', 'natural', 'sin_dato'];

/** {clase: píxeles} → {clase: % con 1 decimal} sobre los píxeles con dato (clase ≠ 0). */
export function porcentajes(conteos) {
  let total = 0;
  for (const c of CLASES) total += conteos?.[c] || 0;
  const pct = {};
  for (const c of CLASES) pct[c] = total ? Math.round(((conteos?.[c] || 0) * 1000) / total) / 10 : 0;
  return { total, pct };
}

/** La zona a partir de los conteos de la ventana. */
export function clasificar(conteos, { umbralUrbana = UMBRAL_URBANA } = {}) {
  const { total, pct } = porcentajes(conteos);
  if (!total) return { zona: 'sin_dato', margen: null, total, pct, grupos: null };
  const grupos = {
    agricola: pct[40],
    pastizal: pct[30],
    natural: Math.round((100 - pct[40] - pct[30] - pct[50]) * 10) / 10,
  };
  if (pct[50] >= umbralUrbana) {
    const resto = Math.max(grupos.agricola, grupos.pastizal, grupos.natural);
    return { zona: 'urbana', margen: Math.round((pct[50] - resto) * 10) / 10, total, pct, grupos };
  }
  const orden = ['agricola', 'pastizal', 'natural'].sort((a, b) => grupos[b] - grupos[a]); // sort estable: desempata por el orden de arriba
  return { zona: orden[0], margen: Math.round((grupos[orden[0]] - grupos[orden[1]]) * 10) / 10, total, pct, grupos };
}
