-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · imerg_colector · el relleno de IMERG-Final por celda, desde hn-colectores (público)   [232 · 14/11/2026]
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE DE APLICAR: la aplica local (número de migración: el que siga en hn-agro/migrations al copiarla).
-- ADITIVA: un esquema nuevo `imerg_colector`, 5 funciones y un rol. NO cambia imerg_pp_diario ni imerg_celda_estado
-- (0060) ni lotes (0001); sólo los lee/escribe a través de las funciones (SECURITY DEFINER, dueño = quien aplica).
--
-- Por qué: el relleno en hn-agro (imerg-backfill.yml) tarda ~27 min por celda y el job tiene 120 min: entran 4 y la 5.ª
-- se corta; el 13/11 quedaron 9 celdas en 'pendiente (lazy)' (PASO0-232). Acá el colector público toma UNA celda por
-- vez de la base, la baja y la guarda; si lo cortan, la toma vence a los 90 min y la corrida siguiente la retoma.
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

-- La celda como la calcula la app (imerg-lazy.js · imergCell, coma flotante): Math.round(x) = floor(x + 0.5).
-- NO es la cuenta en numeric del doctor (que en la frontera, p. ej. lon −60,25, da otra celda: _v1681).
create or replace function imerg_colector.celda_js(p_lat float8, p_lon float8, out clat numeric(5,2), out clon numeric(6,2))
language sql immutable parallel safe set search_path = pg_catalog as $$
  select (floor((floor((p_lat + 89.95::float8) / 0.1::float8) * 0.1::float8 - 89.95::float8) * 100::float8 + 0.5::float8) / 100::float8)::numeric(5,2),
         (floor((floor((p_lon + 179.95::float8) / 0.1::float8) * 0.1::float8 - 179.95::float8) * 100::float8 + 0.5::float8) / 100::float8)::numeric(6,2)
$$;

