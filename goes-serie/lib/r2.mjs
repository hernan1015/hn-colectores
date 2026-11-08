// HN AGRO · goes-serie · cliente R2 (API S3). Reusa la firma SigV4 de rayos-hora/lib/almacen.mjs (no se duplica).
// Suma lo que almacenR2 no tiene: el listado CON tamaño y la copia del lado del servidor (CopyObject).
// Variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET. Nunca se imprimen.
// Los errores salen como un código fijo (r2_<op>_http_NNN), sin URL ni llaves.
import { firmar } from '../../rayos-hora/lib/almacen.mjs';

export const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function errorCodigo(codigo) { const e = new Error(codigo); e.codigo = codigo; return e; }
/** El código de un error, nunca su texto: lo propio, el código de Node o el nombre de la clase. */
export function codigoDe(e) {
  if (e && typeof e.codigo === 'string') return e.codigo;
  if (e && typeof e.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.code)) return e.code.toLowerCase();
  if (e && e.name === 'TimeoutError') return 'timeout';
  if (e && e.name === 'AbortError') return 'abortado';
  if (e && e.cause && typeof e.cause.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.cause.code)) return e.cause.code.toLowerCase();
  return e instanceof TypeError ? 'red' : 'error';
}
const xmlTexto = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** PURA. Una página de ListObjectsV2 → { objetos:[{clave, bytes}], truncado, token } */
export function leerPagina(xml) {
  const objetos = [];
  for (const m of String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
    const t = /<Size>(\d+)<\/Size>/.exec(m[1]);
    if (k) objetos.push({ clave: xmlTexto(k[1]), bytes: t ? Number(t[1]) : null });
  }
  const tk = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { objetos, truncado: /<IsTruncated>true<\/IsTruncated>/.test(xml), token: tk ? xmlTexto(tk[1]) : null };
}

export function r2({ cuenta, clave, secreto, deposito, fetchFn = fetch } = {}) {
  if (!cuenta || !clave || !secreto || !deposito) throw errorCodigo('faltan_secretos_r2');
  const host = `${cuenta}.r2.cloudflarestorage.com`;
  const rutaDe = (k) => '/' + deposito + (k ? '/' + k : '');
  async function pedido(metodo, k, { cuerpo = '', query = {}, headers = {}, ms = 60000 } = {}) {
    const ruta = rutaDe(k);
    const h = firmar({ metodo, host, ruta, query, headers, cuerpo, clave, secreto });
    delete h._firma;
    const qs = Object.keys(query).length ? '?' + Object.keys(query).sort().map((x) => `${enc(x)}=${enc(query[x])}`).join('&') : '';
    return fetchFn(`https://${host}${ruta.split('/').map(enc).join('/')}${qs}`, { method: metodo, headers: h, body: metodo === 'PUT' && cuerpo.length ? cuerpo : undefined, signal: AbortSignal.timeout(ms) });
  }
  const http = (op, r) => errorCodigo(`r2_${op}_http_${Number.isInteger(r.status) ? r.status : 0}`);
  return {
    tipo: 'r2',
    /** → [{clave, bytes}] ordenadas */
    async listar(prefijo) {
      const out = [];
      let token = null;
      for (let pag = 0; pag < 500; pag++) {
        const query = { 'list-type': '2', prefix: prefijo };
        if (token) query['continuation-token'] = token;
        const r = await pedido('GET', '', { query });
        if (!r.ok) throw http('listar', r);
        const p = leerPagina(await r.text());
        out.push(...p.objetos);
        if (!p.truncado) break;
        if (!p.token) throw errorCodigo('r2_listar_sin_token');
        token = p.token;
      }
      return out.sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
    },
    async leer(k) {
      const r = await pedido('GET', k);
      if (r.status === 404) return null;
      if (!r.ok) throw http('leer', r);
      return Buffer.from(await r.arrayBuffer());
    },
    /** → true (escrito) | false (ya existía y se pidió soloSiNoExiste) */
    async escribir(k, cuerpo, { tipo = 'application/json', soloSiNoExiste = false } = {}) {
      const headers = { 'content-type': tipo };
      if (soloSiNoExiste) headers['if-none-match'] = '*';
      const r = await pedido('PUT', k, { cuerpo: Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo), headers, ms: 120000 });
      if (soloSiNoExiste && (r.status === 412 || r.status === 409)) return false;
      if (!r.ok) throw http('escribir', r);
      return true;
    },
    async borrar(k) {
      const r = await pedido('DELETE', k);
      if (!r.ok && r.status !== 404) throw http('borrar', r);
    },
    /** CopyObject del lado del servidor. Si R2 no la acepta (501 / NotImplemented) → error r2_copiar_no_soportado. */
    async copiar(origen, destino) {
      const r = await pedido('PUT', destino, { headers: { 'x-amz-copy-source': rutaDe(origen).split('/').map(enc).join('/') } });
      let txt = '';
      try { txt = await r.text(); } catch { /* sin cuerpo */ }
      if (r.status === 501 || /NotImplemented/.test(txt)) throw errorCodigo('r2_copiar_no_soportado');
      if (!r.ok) throw http('copiar', r);
      if (/<Error>/.test(txt)) throw errorCodigo(/NotImplemented/.test(txt) ? 'r2_copiar_no_soportado' : 'r2_copiar_error_en_200');
      return true;
    },
  };
}
