-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · imerg_colector · el relleno de IMERG-Final por celda, desde hn-colectores (público)   [232 · 14/11/2026]
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE DE APLICAR: la aplica local (número de migración: el que siga en hn-agro/migrations al copiarla).
-- ADITIVA: un esquema nuevo `imerg_colector` con una tabla propia (`tomas`), 5 funciones y un rol. NO cambia
-- imerg_pp_diario ni imerg_celda_estado (0060) ni lotes (0001); sólo los lee/escribe a través de las funciones
-- (SECURITY DEFINER, dueño = quien aplica).
--
-- Por qué: el relleno en hn-agro (imerg-backfill.yml) tarda ~27 min por celda y el job tiene 120 min: entran 4 y la 5.ª
-- se corta; el 13/11 quedaron 9 celdas en 'pendiente (lazy)' (PASO0-232). Acá el colector público toma UNA celda por
-- vez de la base, la baja y la guarda; si algo sale mal, la base la retiene y una corrida de horas después la retoma
-- sola.
--
-- 2.ª VUELTA (NO ENTRA de Codex, n3-232-1411): LOS LÍMITES VIVEN EN LA BASE, no en el workflow ni en el parámetro.
--   Constantes fijas de las funciones (cambiarlas es una migración nueva, no una variable):
--     · espera mínima sobre la reserva de la app ('pendiente (lazy)' y cualquier otra que no sea del colector): 180 min,
--       aunque se pida menos (tomar(0) da lo mismo que tomar(180));
--     · nunca dos tomas vivas (una toma abierta de menos de 90 min frena todo);
--     · como mucho 2 tomas por hora (ventana móvil de 60 min), cualquiera sea el resultado;
--     · cada toma graba AL TOMARSE un «no antes de» = ahora + 8 h (6 h de espera + los 100 min del job: el peor caso
--       del último pedido a la NASA de esa toma). Si la serie no queda COMPLETA, la celda no se vuelve a dar antes
--       de esa hora, aunque `soltar` no llegue nunca. Por cada toma no completa de la celda en los últimos 7 días, la
--       espera se duplica (8 → 16 → 32 → 64 → 128 h; tope 7 días): una celda que la NASA no da no se pide en bucle;
--     · `guardar` sólo da por completa la serie desde 2000-06-01 hasta al menos 2025-09-30 (lo último que trae Giovanni
--       al 13/11: 9253 días), con 30 días faltantes de tolerancia. Si no, no escribe la lluvia y deja la celda
--       'parcial (colectores)' (filas NULL), retenida hasta su «no antes de».
--   La tabla `imerg_colector.tomas` es del colector: la app no la toca. Aunque hn-agro borre o renueve la fila de
--   imerg_celda_estado, la espera del colector sigue en pie.
--   search_path de todas las funciones = pg_catalog, pg_temp, con TODO calificado (public.…, imerg_colector.…): una
--   tabla temporal del rol no puede hacerse pasar por lotes ni por imerg_celda_estado.
--
-- El rol `colector_imerg` NO tiene permiso sobre ninguna tabla: sólo EXECUTE sobre 4 funciones de un esquema que
-- PostgREST no expone. No ve lotes, nombres ni puntos: sólo el centro de la celda (0,1°, ~11 km) que le toca.
--
-- ⛔ LA CONTRASEÑA NO ESTÁ EN ESTE ARCHIVO (igual que la 0147b): llega su verificador SCRAM por la variable de psql
--   `clave` →  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f imerg_colector.sql
--   (VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)). Sin -v clave, la sentencia da error y no
--   se aplica nada más. Idempotente.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists imerg_colector;
revoke all on schema imerg_colector from public;

-- Las tomas del colector: una fila por toma. La escriben sólo tomar, guardar y soltar (el rol no tiene permiso).
create table if not exists imerg_colector.tomas (
  id          bigint generated always as identity primary key,
  celda_lat   numeric(5,2) not null,
  celda_lon   numeric(6,2) not null,
  tomada      timestamptz  not null default now(),
  no_antes_de timestamptz  not null,                 -- la celda no se vuelve a dar antes de esto (si no quedó completa)
  cerrada     timestamptz,
  resultado   text check (resultado in ('completa', 'parcial', 'fallo')));
create index if not exists tomas_celda  on imerg_colector.tomas (celda_lat, celda_lon, no_antes_de);
create index if not exists tomas_tomada on imerg_colector.tomas (tomada);
alter table imerg_colector.tomas enable row level security;     -- sin políticas: sólo el dueño (las funciones)
revoke all on table imerg_colector.tomas from public;