-- Las celdas de lotes ACTIVOS que el colector puede tomar ahora (sin lote activo, no se pide: la baja no entra).
--   · sin fila en imerg_celda_estado (la pregunta B del 13/11: los «sin reserva»);
--   · filas IS NULL y: 'en curso (colectores)' vencida (> 90 min: el run se cortó) · 'fallo (colectores)' de hace
--     > 6 h (la espera ante un error de la NASA) · cualquier otra (la 'pendiente (lazy)' de hn-agro) de hace más de
--     p_espera_lazy_min (180 = «trabada», para no pisarle un run vivo a hn-agro; 0 cuando hn-agro ya no despacha).
create or replace function imerg_colector._candidatas(p_espera_lazy_min integer)
returns table (celda_lat numeric(5,2), celda_lon numeric(6,2), actualizado timestamptz, sin_fila boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with act as (
    select distinct c.clat, c.clon
      from lotes l, lateral imerg_colector.celda_js(l.lat::float8, l.lon::float8) c
     where l.activo = true and l.lat is not null and l.lon is not null)
  select a.clat, a.clon, e.actualizado, (e.celda_lat is null)
    from act a
    left join imerg_celda_estado e on e.celda_lat = a.clat and e.celda_lon = a.clon
   where e.celda_lat is null
      or (e.filas is null and (
            (e.fuente = 'en curso (colectores)' and e.actualizado < now() - interval '90 minutes')
         or (e.fuente = 'fallo (colectores)'    and e.actualizado < now() - interval '6 hours')
         or (e.fuente is distinct from 'en curso (colectores)' and e.fuente is distinct from 'fallo (colectores)'
             and e.actualizado < now() - make_interval(mins => greatest(coalesce(p_espera_lazy_min, 180), 0)))))
   order by (e.celda_lat is null), e.actualizado nulls last, a.clat, a.clon
$$;

-- Cuántas hay para tomar (modo seco y registro: sólo la cantidad).
create or replace function imerg_colector.contar(p_espera_lazy_min integer default 180)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from imerg_colector._candidatas(p_espera_lazy_min)
$$;

-- Toma UNA celda (o ninguna). Nunca dos tomas vivas: si hay una 'en curso (colectores)' de menos de 90 min, no da nada.
-- Anti-spam igual que imerg-lazy: candado global del barrido (_v1681) + candado de la celda (_v1641: el del alta y la
-- baja) + toma condicional (sólo si `actualizado` no cambió desde que se miró y sigue sin serie y con lote activo).
create or replace function imerg_colector.tomar(p_espera_lazy_min integer default 180)
returns table (celda_lat numeric(5,2), celda_lon numeric(6,2))
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare c record; tomadas integer;
begin
  perform pg_advisory_xact_lock(hashtext('imerg:barrido'));
  if exists (select 1 from imerg_celda_estado e where e.filas is null and e.fuente = 'en curso (colectores)'
              and e.actualizado >= now() - interval '90 minutes') then
    return;
  end if;
  for c in select * from imerg_colector._candidatas(p_espera_lazy_min) loop
    perform pg_advisory_xact_lock(hashtext('imerg:' || c.celda_lat::text || ',' || c.celda_lon::text));
    -- bajo el candado de la celda: ¿sigue habiendo un lote activo ahí? (una baja que confirmó recién no entra)
    continue when not exists (select 1 from lotes l, lateral imerg_colector.celda_js(l.lat::float8, l.lon::float8) j
                               where l.activo = true and l.lat is not null and l.lon is not null
                                 and j.clat = c.celda_lat and j.clon = c.celda_lon);
    if c.sin_fila then
      insert into imerg_celda_estado as e (celda_lat, celda_lon, fuente, actualizado)
      values (c.celda_lat, c.celda_lon, 'en curso (colectores)', now())
      on conflict (celda_lat, celda_lon) do nothing;
    else
      update imerg_celda_estado e set fuente = 'en curso (colectores)', actualizado = now()
       where e.celda_lat = c.celda_lat and e.celda_lon = c.celda_lon
         and e.filas is null and e.actualizado is not distinct from c.actualizado;
    end if;
    get diagnostics tomadas = row_count;
    if tomadas > 0 then
      celda_lat := c.celda_lat; celda_lon := c.celda_lon;
      return next;
      return;
    end if;
  end loop;
end $$;

-- Guarda la serie de la celda TOMADA, en una sola transacción (serie + estado). Valida todo: si algo no cierra, no
-- guarda nada. Devuelve las filas guardadas.
create or replace function imerg_colector.guardar(p_lat numeric, p_lon numeric, p_fechas date[], p_mm real[])
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
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
  perform pg_advisory_xact_lock(hashtext('imerg:' || p_lat::numeric(5,2)::text || ',' || p_lon::numeric(6,2)::text));
  perform 1 from imerg_celda_estado e
   where e.celda_lat = p_lat and e.celda_lon = p_lon and e.filas is null and e.fuente = 'en curso (colectores)'
   for update;
  if not found then
    raise exception 'imerg_colector: la celda no está tomada por el colector';
  end if;
  insert into imerg_pp_diario (celda_lat, celda_lon, fecha, pp_mm)
  select p_lat, p_lon, f, mm from unnest(p_fechas, p_mm) t(f, mm)
  on conflict (celda_lat, celda_lon, fecha) do update set pp_mm = excluded.pp_mm;
  update imerg_celda_estado e
     set desde = (select min(f) from unnest(p_fechas) f), hasta = (select max(f) from unnest(p_fechas) f),
         filas = n, fuente = 'GPM_3IMERGDF_07 (Giovanni · colectores)', actualizado = now()
   where e.celda_lat = p_lat and e.celda_lon = p_lon;
  return n;
end $$;

-- Suelta la celda tomada por un error (de la NASA o del parseo): queda 'fallo (colectores)' y se reintenta en 6 h.
create or replace function imerg_colector.soltar(p_lat numeric, p_lon numeric)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext('imerg:' || p_lat::numeric(5,2)::text || ',' || p_lon::numeric(6,2)::text));
  update imerg_celda_estado e set fuente = 'fallo (colectores)', actualizado = now()
   where e.celda_lat = p_lat and e.celda_lon = p_lon and e.filas is null and e.fuente = 'en curso (colectores)';
  return found;
end $$;

-- Las funciones nacen con EXECUTE para PUBLIC: se le saca a todos y se le da sólo al rol.
revoke all on function imerg_colector.celda_js(float8, float8) from public;
revoke all on function imerg_colector._candidatas(integer) from public;
revoke all on function imerg_colector.contar(integer) from public;
revoke all on function imerg_colector.tomar(integer) from public;
revoke all on function imerg_colector.guardar(numeric, numeric, date[], real[]) from public;
revoke all on function imerg_colector.soltar(numeric, numeric) from public;

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
--   select * from imerg_colector._candidatas(0);    -- ERROR: permission denied
--   reset role;
--   select has_function_privilege('anon', 'imerg_colector.tomar(integer)', 'execute');   -- false

-- ROLLBACK (comentado a propósito; las filas ya bajadas quedan, son las mismas que bajaba hn-agro):
-- update imerg_celda_estado set fuente = 'pendiente (lazy)' where filas is null and fuente in ('en curso (colectores)', 'fallo (colectores)');
-- drop schema imerg_colector cascade;
-- drop role colector_imerg;
