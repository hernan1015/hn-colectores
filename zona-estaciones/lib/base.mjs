// 257 · la base (Supabase) por POSTGRES DIRECTO con el rol propio `clasificador_zona` (migracion/0153_..._PROPUESTA).
// Patrón de hn-colectores/sipan-alto-valle/lib/base.mjs (Plan B del 13/11: sin PostgREST ni JWT).
//
// Un solo secreto, ZONA_PG_URL (secrets.* del workflow; nunca en el código y NUNCA se imprime):
//   postgresql://clasificador_zona.<ref>:<clave>@<host-del-pooler>:6543/postgres
// El rol NO tiene permisos sobre ninguna tabla: sólo puede ejecutar dos funciones SECURITY DEFINER:
//   · estaciones_zona_pendientes(regla)  → red, estacion_id, lat, lon de las que no tienen zona con esa regla
//     para su coordenada actual;
//   · estaciones_fijar_zona(red, estacion_id, zona, detalle) → escribe SÓLO las claves `zona` y `zona_wc` de
//     estaciones.metadatos (el resto de metadatos no se toca).
import postgres from 'postgres';

export const ROL = 'clasificador_zona';

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

const DESC = { 42501: 'sin permiso', 42883: 'falta la función (¿se aplicó la 0153?)', '28P01': 'usuario o clave', 28000: 'usuario o clave',
  53300: 'demasiadas conexiones', ECONNREFUSED: 'conexión rechazada', ENOTFOUND: 'host desconocido', ETIMEDOUT: 'tiempo agotado',
  CONNECT_TIMEOUT: 'tiempo agotado', P0001: 'la función rechazó el valor' };

/** Un error del driver → un Error nuestro, SIN el mensaje original (puede traer host, usuario o la URL). */
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`);
  err.codigo = codigo;
  return err;
}

export async function conectar(url) {
  const u = usuarioDeUrl(url);
  if (!u || (u !== ROL && !u.startsWith(ROL + '.'))) throw new Error(`base: la URL no es del rol ${ROL}`);
  const host = hostDeUrl(url);
  if (!host || !HOST_POOLER.test(host)) throw new Error('base: la URL no apunta al pooler de Supabase');
  const sql = postgres(url, { max: 1, prepare: false, ssl: 'require', connect_timeout: 20, idle_timeout: 5, onnotice: () => {} });
  try {
    const [{ current_user: cu }] = await sql`select current_user`;
    if (cu !== ROL) throw new Error('rol');
  } catch (e) { await sql.end({ timeout: 2 }).catch(() => {}); throw e.message === 'rol' ? new Error(`base: no es el rol ${ROL}`) : errorLimpio(e, 'conectar'); }
  return {
    async pendientes(regla, todas = false) {
      try { return await sql`select red, estacion_id, lat::float8 as lat, lon::float8 as lon from estaciones_zona_pendientes(${regla}, ${todas})`; }
      catch (e) { throw errorLimpio(e, 'pendientes'); }
    },
    async fijar(red, id, zona, detalle) {
      try { await sql`select estaciones_fijar_zona(${red}, ${id}, ${zona}, ${sql.json(detalle)})`; }
      catch (e) { throw errorLimpio(e, 'fijar'); }
    },
    async cerrar() { await sql.end({ timeout: 5 }).catch(() => {}); },
  };
}
