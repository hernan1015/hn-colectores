-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0154 · la MEDICIÓN DIARIA de la app contra las estaciones (260): la tabla medicion_app_estacion, la
--                  lectura recortada de estaciones_obs y el rol `medicion_app`                      [15/11/2026 · 260]
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA · NO APLICADA. La revisa y la aplica local. El número: 0150 es de la 176, 0151 de la 139 SMN, 0152 la
--   unificada del parseo (PR #13) y 0153 la zona de la 257; ninguna rama de hn-agro ni de hn-colectores tiene otra
--   0154 (git ls-tree de todas las ramas, 15/11 14:17). Si al aplicarla ya está tomada, renumerar.
--   Va DESPUÉS de la 0147 (columnas de la noche y el muestreo), la 0147b (prende la RLS de registro_procesos) y la
--   0152. No necesita la 0153: sin zona, la estación cuenta como sin_dato.
--   El archivo vive en hn-colectores (medicion-app/migracion/); local lo copia a hn-agro/migrations/.
--
-- El sello del criterio: hn-cortex docs/mejora-continua/260-medicion/SELLO.json (regla m1), sellado ANTES de medir.
--
-- POR QUÉ ASÍ (el job corre en Actions de un repo PÚBLICO: si roban la clave, que no sirva para nada más):
--   · LEER: el rol no tiene ningún permiso sobre estaciones ni estaciones_obs. Lee por UNA función SECURITY DEFINER,
--     medicion_app_obs(fecha), que devuelve sólo lo que hace falta de las filas de `fecha` y `fecha + 1`: red, id,
--     coordenada, la zona (metadatos->>'zona', nada más de metadatos), las columnas de temperatura y conteos y las
--     lecturas del crudo. No devuelve nombres, ni el resto de metadatos, ni la lluvia, ni otra tabla.
--   · ESCRIBIR: sólo su tabla (select, insert, update; sin delete) y renglones de registro_procesos con su proceso.
--   · LOGIN con CONNECTION LIMIT 2, sin BYPASSRLS. La clave llega por psql como verificador SCRAM (igual que la 0147b
--     y la 0153; ver sipan-alto-valle/migracion/scram.mjs):
--       VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)
--       psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f 0154_medicion_app_PROPUESTA.sql
--   ⛔ INTERNO: la tabla es un dato interno (sale de estaciones con mostrar = false). RLS sin políticas para anon ni
--   authenticated: el navegador no ve nada. NO se muestra nada en pantalla (la vista por lote es una propuesta futura).
-- Idempotente.
-- ════════════════════════════════════════════════════════════════════════════

-- 0. Lo que tiene que estar antes ─────────────────────────────────────────────
do $$
begin
  if to_regclass('public.estaciones_obs') is null or to_regclass('public.registro_procesos') is null then
    raise exception '0154: faltan estaciones_obs o registro_procesos (0110 y 0075)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'estaciones_obs' and column_name = 'tmin_noche_c') then
    raise exception '0154: falta la 0147 (estaciones_obs.tmin_noche_c)';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.registro_procesos'::regclass) then
    raise exception '0154: registro_procesos sin RLS (aplicar antes la 0147b): sin RLS la política del proceso no rige';
  end if;
  if current_user in ('anon', 'authenticated', 'service_role', 'medicion_app', 'colector_estaciones') then
    raise exception '0154: aplicala como postgres, no como %', current_user;
  end if;
end $$;

