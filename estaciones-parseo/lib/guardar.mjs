// HN AGRO · estaciones-parseo · el guardado (tablas de la 0110 y la 0161), por la interfaz q(texto, params) de base.mjs.
// Todo en lotes con jsonb_to_recordset: un parámetro por lote, igual en postgres.js y en PGlite.
//   · estaciones: alta o actualización SÓLO si cambió su firma; `metadatos` se une con lo que ya tenía (la zona de la
//     254, por ejemplo, queda); una coordenada que la fuente no trae NO borra la guardada. La marca `mostrar` no se
//     manda: la pone la base (false; el rol del colector no la puede cambiar).
//   · estaciones_lecturas: alta, o actualización SÓLO si cambió la firma y la nueva no tiene menos datos que la guardada.
//   · al final: las duplicadas a < 2 km (estaciones_marcar_duplicados), la poda a 10 días y el renglón de registro_procesos.
import { firmaEstacion, VARIABLES } from './calidad.mjs';

export const LOTE = 500;
export const PROCESO = 'estaciones_parseo';

const enLotes = (a, n = LOTE) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const SQL_ESTACIONES = `
insert into public.estaciones as s (red, estacion_id, nombre, partido, provincia, lat, lon, precision_ubicacion, fuente_ubicacion,
                                    activa, metadatos, actualizado_en, parseo_firma)
select $1, x.estacion_id, x.nombre, x.partido, x.provincia, x.lat, x.lon, x.precision_ubicacion, x.fuente_ubicacion,
       coalesce(x.activa, true), coalesce(x.metadatos, '{}'::jsonb), now(), x.parseo_firma
  from jsonb_to_recordset($2::jsonb) as x(estacion_id text, nombre text, partido text, provincia text, lat numeric, lon numeric,
       precision_ubicacion text, fuente_ubicacion text, activa boolean, metadatos jsonb, parseo_firma text)
on conflict (red, estacion_id) do update set
  nombre = coalesce(excluded.nombre, s.nombre), partido = coalesce(excluded.partido, s.partido),
  provincia = coalesce(excluded.provincia, s.provincia),
  lat = case when excluded.lat is null or excluded.lon is null then s.lat else excluded.lat end,
  lon = case when excluded.lat is null or excluded.lon is null then s.lon else excluded.lon end,
  precision_ubicacion = coalesce(excluded.precision_ubicacion, s.precision_ubicacion),
  fuente_ubicacion = coalesce(excluded.fuente_ubicacion, s.fuente_ubicacion),
  activa = excluded.activa, metadatos = s.metadatos || excluded.metadatos, actualizado_en = now(), parseo_firma = excluded.parseo_firma
where s.parseo_firma is distinct from excluded.parseo_firma
returning 1 as n`;

const LLENAS = (t) => `num_nonnulls(${VARIABLES.map((v) => `${t}.${v}`).join(', ')})`;
const SQL_LECTURAS = `
insert into public.estaciones_lecturas as l (red, estacion_id, instante, temp_c, hum_pct, lluvia_mm, lluvia_periodo_min, lluvia_dia_mm,
                                             viento_ms, racha_ms, viento_dir_gr, presion_hpa, marcas, crudo, firma, leido_en)
select $1, x.estacion_id, x.instante, x.temp_c, x.hum_pct, x.lluvia_mm, x.lluvia_periodo_min, x.lluvia_dia_mm,
       x.viento_ms, x.racha_ms, x.viento_dir_gr, x.presion_hpa, coalesce(x.marcas, '{}'), coalesce(x.crudo, '{}'::jsonb), x.firma, x.leido_en
  from jsonb_to_recordset($2::jsonb) as x(estacion_id text, instante timestamptz, temp_c numeric, hum_pct numeric, lluvia_mm numeric,
       lluvia_periodo_min smallint, lluvia_dia_mm numeric, viento_ms numeric, racha_ms numeric, viento_dir_gr numeric,
       presion_hpa numeric, marcas text[], crudo jsonb, firma text, leido_en timestamptz)
on conflict (red, estacion_id, instante) do update set
  temp_c = excluded.temp_c, hum_pct = excluded.hum_pct, lluvia_mm = excluded.lluvia_mm, lluvia_periodo_min = excluded.lluvia_periodo_min,
  lluvia_dia_mm = excluded.lluvia_dia_mm, viento_ms = excluded.viento_ms, racha_ms = excluded.racha_ms,
  viento_dir_gr = excluded.viento_dir_gr, presion_hpa = excluded.presion_hpa, marcas = excluded.marcas, crudo = excluded.crudo,
  firma = excluded.firma, leido_en = excluded.leido_en
where l.firma is distinct from excluded.firma and ${LLENAS('excluded')} >= ${LLENAS('l')}
returning (xmax = 0) as nueva`;

