// HN AGRO · estaciones-privadas/parseo · LA ÚNICA CAPA DE GUARDADO de las 9 fuentes: estaciones, estaciones_obs
// (hn-agro 0110 + 0147), estaciones_ultima_lectura (0147) y el renglón de registro_procesos (0075), por Postgres directo
// con el rol `colector_estaciones` (0147b + 0152: sin BYPASSRLS, sin DELETE).
// (Unificada el 15/11: es la base de la 139 más lo que traía de más la 138b: la última lectura que nunca retrocede,
//  las inactivas, la lista cerrada de redes y el `metadatos` que se une sin perder lo de otros.)
//
// Escrito sobre un «ejecutor» mínimo: { query(texto, parametros) → filas }. Así el MISMO SQL corre:
//   · en producción con postgres.js (`sql.unsafe`, pooler en modo transacción: prepare false, 1 conexión);
//   · en los tests contra PGlite (un Postgres de verdad, en memoria), con las migraciones reales, también COMO el rol.
// Las defensas de la conexión son las del SIPAN y el SMN (hn-colectores sipan-alto-valle/lib/base.mjs): el usuario de la
// URL tiene que ser colector_estaciones, el host el pooler de Supabase, current_user y session_user los dos el rol, y
// ningún error del driver sale tal cual (puede traer host, usuario o la URL).
// Un secreto: PARSEO_PG_URL = postgresql://colector_estaciones.<ref>:<clave>@<host-del-pooler>:6543/postgres (el mismo
// valor de SIPAN_PG_URL).
//
// INTERNO: toda estación se guarda con metadatos.mostrar = false y uso = 'interno', aunque la fuente o lo ya guardado
// digan otra cosa (lo fuerza el SQL, no sólo el código). Idempotente: upsert por clave; sin DELETE.
export const ROL = 'colector_estaciones';
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;
/** Las redes que este job puede escribir: las de la política de la 0152, menos las de otros colectores. */
export const REDES = Object.freeze(['WEATHERLINK_PUB', 'WEATHERCLOUD_PUB', 'SIGA_RT', 'EEAOC', 'DACC_MZA', 'REM_SL', 'BCP_RT',
  'ER_HIDRAULICA', 'INA_METEO', 'INA_ALERTA']);

export function usuarioDeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return decodeURIComponent(u.username) || null;
  } catch { return null; }
}
/** El host como lo lee postgres.js (corta en el PRIMER «@»): un solo «@» y la clave codificada. */
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}

