// HN AGRO · el TLS VERIFICADO hacia Postgres (Supabase), común a TODOS los colectores (la 264).
//
// Por qué: con postgres.js 3.4.4, `ssl: 'require'` (y 'prefer' / 'allow', y un `?sslmode=require` en la URL) es
// `rejectUnauthorized: false`: cifra, pero acepta CUALQUIER certificado, así que cualquiera en el camino puede hacerse
// pasar por la base y quedarse con la clave del rol. Sin `ssl`, ni siquiera cifra. Acá va SIEMPRE
//   ssl: { rejectUnauthorized: true, ca: <CA de Supabase>, servername: <host de la URL>, checkServerIdentity, minVersion }
// que Node valida contra ESA CA (no la del sistema) y contra el nombre del host de la URL.
//
// La CA: `lib/ca/supabase-prod-ca-2021.crt`, la raíz pública que Supabase publica (Dashboard → Database → SSL
// Configuration → Download certificate). NO es un secreto: va en el repo, una sola para todos los colectores (decisión
// de local, 16/11 05:33). Un colector puede pasar otra CA en texto (por ejemplo un secreto ZONA_PG_CA) como override
// OPCIONAL; igual se verifica con rejectUnauthorized: true.
//
// Sin una CA legible y válida, el colector NO se conecta: `pgTls` tira un error claro y nunca cae a la conexión sin
// verificar. Los errores no traen la URL ni la clave (sólo «el host», nunca cuál).
//
// Uso (el test estático lib/test/pg-tls-estatico.test.mjs exige que todo archivo que abra Postgres pase por acá):
//   import { conTls } from '../../lib/pg-tls.mjs';
//   const sql = postgres(url, conTls(url, { max: 1, prepare: false }));
// `conTls` pone `ssl` AL FINAL: unas opciones que ya traigan `ssl` no lo pisan. Las opciones de postgres() ganan sobre
// un `?sslmode=` de la URL, así que la URL tampoco puede bajarlo.
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** La CA común, al lado de este archivo. */
export const CA_COMUN = fileURLToPath(new URL('./ca/supabase-prod-ca-2021.crt', import.meta.url));

const propio = (m) => Object.assign(new Error(m), { propio: true, codigo: 'tls_sin_ca' });

const BLOQUE = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;

/** Lee y valida la CA. `texto` (override opcional) gana sobre `archivo` (por defecto, la común del repo).
 *  Cada bloque tiene que ser un certificado X.509 de CA (basicConstraints CA:TRUE) y estar vigente `ahora`.
 *  Devuelve el PEM normalizado (los bloques, uno por línea final). */
export function leerCa({ texto = null, archivo = CA_COMUN, ahora = new Date() } = {}) {
  let pem = texto != null && String(texto).trim() ? String(texto) : null;
  if (!pem) {
    try { pem = fs.readFileSync(archivo, 'utf8'); }
    catch { throw propio('postgres: no se puede leer la CA de Supabase (lib/ca/supabase-prod-ca-2021.crt): sin ella no se autentica al servidor y NO se conecta'); }
  }
  const resto = pem.replace(BLOQUE, '').trim();
  const bloques = pem.match(BLOQUE) || [];
  if (!bloques.length || resto) throw propio('postgres: la CA no es un certificado PEM (sólo bloques BEGIN/END CERTIFICATE): NO se conecta');
  for (const b of bloques) {
    let c;
    try { c = new X509Certificate(b); } catch { throw propio('postgres: la CA no es un certificado X.509 válido: NO se conecta'); }
    if (!c.ca) throw propio('postgres: el certificado dado no es de una CA (falta CA:TRUE): NO se conecta');
    if (!(new Date(c.validFrom) <= ahora && ahora <= new Date(c.validTo))) throw propio('postgres: la CA no está vigente (vencida o todavía no válida): NO se conecta');
  }
  return bloques.join('\n') + '\n';
}

/** La huella SHA-256 (la de `openssl x509 -fingerprint -sha256`) de cada certificado del PEM. */
export function huellas(pem) {
  return (String(pem).match(BLOQUE) || []).map((b) => new X509Certificate(b).fingerprint256);
}

/** El host de una URL postgres TAL COMO LO LEE postgres.js (corta en el PRIMER «@»): exige un solo «@».
 *  null si la forma no es postgres(ql)://usuario:clave@host[:puerto]/base[?…]. */
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}

/** La opción `ssl` de postgres.js, verificada. `destino`: la URL postgres o el host solo.
 *  `ca`: PEM override opcional (por defecto, el archivo común). Tira si no hay host o no hay CA válida. */
export function pgTls(destino, { ca = null, archivo = CA_COMUN, ahora } = {}) {
  const d = String(destino ?? '');
  const host = d.includes('://') ? hostDeUrl(d) : (/^[A-Za-z0-9.-]+$/.test(d) ? d.toLowerCase() : null);
  if (!host) throw Object.assign(new Error('postgres: no se entiende el host de la URL: NO se conecta'), { propio: true, codigo: 'tls_sin_host' });
  const pem = leerCa({ texto: ca, archivo, ahora });
  return Object.freeze({
    rejectUnauthorized: true,
    ca: pem,
    /* SNI con el nombre (no se manda una IP como SNI: RFC 6066) */
    servername: net.isIP(host) ? undefined : host,
    /* el nombre se controla SIEMPRE contra el host de la URL (también si es una IP: contra los SAN de IP) */
    checkServerIdentity: (_h, cert) => tls.checkServerIdentity(host, cert),
    minVersion: 'TLSv1.2',
  });
}

/** Las opciones de postgres() con el `ssl` verificado puesto al final (nada de lo que traigan las opciones lo pisa). */
export function conTls(destino, opciones = {}, tlsOpts = {}) {
  return { ...opciones, ssl: pgTls(destino, tlsOpts) };
}