const fila = (l) => ({ estacion_id: l.estacion_id, instante: new Date(l.instante).toISOString(),
  ...Object.fromEntries(VARIABLES.map((k) => [k, l[k] ?? null])), lluvia_periodo_min: l.lluvia_periodo_min ?? null,
  marcas: l.marcas || [], crudo: l.crudo || {}, firma: l.firma, leido_en: new Date(l.leido_en).toISOString() });

/** Guarda una red. → { estaciones_escritas, lecturas_nuevas, lecturas_cambiadas, lecturas_iguales, sin_estacion } */
export async function guardarRed(db, { red, estaciones, lecturas }) {
  const r = { estaciones_escritas: 0, lecturas_nuevas: 0, lecturas_cambiadas: 0, lecturas_iguales: 0, sin_estacion: 0 };
  const ests = estaciones.map((e) => ({ estacion_id: e.estacion_id, nombre: e.nombre ?? null, partido: e.partido ?? null,
    provincia: e.provincia ?? null, lat: e.lat ?? null, lon: e.lon ?? null, precision_ubicacion: e.precision_ubicacion ?? null,
    fuente_ubicacion: e.fuente_ubicacion ?? null, activa: e.activa ?? true, metadatos: e.metadatos || {} }))
    .map((e) => ({ ...e, parseo_firma: firmaEstacion(e) }));
  for (const lote of enLotes(ests)) {
    r.estaciones_escritas += (await db.q(SQL_ESTACIONES, [red, JSON.stringify(lote)], 'estaciones')).length;
  }
  const conocidas = new Set(ests.map((e) => e.estacion_id));
  const buenas = lecturas.filter((l) => conocidas.has(l.estacion_id));
  r.sin_estacion = lecturas.length - buenas.length;
  for (const lote of enLotes(buenas)) {
    const filas = await db.q(SQL_LECTURAS, [red, JSON.stringify(lote.map(fila))], 'estaciones_lecturas');
    const nuevas = filas.filter((f) => f.nueva === true || f.nueva === 't').length;
    r.lecturas_nuevas += nuevas;
    r.lecturas_cambiadas += filas.length - nuevas;
    r.lecturas_iguales += lote.length - filas.length;
  }
  return r;
}

/** `podar` = false en una corrida que repasa el pasado (--ahora): la poda mide contra now() de la base. */
export async function cerrarCorrida(db, { ok, resumen, podarDias = 10, podar = true }) {
  const dup = await db.q('select public.estaciones_marcar_duplicados(2) as n', [], 'duplicadas');
  const pod = podar ? await db.q('select public.estaciones_lecturas_podar($1) as n', [podarDias], 'poda') : [{ n: 0 }];
  await db.q('insert into public.registro_procesos (proceso, ok, resumen) values ($1, $2, $3::jsonb)',
    [PROCESO, ok, JSON.stringify(resumen)], 'registro_procesos');
  return { duplicadas_cambiadas: Number(dup[0]?.n ?? 0), lecturas_podadas: Number(pod[0]?.n ?? 0) };
}