-- 1. La tabla ─────────────────────────────────────────────────────────────────
create table if not exists public.medicion_app_estacion (
  red              text         not null,
  estacion_id      text         not null,
  fecha            date         not null,   -- la víspera: máxima y HR de ese día; la noche EMPIEZA esa tarde (18 h) y
                                            -- termina a las 09 h de fecha + 1 (= estaciones_obs.tmin_noche_c de fecha + 1)
  regla            text         not null,   -- 'm1' (SELLO 260)
  zona             text         not null,   -- la de la 257 al medir (sin zona: sin_dato)
  region           text         not null,   -- las cajas del sello
  lat              numeric      not null,   -- el punto pedido (4 decimales)
  lon              numeric      not null,
  noche_est_c      numeric,  noche_app_c  numeric,  noche_dif_c  numeric,   -- dif = app − estación, sólo si noche_ok
  noche_registros  smallint, noche_esperados smallint,
  noche_ok         boolean      not null,
  tmax_est_c       numeric,  tmax_app_c   numeric,  tmax_dif_c   numeric,
  dia_registros    smallint, dia_esperados smallint,
  tmax_ok          boolean      not null,
  hr_est_pct       numeric,  hr_app_pct   numeric,  hr_dif_pp    numeric,
  hr_lecturas      smallint,
  hr_ok            boolean      not null,
  muestreo_min     smallint,
  motivos          text[]       not null default '{}',   -- por qué una variable no vale (noche_pocas_lecturas, …)
  app              jsonb        not null default '{}'::jsonb,   -- { modelo: 'best_match', celda: { lat, lon, elevacion } }
  medido_en        timestamptz  not null default now(),
  primary key (red, estacion_id, fecha, regla),
  foreign key (red, estacion_id) references public.estaciones (red, estacion_id),
  constraint mae_regla   check (regla ~ '^m[0-9]+$'),
  constraint mae_zona    check (zona in ('agricola', 'pastizal', 'urbana', 'natural', 'sin_dato')),
  constraint mae_region  check (region in ('patagonia', 'noa', 'nea', 'cuyo', 'pampa_norte', 'pampa_sur')),
  constraint mae_lat     check (lat between -90 and 90),
  constraint mae_lon     check (lon between -180 and 180),
  constraint mae_temps   check ((noche_est_c is null or (noche_est_c > -40 and noche_est_c < 60)) and (noche_app_c is null or (noche_app_c > -60 and noche_app_c < 70))
                            and (tmax_est_c is null or (tmax_est_c > -40 and tmax_est_c < 60)) and (tmax_app_c is null or (tmax_app_c > -60 and tmax_app_c < 70))),
  constraint mae_hr      check ((hr_est_pct is null or hr_est_pct between 0 and 100) and (hr_app_pct is null or hr_app_pct between 0 and 100)),
  -- la diferencia existe SÓLO si la variable vale, y es app − estación
  constraint mae_noche   check (case when noche_ok then noche_est_c is not null and noche_app_c is not null and noche_dif_c is not null
                                                       and abs(noche_dif_c - (noche_app_c - noche_est_c)) < 0.006
                                     else noche_dif_c is null end),
  constraint mae_tmax    check (case when tmax_ok then tmax_est_c is not null and tmax_app_c is not null and tmax_dif_c is not null
                                                      and abs(tmax_dif_c - (tmax_app_c - tmax_est_c)) < 0.006
                                     else tmax_dif_c is null end),
  constraint mae_hr_ok   check (case when hr_ok then hr_est_pct is not null and hr_app_pct is not null and hr_dif_pp is not null
                                                    and abs(hr_dif_pp - (hr_app_pct - hr_est_pct)) < 0.006
                                     else hr_dif_pp is null end),
  constraint mae_app_tam check (octet_length(app::text) <= 1000),
  constraint mae_motivos check (cardinality(motivos) <= 30)
);
comment on table public.medicion_app_estacion is
  'Interna (260): por estación y día, la mínima nocturna (18-09), la máxima y la HR media de la estación contra Open-Meteo best_match horario en el mismo punto (lo que muestra la app). Regla y umbrales en el SELLO 260 (m1). RLS sin políticas para anon/authenticated.';
create index if not exists medicion_app_estacion_fecha_idx on public.medicion_app_estacion (fecha, regla);
alter table public.medicion_app_estacion enable row level security;
revoke all on table public.medicion_app_estacion from public, anon, authenticated;

