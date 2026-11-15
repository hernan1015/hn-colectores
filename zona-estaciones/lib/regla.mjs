// 257 · la regla de la zona de una estación, a partir de los conteos de clases de ESA WorldCover 2021 v200
// en una ventana circular alrededor del punto.
//
// Clases de WorldCover (Zanaga et al. 2022): 10 árboles · 20 arbustos · 30 pastizal · 40 cultivo · 50 construido ·
// 60 suelo desnudo o vegetación rala · 70 nieve y hielo · 80 agua permanente · 90 humedal herbáceo · 95 manglar ·
// 100 musgo y líquenes · 0 = sin dato (no cuenta). 255 = píxel NO LEÍDO (el tile no existe): tampoco cuenta.
//
// REGLA r1 (propuesta; los umbrales salen de la tanda del 15/11 y se recalibran con los porcentajes guardados):
//   1. Se mira el círculo de 250 m de radio (≈ 2.750 píxeles de 10 m).
//   2. COBERTURA = píxeles con dato / píxeles del círculo. Con menos del 90 % → `sin_dato` (no se calcula una zona
//      sobre una ventana incompleta como si fuera la entera). Entre el 90 % y el 100 % se calcula, pero queda
//      `dudosa` por cobertura.
//   3. `urbana` si lo construido (50) es ≥ 30 % de los píxeles con dato.
//   4. Si no, se suman tres grupos sobre lo NO construido: agricola = 40; pastizal = 30; natural = todo lo demás
//      (10, 20, 60, 70, 80, 90, 95, 100). Gana el grupo mayor. Empate: agricola > pastizal > natural.
//   5. `margen` = puntos entre el primero y el segundo grupo (en urbana: construido − el mayor del resto).
//      Con margen < 10 la zona es `dudosa` por margen.
//   TODAS LAS DECISIONES SE TOMAN CON CONTEOS ENTEROS (construido × 100 ≥ 30 × total, etc.): el redondeo a un
//   decimal es sólo para mostrar.

export const REGLA = 'r1';
export const RADIO_REGLA_M = 250;
export const UMBRAL_URBANA = 30;     // % de construido
export const UMBRAL_COBERTURA = 90;  // % mínimo del círculo con dato
export const UMBRAL_MARGEN = 10;     // puntos: por debajo, dudosa

export const CLASES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
export const NOMBRE_CLASE = { 10: 'arboles', 20: 'arbustos', 30: 'pastizal', 40: 'cultivo', 50: 'construido', 60: 'desnudo',
  70: 'nieve', 80: 'agua', 90: 'humedal', 95: 'manglar', 100: 'musgo' };
export const ZONAS = ['agricola', 'pastizal', 'urbana', 'natural', 'sin_dato'];
export const NO_LEIDO = 255;

/** Un % con 1 decimal, SÓLO para mostrar. */
const mostrar = (n, total) => (total ? Math.round((n * 1000) / total) / 10 : 0);

/**
 * {clase: píxeles} → { total (con dato), circulo (todos los píxeles del círculo, con 0 y no leídos), cobertura (%,
 * para mostrar), pct: {clase: % para mostrar sobre los píxeles con dato} }.
 */
export function porcentajes(conteos) {
  let total = 0, circulo = 0;
  for (const c of CLASES) total += conteos?.[c] || 0;
  for (const v of Object.values(conteos || {})) circulo += v || 0;
  const pct = {};
  for (const c of CLASES) pct[c] = mostrar(conteos?.[c] || 0, total);
  return { total, circulo, cobertura: mostrar(total, circulo), pct };
}

/** La zona a partir de los conteos de la ventana. */
export function clasificar(conteos, { umbralUrbana = UMBRAL_URBANA, umbralCobertura = UMBRAL_COBERTURA, umbralMargen = UMBRAL_MARGEN } = {}) {
  const { total, circulo, cobertura, pct } = porcentajes(conteos);
  const n = (c) => conteos?.[c] || 0;
  const base = { total, circulo, cobertura, pct };
  // cobertura: entera, sin redondear (total × 100 < 90 × círculo)
  if (!total || total * 100 < umbralCobertura * circulo) {
    return { ...base, zona: 'sin_dato', margen: null, dudosa: false, motivos: [], grupos: null };
  }
  const g = { agricola: n(40), pastizal: n(30), natural: total - n(40) - n(30) - n(50) };
  const grupos = { agricola: pct[40], pastizal: pct[30], natural: mostrar(g.natural, total) };
  let zona, ventaja;
  if (n(50) * 100 >= umbralUrbana * total) {
    zona = 'urbana';
    ventaja = n(50) - Math.max(g.agricola, g.pastizal, g.natural);
  } else {
    const orden = ['agricola', 'pastizal', 'natural'].sort((a, b) => g[b] - g[a]); // sort estable: desempata por el orden de arriba
    zona = orden[0];
    ventaja = g[orden[0]] - g[orden[1]];
  }
  const motivos = [];
  if (ventaja * 100 < umbralMargen * total) motivos.push('margen');
  if (total < circulo) motivos.push('cobertura');
  return { ...base, zona, margen: mostrar(ventaja, total), dudosa: motivos.length > 0, motivos, grupos };
}
