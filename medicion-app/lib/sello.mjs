// HN AGRO · 260 · medicion-app · LOS UMBRALES DEL SELLO, en un solo lugar.
// El sello está en el cortex: docs/mejora-continua/260-medicion/SELLO.json (regla m1, 15/11/2026 14:17, ANTES de medir).
// Estos números NO se cambian mirando resultados: un cambio va con SELLO-2.json, regla m2 (test/sello.test.mjs compara
// este archivo con el sello cuando hay copia del cortex, HN_SELLO_260=<ruta al SELLO.json>).
export const REGLA = 'm1';

export const SELLO = Object.freeze({
  fraccion_minima: 0.8,          // lecturas válidas ≥ techo(0,8 × esperadas)
  hueco_noche_min: 120,          // el hueco más largo en (fecha 18:00, fecha+1 09:00]
  hueco_dia_min: 180,            // el hueco más largo en (fecha 00:00, fecha+1 00:00]
  madrugada: ['03:00', '09:00'], // al menos una lectura válida en (fecha+1 03:00, 09:00]
  muestreo_max_min: 60,          // muestreo_min null (consola) o ≤ 60
  redes_sin_extremos: Object.freeze(['BCP_RT']),   // sus extremos no dicen desde qué hora cuentan
  umbral_temp_c: 3,              // % de estaciones con |dif| ≥ 3 °C
  umbral_hr_pp: 10,              // % con |dif| ≥ 10 pp
  n_minimo_grupo: 5,             // con menos, sólo n
  horas_noche: 15,               // fecha 19:00 … fecha+1 09:00
  horas_dia: 24,                 // fecha 01:00 … fecha+1 00:00
});

/** Lo que pide la app (hn-agro main 1cc6afd3, index.html _v1084 FIJO / _v722): /v1/forecast, sin `models` (best_match). */
export const OM = Object.freeze({
  base: 'https://api.open-meteo.com/v1/forecast',
  hourly: Object.freeze(['temperature_2m', 'relative_humidity_2m']),
  timezone: 'America/Argentina/Buenos_Aires',
  offset_s: -10800,
  decimales: 4,
  por_pedido: 50,
  pausa_ms: 30000,
  reintento_ms: 60000,
  timeout_ms: 60000,
  tope_puntos: 2000,
  tolerancia_celda_gr: 0.5,
  modelo: 'best_match',
});

export const ZONAS = Object.freeze(['agricola', 'pastizal', 'urbana', 'natural', 'sin_dato']);
export const REGIONES = Object.freeze(['patagonia', 'noa', 'nea', 'cuyo', 'pampa_norte', 'pampa_sur']);
export const PROCESO = 'medicion_app';
