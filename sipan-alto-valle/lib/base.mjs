// HN AGRO · SIPAN Alto Valle · la base (Supabase) por POSTGRES DIRECTO, con el rol propio `colector_estaciones`
// (migracion/0147b: LOGIN, sin BYPASSRLS, CONNECTION LIMIT 3). Plan B del 13/11: el proyecto firma los JWT con ECC
// (P-256) y el HS256 legado puede revocarse sin aviso, así que no se usa PostgREST ni ningún JWT.
//
// Un solo secreto, SIPAN_PG_URL (secrets.* del workflow; nunca en el código y NUNCA se imprime):
//   postgresql://colector_estaciones.<ref>:<clave>@<host-del-pooler>:6543/postgres
// Pooler de Supabase en modo TRANSACCIÓN (6543): por eso `prepare: false` (no hay sentencias preparadas entre
// transacciones) y max 1 conexión (el rol tiene CONNECTION LIMIT 3).
//
// Defensas:
//   · antes de conectar, el usuario de la URL tiene que ser colector_estaciones (o colector_estaciones.<ref>);
//   · al arrancar, `select current_user` tiene que dar colector_estaciones; si no, se cierra y aborta;
//   · ningún mensaje de error del driver sale tal cual (pueden traer host, usuario o la URL): se reemplazan por el
//     código (SQLSTATE o el errno de red) y una descripción nuestra. Ver `errorLimpio`.
//
// Tablas: estaciones y estaciones_obs (hn-agro migrations/0110 + las columnas de la 0147), registro_procesos (0075) y
// pronostico_helada_medicion (0147).
import postgres from 'postgres';

export const RED = 'INTA_SIPAN_AV';
export const ROL = 'colector_estaciones';

/** El usuario de una URL postgres (sin conectar). null si la URL no se entiende. */
export function usuarioDeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return decodeURIComponent(u.username) || null;
  } catch { return null; }
}

/** El host de la URL TAL COMO LO VA A LEER postgres.js, que corta en el PRIMER «@»: exige un solo «@» y nada sin
 *  codificar antes (así una clave con «@» o «/» sin codificar no termina como nombre de host en una consulta DNS).
 *  null si la forma no es postgresql://usuario:clave@host:puerto/base. */
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;

const DESC = { 23503: 'FK', 23505: 'clave repetida', 23514: 'CHECK', 42501: 'sin permiso (RLS o grant)', '28P01': 'usuario o clave',
  28000: 'usuario o clave', 53300: 'demasiadas conexiones', ECONNREFUSED: 'conexión rechazada', ENOTFOUND: 'host desconocido',
  ETIMEDOUT: 'tiempo agotado', CONNECT_TIMEOUT: 'tiempo agotado' };

