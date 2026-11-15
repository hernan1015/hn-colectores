// HN AGRO · parseo de estaciones internas · EL GUARDADO COMÚN (estaciones / estaciones_obs / estaciones_ultima_lectura
// / registro_procesos). Lo usan TODOS los módulos de fuentes/ (WeatherLink y Weathercloud hoy; SIGA, EEAOC, DACC, REM,
// BCP, INA y Entre Ríos, del agente de la 139, después).
//
// Por Postgres directo con el rol propio `colector_estaciones` (0147b), igual que el SIPAN y el SMN: sólo ese usuario,
// sólo el pooler de Supabase, la URL nunca se imprime y los errores del driver salen sin su mensaje.
// Un secreto: PARSEO_PG_URL = postgresql://colector_estaciones.<ref>:<clave>@<host-del-pooler>:6543/postgres
// (el mismo valor de SIPAN_PG_URL). El rol sólo puede tocar las redes de sus políticas (0147b + 0151 + 0152).
//
// La base es una interfaz mínima `q(texto, params) → filas`: en la nube, postgres.js (`sql.unsafe`); en los tests,
// PGlite. Así el SQL que se prueba es el mismo que corre.
export const ROL = 'colector_estaciones';
export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;
/** Las redes que este job puede escribir. Una red nueva se suma ACÁ y en la política del rol (migración). */
export const REDES = new Set(['WEATHERLINK_PUB', 'WEATHERCLOUD_PUB']);
export const PROCESO = 'estaciones_privadas_parseo';

export function usuarioDeUrl(url) {
  try { const u = new URL(String(url)); return /^postgres(ql)?:$/.test(u.protocol) ? decodeURIComponent(u.username) || null : null; }
  catch { return null; }
}
export function hostDeUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^@/?#\s]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/[A-Za-z0-9_-]+(\?[^@#\s]*)?$/.exec(String(url));
  return m ? m[2].toLowerCase() : null;
}
export function errorLimpio(e, que = 'base') {
  const crudo = e && (e.code || e.errno);
  const codigo = crudo ? String(crudo).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : 'sin_codigo';
  const err = new Error(`${que}: ${codigo}`);
  err.codigo = codigo;
  return err;
}

/** La conexión de la nube (postgres.js) → { q, cerrar }. `conectar` se inyecta en los tests. */
export async function conectarPg({ url, conectar, hostPermitido = (h) => HOST_POOLER.test(h) }) {
  if (!url) throw new Error('falta PARSEO_PG_URL');
  const usuario = usuarioDeUrl(url);
  if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) throw new Error(`PARSEO_PG_URL tiene que ser del usuario ${ROL} (o ${ROL}.<ref>)`);
  const host = hostDeUrl(url);
  if (!host || !hostPermitido(host)) throw new Error('PARSEO_PG_URL: el host tiene que ser el pooler de Supabase y la clave ir codificada');
  if (!conectar) { const { default: postgres } = await import('postgres'); conectar = (u, o) => postgres(u, o); }
  let sql;
  try { sql = conectar(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 20, onnotice: () => {}, connection: { application_name: 'parseo-estaciones-privadas' } }); }
  catch (e) { throw errorLimpio(e, 'conectar'); }
  const cerrar = async () => { try { await sql.end({ timeout: 5 }); } catch { /* nada */ } };
  const q = async (texto, params = []) => { try { return await sql.unsafe(texto, params); } catch (e) { throw errorLimpio(e, 'base'); } };
  let r;
  try { r = (await sql.unsafe('select current_user as u, session_user as s'))[0] || {}; } catch (e) { await cerrar(); throw errorLimpio(e, 'conectar'); }
  if (r.u !== ROL || r.s !== ROL) { await cerrar(); throw new Error(`la conexión entró como otro usuario (no ${ROL}): se aborta`); }
  return { q, cerrar };
}

const red_ = (red) => { if (!REDES.has(red)) throw new Error(`red no permitida: ${red}`); return red; };
const n = (x) => (x == null ? null : Number(x));

