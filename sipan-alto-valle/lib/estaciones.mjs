// HN AGRO · SIPAN Alto Valle · el catálogo de estaciones de la red agrometeorológica del INTA EEA Alto Valle.
// ⛔ USO INTERNO: no se muestra en SATCHI ni en HN AGRO hasta que el INTA lo autorice (decisión del maker, 13/11/2026).
//
// Los ids son los de la dirección https://sipan.inta.gob.ar/agrometeorologia/met/<id>/downld02.txt. Los 5 que
// respondían el 13/11/2026 15:55 (prueba de la sesión local). Las coordenadas salen de `Estacion.csv` del repositorio
// de GitHub Ferka7/Data_EEA_AltoValle (sin licencia declarada: sólo se toman las coordenadas, para ubicar), cruzadas por
// el NOMBRE de la estación; falta confirmarlas con clima.htm del SIPAN (desde la PC de pc-nanci el SIPAN corta la
// conexión, ver LEEME).
//
// Faltan, sin id conocido: Vista Alegre (Estacion.csv EEA02: −38,762103, −68,164161, 305 m), Río Colorado y la
// estación nueva de junio de 2026. El modo «barrer» del colector los busca en clima.htm (un pedido) y prueba sólo los
// ids que aparezcan ahí (tope 15).
export const BASE_URL = 'https://sipan.inta.gob.ar/agrometeorologia/met/';
export const urlDe = (id) => `${BASE_URL}${encodeURIComponent(id)}/downld02.txt`;

const FUENTE_UBIC = 'Estacion.csv de github.com/Ferka7/Data_EEA_AltoValle (por nombre; a confirmar con clima.htm del SIPAN)';

export const ESTACIONES = [
  { id: '10', nombre: 'Guerrico (EEA Alto Valle)', partido: 'General Roca', provincia: 'Río Negro', lat: -39.016667, lon: -67.666667, elevacion_m: 242, csv: 'EEA03' },
  { id: '40', nombre: 'Villa Regina', partido: 'General Roca', provincia: 'Río Negro', lat: -39.125833, lon: -67.106111, elevacion_m: 158, csv: 'EEA04' },
  { id: '41', nombre: 'Coronel Belisle', partido: 'Avellaneda', provincia: 'Río Negro', lat: -39.1975, lon: -65.893611, elevacion_m: 128, csv: 'EEA05' },
  { id: '42', nombre: 'Luis Beltrán', partido: 'Avellaneda', provincia: 'Río Negro', lat: -39.3171864, lon: -65.75345755, elevacion_m: 128, csv: 'EEA06' },
  { id: '45', nombre: 'Cinco Saltos', partido: 'General Roca', provincia: 'Río Negro', lat: -38.844722, lon: -68.069167, elevacion_m: 282, csv: 'EEA01' },
  /* [13/11 22:00] Las que encontró el barrido (local, primera corrida desde Actions) y están INACTIVAS: se registran en
     el catálogo como inactivas, con su último dato conocido, y se les pide el archivo UNA vez por mes (el día 1), por si
     reviven. Sin coordenadas: no están en Estacion.csv (falta clima.htm). */
  { id: '20', nombre: 'Valle Inferior', partido: null, provincia: 'Río Negro', lat: null, lon: null, elevacion_m: null, csv: null, pedir: 'mensual', ultimo_conocido: 'la página existe, sin downld02 (13/11/2026)' },
  { id: '48', nombre: 'Picún Leufú', partido: null, provincia: 'Neuquén', lat: null, lon: null, elevacion_m: null, csv: null, pedir: 'mensual', ultimo_conocido: 'último registro de 2019 (barrido del 13/11/2026)' },
  { id: '68', nombre: 'Centenario', partido: null, provincia: 'Neuquén', lat: null, lon: null, elevacion_m: null, csv: null, pedir: 'mensual', ultimo_conocido: 'último registro de 2021 (barrido del 13/11/2026)' },
];

/** La fila de `estaciones` (0110). `metadatos` junta lo fijo con lo que deja cada corrida. */
export function filaEstacion(e, metadatos = {}) {
  return {
    red: 'INTA_SIPAN_AV', estacion_id: e.id, nombre: e.nombre, partido: e.partido, provincia: e.provincia,
    lat: e.lat, lon: e.lon, precision_ubicacion: e.lat == null ? null : 'declarada por un tercero', fuente_ubicacion: e.lat == null ? null : FUENTE_UBIC,
    activa: metadatos.estado !== 'inactiva',   // la columna de la 0110 sigue al estado (metadatos.estado / metadatos.activa)
    metadatos: {
      red_interna: 'INTA EEA Alto Valle · SIPAN agrometeorología', url: urlDe(e.id), elevacion_m: e.elevacion_m, id_csv: e.csv,
      tipo: 'Davis Vantage (export WeatherLink downld02.txt, 10 min)', hora: 'reloj de la estación = hora de Argentina (UTC−3)',
      uso: 'INTERNO: no se muestra en SATCHI ni en HN AGRO hasta que el INTA lo autorice; citar al INTA EEA Alto Valle',
      ...metadatos,
    },
    actualizado_en: new Date().toISOString(),
  };
}

/** clima.htm → [{ id, texto }] con los ids de estación que aparezcan en enlaces (formato desconocido: se busca genérico). */
export function idsDePagina(html) {
  const out = new Map();
  const re = /<a\b[^>]*href=["']?([^"' >]*)["']?[^>]*>([\s\S]{0,200}?)<\/a>/gi;
  for (const m of String(html || '').matchAll(re)) {
    const h = m[1];
    const id = (/(?:^|\/)met\/(\d{1,3})\//.exec(h) || /(?:^|\/)(\d{1,3})\/(?:downld02\.txt|Current_Vantage\.htm|index\.htm)/i.exec(h) || [])[1];
    if (!id) continue;
    const texto = m[2].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!out.has(id) || (!out.get(id).texto && texto)) out.set(id, { id, texto });
  }
  return [...out.values()].sort((a, b) => +a.id - +b.id);
}