/** Un error del driver → un Error nuestro, SIN el mensaje original (puede traer host, usuario o la URL). */
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`);
  err.codigo = codigo;
  return err;
}

/** Las columnas jsonb van con sql.json(); el resto tal cual. */
const JSONB = new Set(['metadatos', 'crudo', 'resumen']);
function preparar(sql, fila) {
  const out = {};
  for (const [k, v] of Object.entries(fila)) out[k] = JSONB.has(k) && v != null ? sql.json(v) : v;
  return out;
}

/* postgres.js devuelve numeric como TEXTO y timestamptz como Date: acá vuelven como número y como texto ISO */
const NUM = ['tmin_c', 'tmax_c', 'lluvia_mm', 'eto_mm', 'tmin_noche_c', 'rad_mj_m2', 'lat', 'lon'];
const FECHAHORA = ['tmin_noche_en', 'leido_en', 'actualizado_en'];
function tipos(f) {
  const o = { ...f };
  for (const k of NUM) if (o[k] != null) o[k] = Number(o[k]);
  for (const k of FECHAHORA) if (o[k] instanceof Date) o[k] = o[k].toISOString();
  return o;
}
const COLS_OBS = ['red', 'estacion_id', 'lluvia_mm', 'horas_validas', 'tmin_c', 'tmax_c', 'leido_en', 'url', 'crudo', 'eto_mm', 'tmin_noche_c',
  'tmin_noche_en', 'noche_registros', 'noche_esperados', 'registros_validos', 'registros_esperados', 'muestreo_min', 'lluvia_origen',
  'rad_mj_m2', 'rad_registros'];

const COLS_EST = ['red', 'estacion_id', 'nombre', 'partido', 'provincia', 'lat', 'lon', 'precision_ubicacion', 'fuente_ubicacion', 'activa', 'metadatos', 'actualizado_en'];

export async function crearBase({ url, conectar = (u, o) => postgres(u, o), hostPermitido = (h) => HOST_POOLER.test(h) }) {
  if (!url) throw new Error('falta SIPAN_PG_URL');
  const usuario = usuarioDeUrl(url);
  if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) {
    throw new Error(`SIPAN_PG_URL tiene que ser del usuario ${ROL} (o ${ROL}.<ref>): no se usa otro usuario`);
  }
  /* el host: el pooler de Supabase y nada más (en los tests se permite 127.0.0.1); la URL no se imprime */
  const host = hostDeUrl(url);
  if (!host || !hostPermitido(host)) {
    throw new Error('SIPAN_PG_URL: el host tiene que ser el pooler de Supabase (…pooler.supabase.com) y la clave ir codificada: no se conecta');
  }
  let sql;
  try {
    sql = conectar(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 20, onnotice: () => {}, connection: { application_name: 'colector-sipan' } });
  } catch (e) { throw errorLimpio(e, 'conectar'); }
  const cerrar = async () => { try { await sql.end({ timeout: 5 }); } catch { /* nada */ } };
  const q = async (que, f) => { try { return await f(); } catch (e) { throw errorLimpio(e, que); } };
  /* al arrancar: ¿somos de verdad colector_estaciones? Los DOS: current_user (el rol vigente) y session_user (con quién
     se autenticó la conexión). Con «?user=postgres&options=-c role=…» current_user daría el rol, pero la clave del
     secreto sería la de postgres: eso también se rechaza. */
  let yo, sesion;
  try { const r = (await sql`select current_user as u, session_user as s`)[0] || {}; yo = r.u; sesion = r.s; }
  catch (e) { await cerrar(); throw errorLimpio(e, 'conectar'); }
  if (yo !== ROL || sesion !== ROL) { await cerrar(); throw new Error(`la conexión entró como otro usuario (no ${ROL}): se aborta`); }

  return {
    usuario: yo,
    cerrar,
    async estaciones() {
      return (await q('leer estaciones', () => sql`select estacion_id, nombre, lat, lon, activa, metadatos from estaciones where red = ${RED}`)).map(tipos);
    },
    async guardarEstaciones(filas) {
      for (const f of filas) {
        const p = preparar(sql, f);
        const cols = COLS_EST.filter((c) => c in p);
        const resto = cols.filter((c) => c !== 'red' && c !== 'estacion_id');
        await q('guardar estaciones', () => sql`insert into estaciones ${sql(p, cols)} on conflict (red, estacion_id) do update set ${sql(p, resto)}`);
      }
    },
    async obs(estacionId, fechas) {
      if (!fechas.length) return [];
      /* las columnas una por una (sin «select *»): fecha y hora_corte como texto (postgres.js las devolvería como Date) */
      const filas = await q('leer estaciones_obs', () => sql`select ${sql(COLS_OBS)}, fecha::text as fecha, hora_corte::text as hora_corte
        from estaciones_obs where red = ${RED} and estacion_id = ${estacionId} and fecha = any(${fechas}::date[])`);
      return filas.map(tipos);
    },
    async obsDesde(desde) {
      const filas = await q('leer estaciones_obs', () => sql`select estacion_id, fecha::text as fecha, tmin_c, tmin_noche_c, tmin_noche_en,
          noche_registros, noche_esperados, registros_validos, registros_esperados
        from estaciones_obs where red = ${RED} and fecha >= ${desde}::date`);
      return filas.map(tipos);
    },
    async guardarObs(filas) {
      /* una por una: así una fila mala (un CHECK) no tira las demás, y cada una lleva todas sus columnas */
      let ok = 0; const errores = [];
      for (const f of filas) {
        const p = preparar(sql, f);
        const cols = Object.keys(p);
        const resto = cols.filter((c) => !['red', 'estacion_id', 'fecha'].includes(c));
        try {
          await sql`insert into estaciones_obs ${sql(p, cols)} on conflict (red, estacion_id, fecha) do update set ${sql(p, resto)}`;
          ok++;
        } catch (e) { errores.push(`${f.estacion_id} ${f.fecha}: ${errorLimpio(e, 'estaciones_obs').message}`); }
      }
      return { ok, errores };
    },
    async guardarMedicion(filas) {
      for (const f of filas) {
        const p = preparar(sql, f);
        const cols = Object.keys(p);
        const resto = cols.filter((c) => !['red', 'estacion_id', 'noche', 'fuente', 'anticipacion_dias'].includes(c));
        await q('guardar medición', () => sql`insert into pronostico_helada_medicion ${sql(p, cols)}
          on conflict (red, estacion_id, noche, fuente, anticipacion_dias) do update set ${sql(p, resto)}`);
      }
    },
    async registrar(proceso, ok, resumen) {
      let txt = JSON.stringify(resumen);
      if (txt.length > 60000) { resumen = { recortado: true, largo: txt.length, avisos: resumen.avisos }; txt = JSON.stringify(resumen); }
      await q('registro_procesos', () => sql`insert into registro_procesos (proceso, ok, resumen) values (${proceso}, ${ok}, ${sql.json(resumen)})`);
    },
  };
}
