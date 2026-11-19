// HN AGRO · estaciones-parseo · la base: Postgres de Supabase con el rol propio `colector_estaciones` (0147b: LOGIN, sin
// BYPASSRLS, CONNECTION LIMIT 3), o PGlite en memoria para el modo seco y los tests. Las dos dan la misma interfaz:
//   { q(texto, params) → filas, cerrar(), tipo }
// Un solo secreto, PARSEO_PG_URL (en el workflow, el secreto SIPAN_PG_URL: el mismo rol). NUNCA se imprime.
// Defensas (las mismas del colector del SIPAN):
//   · el usuario de la URL tiene que ser colector_estaciones (o colector_estaciones.<ref>) y el host, el pooler de Supabase;
//   · al conectar, current_user y session_user tienen que dar colector_estaciones; si no, se cierra y aborta;
//   · ningún mensaje del driver sale tal cual (puede traer host, usuario o la URL): sólo el código.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const ROL = 'colector_estaciones';
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;
const DIR = path.dirname(fileURLToPath(import.meta.url));

export function usuarioDeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return decodeURIComponent(u.username) || null;
  } catch { return null; }
}
/** El host como lo lee postgres.js (corta en el PRIMER «@»): exige un solo «@». null si la forma no es la esperada. */
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}

/** Un error del driver → uno nuestro, SIN el mensaje original. */
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}`);
  err.codigo = codigo;
  return err;
}

export async function conectarPg({ url, conectar, hostPermitido = (h) => HOST_POOLER.test(h) }) {
  if (!url) throw new Error('falta PARSEO_PG_URL');
  const u = usuarioDeUrl(url);
  if (!u || !(u === ROL || u.startsWith(ROL + '.'))) throw new Error(`PARSEO_PG_URL tiene que ser del usuario ${ROL}: no se usa otro`);
  const host = hostDeUrl(url);
  if (!host || !hostPermitido(host)) throw new Error('PARSEO_PG_URL: el host tiene que ser el pooler de Supabase: no se conecta');
  if (!conectar) conectar = (await import('postgres')).default;
  let sql;
  try {
    sql = conectar(url, { max: 1, prepare: false, ssl: 'require', idle_timeout: 20, connect_timeout: 20, onnotice: () => {},
      connection: { application_name: 'estaciones-parseo' } });
  } catch (e) { throw errorLimpio(e, 'conectar'); }
  const cerrar = async () => { try { await sql.end({ timeout: 5 }); } catch { /* nada */ } };
  let r;
  try { r = (await sql.unsafe('select current_user as u, session_user as s'))[0] || {}; } catch (e) { await cerrar(); throw errorLimpio(e, 'conectar'); }
  if (r.u !== ROL || r.s !== ROL) { await cerrar(); throw new Error(`la conexión entró como otro usuario (no ${ROL}): se aborta`); }
  return {
    tipo: 'pg', cerrar,
    async q(texto, params = [], que = 'base') { try { return [...(await sql.unsafe(texto, params))]; } catch (e) { throw errorLimpio(e, que); } },
  };
}

/** El esquema de la base de pruebas: lo que producción ya tiene (copias) + la 0161 (copia de hn-agro). */
export const ESQUEMA = [
  path.join(DIR, '..', 'esquema', 'previo.sql'),
  path.join(DIR, '..', 'esquema', '0075_registro_procesos_COPIA.sql'),
  path.join(DIR, '..', 'esquema', '0110_estaciones_comun_COPIA.sql'),
  path.join(DIR, '..', '..', 'sipan-alto-valle', 'migracion', '0147_estaciones_noche_y_muestreo.sql'),
  path.join(DIR, '..', 'esquema', 'previo-0147b.sql'),
];
export const MIGRACION_0161 = path.join(DIR, '..', 'esquema', '0161_estaciones_parseo_unificada_COPIA.sql');

/** PGlite: de HN_PGLITE (la carpeta de @electric-sql/pglite) o del paquete instalado. */
export async function cargarPglite(env = process.env) {
  if (env.HN_PGLITE) {
    const p = path.join(env.HN_PGLITE, 'dist', 'index.js');
    if (!fs.existsSync(p)) throw new Error('HN_PGLITE no apunta a @electric-sql/pglite');
    return (await import(pathToFileURL(p).href)).PGlite;
  }
  return (await import('@electric-sql/pglite')).PGlite;
}

/** Una base PGlite en memoria con el esquema (y la 0161, salvo `sin0161`), conectada COMO el rol del colector. */
export async function conectarPglite({ PGlite, sin0161 = false, comoRol = true } = {}) {
  if (!PGlite) PGlite = await cargarPglite();
  const pg = new PGlite();
  for (const f of [...ESQUEMA, ...(sin0161 ? [] : [MIGRACION_0161])]) await pg.exec(fs.readFileSync(f, 'utf8'));
  if (comoRol) await pg.exec(`set role ${ROL}`);
  return {
    tipo: 'pglite', pg, cerrar: () => pg.close(),
    async q(texto, params = [], que = 'base') {
      try { return (await pg.query(texto, params)).rows; } catch (e) { const err = errorLimpio(e, que); err.detalle = e.message; throw err; }
    },
  };
}
