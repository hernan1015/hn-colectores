// 257 · la base (Supabase) por POSTGRES DIRECTO con el rol propio `clasificador_zona` (migracion/0153_..._PROPUESTA).
// Patrón de hn-colectores/sipan-alto-valle/lib/base.mjs (Plan B del 13/11: sin PostgREST ni JWT).
//
// Dos secretos (secrets.* del workflow; nunca en el código y NUNCA se imprimen):
//   ZONA_PG_URL = postgresql://clasificador_zona.<ref>:<clave>@<host-del-pooler>:6543/postgres
//   ZONA_PG_CA  = el certificado raíz de Supabase en PEM (Dashboard → Database → SSL Configuration → «Download
//                 certificate», prod-ca-2021.crt). No es secreto, pero va como secreto para no versionar un archivo
//                 que no podemos verificar desde acá; también se acepta ZONA_PG_CA_FILE = ruta a ese archivo.
//
// TLS (Codex 15/11, bloqueo 5): `ssl: 'require'` en postgres.js 3.4.4 es `rejectUnauthorized: false` (cifra, pero
// acepta cualquier certificado: se puede suplantar al servidor). Acá va SIEMPRE
//   ssl: { rejectUnauthorized: true, ca: <CA de Supabase>, servername: <host> }
// que Node valida contra esa CA y contra el nombre del host (checkServerIdentity). Sin CA no se conecta. Las opciones
// pasadas a postgres() ganan sobre un `?sslmode=` de la URL, así que la URL no puede bajarlo.
//
// El rol NO tiene permisos sobre ninguna tabla: sólo puede ejecutar dos funciones SECURITY DEFINER:
//   · estaciones_zona_pendientes(regla, todas) → red, estacion_id, lat, lon de las que no tienen zona con esa regla
//     para su coordenada actual;
//   · estaciones_fijar_zona(red, estacion_id, zona, detalle) → escribe SÓLO las claves `zona` y `zona_wc` de
//     estaciones.metadatos (el resto de metadatos no se toca), valida tipos y rangos, y devuelve false sin escribir
//     si no cambió nada.
import fs from 'node:fs';

export const ROL = 'clasificador_zona';
const propio = (m) => Object.assign(new Error(m), { propio: true });

export function usuarioDeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return decodeURIComponent(u.username) || null;
  } catch { return null; }
}

/** Host como lo lee postgres.js (corta en el primer «@»): exige un solo «@». */
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;

const PEM = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/;
/** La CA: del texto (ZONA_PG_CA) o de un archivo (ZONA_PG_CA_FILE). Tiene que ser uno o más certificados PEM. */
export function leerCa({ texto = process.env.ZONA_PG_CA, archivo = process.env.ZONA_PG_CA_FILE } = {}) {
  let ca = texto && String(texto).trim() ? String(texto) : null;
  if (!ca && archivo) { try { ca = fs.readFileSync(archivo, 'utf8'); } catch { throw propio('base: no se pudo leer ZONA_PG_CA_FILE'); } }
  if (!ca) throw propio('base: falta la CA de Supabase (ZONA_PG_CA o ZONA_PG_CA_FILE): sin ella no se autentica al servidor y no se conecta');
  const bloques = ca.trim().split(/(?<=-----END CERTIFICATE-----)\s*/).filter(Boolean);
  if (!bloques.length || !bloques.every((b) => PEM.test(b.trim() + '\n'))) throw propio('base: la CA no es un certificado PEM');
  return ca.trim() + '\n';
}

/** Las opciones de postgres.js. Exportadas para el test: el TLS que autentica al servidor está acá y en ningún otro lado. */
export function opcionesPg(host, ca) {
  return {
    max: 1, prepare: false, connect_timeout: 20, idle_timeout: 5, onnotice: () => {},
    connection: { application_name: 'clasificador-zona' },
    ssl: { rejectUnauthorized: true, ca, servername: host, minVersion: 'TLSv1.2' },
  };
}

const DESC = { 42501: 'sin permiso', 42883: 'falta la función (¿se aplicó la 0153?)', '28P01': 'usuario o clave', 28000: 'usuario o clave',
  53300: 'demasiadas conexiones', ECONNREFUSED: 'conexión rechazada', ENOTFOUND: 'host desconocido', ETIMEDOUT: 'tiempo agotado',
  CONNECT_TIMEOUT: 'tiempo agotado', P0001: 'la función rechazó el valor', SELF_SIGNED_CERT_IN_CHAIN: 'certificado no confiable',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado no confiable', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificado no confiable',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'certificado no confiable', ERR_TLS_CERT_ALTNAME_INVALID: 'el certificado es de otro host',
  CERT_HAS_EXPIRED: 'certificado vencido' };

/** Un error del driver → un Error nuestro, SIN el mensaje original (puede traer host, usuario o la URL). */
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`);
  err.codigo = codigo;
  err.propio = true;
  return err;
}

/** `pg` (la fábrica de postgres.js) y `ca` se inyectan en los tests: ahí nunca hay red. */
export async function conectar(url, { pg = null, ca = null } = {}) {
  const u = usuarioDeUrl(url);
  if (!u || (u !== ROL && !u.startsWith(ROL + '.'))) throw propio(`base: la URL no es del rol ${ROL}`);
  const host = hostDeUrl(url);
  if (!host || !HOST_POOLER.test(host)) throw propio('base: la URL no apunta al pooler de Supabase');
  const opciones = opcionesPg(host, ca ?? leerCa());
  if (!pg) ({ default: pg } = await import('postgres'));
  let sql;
  try { sql = pg(url, opciones); } catch (e) { throw errorLimpio(e, 'conectar'); }
  try {
    const [{ u: cu, s: su }] = await sql`select current_user as u, session_user as s`;
    if (cu !== ROL || su !== ROL) throw propio('rol');
  } catch (e) {
    await sql.end({ timeout: 2 }).catch(() => {});
    if (e?.message === 'rol') { const r = new Error(`base: no es el rol ${ROL}`); r.propio = true; throw r; }
    throw errorLimpio(e, 'conectar');
  }
  return {
    async pendientes(regla, todas = false) {
      try { return await sql`select red, estacion_id, lat::float8 as lat, lon::float8 as lon from estaciones_zona_pendientes(${regla}, ${todas})`; }
      catch (e) { throw errorLimpio(e, 'pendientes'); }
    },
    /** true = escribió; false = era igual a lo guardado (salvo calculado_en) y no se tocó. */
    async fijar(red, id, zona, detalle) {
      try { const [r] = await sql`select estaciones_fijar_zona(${red}, ${id}, ${zona}, ${sql.json(detalle)}) as cambio`; return r?.cambio === true; }
      catch (e) { throw errorLimpio(e, 'fijar'); }
    },
    async cerrar() { await sql.end({ timeout: 5 }).catch(() => {}); },
  };
}
