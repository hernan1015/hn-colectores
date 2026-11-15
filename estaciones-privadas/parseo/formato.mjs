// HN AGRO · parseo de estaciones internas · LO QUE SE SABE DEL FORMATO de cada crudo (y lo que no).
//
// Lo VERIFICADO sale de ronda.mjs (main 7a3d3af), que es quien escribe el crudo en R2:
//   WeatherLink   estaciones-internas/weatherlink/<día ARG>/<HHMM UTC>.jsonl   un renglón por estación:
//                   { id, leido: ISO, d: <la respuesta de /map/data/station/{id}> }
//                 estaciones-internas/weatherlink/indices/<día ARG>.json      [{ id, lat, lng, tb, … }] (ya sólo AR;
//                   tb = −1 = inactiva)
//   Weathercloud  estaciones-internas/weathercloud/<día ARG>/<HHMM UTC>.json  { leido: ISO, devices: [ [ … ], … ] }
//                   (ya sólo AR); cada device es un ARRAY: [2] = lat, [3] = lon, [4] = estado (2 = en línea).
//
// ⚠ Lo NO VERIFICADO (desde pc-nanci no hay ninguna muestra del crudo y no se hizo ningún pedido, ni a R2):
//   · las CLAVES del detalle de WeatherLink. Las de abajo son las supuestas; si no están, la lectura cuenta como
//     'formato' y no se guarda (no se inventa nada). Las unidades: °F, mph, in e inHg (lo dijo local el 13/11).
//   · las demás POSICIONES del array de Weathercloud (id, nombre, variables, en décimas según local). Por eso WC
//     nace con `verificado: false`: sin una muestra mirada, NO se guarda nada de Weathercloud (sólo se cuenta).
//     Local mira un device de R2, completa `posiciones` y pone `verificado: true` (es un cambio de este archivo).

export const WEATHERLINK = {
  verificado: false,          // las claves son supuestas: lo que no se entiende se descarta CONTADO, no se adivina
  campos: {
    instante:   { claves: ['lastTimestamp', 'lastReceived', 'timestamp', 'ts'] },
    edad:       { claves: ['ageInSeconds', 'age'] },
    nombre:     { claves: ['stationName', 'name', 'station_name'] },
    temp_c:     { claves: ['temperature', 'temp', 'tempOut', 'outsideTemp'], unidad: 'F' },
    hum_pct:    { claves: ['humidity', 'hum', 'humOut', 'outsideHum'], unidad: '%' },
    viento_ms:  { claves: ['windSpeed', 'wind', 'windSpeedLast'], unidad: 'mph' },
    racha_ms:   { claves: ['windGust', 'gust', 'windSpeedHi'], unidad: 'mph' },
    viento_dir_gr: { claves: ['windDirection', 'windDir'], unidad: 'gr' },
    presion_hpa:   { claves: ['barometer', 'pressure', 'bar', 'barometricPressure'], unidad: 'inHg' },
    lluvia_dia_mm: { claves: ['rainDay', 'dailyRain', 'rainDaily', 'rain'], unidad: 'in' },
  },
  edad_max_s: 7200,           // una lectura con ageInSeconds > 2 h no cuenta (138b)
};

export const WEATHERCLOUD = {
  verificado: false,          // ⚠ hasta que local mire una muestra: no se guarda NADA de Weathercloud
  posiciones: {
    // verificadas (ronda.mjs):
    lat: 2, lon: 3, estado: 4,
    // SUPUESTAS (completar con una muestra; null = no se lee):
    id: 0, nombre: 1, instante: null,
    temp_c: null, hum_pct: null, viento_ms: null, racha_ms: null, viento_dir_gr: null, presion_hpa: null, lluvia_dia_mm: null,
  },
  // la escala de cada variable: Weathercloud manda décimas (local, 15/11): 215 = 21,5 °C
  escala: { temp_c: 0.1, viento_ms: 0.1, racha_ms: 0.1, presion_hpa: 0.1, lluvia_dia_mm: 0.1, hum_pct: 1, viento_dir_gr: 1 },
  // la unidad DESPUÉS de la escala: el viento en m/s (como estaciones_ultima_lectura) o en km/h
  unidad: { viento_ms: 'ms', racha_ms: 'ms' },
  en_linea: 2,                // estado = 2: en línea (ronda.mjs). Las que no están en línea no aportan lecturas.
};