/** Guardado sobre una `q`. Todo por lotes chicos y con parámetros (nada de SQL armado con datos). */
export function crearGuardado(q) {
  return {
    /** Alta/actualización. metadatos se UNE (lo que pusieron otros, p. ej. la 254, queda); el nombre no se borra. */
    async estaciones(red, filas) {
      red_(red);
      for (const f of filas) {
        await q(`insert into estaciones (red, estacion_id, nombre, lat, lon, fuente_ubicacion, precision_ubicacion, activa, metadatos, actualizado_en)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
                 on conflict (red, estacion_id) do update set
                   nombre = coalesce(excluded.nombre, estaciones.nombre),
                   lat = coalesce(excluded.lat, estaciones.lat), lon = coalesce(excluded.lon, estaciones.lon),
                   fuente_ubicacion = coalesce(excluded.fuente_ubicacion, estaciones.fuente_ubicacion),
                   precision_ubicacion = coalesce(excluded.precision_ubicacion, estaciones.precision_ubicacion),
                   activa = excluded.activa,
                   metadatos = (estaciones.metadatos - 'inactiva_desde' - 'motivo_inactiva') || excluded.metadatos,
                   actualizado_en = now()`,
          [red, f.estacion_id, f.nombre ?? null, f.lat ?? null, f.lon ?? null, f.fuente_ubicacion ?? null, f.precision_ubicacion ?? null,
           f.activa !== false, JSON.stringify(f.metadatos || {})]);
      }
      return filas.length;
    },
    /** Las conocidas que NO están en `presentes`: inactivas, sin borrar nada. */
    async inactivas(red, presentes, dia) {
      red_(red);
      const r = await q(`update estaciones set activa = false, actualizado_en = now(),
                           metadatos = metadatos || jsonb_build_object('inactiva_desde', $3::text, 'motivo_inactiva', 'fuera_del_crudo')
                          where red = $1 and activa and not (estacion_id = any($2::text[])) returning estacion_id`, [red, presentes, dia]);
      return r.length;
    },
    async obsDe(red, fechas) {
      red_(red);
      const r = await q(`select estacion_id, fecha::text as fecha, tmin_c, tmax_c, registros_validos, registros_esperados, lluvia_mm,
                                tmin_noche_c, tmin_noche_en, noche_registros, noche_esperados
                           from estaciones_obs where red = $1 and fecha = any($2::date[])`, [red, fechas]);
      return r.map((f) => ({ ...f, tmin_c: n(f.tmin_c), tmax_c: n(f.tmax_c), lluvia_mm: n(f.lluvia_mm), tmin_noche_c: n(f.tmin_noche_c),
        tmin_noche_en: f.tmin_noche_en instanceof Date ? f.tmin_noche_en.toISOString() : f.tmin_noche_en }));
    },
    /** Upsert de días (ya combinados con lo guardado). Una por una: una fila mala no tira las demás. */
    async obs(red, filas) {
      red_(red);
      let ok = 0; const errores = [];
      for (const f of filas) {
        if (f.red !== red) throw new Error('fila de otra red');
        try {
          await q(`insert into estaciones_obs (red, estacion_id, fecha, hora_corte, url, leido_en, crudo, tmin_c, tmax_c, registros_validos,
                     registros_esperados, tmin_noche_c, tmin_noche_en, noche_registros, noche_esperados, muestreo_min, lluvia_mm, lluvia_origen, horas_validas)
                   values ($1, $2, $3::date, $4::time, $5, now(), $6::jsonb, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14, $15, $16, $17, $18)
                   on conflict (red, estacion_id, fecha) do update set
                     url = excluded.url, leido_en = excluded.leido_en, crudo = excluded.crudo, tmin_c = excluded.tmin_c, tmax_c = excluded.tmax_c,
                     registros_validos = excluded.registros_validos, registros_esperados = excluded.registros_esperados,
                     tmin_noche_c = excluded.tmin_noche_c, tmin_noche_en = excluded.tmin_noche_en, noche_registros = excluded.noche_registros,
                     noche_esperados = excluded.noche_esperados, muestreo_min = excluded.muestreo_min, lluvia_mm = excluded.lluvia_mm,
                     lluvia_origen = excluded.lluvia_origen, horas_validas = excluded.horas_validas`,
            [red, f.estacion_id, f.fecha, f.hora_corte || '00:00', f.url ?? null, JSON.stringify(f.crudo || {}), f.tmin_c, f.tmax_c,
             f.registros_validos, f.registros_esperados, f.tmin_noche_c, f.tmin_noche_en, f.noche_registros, f.noche_esperados,
             f.muestreo_min, f.lluvia_mm, f.lluvia_origen ?? null, f.horas_validas ?? null]);
          ok++;
        } catch (e) { errores.push(e.codigo || 'error'); }
      }
      return { ok, errores };
    },
    /** La última lectura por estación: nunca retrocede. */
    async ultimas(red, lecturas, fuente) {
      red_(red);
      for (const l of lecturas) {
        await q(`insert into estaciones_ultima_lectura as u (red, estacion_id, instante, leido_en, edad_s, temp_c, hum_pct, viento_ms, racha_ms,
                   viento_dir_gr, presion_hpa, lluvia_dia_mm, marcas, crudo)
                 values ($1, $2, $3::timestamptz, now(), $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13::jsonb)
                 on conflict (red, estacion_id) do update set instante = excluded.instante, leido_en = excluded.leido_en, edad_s = excluded.edad_s,
                   temp_c = excluded.temp_c, hum_pct = excluded.hum_pct, viento_ms = excluded.viento_ms, racha_ms = excluded.racha_ms,
                   viento_dir_gr = excluded.viento_dir_gr, presion_hpa = excluded.presion_hpa, lluvia_dia_mm = excluded.lluvia_dia_mm,
                   marcas = excluded.marcas, crudo = excluded.crudo
                 where excluded.instante > u.instante`,
          [red, l.id, new Date(l.instante).toISOString(), l.edad_s ?? null, l.temp_c ?? null, l.hum_pct ?? null, l.viento_ms ?? null,
           l.racha_ms ?? null, l.viento_dir_gr ?? null, l.presion_hpa ?? null, l.lluvia_dia_mm ?? null, l.marcas || [],
           JSON.stringify({ fuente, desde: 'R2' })]);
      }
      return lecturas.length;
    },
    async registrar(ok, resumen) {
      let txt = JSON.stringify(resumen);
      if (txt.length > 60000) txt = JSON.stringify({ recortado: true, largo: txt.length });
      await q('insert into registro_procesos (proceso, ok, resumen) values ($1, $2, $3::jsonb)', [PROCESO, ok, txt]);
    },
  };
}