-- La celda como la calcula la app (imerg-lazy.js · imergCell, coma flotante): Math.round(x) = floor(x + 0.5).
-- NO es la cuenta en numeric del doctor (que en la frontera, p. ej. lon −60,25, da otra celda: _v1681).
create or replace function imerg_colector.celda_js(p_lat float8, p_lon float8, out clat numeric(5,2), out clon numeric(6,2))
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select (floor((floor((p_lat + 89.95::float8) / 0.1::float8) * 0.1::float8 - 89.95::float8) * 100::float8 + 0.5::float8) / 100::float8)::numeric(5,2),
         (floor((floor((p_lon + 179.95::float8) / 0.1::float8) * 0.1::float8 - 179.95::float8) * 100::float8 + 0.5::float8) / 100::float8)::numeric(6,2)
$$;

-- Las celdas de lotes ACTIVOS que el colector puede tomar ahora (sin lote activo, no se pide: la baja no entra).
--   · ninguna con una toma del colector cuyo «no antes de» no pasó (lo manda la tabla tomas, no la fila de la app);
--   · sin fila en imerg_celda_estado (la pregunta B del 13/11: los «sin reserva»);
--   · filas IS NULL y: una fila del colector ('en curso', 'fallo' o 'parcial (colectores)': su espera ya la juzgó
--     la tabla tomas) · cualquier otra (la 'pendiente (lazy)' de hn-agro) de hace más de
--     max(p_espera_lazy_min, 180): el mínimo de 180 es FIJO, para no pisarle nunca una reserva fresca a la app.
create or replace function imerg_colector._candidatas(p_espera_lazy_min integer)
returns table (celda_lat numeric(5,2), celda_lon numeric(6,2), actualizado timestamptz, sin_fila boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with act as (
    select distinct c.clat, c.clon
      from public.lotes l, lateral imerg_colector.celda_js(l.lat::float8, l.lon::float8) c
     where l.activo = true and l.lat is not null and l.lon is not null)
  select a.clat, a.clon, e.actualizado, (e.celda_lat is null)
    from act a
    left join public.imerg_celda_estado e on e.celda_lat = a.clat and e.celda_lon = a.clon
   where not exists (select 1 from imerg_colector.tomas t
                      where t.celda_lat = a.clat and t.celda_lon = a.clon and t.no_antes_de > now())
     and (e.celda_lat is null
      or (e.filas is null and (
            e.fuente in ('en curso (colectores)', 'fallo (colectores)', 'parcial (colectores)')
         or e.actualizado < now() - make_interval(mins => greatest(coalesce(p_espera_lazy_min, 180), 180)))))
   order by (e.celda_lat is null), e.actualizado nulls last, a.clat, a.clon
$$;

-- Cuántas hay para tomar (modo seco y registro: sólo la cantidad).
create or replace function imerg_colector.contar(p_espera_lazy_min integer default 180)
returns integer language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select count(*)::int from imerg_colector._candidatas(p_espera_lazy_min)
$$;

-- Toma UNA celda (o ninguna) y devuelve su «no antes de». Límites fijos, bajo el candado global del barrido:
-- nunca dos tomas vivas, como mucho 2 por hora. Anti-spam igual que imerg-lazy: candado global (_v1681) + candado de
-- la celda (_v1641: el del alta y la baja) + toma condicional (sólo si `actualizado` no cambió desde que se miró y
-- sigue sin serie y con lote activo).
create or replace function imerg_colector.tomar(p_espera_lazy_min integer default 180)
returns table (celda_lat numeric(5,2), celda_lon numeric(6,2), no_antes_de timestamptz)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
#variable_conflict use_column
declare c record; tomadas integer; previas integer; v_hasta timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('imerg:barrido'));
  if exists (select 1 from imerg_colector.tomas t
              where t.cerrada is null and t.tomada > now() - interval '90 minutes') then
    return;                                                     -- una toma viva: no se da otra
  end if;
  if (select count(*) from imerg_colector.tomas t where t.tomada > now() - interval '1 hour') >= 2 then
    return;                                                     -- tope fijo: 2 tomas por hora
  end if;
  delete from imerg_colector.tomas t where t.tomada < now() - interval '30 days' and t.no_antes_de < now();
  for c in select * from imerg_colector._candidatas(p_espera_lazy_min) loop
    perform pg_advisory_xact_lock(hashtext('imerg:' || c.celda_lat::text || ',' || c.celda_lon::text));
    -- bajo el candado de la celda: ¿sigue habiendo un lote activo ahí? (una baja que confirmó recién no entra)
    continue when not exists (select 1 from public.lotes l, lateral imerg_colector.celda_js(l.lat::float8, l.lon::float8) j
                               where l.activo = true and l.lat is not null and l.lon is not null
                                 and j.clat = c.celda_lat and j.clon = c.celda_lon);
    -- (el «no antes de» ya lo filtró _candidatas: las tomas sólo se crean acá, bajo el candado global, y guardar/soltar
    --  nunca lo acortan)
    if c.sin_fila then
      insert into public.imerg_celda_estado as e (celda_lat, celda_lon, fuente, actualizado)
      values (c.celda_lat, c.celda_lon, 'en curso (colectores)', now())
      on conflict (celda_lat, celda_lon) do nothing;
    else
      update public.imerg_celda_estado e set fuente = 'en curso (colectores)', actualizado = now()
       where e.celda_lat = c.celda_lat and e.celda_lon = c.celda_lon
         and e.filas is null and e.actualizado is not distinct from c.actualizado;
    end if;
    get diagnostics tomadas = row_count;
    if tomadas > 0 then
      select count(*) into previas from imerg_colector.tomas t
       where t.celda_lat = c.celda_lat and t.celda_lon = c.celda_lon
         and t.tomada > now() - interval '7 days' and t.resultado is distinct from 'completa';
      v_hasta := now() + least(interval '8 hours' * (2 ^ least(previas, 5)), interval '7 days');
      insert into imerg_colector.tomas (celda_lat, celda_lon, tomada, no_antes_de)
      values (c.celda_lat, c.celda_lon, now(), v_hasta);
      celda_lat := c.celda_lat; celda_lon := c.celda_lon; no_antes_de := v_hasta;
      return next;
      return;
    end if;
  end loop;
