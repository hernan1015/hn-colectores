// HN AGRO · 260 · la base (Supabase) por POSTGRES DIRECTO con el rol propio `medicion_app` (migracion/0154_PROPUESTA).
// Patrón de la 257 v2 (zona-estaciones/lib/base.mjs) y del SIPAN: el pooler, un rol sin permisos de más, y TLS que
// AUTENTICA al servidor:  ssl: { rejectUnauthorized: true, ca: <CA de Supabase>, servername: <host> }.
// (`ssl: 'require'` en postgres.js 3.4.4 es rejectUnauthorized: false: cifra pero acepta cualquier certificado.)
//
// Dos secretos (nunca en el código y NUNCA se imprimen):
//   MEDICION_PG_URL = postgresql://medicion_app.<ref>:<clave>@<host-del-pooler>:6543/postgres
//   MEDICION_PG_CA  = la CA de Supabase en PEM (prod-ca-2021.crt; o MEDICION_PG_CA_FILE = ruta). Sin ella no conecta.
//
// Todo el SQL corre sobre un «ejecutor» { query(texto, params) → filas }: en producción postgres.js (sql.unsafe), en los
// tests PGlite COMO el rol (los grants y la RLS de verdad).
import fs from 'node:fs';
import { REGLA, PROCESO } from './sello.mjs';

export const ROL = 'medicion_app';
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;
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

const PEM = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/;
export function leerCa({ texto = process.env.MEDICION_PG_CA, archivo = process.env.MEDICION_PG_CA_FILE } = {}) {
  let ca = texto && String(texto).trim() ? String(texto) : null;
  if (!ca && archivo) { try { ca = fs.readFileSync(archivo, 'utf8'); } catch { throw propio('base: no se pudo leer MEDICION_PG_CA_FILE'); } }
  if (!ca) throw propio('base: falta la CA de Supabase (MEDICION_PG_CA o MEDICION_PG_CA_FILE): sin ella no se autentica al servidor y no se conecta');
  const bloques = ca.trim().split(/(?<=-----END CERTIFICATE-----)\s*/).filter(Boolean);
  if (!bloques.length || !bloques.every((b) => PEM.test(b.trim() + '\n'))) throw propio('base: la CA no es un certificado PEM');
  return ca.trim() + '\n';
}

/** Las opciones de postgres.js: el TLS que autentica al servidor está acá y en ningún otro lado. */
export function opcionesPg(host, ca) {
  return {
    max: 1, prepare: false, connect_timeout: 20, idle_timeout: 5, onnotice: () => {},
    connection: { application_name: 'medicion-app' },
    ssl: { rejectUnauthorized: true, ca, servername: host, minVersion: 'TLSv1.2' },
  };
}

const DESC = { 42501: 'sin permiso', 42883: 'falta la función (¿se aplicó la 0154?)', '42P01': 'falta la tabla (¿se aplicó la 0154?)',
  '28P01': 'usuario o clave', 28000: 'usuario o clave', 23514: 'CHECK', 23503: 'FK', 53300: 'demasiadas conexiones',
  ECONNREFUSED: 'conexión rechazada', ENOTFOUND: 'host desconocido', ETIMEDOUT: 'tiempo agotado', CONNECT_TIMEOUT: 'tiempo agotado',
  SELF_SIGNED_CERT_IN_CHAIN: 'certificado no confiable', DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado no confiable',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificado no confiable', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'certificado no confiable',
  ERR_TLS_CERT_ALTNAME_INVALID: 'el certificado es de otro host', CERT_HAS_EXPIRED: 'certificado vencido' };