-- 2. La lectura recortada ─────────────────────────────────────────────────────
create or replace function public.medicion_app_obs(p_fecha date)
returns table (red text, estacion_id text, lat double precision, lon double precision, zona text, fecha date,
               tmin_noche_c numeric, noche_registros smallint, noche_esperados smallint, tmax_c numeric,
               registros_validos smallint, registros_esperados smallint, muestreo_min smallint, lecturas jsonb)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select o.red, o.estacion_id, e.lat::float8, e.lon::float8,
         case when jsonb_typeof(e.metadatos->'zona') = 'string' then e.metadatos->>'zona' end,
         o.fecha, o.tmin_noche_c, o.noche_registros, o.noche_esperados, o.tmax_c, o.registros_validos,
         o.registros_esperados, o.muestreo_min,
         case when jsonb_typeof(o.crudo->'lecturas') = 'array' then o.crudo->'lecturas' end
    from public.estaciones_obs o
    join public.estaciones e on e.red = o.red and e.estacion_id = o.estacion_id
   where p_fecha is not null and o.fecha in (p_fecha, p_fecha + 1)
     and e.lat is not null and e.lon is not null
     and (o.tmin_noche_c is not null or o.tmax_c is not null or jsonb_typeof(o.crudo->'lecturas') = 'array')
   order by o.red, o.estacion_id, o.fecha
$$;
revoke all on function public.medicion_app_obs(date) from public, anon, authenticated;

-- 3. El rol ───────────────────────────────────────────────────────────────────
select 'create role medicion_app login nocreatedb nocreaterole noinherit connection limit 2'
 where not exists (select 1 from pg_roles where rolname = 'medicion_app') \gexec
alter role medicion_app with login nocreatedb nocreaterole noinherit connection limit 2
  password :'clave';
do $$
declare r record;
begin
  select rolsuper, rolreplication, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolconnlimit
    into r from pg_roles where rolname = 'medicion_app';
  if r.rolsuper or r.rolreplication or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolinherit then
    raise exception 'medicion_app tiene atributos de más: no se sigue';
  end if;
  if not r.rolcanlogin or r.rolconnlimit <> 2 then
    raise exception 'medicion_app quedó sin LOGIN o sin CONNECTION LIMIT 2';
  end if;
end $$;

grant usage on schema public to medicion_app;
grant execute on function public.medicion_app_obs(date) to medicion_app;
-- su tabla: upsert (on conflict … do update necesita select). Sin DELETE.
grant select, insert, update on table public.medicion_app_estacion to medicion_app;
-- registro_procesos: sólo agregar renglones de SU proceso (bigserial: hace falta la secuencia). Ni leer ni cambiar.
grant insert on table public.registro_procesos to medicion_app;
grant usage on sequence public.registro_procesos_id_seq to medicion_app;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'medicion_app_estacion' and policyname = 'medicion_app_su_tabla') then
    create policy medicion_app_su_tabla on public.medicion_app_estacion for all to medicion_app using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'registro_procesos' and policyname = 'medicion_app_su_proceso') then
    create policy medicion_app_su_proceso on public.registro_procesos for insert to medicion_app with check (proceso = 'medicion_app');
  end if;
end $$;
-- Ningún grant sobre estaciones ni estaciones_obs.

-- Verificación (a mano, después de aplicar):
--   set role medicion_app;      -- (si da «permission denied to set role»: grant medicion_app to postgres; … ; revoke)
--   select count(*) from medicion_app_obs(current_date - 1);             -- n > 0 si el parseo ya corrió
--   select count(*) from estaciones;                                      -- ERROR: permission denied
--   select count(*) from estaciones_obs;                                  -- ERROR: permission denied
--   insert into registro_procesos (proceso, ok) values ('otro', true);   -- ERROR: viola la política
--   delete from medicion_app_estacion;                                    -- ERROR: permission denied
--   reset role;
-- Consulta de uso (ejemplo, como postgres): el error de la app de noche por zona, la última semana
--   select zona, count(*), round(avg(noche_dif_c), 2) sesgo, round(avg(abs(noche_dif_c)), 2) mae
--     from medicion_app_estacion where regla = 'm1' and noche_ok and fecha > current_date - 8 group by 1 order by 1;

-- ROLLBACK (comentado a propósito):
-- drop policy if exists medicion_app_su_proceso on public.registro_procesos;
-- drop policy if exists medicion_app_su_tabla on public.medicion_app_estacion;
-- revoke all on function public.medicion_app_obs(date) from medicion_app;
-- revoke all on public.medicion_app_estacion, public.registro_procesos from medicion_app;
-- revoke usage on sequence public.registro_procesos_id_seq from medicion_app;
-- drop function if exists public.medicion_app_obs(date);
-- drop table if exists public.medicion_app_estacion;
-- drop role if exists medicion_app;