end $$;

-- Guarda la serie de la celda TOMADA (toma abierta y viva), en una sola transacción (serie + estado + toma). Valida
-- todo: si algo no cierra, no guarda nada. Devuelve las filas guardadas si la serie quedó COMPLETA; si no cubre el
-- rango esperado devuelve 0, no escribe la lluvia y deja la celda 'parcial (colectores)' hasta su «no antes de».
create or replace function imerg_colector.guardar(p_lat numeric, p_lon numeric, p_fechas date[], p_mm real[])
returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare n integer; v_lat numeric(5,2); v_lon numeric(6,2); v_toma bigint; v_desde date; v_hasta date;
begin
  n := coalesce(array_length(p_fechas, 1), 0);
  if n = 0 or n <> coalesce(array_length(p_mm, 1), -1) or n > 20000 then
    raise exception 'imerg_colector: serie inválida (largos %/%)', n, coalesce(array_length(p_mm, 1), 0);
  end if;
  if exists (select 1 from unnest(p_fechas, p_mm) t(f, mm)
              where f is null or mm is null or mm < 0 or mm > 2000
                 or f < date '2000-06-01' or f > current_date) then
    raise exception 'imerg_colector: serie con valores fuera de rango';
  end if;
  if (select count(distinct f) from unnest(p_fechas) f) <> n then
    raise exception 'imerg_colector: fechas repetidas';
  end if;
  v_lat := p_lat; v_lon := p_lon;
  if v_lat is distinct from p_lat or v_lon is distinct from p_lon then
    raise exception 'imerg_colector: celda inválida';
  end if;
  perform pg_advisory_xact_lock(hashtext('imerg:' || v_lat::text || ',' || v_lon::text));
  select t.id into v_toma from imerg_colector.tomas t
   where t.celda_lat = v_lat and t.celda_lon = v_lon and t.cerrada is null and t.tomada > now() - interval '90 minutes'
   order by t.tomada desc limit 1 for update;
  perform 1 from public.imerg_celda_estado e
   where e.celda_lat = v_lat and e.celda_lon = v_lon and e.filas is null and e.fuente = 'en curso (colectores)'
   for update;
  if v_toma is null or not found then
    raise exception 'imerg_colector: la celda no está tomada por el colector';
  end if;
  select min(f), max(f) into v_desde, v_hasta from unnest(p_fechas) f;
  -- COMPLETA: desde el inicio fijo, hasta lo último que da Giovanni (2025-09-30 al 13/11), con 30 días de tolerancia.
  if not (v_desde = date '2000-06-01' and v_hasta >= date '2025-09-30' and n >= (v_hasta - v_desde + 1) - 30) then
    update public.imerg_celda_estado e set fuente = 'parcial (colectores)', actualizado = now()
     where e.celda_lat = v_lat and e.celda_lon = v_lon;
    update imerg_colector.tomas t set cerrada = now(), resultado = 'parcial' where t.id = v_toma;
    return 0;
  end if;
  insert into public.imerg_pp_diario (celda_lat, celda_lon, fecha, pp_mm)
  select v_lat, v_lon, f, mm from unnest(p_fechas, p_mm) t(f, mm)
  on conflict (celda_lat, celda_lon, fecha) do update set pp_mm = excluded.pp_mm;
  update public.imerg_celda_estado e
     set desde = v_desde, hasta = v_hasta, filas = n, fuente = 'GPM_3IMERGDF_07 (Giovanni · colectores)', actualizado = now()
   where e.celda_lat = v_lat and e.celda_lon = v_lon;
  update imerg_colector.tomas t set cerrada = now(), resultado = 'completa' where t.id = v_toma;
  return n;
