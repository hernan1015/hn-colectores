// HN AGRO · estaciones-privadas/parseo · el GUARDADO en estaciones / estaciones_obs (hn-agro 0110 + 0147) y el renglón de
// registro_procesos (0075), por Postgres directo con el rol `colector_estaciones` (0147b: sin BYPASSRLS, sin DELETE).
//
// Escrito sobre un «ejecutor» mínimo: { query(texto, parametros) → filas }. Así el MISMO SQL corre:
//   · en producción con postgres.js (`sql.unsafe`, pooler en modo transacción: prepare false, 1 conexión);
//   · en los tests contra PGlite (un Postgres de verdad, en memoria), con las migraciones reales 0110 + 0147.
// Las defensas de la conexión son las del SIPAN y el SMN (hn-colectores sipan-alto-valle/lib/base.mjs): el usuario de la
// URL tiene que ser colector_estaciones, el host el pooler de Supabase, current_user y session_user los dos el rol, y
// ningún error del driver sale tal cual (puede traer host, usuario o la URL).
//
// INTERNO: toda estación se guarda con metadatos.mostrar = false y uso = 'interno', aunque la fuente o lo ya guardado
// digan otra cosa (lo fuerza el SQL, no sólo el código). Idempotente: upsert por clave; sin DELETE.
export const ROL = 'colector_estaciones';
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;

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
export async function conectarPg({ url, conectar = null, hostPermitido = (h) => HOST_POOLER.test(h), app = 'colector-estaciones' }) {
  if (!url) throw new Error('falta la URL de la base');
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
  return { query: (texto, params = []) => sql.unsafe(texto, params), cerrar };
}

/** Un ejecutor sobre PGlite (tests). */
export const ejecutorPglite = (pg) => ({ query: async (texto, params = []) => (await pg.query(texto, params)).rows, cerrar: async () => {} });

const NUM = ['tmin_c', 'tmax_c', 'lluvia_mm', 'eto_mm', 'tmin_noche_c', 'lat', 'lon'];
const tipos = (f) => { const o = { ...f }; for (const k of NUM) if (o[k] != null) o[k] = Number(o[k]); return o; };

/**
 * Las operaciones de guardado de UNA red. `red` es fija: ninguna operación toca otra red.
 */
export function crearGuardado(ej, red) {
  if (!/^[A-Z][A-Z0-9_]{2,31}$/.test(red)) throw new Error('red inválida');
  const q = async (que, texto, params) => { try { return await ej.query(texto, params); } catch (e) { throw errorLimpio(e, que); } };
  return {
    red,
    async estaciones() {
      return (await q('leer estaciones', 'select estacion_id, nombre, lat::text as lat, lon::text as lon, activa, metadatos from estaciones where red = $1', [red])).map(tipos);
    },
    /** Alta / actualización del catálogo. metadatos se MEZCLA con lo guardado y mostrar queda false siempre. */
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
               metadatos = (estaciones.metadatos || excluded.metadatos || '{"mostrar": false, "uso": "interno"}'::jsonb), actualizado_en = now()`,
            [red, String(f.estacion_id), f.nombre ?? null, f.partido ?? null, f.provincia ?? null, f.lat ?? null, f.lon ?? null,
              f.precision_ubicacion ?? 'declarada por la red', f.fuente_ubicacion ?? null, f.activa !== false, JSON.stringify(meta)]);
          ok++;
        } catch (e) { errores.push(`${f.estacion_id}: ${errorLimpio(e, 'estaciones').message}`); }
      }
      return { ok, errores };
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
        } catch (e) { errores.push(`${f.estacion_id} ${f.fecha}: ${errorLimpio(e, 'estaciones_obs').message}`); }
      }
      return { ok, errores };
    },
    async registrar(proceso, ok, resumen) {
      let txt = JSON.stringify(resumen);
      if (txt.length > 60000) txt = JSON.stringify({ recortado: true, largo: txt.length, avisos: resumen.avisos });
      await q('registro_procesos', 'insert into registro_procesos (proceso, ok, resumen) values ($1, $2, $3::jsonb)', [proceso, ok, txt]);
    },
  };
}
