// HN AGRO · imerg-pendientes · la base, por Postgres directo con el rol propio `colector_imerg` (migracion/imerg_colector.sql).
// El rol no tiene permiso sobre ninguna tabla: sólo ejecuta 4 funciones del esquema imerg_colector (contar, tomar,
// guardar, soltar). Un solo secreto, IMERG_PG_URL (nunca se imprime):
//   postgresql://colector_imerg.<ref>:<clave>@<host-del-pooler>:6543/postgres
// Pooler en modo transacción → prepare: false, una conexión. Defensas como sipan-alto-valle/lib/base.mjs: el usuario
// de la URL tiene que ser colector_imerg, el host un pooler de Supabase, current_user tiene que dar colector_imerg y
// ningún mensaje del driver sale tal cual (puede traer host o usuario).
import postgres from 'postgres';

export const ROL = 'colector_imerg';
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;

export function usuarioDeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return decodeURIComponent(u.username) || null;
  } catch { return null; }
}

/** El host como lo lee postgres.js (corta en el primer «@»): exige un solo «@». null si la forma no es la esperada. */
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}

/** Un error del driver → uno nuestro con el código solo (SQLSTATE o errno), sin el mensaje original. */
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}`);
  err.codigo = codigo;
  return err;
}

/** postgres.js devuelve numeric como texto: se conserva el texto (vuelve tal cual a la base) y el número aparte. */
const celda = (f) => (f ? { lat: Number(f.celda_lat), lon: Number(f.celda_lon), latTxt: String(f.celda_lat), lonTxt: String(f.celda_lon) } : null);

/** Las 4 operaciones sobre una conexión `sql` (postgres.js o algo con la misma forma de tagged template). */
export function operaciones(sql) {
  const envolver = (que, fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw errorLimpio(e, que); } };
  return {
    contar: envolver('contar', async (espera) => Number((await sql`select imerg_colector.contar(${espera}::int) as n`)[0].n)),
    tomar: envolver('tomar', async (espera) => celda((await sql`select celda_lat, celda_lon from imerg_colector.tomar(${espera}::int)`)[0])),
    guardar: envolver('guardar', async (c, filas) => {
      const fechas = '{' + filas.map((f) => f[0]).join(',') + '}';
      const mm = '{' + filas.map((f) => String(f[1])).join(',') + '}';
      return Number((await sql`select imerg_colector.guardar(${c.latTxt}::numeric, ${c.lonTxt}::numeric, ${fechas}::date[], ${mm}::real[]) as n`)[0].n);
    }),
    soltar: envolver('soltar', async (c) => (await sql`select imerg_colector.soltar(${c.latTxt}::numeric, ${c.lonTxt}::numeric) as ok`)[0].ok === true),
  };
}

export async function crearBase({ url, conectar = (u, o) => postgres(u, o), hostPermitido = (h) => HOST_POOLER.test(h) }) {
  if (!url) throw new Error('falta IMERG_PG_URL');
  const usuario = usuarioDeUrl(url);
  if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) throw new Error('IMERG_PG_URL no es del rol ' + ROL + ': no se conecta');
  const host = hostDeUrl(url);
  if (!host || !hostPermitido(host)) throw new Error('IMERG_PG_URL no apunta al pooler de Supabase: no se conecta');
  const sql = conectar(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 30, onnotice: () => {} });
  try {
    const [{ u }] = await sql`select current_user as u`;
    if (u !== ROL) throw Object.assign(new Error('rol'), { code: 'ROL_DISTINTO' });
  } catch (e) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw errorLimpio(e, 'conectar');
  }
  return Object.assign(operaciones(sql), { cerrar: () => sql.end({ timeout: 5 }) });
}
