// HN AGRO · ARCHIVO DEL ÍNDICE CAP DEL SMN (225) · lo que toca al SMN: el pedidor (anti-spam) y la lectura del índice.
// Nada de red salvo `crearPedidor().pedir` (con fetch inyectable). Ver cap-archivo/LEEME.md.
//
// EL ÍNDICE: https://ssl.smn.gob.ar/CAP/AR.php, un RSS 2.0 con un <item> por aviso y su <link> al XML CAP. El 14/11 a
//   las 14:26 traía 96 ítems: 93 de feeds/CAP/xml_generados/, 1 ACP de feeds/CAP/avisocortoplazo/ y 2 de calor de
//   http://forms.smn.gob.ar/feeds/CAP/oladecalor/ (la 222). Licencia CC BY 4.0, lo dice el propio RSS.
// LA LISTA BLANCA (la regla de la 222): se siguen SÓLO los <link> hijos de un <item> con la forma completa y anclada
//   http(s)://(ssl|forms).smn.gob.ar/feeds/CAP/<carpeta>/<archivo>.xml, y la carpeta tiene que estar en CARPETAS.
//   · una carpeta del SMN que no está en la lista → NO se pide y es FALLA (`carpeta_nueva`): alguien tiene que mirarla
//     y sumarla (así se perdieron los ACP hasta el 14/11);
//   · un <link> que no tiene esa forma (otro host, cortado, vacío) → NO se pide y es FALLA (`enlace_raro`);
//   · el índice se guarda ENTERO igual, tal cual llegó: lo que no se siguió queda en el archivo para mirarlo.
// EL ANTI-SPAM (el SMN nos frenó el 14/11 por los pedidos de prueba):
//   · UN pedido por URL y por corrida: el pedidor rechaza una URL ya pedida (no hay reintentos en bucle);
//   · UN pedido al índice por corrida (lo hace flujo.mjs, una vez);
//   · de a uno, con PAUSA_MS entre pedidos, y como mucho TOPE_XML XML por corrida;
//   · ante un 429 (o 403, 5xx, sin conexión o tiempo agotado) se CORTA: el pedidor no hace ningún pedido más en esa
//     corrida, y flujo.mjs anota una pausa (PAUSA_CORTE) que las corridas siguientes respetan SIN pedirle nada al SMN;
//   · User-Agent identificable: UA.
import crypto from 'node:crypto';

export const INDICE_URL = 'https://ssl.smn.gob.ar/CAP/AR.php';
export const UA = 'hn-colectores-cap-archivo/1.0 (HN AGRO; archivo de avisos CAP del SMN, un pedido cada 10 min)';
export const CARPETAS = Object.freeze(['xml_generados', 'avisocortoplazo', 'oladecalor']);
export const RE_LINK = /^https?:\/\/(ssl|forms)\.smn\.gob\.ar\/feeds\/CAP\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+\.xml)$/;
export const PAUSA_MS = 1500;          // entre dos pedidos al SMN
export const TOPE_XML = 150;           // XML por corrida (el 14/11 había 96 en el índice)
export const TIEMPO_MS = 20000;        // corte de cada pedido
export const TOPE_BYTES = 5 * 1024 * 1024;   // el índice pesa ~70 KB y cada XML ~2 KB
/** Cuánto se espera, en minutos, antes de volver a pedirle algo al SMN después de un corte. */
export const PAUSA_CORTE = Object.freeze({ http_429: 60, http_403: 60, http_5xx: 20, red: 20 });
const MIN = 60000;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** ¿esta respuesta corta la corrida? → el motivo ('http_429', 'http_403', 'http_5xx', 'red') o null. */
export function motivoCorte(r) {
  if (r.error) return 'red';
  if (r.http === 429) return 'http_429';
  if (r.http === 403) return 'http_403';
  if (r.http >= 500) return 'http_5xx';
  return null;
}

/** Los segundos que pide un Retry-After, en sus dos formas (RFC 9110 §10.2.3): un número de segundos, o una fecha HTTP
 *  (contada desde `desdeMs`, la hora del pedido). null si no se entiende o no pide esperar. */
