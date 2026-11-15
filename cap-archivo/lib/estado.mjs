// HN AGRO · ARCHIVO DEL ÍNDICE CAP (225) · el ESTADO entre corridas: qué URL ya se pidió (y con qué hash quedó
// guardada), el hash del último índice y la pausa después de un corte del SMN.
// Vive como asset `estado__<sello>.json.gz` en la release del día (se reemplaza: el nuevo antes que el viejo). Al
// empezar el día se lee el de la release del día anterior (hasta DIAS_ATRAS). Un estado que existe y no se lee FRENA la
// corrida (flujo.mjs, estado_ilegible). Sin ningún estado, se arranca vacío: en ese caso
// se vuelven a pedir los XML del índice vigente (una vez; es la única forma de no perderlos).
import zlib from 'node:zlib';

export const FORMATO_ESTADO = 'hn-smn-cap-estado/1';
export const RE_ESTADO = /^estado__\d{8}T\d{6}\.json\.gz$/;
export const DIAS_ATRAS = 3;
/** Una URL que no volvió a aparecer en el índice en este plazo se olvida (los avisos duran 1-3 días). */
export const OLVIDO_MS = 4 * 864e5;
/** Intentos por URL: el primero siempre; el segundo sólo si el primero fue un corte (429, 403, 5xx, red), en OTRA corrida. */
export const INTENTOS_MAX = 2;

export const vacio = () => ({ formato: FORMATO_ESTADO, indice: null, urls: {}, pausa_hasta: null, pausa_motivo: null });

export const empaquetarEstado = (e) => zlib.gzipSync(Buffer.from(JSON.stringify(e), 'utf8'), { level: 9 });
export function leerEstado(buf) {
  const j = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  if (!j || j.formato !== FORMATO_ESTADO || typeof j.urls !== 'object') throw new Error('estado con otro formato');
  return j;
}

/** Une varios estados (un reemplazo cortado deja dos): de cada URL se queda con la entrada más firme. */
export function unirEstados(lista) {
  const out = vacio();
  for (const e of lista) {
    if (e.indice && (!out.indice || e.indice.en > out.indice.en)) out.indice = e.indice;
    if (e.pausa_hasta && (!out.pausa_hasta || e.pausa_hasta > out.pausa_hasta)) { out.pausa_hasta = e.pausa_hasta; out.pausa_motivo = e.pausa_motivo; }
    for (const [url, x] of Object.entries(e.urls || {})) {
      const y = out.urls[url];
      if (!y) { out.urls[url] = { ...x }; continue; }
      const firme = (z) => (z.asset ? 2 : 0) + (z.final ? 1 : 0);
      const gana = firme(x) > firme(y) || (firme(x) === firme(y) && (x.intentos || 0) > (y.intentos || 0)) ? { ...x } : { ...y };
      gana.visto = Math.max(x.visto || 0, y.visto || 0);
      gana.intentos = Math.max(x.intentos || 0, y.intentos || 0);
      out.urls[url] = gana;
    }
  }
  return out;
}

/** ¿hay que pedir esta URL? Nunca pedida, o pedida una vez y cortada (sin llegar al tope de intentos). */
export function pendiente(estado, url) {
  const x = estado.urls[url];
  if (!x) return true;
  return !x.final && (x.intentos || 0) < INTENTOS_MAX;
}

/** hash → asset donde ya está guardado ese contenido (para no guardar dos veces lo mismo). */
export function hashesGuardados(estado) {
  const m = new Map();
  for (const x of Object.values(estado.urls)) if (x.sha256 && x.asset && !m.has(x.sha256)) m.set(x.sha256, x.asset);
  return m;
}

export function podar(estado, ahoraMs) {
  for (const [url, x] of Object.entries(estado.urls)) if (!x.visto || x.visto < ahoraMs - OLVIDO_MS) delete estado.urls[url];
  if (estado.pausa_hasta && estado.pausa_hasta <= ahoraMs) { estado.pausa_hasta = null; estado.pausa_motivo = null; }
  return estado;
}
