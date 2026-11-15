// HN AGRO · ARCHIVO DEL ÍNDICE CAP (225) · registro_procesos por POSTGRES DIRECTO, con el rol propio `colector_cap`
// (migracion/0225_rol_colector_cap.sql: LOGIN, sin BYPASSRLS, CONNECTION LIMIT 2, SÓLO puede agregar renglones a
// registro_procesos con proceso = 'smn_cap_archivo'). El mismo molde que la SIPAN (sipan-alto-valle/lib/base.mjs):
//   · un solo secreto, CAP_PG_URL = postgresql://colector_cap.<ref>:<clave>@<host-del-pooler>:6543/postgres (nunca se imprime);
//   · antes de conectar: el usuario de la URL tiene que ser colector_cap y el host, el pooler de Supabase;
//   · al conectar: current_user y session_user tienen que dar colector_cap; si no, se cierra y aborta;
//   · ningún mensaje del driver sale tal cual (puede traer host, usuario o la URL): sólo su código.
import postgres from 'postgres';

export const ROL = 'colector_cap';
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;

export function usuarioDeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return decodeURIComponent(u.username) || null;
  } catch { return null; }
}

/** El host TAL COMO LO LEE postgres.js (corta en el PRIMER «@»): un solo «@» y nada sin codificar antes. */
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}

const DESC = { 23514: 'CHECK', 42501: 'sin permiso (RLS o grant)', '28P01': 'usuario o clave', 28000: 'usuario o clave', 53300: 'demasiadas conexiones',
  ECONNREFUSED: 'conexión rechazada', ENOTFOUND: 'host desconocido', ETIMEDOUT: 'tiempo agotado', CONNECT_TIMEOUT: 'tiempo agotado' };

export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`);
  err.codigo = codigo;
  return err;
}

export async function crearBase({ url, conectar = (u, o) => postgres(u, o), hostPermitido = (h) => HOST_POOLER.test(h) }) {
  if (!url) throw new Error('falta CAP_PG_URL');
  const usuario = usuarioDeUrl(url);
  if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) throw new Error(`CAP_PG_URL tiene que ser del usuario ${ROL} (o ${ROL}.<ref>): no se usa otro usuario`);
  const host = hostDeUrl(url);
  if (!host || !hostPermitido(host)) throw new Error('CAP_PG_URL: el host tiene que ser el pooler de Supabase (…pooler.supabase.com) y la clave ir codificada: no se conecta');
  let sql;
  try { sql = conectar(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 20, onnotice: () => {}, connection: { application_name: 'colector-cap' } }); }
  catch (e) { throw errorLimpio(e, 'conectar'); }
  const cerrar = async () => { try { await sql.end({ timeout: 5 }); } catch { /* nada */ } };
  let yo, sesion;
  try { const r = (await sql`select current_user as u, session_user as s`)[0] || {}; yo = r.u; sesion = r.s; }
  catch (e) { await cerrar(); throw errorLimpio(e, 'conectar'); }
  if (yo !== ROL || sesion !== ROL) { await cerrar(); throw new Error(`la conexión entró como otro usuario (no ${ROL}): se aborta`); }
  return {
    usuario: yo,
    cerrar,
    async registrar(proceso, ok, resumen) {
      let txt = JSON.stringify(resumen);
      if (txt.length > 60000) { resumen = { recortado: true, largo: txt.length, avisos: resumen.avisos }; txt = JSON.stringify(resumen); }
      try { await sql`insert into registro_procesos (proceso, ok, resumen) values (${proceso}, ${ok}, ${sql.json(resumen)})`; }
      catch (e) { throw errorLimpio(e, 'registro_procesos'); }
    },
  };
}
