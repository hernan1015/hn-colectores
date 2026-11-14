// HN AGRO · ARCHIVO DE BARRIDOS DE GRANIZO (147) · lo puro: pedir, clasificar, nombrar y armar el sobre.
// Nada de red salvo `pedirGranizo` (con fetch inyectable). Ver granizo-archivo/PRENDER.md.
//
// LA RESPUESTA (satchi-publico?que=granizo → granizo-vivo._publico, repo hn-agro):
//   { ok, parcial, scan_t, scan_t20, edad_min, h0_fuente, celdas:[…], sin_dato:[…], faltantes:[…], resumen, archivos, … }
//   ~380 KB de JSON (≈2200 celdas + ≈950 sin_dato). La function NO guarda nada: la buena vive 600 s en la red de Netlify
//   y la parcial o la falla, ni eso. Por eso este archivo.
// LOS TRES ESTADOS (el mismo criterio que satchi-publico.esBuena):
//   · buena   = HTTP 200, JSON, ok ≠ false, parcial ≠ true y un scan_t válido;
//   · parcial = HTTP 200, JSON, ok ≠ false y parcial = true (faltó NOAA, GLM u Open-Meteo para una parte), o sin scan_t;
//   · falla   = todo lo demás: sin respuesta, HTTP ≠ 200 (403 apagado, 429, 5xx), JSON roto u ok = false.
//   Las tres se GUARDAN: lo que SATCHI mostraba (o no) a esa hora también es un dato del caso.
// EL NOMBRE (= la deduplicación): `AAAAMMDDTHHMMZ.<estado>.json.gz` con la hora del SCAN de GOES (UTC, al minuto).
//   El mismo scan con el mismo estado tiene el mismo nombre: un cron atrasado o doble no lo duplica. Sin scan_t
//   (la falla de red, casi siempre) se nombra por el turno de 10 min del PEDIDO: `pedido-AAAAMMDDTHHMMZ.<estado>.json.gz`.
// EL DÍA (= el release `granizo-AAAA-MM-DD`): el día ARGENTINO del scan (o del pedido, si no hay scan), como el radar.
// SALTEAR LA CACHÉ VENCIDA (147a, decisión de local): la red de Netlify guarda la buena «durable» con
//   stale-while-revalidate y el 13/11 21:54 sirvió un scan de 34 min (age 958, ttl=-358). El pedido lleva `&_t=<turno de
//   10 min UTC>`: granizo no declara Netlify-Vary, así que la clave de la red es la URL entera y cada turno es una copia
//   nueva (un cálculo por turno, ~144 por día; un reintento en el mismo turno reusa la copia). satchi-publico arma `q` sólo
//   con los parámetros que conoce (granizo no lee ninguno) y `_t` no está en PARAMS_LOTE ni en QS_CREDENCIAL: no cambia
//   la respuesta ni la saca de la red compartida. Se guardan `age` y `cache-status` para medir.
import zlib from 'node:zlib';

