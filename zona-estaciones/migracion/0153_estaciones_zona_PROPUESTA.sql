-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0153 · la ZONA de cada estación (ESA WorldCover 2021 v200) en estaciones.metadatos   [15/11/2026 · 257]
--                  + el rol `clasificador_zona`, que SÓLO puede escribir esas dos claves
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA: la revisa y la aplica local (número: 0150 es de la 176, 0151 de la 139, 0152 de la 138b/0152b WC;
--   si al aplicarla la 0153 ya está tomada, renumerar). No cambia la forma de ninguna tabla.
--
-- QUÉ GUARDA (en la columna que ya existe, estaciones.metadatos jsonb not null default '{}', migración 0110):
--   metadatos.zona     = 'agricola' | 'pastizal' | 'urbana' | 'natural' | 'sin_dato'      (texto: fácil de filtrar)
--   metadatos.zona_wc  = { regla, radio_m, umbral_urbana_pct, margen, pixel, pct: {"100":{…},"250":{…},"500":{…}},
--                          pixeles, lat, lon, fuente, licencia, cita, calculado_en }
--   (pct = % de cada clase de WorldCover con dato en el círculo de ese radio; lat/lon = la coordenada con la que se
--    calculó: si la estación se mueve, vuelve a quedar «pendiente».)
--
-- POR QUÉ FUNCIONES Y NO GRANTS SOBRE LA TABLA: el clasificador corre en Actions de un repo PÚBLICO. Con UPDATE sobre
-- la columna metadatos, quien robe la clave podría pisar TODO metadatos de todas las redes. Con estas dos funciones
-- SECURITY DEFINER el rol no tiene ningún permiso sobre tablas: sólo lee (red, id, lat, lon) de las pendientes y
-- escribe las claves `zona` y `zona_wc`, con el valor validado. No ve nombres, ni observaciones, ni datos de usuarios.
--
-- Se aplica con psql (la clave llega como VERIFICADOR SCRAM, igual que la 0147b; ver sipan-alto-valle/migracion/scram.mjs):
--   VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f 0153_estaciones_zona_PROPUESTA.sql
-- Idempotente.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Las funciones ────────────────────────────────────────────────────────────
create or replace function public.estaciones_zona_pendientes(p_regla text, p_todas boolean default false)
returns table (red text, estacion_id text, lat numeric, lon numeric)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select e.red, e.estacion_id, e.lat, e.lon
    from public.estaciones e
   where e.lat is not null and e.lon is not null
     and (p_todas
          or e.metadatos->'zona_wc' is null
          or e.metadatos->'zona_wc'->>'regla' is distinct from p_regla
          or abs(coalesce((e.metadatos->'zona_wc'->>'lat')::numeric, 999) - e.lat) > 0.000001
          or abs(coalesce((e.metadatos->'zona_wc'->>'lon')::numeric, 999) - e.lon) > 0.000001)
   order by e.red, e.estacion_id
$$;

create or replace function public.estaciones_fijar_zona(p_red text, p_estacion_id text, p_zona text, p_detalle jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_zona is null or p_zona not in ('agricola', 'pastizal', 'urbana', 'natural', 'sin_dato') then
    raise exception 'zona inválida';
  end if;
  if p_detalle is null or jsonb_typeof(p_detalle) <> 'object' or length(p_detalle::text) > 4000
     or not (p_detalle ? 'regla' and p_detalle ? 'cita' and p_detalle ? 'lat' and p_detalle ? 'lon') then
    raise exception 'detalle inválido';
  end if;
  update public.estaciones
     set metadatos = coalesce(metadatos, '{}'::jsonb) || jsonb_build_object('zona', p_zona, 'zona_wc', p_detalle)
   where red = p_red and estacion_id = p_estacion_id;
  -- actualizado_en NO se toca: lo usan los colectores para saber cuándo se refrescó el catálogo.
  if not found then
    raise exception 'estación inexistente';
  end if;
end $$;

comment on function public.estaciones_fijar_zona(text, text, text, jsonb) is
  '257: escribe metadatos.zona y metadatos.zona_wc (ESA WorldCover 2021 v200, CC BY 4.0, Zanaga et al. 2022, doi:10.5281/zenodo.7254221). Nada más.';

-- En Supabase las funciones nuevas de public quedan ejecutables por anon/authenticated (privilegios por defecto): se saca.
revoke all on function public.estaciones_zona_pendientes(text, boolean) from public, anon, authenticated;
revoke all on function public.estaciones_fijar_zona(text, text, text, jsonb) from public, anon, authenticated;

-- 2. El rol ──────────────────────────────────────────────────────────────────
select 'create role clasificador_zona login nocreatedb nocreaterole noinherit connection limit 2'
 where not exists (select 1 from pg_roles where rolname = 'clasificador_zona') \gexec
alter role clasificador_zona with login nocreatedb nocreaterole noinherit connection limit 2
  password :'clave';
do $$
declare r record;
begin
  select rolsuper, rolreplication, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
    into r from pg_roles where rolname = 'clasificador_zona';
  if r.rolsuper or r.rolreplication or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolinherit then
    raise exception 'clasificador_zona tiene atributos de más: no se sigue';
  end if;
end $$;

grant usage on schema public to clasificador_zona;
grant execute on function public.estaciones_zona_pendientes(text, boolean) to clasificador_zona;
grant execute on function public.estaciones_fijar_zona(text, text, text, jsonb) to clasificador_zona;
-- Ningún grant sobre tablas.

-- Verificación (a mano, después de aplicar):
--   set role clasificador_zona;      -- (si da «permission denied to set role»: grant clasificador_zona to postgres; … ; revoke)
--   select count(*) from estaciones_zona_pendientes('r1', false);     -- n > 0
--   select count(*) from estaciones;                                   -- ERROR: permission denied
--   select estaciones_fijar_zona('SNIH', '111872', 'selva', '{}');     -- ERROR: zona inválida
--   reset role;
--   select metadatos->'zona', metadatos->'zona_wc'->'pct'->'250' from estaciones where red = 'SNIH' limit 3;

-- Consulta de uso (ejemplo): las estaciones agrícolas cerca de un lote
--   select red, estacion_id from estaciones where metadatos->>'zona' = 'agricola';
-- Si hace falta un índice: create index on estaciones ((metadatos->>'zona'));   (hoy son ~3.000 filas: no hace falta)

-- ROLLBACK (comentado a propósito):
-- revoke all on function public.estaciones_fijar_zona(text, text, text, jsonb) from clasificador_zona;
-- revoke all on function public.estaciones_zona_pendientes(text, boolean) from clasificador_zona;
-- drop function if exists public.estaciones_fijar_zona(text, text, text, jsonb);
-- drop function if exists public.estaciones_zona_pendientes(text, boolean);
-- drop role if exists clasificador_zona;
-- update estaciones set metadatos = metadatos - 'zona' - 'zona_wc';
