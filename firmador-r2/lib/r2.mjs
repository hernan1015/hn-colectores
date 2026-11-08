// HN AGRO · firmador-r2 · R2: listar con tamaño (ListObjectsV2, firma de cabeceras de rayos-hora/lib/almacen.mjs) y
// firmar el GET de cada objeto (presign.mjs). Variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET. Nunca se imprimen, y tampoco las URL firmadas (dan acceso al objeto por 7 días).
import { firmar } from '../../rayos-hora/lib/almacen.mjs';
import { presignGet, enc, MAX_EXPIRA } from './presign.mjs';
import { errorCodigo } from './errores.mjs';

const xmlTexto = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** PURA. Una página de ListObjectsV2 → { objetos:[{clave, bytes}], truncado, token } */
export function leerPagina(xml) {
  const objetos = [];
  for (const m of String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
    const t = /<Size>(\d+)<\/Size>/.exec(m[1]);
    if (k) objetos.push({ clave: xmlTexto(k[1]), bytes: t ? Number(t[1]) : null });
  }
  const truncado = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const tk = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { objetos, truncado, token: tk ? xmlTexto(tk[1]) : null };
}

export function r2Firmador({ cuenta, clave, secreto, deposito, fetchFn = fetch, expira = MAX_EXPIRA } = {}) {
  if (!cuenta || !clave || !secreto || !deposito) throw errorCodigo('faltan_secretos_r2');
  const host = `${cuenta}.r2.cloudflarestorage.com`;
  return {
    host,
    /** → [{clave, bytes}] ordenadas; falla con un código fijo (r2_listar_http_NNN), sin URL ni llaves */
    async listar(prefijo) {
      const out = [];
      let token = null;
      for (let pag = 0; pag < 200; pag++) {
        const query = { 'list-type': '2', prefix: prefijo };
        if (token) query['continuation-token'] = token;
        const ruta = '/' + deposito;
        const h = firmar({ metodo: 'GET', host, ruta, query, clave, secreto });
        delete h._firma;
        const qs = Object.keys(query).sort().map((x) => `${enc(x)}=${enc(query[x])}`).join('&');
        const r = await fetchFn(`https://${host}${ruta.split('/').map(enc).join('/')}?${qs}`, { method: 'GET', headers: h, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw errorCodigo('r2_listar_http_' + (Number.isInteger(r.status) ? r.status : 0));
        const p = leerPagina(await r.text());
        out.push(...p.objetos);
        if (!p.truncado) break;
        if (!p.token) throw errorCodigo('r2_listar_sin_token');
        token = p.token;
      }
      return out.sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
    },
    /** GET firmado de un objeto → { url, vence } */
    presignar(k, fecha) {
      const { url, vence } = presignGet({ host, ruta: '/' + deposito + '/' + k, clave, secreto, fecha, expira });
      return { url, vence };
    },
  };
}