export const URL_GRANIZO = 'https://app.hnagroapp.com/.netlify/functions/satchi-publico?que=granizo';
export const UA = 'hn-colectores-granizo-archivo';
export const TZ_AR = 'America/Argentina/Buenos_Aires';
export const TOPE_BYTES = 20 * 1024 * 1024;     // la respuesta normal pesa ~0,4 MB
export const FORMATO = 'hn-granizo-barrido/1';
const MIN = 60000;
const DIEZ = 10 * MIN;
const CABECERAS = ['date', 'age', 'cache-control', 'cache-status', 'netlify-cdn-cache-control', 'x-nf-request-id', 'content-type', 'content-length', 'retry-after'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

const fmtAR = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** 'AAAA-MM-DDTHH:MM:SS-03:00' (la Argentina no tiene horario de verano; igual se calcula con la zona). */
export function horaAR(ms) {
  const p = Object.fromEntries(fmtAR.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((local - Math.floor(ms / 1000) * 1000) / MIN);
  const s = off < 0 ? '-' : '+', a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
export const diaAR = (ms) => horaAR(ms).slice(0, 10);
export const minutoUTC = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 13);   // AAAAMMDDTHHMM
export const turno10 = (ms) => Math.floor(ms / DIEZ) * DIEZ;
export const PARAM_TURNO = '_t';
/** La URL con el turno de 10 min del pedido (saltea la copia vencida de la red; ver arriba). */
export function conTurno(url, ms) {
  const u = new URL(url);
  u.searchParams.set(PARAM_TURNO, minutoUTC(turno10(ms)) + 'Z');
  return u.toString();
}

/** Un pedido, una vez. Nunca lanza: lo que pase queda en el resultado. */
export async function pedirGranizo({ url = URL_GRANIZO, fetchFn = globalThis.fetch, ahora = () => Date.now(), tiempoMs = 45000, saltearCache = true } = {}) {
  const pedido_ms = ahora();
  if (saltearCache) url = conTurno(url, pedido_ms);
  const out = { url, pedido_ms, duracion_ms: null, http: null, cabeceras: {}, cuerpo: null, error: null };
  try {
    const r = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(tiempoMs) });
    out.http = r.status;
    for (const k of CABECERAS) { const v = r.headers && r.headers.get ? r.headers.get(k) : null; if (v != null) out.cabeceras[k] = v; }
    const t = await r.text();
    if (Buffer.byteLength(t, 'utf8') > TOPE_BYTES) out.error = 'cuerpo de más de ' + TOPE_BYTES + ' bytes (no se guarda)';
    else out.cuerpo = t;
  } catch (e) {
    out.error = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'red: tiempo agotado (' + tiempoMs + ' ms)'
      : 'red: ' + String((e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 200);
  }
  out.duracion_ms = ahora() - pedido_ms;
  return out;
}

/** scan_t válido: ISO UTC y entre 2 días antes y 1 hora después del pedido (un scan_t basura no nombra nada). */
export function scanValido(scan_t, pedido_ms) {
  if (typeof scan_t !== 'string' || !ISO.test(scan_t)) return null;
  const ms = Date.parse(scan_t);
  if (!Number.isFinite(ms) || ms < pedido_ms - 2 * 864e5 || ms > pedido_ms + 60 * MIN) return null;
  return ms;
}

export function clasificar(p) {
  const c = { estado: 'falla', motivo: null, ok: null, parcial: null, scan_t: null, scan_ms: null, faltantes: null };
  if (p.error) { c.motivo = p.error; return c; }
  let j = null;
  try { j = JSON.parse(p.cuerpo); } catch { j = null; }
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    c.ok = j.ok === undefined ? null : j.ok; c.parcial = j.parcial === undefined ? null : j.parcial;
    c.faltantes = Array.isArray(j.faltantes) ? j.faltantes.map(String).slice(0, 20) : null;
    c.scan_ms = scanValido(j.scan_t, p.pedido_ms);
    c.scan_t = c.scan_ms == null ? null : new Date(c.scan_ms).toISOString();
  }
  if (p.http !== 200) { c.motivo = 'http_' + p.http + (j && j.motivo ? ':' + String(j.motivo).slice(0, 40) : ''); return c; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) { c.motivo = 'json_roto'; return c; }
  if (j.ok === false) { c.motivo = 'ok_false' + (j.motivo ? ':' + String(j.motivo).slice(0, 40) : ''); return c; }
  if (j.parcial === true) { c.estado = 'parcial'; c.motivo = 'parcial' + (c.faltantes && c.faltantes.length ? ':' + c.faltantes.join(',').slice(0, 80) : ''); return c; }
  if (c.scan_ms == null) { c.estado = 'parcial'; c.motivo = 'sin_scan_t'; return c; }
  c.estado = 'buena';
  return c;
}

export function nombreBarrido(c, pedido_ms) {
  return c.scan_ms != null ? `${minutoUTC(c.scan_ms)}Z.${c.estado}.json.gz` : `pedido-${minutoUTC(turno10(pedido_ms))}Z.${c.estado}.json.gz`;
}
export const RE_BARRIDO = /^(pedido-)?(\d{8}T\d{4})Z\.(buena|parcial|falla)\.json\.gz$/;
export function leerNombre(nombre) {
  const m = RE_BARRIDO.exec(String(nombre));
  return m ? { porPedido: !!m[1], hora: m[2], estado: m[3] } : null;
}
export const tagDe = (c, pedido_ms) => 'granizo-' + diaAR(c.scan_ms != null ? c.scan_ms : pedido_ms);

/** El sobre: los metadatos del pedido y el CUERPO TAL CUAL (el texto recibido, sin volver a serializar). */
export function sobre(p, c, colector = {}) {
  return {
    formato: FORMATO, url: p.url,
    pedido_utc: new Date(p.pedido_ms).toISOString(), pedido_art: horaAR(p.pedido_ms), duracion_ms: p.duracion_ms,
    http: p.http, cabeceras: p.cabeceras, error: p.error,
    estado: c.estado, motivo: c.motivo, ok: c.ok, parcial: c.parcial, faltantes: c.faltantes,
    scan_t: c.scan_t, scan_art: c.scan_ms != null ? horaAR(c.scan_ms) : null,
    colector, cuerpo: p.cuerpo,
  };
}
export const empaquetar = (s) => zlib.gzipSync(Buffer.from(JSON.stringify(s), 'utf8'), { level: 9 });
export const desempaquetar = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
