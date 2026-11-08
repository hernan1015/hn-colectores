// HN AGRO · firmador-r2 · GET firmado por query string (SigV4 «presigned URL»), sin dependencias.
// Es la otra mitad de rayos-hora/lib/almacen.mjs: allá se firma con cabeceras (para listar y subir); acá se firma la
// URL misma, para que la lea quien no tiene las llaves (las functions de Netlify, por public.r2_enlaces).
// Regla de AWS: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
// Se firma sólo la cabecera host y el cuerpo va como UNSIGNED-PAYLOAD. R2 acepta hasta 7 días (604800 s).
import crypto from 'node:crypto';

export const MAX_EXPIRA = 604800;   // 7 días: el tope de SigV4 (y de R2)

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();
/** URI-encode de SigV4 (RFC 3986: también ! ' ( ) *) */
export const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Date → '20130524T000000Z' */
export function amzFecha(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
/** '20130524T000000Z' → Date (o null) */
export function deAmzFecha(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

/**
 * GET firmado por query. host: 'examplebucket.s3.amazonaws.com' o '<cuenta>.r2.cloudflarestorage.com';
 * ruta: '/test.txt' o '/<depósito>/<clave>' (sin codificar: se codifica acá, segmento por segmento).
 * → { url, vence, canonica, aFirmar, firma }   (vence = X-Amz-Date + X-Amz-Expires)
 */
export function presignGet({ host, ruta, clave, secreto, region = 'auto', fecha = new Date(), expira = MAX_EXPIRA }) {
  if (!host || !ruta || !ruta.startsWith('/')) throw new Error('presign: host y ruta (con «/» inicial) son obligatorios');
  if (!clave || !secreto) throw new Error('presign: faltan las llaves');
  if (!Number.isInteger(expira) || expira < 1 || expira > MAX_EXPIRA) throw new Error(`presign: X-Amz-Expires fuera de 1..${MAX_EXPIRA}`);
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) throw new Error('presign: fecha inválida');
  const amz = amzFecha(fecha);
  const dia = amz.slice(0, 8);
  const alcance = `${dia}/${region}/s3/aws4_request`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${clave}/${alcance}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expira),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonQ = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonRuta = ruta.split('/').map(enc).join('/');
  const canonica = ['GET', canonRuta, canonQ, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const aFirmar = ['AWS4-HMAC-SHA256', amz, alcance, sha256(canonica)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + secreto, dia), region), 's3'), 'aws4_request');
  const firma = crypto.createHmac('sha256', k).update(aFirmar).digest('hex');
  const vence = new Date(deAmzFecha(amz).getTime() + expira * 1000);
  return { url: `https://${host}${canonRuta}?${canonQ}&X-Amz-Signature=${firma}`, vence, canonica, aFirmar, firma };
}
