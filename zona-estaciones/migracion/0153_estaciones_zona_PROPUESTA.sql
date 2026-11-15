-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0153 · la ZONA de cada estación (ESA WorldCover 2021 v200) en estaciones.metadatos   [15/11/2026 · 257]
--                  + el rol `clasificador_zona`, que SÓLO puede escribir esas dos claves
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA: la revisa y la aplica local (número: 0150 es de la 176, 0151 de smn-abierto/139, 0152 la unificada del
--   parseo, PR #11 de hn-colectores, estaciones-privadas/parseo/; revisado el 15/11: ninguna rama usa la 0153; si al
--   aplicarla ya está tomada, renumerar). No cambia la forma de ninguna tabla.
-- 2.ª vuelta (Codex 15/11, n3-257-1511): el detalle se valida clave por clave (tipos, rangos, lista cerrada) y
--   estaciones_fijar_zona devuelve false sin escribir si nada cambió.
--
-- QUÉ GUARDA (en la columna que ya existe, estaciones.metadatos jsonb not null default '{}', migración 0110):
--   metadatos.zona     = 'agricola' | 'pastizal' | 'urbana' | 'natural' | 'sin_dato'      (texto: fácil de filtrar)
--   metadatos.zona_wc  = { regla, radio_m, umbral_urbana_pct, umbral_cobertura_pct, umbral_margen, margen, dudosa,
--                          dudosa_motivo, pixel, cobertura: {"100":n,"250":n,"500":n}, pct: {"100":{…},"250":{…},"500":{…}},
--                          pixeles, pixeles_circulo, lat, lon, fuente, licencia, cita, calculado_en }
--   (pct = % de cada clase de WorldCover sobre los píxeles CON DATO del círculo de ese radio; cobertura = % del círculo
--    con dato; dudosa = true con dudosa_motivo ['margen'] y/o ['cobertura']; lat/lon = la coordenada con la que se
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
-- Una coordenada guardada en zona_wc sólo se usa si es un número: un valor raro (que no puede entrar por
-- estaciones_fijar_zona, pero podría venir de una edición a mano) deja la estación como pendiente y NUNCA rompe
-- la consulta (Codex 15/11, bloqueo 4: un lat:"INVALID" hacía fallar estaciones_zona_pendientes entera).
create or replace function public.estaciones_zona_num(p jsonb)
returns numeric
language sql immutable
set search_path = public, pg_temp
as $$ select case when jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric end $$;

create or replace function public.estaciones_zona_pendientes(p_regla text, p_todas boolean default false)
returns table (red text, estacion_id text, lat numeric, lon numeric)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select e.red, e.estacion_id, e.lat, e.lon
    from public.estaciones e
   where e.lat is not null and e.lon is not null
     and (p_todas
          or jsonb_typeof(e.metadatos->'zona_wc') is distinct from 'object'
          or e.metadatos->'zona_wc'->>'regla' is distinct from p_regla
          or abs(coalesce(public.estaciones_zona_num(e.metadatos->'zona_wc'->'lat'), 999) - e.lat) > 0.000001
          or abs(coalesce(public.estaciones_zona_num(e.metadatos->'zona_wc'->'lon'), 999) - e.lon) > 0.000001)
   order by e.red, e.estacion_id
$$;

-- ¿Es un número de jsonb entre lo y hi? Nunca da error ni null (el cast va dentro de un CASE, que no se adelanta).
create or replace function public.estaciones_zona_en_rango(p jsonb, lo numeric, hi numeric)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$ select case when jsonb_typeof(p) = 'number' then coalesce((p #>> '{}')::numeric between lo and hi, false) else false end $$;

-- ¿Un objeto {clase: % de 0 a 100} (los porcentajes de un radio)?
create or replace function public.estaciones_zona_pcts_ok(p jsonb)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(p) = 'object' then not exists (select 1 from jsonb_each(p) x
                      where x.key !~ '^(10|20|30|40|50|60|70|80|90|95|100)$'
                         or not public.estaciones_zona_en_rango(x.value, 0, 100)) else false end
$$;

-- El detalle, validado clave por clave: tipos, rangos y una lista CERRADA de claves (lo que sobra o falta, se rechaza).
create or replace function public.estaciones_zona_detalle_ok(p_zona text, d jsonb)
returns boolean
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  claves constant text[] := array['regla', 'radio_m', 'umbral_urbana_pct', 'umbral_cobertura_pct', 'umbral_margen', 'margen',
    'dudosa', 'dudosa_motivo', 'pixel', 'cobertura', 'pct', 'pixeles', 'pixeles_circulo', 'lat', 'lon', 'fuente', 'licencia',
    'cita', 'calculado_en'];
  radios constant text[] := array['100', '250', '500'];
  k text;
begin
  if d is null or jsonb_typeof(d) <> 'object' or length(d::text) > 4000 then return false; end if;
  -- ni una clave de más ni una de menos
  if exists (select 1 from jsonb_object_keys(d) x where x <> all (claves)) then return false; end if;
  if not (d ?& claves) then return false; end if;
  -- la regla: de una lista
  if jsonb_typeof(d->'regla') <> 'string' or d->>'regla' not in ('r1') then return false; end if;
  -- números y rangos
  if not public.estaciones_zona_en_rango(d->'lat', -90, 90) then return false; end if;
  if not public.estaciones_zona_en_rango(d->'lon', -180, 180) then return false; end if;
  if not public.estaciones_zona_en_rango(d->'radio_m', 1, 5000) then return false; end if;
  foreach k in array array['umbral_urbana_pct', 'umbral_cobertura_pct', 'umbral_margen'] loop
    if not public.estaciones_zona_en_rango(d->k, 0, 100) then return false; end if;
  end loop;
  if not public.estaciones_zona_en_rango(d->'pixeles_circulo', 0, 1000000) then return false; end if;
  if not public.estaciones_zona_en_rango(d->'pixeles', 0, (d->>'pixeles_circulo')::numeric) then return false; end if;
  if (d->>'pixeles')::numeric <> trunc((d->>'pixeles')::numeric)
     or (d->>'pixeles_circulo')::numeric <> trunc((d->>'pixeles_circulo')::numeric) then return false; end if;
  -- el píxel: null o una clase de WorldCover (0 = sin dato)
  if jsonb_typeof(d->'pixel') <> 'null' and (jsonb_typeof(d->'pixel') <> 'number'
     or (d->>'pixel') !~ '^(0|10|20|30|40|50|60|70|80|90|95|100)$') then return false; end if;
  -- margen: null sólo en sin_dato; si no, un número de −100 a 100
  if p_zona = 'sin_dato' then
    if jsonb_typeof(d->'margen') <> 'null' then return false; end if;
  elsif not public.estaciones_zona_en_rango(d->'margen', -100, 100) then
    return false;
  end if;
  -- dudosa: booleano, con sus motivos ('margen', 'cobertura'); dudosa sí y sólo si hay motivos
  if jsonb_typeof(d->'dudosa') <> 'boolean' or jsonb_typeof(d->'dudosa_motivo') <> 'array' then return false; end if;
  if jsonb_array_length(d->'dudosa_motivo') > 2
     or exists (select 1 from jsonb_array_elements(d->'dudosa_motivo') m
                where jsonb_typeof(m) <> 'string' or m #>> '{}' not in ('margen', 'cobertura'))
     or (d->>'dudosa')::boolean <> (jsonb_array_length(d->'dudosa_motivo') > 0) then return false; end if;
  -- porcentajes y cobertura, por radio: de 0 a 100
  if jsonb_typeof(d->'pct') <> 'object' or jsonb_typeof(d->'cobertura') <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(d->'pct') x where x <> all (radios))
     or exists (select 1 from jsonb_object_keys(d->'cobertura') x where x <> all (radios)) then return false; end if;
  foreach k in array radios loop
    if not public.estaciones_zona_pcts_ok(coalesce(d->'pct'->k, '{}'::jsonb)) then return false; end if;
    if not public.estaciones_zona_en_rango(d->'cobertura'->k, 0, 100) then return false; end if;
  end loop;
  -- textos: la cita no nula ni vacía; fuente, licencia y fecha, textos cortos
  foreach k in array array['cita', 'fuente', 'licencia', 'calculado_en'] loop
    if jsonb_typeof(d->k) <> 'string' or length(btrim(d->>k)) = 0 or length(d->>k) > 400 then return false; end if;
  end loop;
  if d->>'calculado_en' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' then return false; end if;
  return true;
end $$;

-- void → boolean: si una 0153 vieja ya estuviera aplicada, create or replace no puede cambiar el tipo; se borra antes
-- (los grants se vuelven a dar más abajo).
drop function if exists public.estaciones_fijar_zona(text, text, text, jsonb);
create function public.estaciones_fijar_zona(p_red text, p_estacion_id text, p_zona text, p_detalle jsonb)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  e record;
begin
  if p_zona is null or p_zona not in ('agricola', 'pastizal', 'urbana', 'natural', 'sin_dato') then
    raise exception 'zona inválida';
  end if;
  if not coalesce(public.estaciones_zona_detalle_ok(p_zona, p_detalle), false) then
    raise exception 'detalle inválido';
  end if;
  select es.lat, es.lon, es.metadatos into e from public.estaciones es
   where es.red = p_red and es.estacion_id = p_estacion_id for update;
  if not found then
    raise exception 'estación inexistente';
  end if;
  -- la coordenada del detalle tiene que ser la de la estación (si no, quedaría pendiente para siempre)
  if e.lat is null or e.lon is null
     or abs((p_detalle->>'lat')::numeric - e.lat) > 0.000001 or abs((p_detalle->>'lon')::numeric - e.lon) > 0.000001 then
    raise exception 'la coordenada no es la de la estación';
  end if;
  -- lo que no cambió no se reescribe (--todas): igual zona e igual detalle, salvo la fecha del cálculo
  if e.metadatos->>'zona' is not distinct from p_zona
     and (e.metadatos->'zona_wc') - 'calculado_en' is not distinct from p_detalle - 'calculado_en' then
    return false;
  end if;
  update public.estaciones
     set metadatos = coalesce(metadatos, '{}'::jsonb) || jsonb_build_object('zona', p_zona, 'zona_wc', p_detalle)
   where red = p_red and estacion_id = p_estacion_id;
  -- actualizado_en NO se toca: lo usan los colectores para saber cuándo se refrescó el catálogo.
  return true;
end $$;

comment on function public.estaciones_fijar_zona(text, text, text, jsonb) is
  '257: escribe metadatos.zona y metadatos.zona_wc (ESA WorldCover 2021 v200, CC BY 4.0, Zanaga et al. 2022, doi:10.5281/zenodo.7254221), validado. Nada más. false = no cambió y no se escribió.';

-- En Supabase las funciones nuevas de public quedan ejecutables por anon/authenticated (privilegios por defecto): se saca.
revoke all on function public.estaciones_zona_pendientes(text, boolean) from public, anon, authenticated;
revoke all on function public.estaciones_fijar_zona(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.estaciones_zona_num(jsonb) from public, anon, authenticated;
revoke all on function public.estaciones_zona_pcts_ok(jsonb) from public, anon, authenticated;
revoke all on function public.estaciones_zona_en_rango(jsonb, numeric, numeric) from public, anon, authenticated;
revoke all on function public.estaciones_zona_detalle_ok(text, jsonb) from public, anon, authenticated;

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