const DESC = { 23503: 'FK', 23505: 'clave repetida', 23514: 'CHECK', 42501: 'sin permiso (RLS o grant)', '28P01': 'usuario o clave',
  28000: 'usuario o clave', 53300: 'demasiadas conexiones', ECONNREFUSED: 'conexión rechazada', ENOTFOUND: 'host desconocido',
  ETIMEDOUT: 'tiempo agotado', CONNECT_TIMEOUT: 'tiempo agotado' };
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`);
  err.codigo = codigo;
  return err;
}

/** Conecta con postgres.js y devuelve un ejecutor. `conectar` se inyecta en los tests (nunca hay red). */
export async function conectarPg({ url, conectar = null, hostPermitido = (h) => HOST_POOLER.test(h), app = 'parseo-estaciones' }) {
  if (!url) throw new Error('falta la URL de la base (PARSEO_PG_URL)');
  const usuario = usuarioDeUrl(url);
  if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) throw new Error(`la URL tiene que ser del usuario ${ROL} (o ${ROL}.<ref>): no se usa otro`);
  const host = hostDeUrl(url);
  if (!host || !hostPermitido(host)) throw new Error('el host tiene que ser el pooler de Supabase (…pooler.supabase.com) y la clave ir codificada: no se conecta');
  if (!conectar) { const { default: postgres } = await import('postgres'); conectar = (u, o) => postgres(u, o); }
  let sql;
  try { sql = conectar(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 20, onnotice: () => {}, connection: { application_name: app } }); }
  catch (e) { throw errorLimpio(e, 'conectar'); }
  const cerrar = async () => { try { await sql.end({ timeout: 5 }); } catch { /* nada */ } };
  let r;
  try { r = (await sql.unsafe('select current_user as u, session_user as s'))[0] || {}; }
  catch (e) { await cerrar(); throw errorLimpio(e, 'conectar'); }
  if (r.u !== ROL || r.s !== ROL) { await cerrar(); throw new Error(`la conexión entró como otro usuario (no ${ROL}): se aborta`); }
  return { query: async (texto, params = []) => { try { return await sql.unsafe(texto, params); } catch (e) { throw errorLimpio(e, 'base'); } }, cerrar };
}

/** Un ejecutor sobre PGlite (tests). Con `rol`, cada consulta corre COMO ese rol (RLS y grants de verdad). */
export const ejecutorPglite = (pg, { rol = null } = {}) => ({
  query: async (texto, params = []) => {
    if (!rol) return (await pg.query(texto, params)).rows;
    await pg.exec(`set role ${rol}`);
    try { return (await pg.query(texto, params)).rows; } finally { await pg.exec('reset role'); }
  },
  cerrar: async () => {},
});

const NUM = ['tmin_c', 'tmax_c', 'lluvia_mm', 'eto_mm', 'tmin_noche_c', 'lat', 'lon'];
const tipos = (f) => { const o = { ...f }; for (const k of NUM) if (o[k] != null) o[k] = Number(o[k]); return o; };

/**
 * Las operaciones de guardado de UNA red. `red` es fija y tiene que estar en REDES: ninguna operación toca otra red.
 * Los errores que devuelve son CÓDIGOS (sin ids ni valores).
 */
export function crearGuardado(ej, red) {
  if (!REDES.includes(red)) throw new Error(`red no permitida: ${red}`);
  const q = async (que, texto, params) => { try { return await ej.query(texto, params); } catch (e) { throw errorLimpio(e, que); } };
  return {
    red,
    async estaciones() {
      return (await q('leer estaciones', 'select estacion_id, nombre, lat::text as lat, lon::text as lon, activa, metadatos from estaciones where red = $1', [red])).map(tipos);
    },
    /** Alta / actualización del catálogo. metadatos se UNE con lo guardado (lo de otros, p. ej. la zona de la 254/257,
     *  queda; las marcas de inactiva se sacan si vuelve) y mostrar queda false siempre. El nombre no se borra. */
    async guardarEstaciones(filas) {
      let ok = 0; const errores = [];
      for (const f of filas) {
        const meta = { ...(f.metadatos || {}), mostrar: false, uso: 'interno' };
        try {
          await ej.query(
            `insert into estaciones (red, estacion_id, nombre, partido, provincia, lat, lon, precision_ubicacion, fuente_ubicacion, activa, metadatos, actualizado_en)
             values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9, $10::boolean, ($11::jsonb || '{"mostrar": false, "uso": "interno"}'::jsonb), now())
             on conflict (red, estacion_id) do update set
               nombre = coalesce(excluded.nombre, estaciones.nombre), partido = coalesce(excluded.partido, estaciones.partido),
               provincia = coalesce(excluded.provincia, estaciones.provincia), lat = coalesce(excluded.lat, estaciones.lat),
               lon = coalesce(excluded.lon, estaciones.lon), precision_ubicacion = coalesce(excluded.precision_ubicacion, estaciones.precision_ubicacion),
               fuente_ubicacion = coalesce(excluded.fuente_ubicacion, estaciones.fuente_ubicacion), activa = excluded.activa,
               metadatos = ((estaciones.metadatos - 'inactiva_desde' - 'motivo_inactiva') || excluded.metadatos || '{"mostrar": false, "uso": "interno"}'::jsonb), actualizado_en = now()`,
            [red, String(f.estacion_id), f.nombre ?? null, f.partido ?? null, f.provincia ?? null, f.lat ?? null, f.lon ?? null,
              f.precision_ubicacion ?? 'declarada por la red', f.fuente_ubicacion ?? null, f.activa !== false, JSON.stringify(meta)]);
          ok++;
        } catch (e) { errores.push(errorLimpio(e, 'estaciones').message); }
      }
      return { ok, errores };
    },
    /** Las conocidas que NO están en `presentes` (el índice entero de la fuente): inactivas, sin borrar nada. */
    async inactivas(presentes, dia) {
      const r = await q('inactivas', `update estaciones set activa = false, actualizado_en = now(),
                           metadatos = metadatos || jsonb_build_object('inactiva_desde', $3::text, 'motivo_inactiva', 'fuera_del_crudo')
                          where red = $1 and activa and not (estacion_id = any($2::text[])) returning estacion_id`, [red, presentes, dia]);
      return r.length;
    },
    /** Las filas guardadas de la red para esas fechas (con el crudo: de ahí salen las lecturas para unir). */
    async obsFechas(fechas) {
      if (!fechas.length) return [];
      const filas = await q('leer estaciones_obs', `select estacion_id, fecha::text as fecha, tmin_c::text as tmin_c, tmax_c::text as tmax_c,
        lluvia_mm::text as lluvia_mm, horas_validas, registros_validos, crudo from estaciones_obs where red = $1 and fecha = any($2::date[])`, [red, fechas]);
      return filas.map((f) => ({ ...tipos(f), crudo: typeof f.crudo === 'string' ? JSON.parse(f.crudo) : f.crudo }));
    },
    /** Upsert de las filas diarias, una por una: una fila mala (un CHECK) no tira las demás. */
    async guardarObs(filas) {
      let ok = 0; const errores = [];
      for (const f of filas) {
        if (f.red != null && f.red !== red) throw new Error('fila de otra red');
        try {
          await ej.query(
            `insert into estaciones_obs (red, estacion_id, fecha, hora_corte, lluvia_mm, horas_validas, tmin_c, tmax_c, leido_en, url, crudo,
               eto_mm, tmin_noche_c, tmin_noche_en, noche_registros, noche_esperados, registros_validos, registros_esperados, muestreo_min, lluvia_origen)
             values ($1, $2, $3::date, $4::time, $5::numeric, $6::smallint, $7::numeric, $8::numeric, now(), $9, $10::jsonb,
               $11::numeric, $12::numeric, $13::timestamptz, $14::smallint, $15::smallint, $16::smallint, $17::smallint, $18::smallint, $19)
             on conflict (red, estacion_id, fecha) do update set
               hora_corte = excluded.hora_corte, lluvia_mm = excluded.lluvia_mm, horas_validas = excluded.horas_validas,
               tmin_c = excluded.tmin_c, tmax_c = excluded.tmax_c, leido_en = excluded.leido_en, url = excluded.url, crudo = excluded.crudo,
               eto_mm = excluded.eto_mm, tmin_noche_c = excluded.tmin_noche_c, tmin_noche_en = excluded.tmin_noche_en,
               noche_registros = excluded.noche_registros, noche_esperados = excluded.noche_esperados,
               registros_validos = excluded.registros_validos, registros_esperados = excluded.registros_esperados,
               muestreo_min = excluded.muestreo_min, lluvia_origen = excluded.lluvia_origen`,
            [red, String(f.estacion_id), f.fecha, f.hora_corte ?? '00:00', f.lluvia_mm ?? null, f.horas_validas ?? null, f.tmin_c ?? null, f.tmax_c ?? null,
              f.url ?? null, JSON.stringify(f.crudo ?? {}), f.eto_mm ?? null, f.tmin_noche_c ?? null, f.tmin_noche_en ?? null,
              f.noche_registros ?? null, f.noche_esperados ?? null, f.registros_validos ?? null, f.registros_esperados ?? null,
              f.muestreo_min ?? null, f.lluvia_origen ?? null]);
          ok++;
        } catch (e) { errores.push(errorLimpio(e, 'estaciones_obs').message); }
      }
      return { ok, errores };
    },
    /** La última lectura por estación (estaciones_ultima_lectura): NUNCA retrocede. `filas` = salida de ultimaFila(). */
    async ultimas(filas, fuente) {
      for (const l of filas) {
        await q('estaciones_ultima_lectura', `insert into estaciones_ultima_lectura as u (red, estacion_id, instante, leido_en, edad_s, temp_c, hum_pct, viento_ms, racha_ms,
                   viento_dir_gr, presion_hpa, lluvia_dia_mm, marcas, crudo)
                 values ($1, $2, $3::timestamptz, now(), $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13::jsonb)
                 on conflict (red, estacion_id) do update set instante = excluded.instante, leido_en = excluded.leido_en, edad_s = excluded.edad_s,
                   temp_c = excluded.temp_c, hum_pct = excluded.hum_pct, viento_ms = excluded.viento_ms, racha_ms = excluded.racha_ms,
                   viento_dir_gr = excluded.viento_dir_gr, presion_hpa = excluded.presion_hpa, lluvia_dia_mm = excluded.lluvia_dia_mm,
                   marcas = excluded.marcas, crudo = excluded.crudo
                 where excluded.instante > u.instante`,
          [red, String(l.id), l.instante, l.edad_s ?? null, l.temp_c ?? null, l.hum_pct ?? null, l.viento_ms ?? null,
            l.racha_ms ?? null, l.viento_dir_gr ?? null, l.presion_hpa ?? null, l.lluvia_dia_mm ?? null, l.marcas || [],
            JSON.stringify({ fuente, desde: 'R2', uso: 'interno' })]);
      }
      return filas.length;
    },
    async registrar(proceso, ok, resumen) {
      let txt = JSON.stringify(resumen);
      if (txt.length > 60000) txt = JSON.stringify({ recortado: true, largo: txt.length, avisos: resumen.avisos });
      await q('registro_procesos', 'insert into registro_procesos (proceso, ok, resumen) values ($1, $2, $3::jsonb)', [proceso, ok, txt]);
    },
  };
}