export function segundosRetryAfter(retryAfter, desdeMs = Date.now()) {
  if (retryAfter == null) return null;
  const t = String(retryAfter).trim();
  if (/^\d+$/.test(t)) { const n = Number(t); return n > 0 ? n : null; }
  if (!/[A-Za-z]/.test(t)) return null;   // «-5», «1.5»: no es ninguna de las dos formas
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const s = Math.ceil((ms - desdeMs) / 1000);
  return s > 0 ? s : null;
}

/** Minutos de pausa después de un corte: el de la tabla, o el Retry-After si pide más (con un tope de 6 h). */
export function minutosDePausa(motivo, retryAfter, desdeMs = Date.now()) {
  const base = PAUSA_CORTE[motivo] ?? 20;
  const ra = segundosRetryAfter(retryAfter, desdeMs);
  return ra ? Math.max(base, Math.min(360, Math.ceil(ra / 60))) : base;
}

/** El cuerpo: texto si es UTF-8 válido (lo normal), si no base64. Así se guarda byte por byte lo que llegó.
 *  · ignoreBOM: el BOM (EF BB BF) queda en el texto como U+FEFF; sin eso TextDecoder lo come y el sha256 no cierra;
 *  · y se comprueba la vuelta: si el texto no reconstruye EXACTAMENTE los mismos bytes, va en base64. */
export function cuerpoDe(buf) {
  let texto = null;
  try { texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { texto = null; }
  if (texto != null && Buffer.from(texto, 'utf8').equals(buf)) return { cuerpo: texto };
  return { cuerpo_b64: buf.toString('base64') };
}
/** Los bytes de un registro guardado con cuerpoDe (para comprobar el sha256). */
export const bytesDe = (x) => (x.cuerpo_b64 != null ? Buffer.from(x.cuerpo_b64, 'base64') : x.cuerpo != null ? Buffer.from(x.cuerpo, 'utf8') : null);

/**
 * El pedidor de UNA corrida. Nunca lanza: lo que pase queda en el resultado.
 *  · `pedir(url)` hace UN pedido. Si la URL ya se pidió en esta corrida, o la corrida ya está cortada, NO pide nada
 *    y devuelve { pedido: false, motivo }.
 *  · entre dos pedidos duerme `pausaMs` (inyectable para los tests).
 */
export function crearPedidor({ fetchFn = globalThis.fetch, pausaMs = PAUSA_MS, dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  ahora = () => Date.now(), tiempoMs = TIEMPO_MS } = {}) {
  const pedidas = new Set();
  const p = { pedidos: 0, cortado: null, retryAfter: null, pausas: 0 };
  p.pedir = async (url) => {
    if (p.cortado) return { url, pedido: false, motivo: 'cortado' };
    if (pedidas.has(url)) return { url, pedido: false, motivo: 'ya_pedida' };
    pedidas.add(url);
    if (p.pedidos > 0 && pausaMs > 0) { await dormir(pausaMs); p.pausas++; }
    p.pedidos++;
    const t0 = ahora();
    const out = { url, pedido: true, pedido_ms: t0, http: null, error: null, bytes: 0, sha256: null, buf: null, retry_after: null, location: null, duracion_ms: null };
    try {
      // redirect: 'manual' → un 3xx NO se sigue: el destino no pasaría por la lista blanca ni por el Set de pedidas, y
      // sería un pedido más sin contar. Vuelve tal cual (http 3xx, con su Location) y flujo.mjs lo trata como falla.
      const r = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' }, redirect: 'manual', signal: AbortSignal.timeout(tiempoMs) });
      out.http = r.status;
      out.retry_after = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
      if (r.status >= 300 && r.status < 400 && r.headers && r.headers.get) out.location = String(r.headers.get('location') || '').slice(0, 200) || null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > TOPE_BYTES) out.error = 'cuerpo de más de ' + TOPE_BYTES + ' bytes (no se guarda)';
      else { out.buf = buf; out.bytes = buf.length; out.sha256 = sha256(buf); }
    } catch (e) {
      out.error = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'red: tiempo agotado (' + tiempoMs + ' ms)'
        : 'red: ' + String((e && e.cause && e.cause.code) || (e && e.message) || e).replace(/[^\w :.-]/g, '').slice(0, 80);
    }
    out.duracion_ms = ahora() - t0;
    const m = motivoCorte(out);
    if (m) { p.cortado = m; p.retryAfter = out.retry_after; }
    return out;
  };
  return p;
}