end $$;

-- Suelta la celda tomada por un error (de la NASA o del parseo): cierra la toma como 'fallo' (su «no antes de» nunca
-- se acorta: queda el mayor entre el de la toma y ahora + 6 h) y la fila queda 'fallo (colectores)'. Si soltar no
-- llega, la espera igual está grabada desde la toma.
create or replace function imerg_colector.soltar(p_lat numeric, p_lon numeric)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_lat numeric(5,2); v_lon numeric(6,2); k integer;
begin
  v_lat := p_lat; v_lon := p_lon;
  if v_lat is distinct from p_lat or v_lon is distinct from p_lon then
    raise exception 'imerg_colector: celda inválida';
  end if;
  perform pg_advisory_xact_lock(hashtext('imerg:' || v_lat::text || ',' || v_lon::text));
  update imerg_colector.tomas t
     set cerrada = now(), resultado = 'fallo', no_antes_de = greatest(t.no_antes_de, now() + interval '6 hours')
   where t.celda_lat = v_lat and t.celda_lon = v_lon and t.cerrada is null;
  get diagnostics k = row_count;
  update public.imerg_celda_estado e set fuente = 'fallo (colectores)', actualizado = now()
   where e.celda_lat = v_lat and e.celda_lon = v_lon and e.filas is null and e.fuente = 'en curso (colectores)';
  return k > 0;
end $$;

-- Las funciones nacen con EXECUTE para PUBLIC: se le saca a todos y se le da sólo al rol.
revoke all on function imerg_colector.celda_js(float8, float8) from public;
revoke all on function imerg_colector._candidatas(integer) from public;
revoke all on function imerg_colector.contar(integer) from public;
revoke all on function imerg_colector.tomar(integer) from public;
revoke all on function imerg_colector.guardar(numeric, numeric, date[], real[]) from public;
revoke all on function imerg_colector.soltar(numeric, numeric) from public;
-- Y por si hay privilegios por defecto que se los dan directo a los roles de la API (Supabase): se les saca todo.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all functions in schema imerg_colector from %I', r);
      execute format('revoke all on all tables in schema imerg_colector from %I', r);
      execute format('revoke all on schema imerg_colector from %I', r);
    end if;
  end loop;
end $$;

-- El rol (como la 0147b: LOGIN, sin BYPASSRLS ni SUPER ni REPLICATION, CONNECTION LIMIT 2, NOINHERIT).
select 'create role colector_imerg login nocreatedb nocreaterole noinherit connection limit 2'
 where not exists (select 1 from pg_roles where rolname = 'colector_imerg') \gexec
alter role colector_imerg with login nocreatedb nocreaterole noinherit connection limit 2
  password :'clave';
do $$
declare r record;
begin
  select rolsuper, rolreplication, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolconnlimit
    into r from pg_roles where rolname = 'colector_imerg';
  if r.rolsuper or r.rolreplication or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolinherit then
    raise exception 'colector_imerg tiene atributos de más: no se sigue (borrar el rol y volver a correr)';
  end if;
  if not r.rolcanlogin or r.rolconnlimit <> 2 then
    raise exception 'colector_imerg quedó sin LOGIN o sin CONNECTION LIMIT 2';
  end if;
end $$;

grant usage on schema imerg_colector to colector_imerg;
grant execute on function imerg_colector.contar(integer) to colector_imerg;
grant execute on function imerg_colector.tomar(integer) to colector_imerg;
grant execute on function imerg_colector.guardar(numeric, numeric, date[], real[]) to colector_imerg;
grant execute on function imerg_colector.soltar(numeric, numeric) to colector_imerg;

-- Verificación (a mano, después de aplicar):
--   set role colector_imerg;                        (si da «permission denied to set role»: ver la 0147b)
--   select imerg_colector.contar(180);              -- un número
--   select count(*) from lotes;                     -- ERROR: permission denied
--   select count(*) from imerg_celda_estado;        -- ERROR: permission denied
--   select count(*) from imerg_colector.tomas;      -- ERROR: permission denied
--   select * from imerg_colector._candidatas(0);    -- ERROR: permission denied
--   reset role;
--   select has_function_privilege('anon', 'imerg_colector.tomar(integer)', 'execute');   -- false
--   select proname, proconfig from pg_proc where pronamespace = 'imerg_colector'::regnamespace;
--     -- todas: {"search_path=pg_catalog, pg_temp"}

-- ROLLBACK (comentado a propósito; las filas ya bajadas quedan, son las mismas que bajaba hn-agro):
-- update imerg_celda_estado set fuente = 'pendiente (lazy)'
--  where filas is null and fuente in ('en curso (colectores)', 'fallo (colectores)', 'parcial (colectores)');
-- drop schema imerg_colector cascade;
-- drop role colector_imerg;