/** Un error del driver → uno nuestro, SIN el mensaje original (puede traer host, usuario, la URL o valores). */
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) : 'sin_codigo';
  return Object.assign(new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`), { codigo, propio: true });
}

/** Conecta y devuelve un ejecutor. `pg` (la fábrica de postgres.js) y `ca` se inyectan en los tests. */
export async function conectar(url, { pg = null, ca = null } = {}) {
  const u = usuarioDeUrl(url);
  if (!u || (u !== ROL && !u.startsWith(ROL + '.'))) throw propio(`base: la URL no es del rol ${ROL}`);
  const host = hostDeUrl(url);
  if (!host || !HOST_POOLER.test(host)) throw propio('base: la URL no apunta al pooler de Supabase');
  const opciones = opcionesPg(host, ca ?? leerCa());
  if (!pg) ({ default: pg } = await import('postgres'));
  let sql;
  try { sql = pg(url, opciones); } catch (e) { throw errorLimpio(e, 'conectar'); }
  const cerrar = async () => { await sql.end({ timeout: 5 }).catch(() => {}); };
  let r;
  try { r = (await sql.unsafe('select current_user as u, session_user as s'))[0] || {}; }
  catch (e) { await cerrar(); throw errorLimpio(e, 'conectar'); }
  if (r.u !== ROL || r.s !== ROL) { await cerrar(); throw propio(`base: no es el rol ${ROL}`); }
  return { query: async (t, p = []) => { try { return await sql.unsafe(t, p); } catch (e) { throw errorLimpio(e, 'base'); } }, cerrar };
}

/** Un ejecutor sobre PGlite (tests). Con `rol`, cada consulta corre COMO ese rol. */
export const ejecutorPglite = (pg, { rol = null } = {}) => ({
  query: async (texto, params = []) => {
    if (!rol) return (await pg.query(texto, params)).rows;
    await pg.exec(`set role ${rol}`);
    try { return (await pg.query(texto, params)).rows; } finally { await pg.exec('reset role'); }
  },
  cerrar: async () => {},
});

const NUM = ['lat', 'lon', 'tmin_noche_c', 'noche_registros', 'noche_esperados', 'tmax_c', 'registros_validos', 'registros_esperados', 'muestreo_min'];
const COLS = ['red', 'estacion_id', 'fecha', 'regla', 'zona', 'region', 'lat', 'lon', 'noche_est_c', 'noche_app_c', 'noche_dif_c',
  'noche_registros', 'noche_esperados', 'noche_ok', 'tmax_est_c', 'tmax_app_c', 'tmax_dif_c', 'dia_registros', 'dia_esperados',
  'tmax_ok', 'hr_est_pct', 'hr_app_pct', 'hr_dif_pp', 'hr_lecturas', 'hr_ok', 'muestreo_min', 'motivos', 'app'];
const TIPOS = { fecha: 'date', lat: 'numeric', lon: 'numeric', noche_est_c: 'numeric', noche_app_c: 'numeric', noche_dif_c: 'numeric',
  noche_registros: 'smallint', noche_esperados: 'smallint', noche_ok: 'boolean', tmax_est_c: 'numeric', tmax_app_c: 'numeric',
  tmax_dif_c: 'numeric', dia_registros: 'smallint', dia_esperados: 'smallint', tmax_ok: 'boolean', hr_est_pct: 'numeric',
  hr_app_pct: 'numeric', hr_dif_pp: 'numeric', hr_lecturas: 'smallint', hr_ok: 'boolean', muestreo_min: 'smallint', motivos: 'text[]', app: 'jsonb' };
const UPSERT = `insert into medicion_app_estacion (${COLS.join(', ')}, medido_en)
  values (${COLS.map((c, i) => `$${i + 1}${TIPOS[c] ? '::' + TIPOS[c] : ''}`).join(', ')}, now())
  on conflict (red, estacion_id, fecha, regla) do update set
  ${COLS.filter((c) => !['red', 'estacion_id', 'fecha', 'regla'].includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}, medido_en = now()`;

/** Las operaciones del job sobre un ejecutor. Los errores son CÓDIGOS (sin ids ni valores). */
export function crearBase(ej) {
  const q = async (que, t, p) => { try { return await ej.query(t, p); } catch (e) { throw e?.propio ? e : errorLimpio(e, que); } };
  return {
    /** Las filas de `fecha` y `fecha + 1` (lo que devuelve medicion_app_obs, 0154). */
    async leer(fecha) {
      const filas = await q('leer', `select red, estacion_id, lat, lon, zona, fecha::text as fecha, tmin_noche_c::text as tmin_noche_c,
        noche_registros, noche_esperados, tmax_c::text as tmax_c, registros_validos, registros_esperados, muestreo_min, lecturas
        from medicion_app_obs($1::date)`, [fecha]);
      return filas.map((f) => {
        const o = { ...f, lecturas: typeof f.lecturas === 'string' ? JSON.parse(f.lecturas) : f.lecturas ?? null };
        for (const k of NUM) o[k] = o[k] == null ? null : Number(o[k]);
        return o;
      });
    },
    /** Upsert de una fila por estación y día; una fila mala (un CHECK) no tira las demás. */
    async guardar(filas) {
      let ok = 0; const errores = {};
      for (const f of filas) {
        if (f.regla !== REGLA) throw propio('base: fila de otra regla');
        try {
          await ej.query(UPSERT, COLS.map((c) => (c === 'app' ? JSON.stringify(f.app ?? {}) : f[c] ?? null)));
          ok++;
        } catch (e) { const c = errorLimpio(e, 'guardar').message; errores[c] = (errores[c] || 0) + 1; }
      }
      return { ok, errores };
    },
    async registrar(ok, resumen) {
      let txt = JSON.stringify(resumen);
      if (txt.length > 60000) txt = JSON.stringify({ recortado: true, largo: txt.length, fecha: resumen.fecha });
      await q('registro_procesos', 'insert into registro_procesos (proceso, ok, resumen) values ($1, $2, $3::jsonb)', [PROCESO, ok, txt]);
    },
  };
}