const ENT = /&(lt|gt|amp|quot|apos);/g;
const ENT_V = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const escXml = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Lo que NO es marcado sale antes de leer: los comentarios se van; un CDATA es TEXTO (se escapa: un <item> adentro no
 *  es un ítem, y un <link><![CDATA[url]]></link> sigue siendo un link); las <?…?> y el <!DOCTYPE> también se van. */
export const sinComentariosNiCdata = (t) =>
  t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g, (_, cd) => (cd != null ? escXml(cd) : ''));

const ITEM = 'rss>channel>item', LINK = 'rss>channel>item>link';
const RE_TAG = /<(\/?)([A-Za-z_][\w.:-]*)(?:\s(?:[^>"']|"[^"]*"|'[^']*')*?)?(\/?)>/g;

/**
 * PURA. El índice → qué ítems trae y a qué XML apunta cada uno. Se recorre como XML (una pila de etiquetas), sobre el
 * texto sin comentarios ni CDATA: cuentan sólo los <item> HIJOS de rss > channel, y de cada uno sólo sus <link> HIJOS.
 *  · items: los <item> completos de rss > channel; abiertos: todas las etiquetas <item (si difieren, hay un ítem
 *    cortado o fuera de lugar → indice_cortado);
 *  · entero: termina en </channel></rss>;
 *  · enlaces: los de la lista blanca, sin repetir (una URL que aparece dos veces se pide una sola vez);
 *  · fuera: carpetas del SMN que no están en la lista ({ carpeta, n });
 *  · raros: CADA <link> de un ítem que no tiene la forma completa (aunque el ítem tenga otro bueno), más cada ítem sin
 *    ningún <link>.
 */
export function leerIndice(texto) {
  const t0 = String(texto == null ? '' : texto);
  const entero = /<\/channel>\s*<\/rss>\s*$/.test(t0);
  const t = sinComentariosNiCdata(t0);
  const abiertos = (t.match(/<item[\s>/]/g) || []).length;
  const vistos = new Set(), enlaces = [], fuera = {}, porCarpeta = {};
  let raros = 0, items = 0;
  const anotar = (l) => {
    const url = l.trim().replace(ENT, (_, e) => ENT_V[e]);
    const m = RE_LINK.exec(url);
    if (!m) { raros++; return; }
    const carpeta = m[2];
    if (!CARPETAS.includes(carpeta)) { fuera[carpeta] = (fuera[carpeta] || 0) + 1; return; }
    if (vistos.has(url)) return;
    vistos.add(url);
    porCarpeta[carpeta] = (porCarpeta[carpeta] || 0) + 1;
    enlaces.push({ url, carpeta, archivo: m[3] });
  };
  const pila = [];
  let item = null, link = null, desde = 0, m;   // item = los links del <item> abierto; link = su texto (null: no hay)
  RE_TAG.lastIndex = 0;
  while ((m = RE_TAG.exec(t))) {
    if (link != null) link += t.slice(desde, m.index);
    desde = RE_TAG.lastIndex;
    const [, cierre, nombre, auto] = m;
    if (cierre) {
      const i = pila.lastIndexOf(nombre);
      if (i < 0) continue;
      const camino = pila.slice(0, i + 1).join('>');
      if (camino === LINK && item) { item.push(link ?? ''); link = null; }
      else if (camino === ITEM && item) { items++; if (!item.length) raros++; for (const l of item) anotar(l); item = null; link = null; }
      pila.length = i;
      continue;
    }
    const camino = [...pila, nombre].join('>');
    if (auto) { if (camino === LINK && item) item.push(''); continue; }
    pila.push(nombre);
    if (camino === ITEM) { item = []; link = null; }
    else if (camino === LINK && item) link = '';
    else if (link != null) link = '\u0000';   // marcado adentro del <link>: no es una URL (queda raro)
  }
  return { items, abiertos, entero, enlaces, por_carpeta: porCarpeta, fuera, raros };
}

/** ¿parece un aviso CAP? (no se valida más: se guarda tal cual; esto sólo marca lo que no lo parece). */
export const pareceCap = (texto) => /<(?:[A-Za-z][\w.-]*:)?alert[\s>]/.test(String(texto)) && /urn:oasis:names:tc:emergency:cap/.test(String(texto));

export const minutos = (n) => n * MIN;
