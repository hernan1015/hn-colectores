-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0147b · el rol propio del colector de estaciones (SIPAN y, después, WeatherLink público)   [13/11/2026]
--                   PLAN B: Postgres directo por el pooler (sin PostgREST ni JWT)
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE DE APLICAR: la aplica local, DESPUÉS de la 0147 (necesita pronostico_helada_medicion).
-- Por qué un rol propio: el colector corre en Actions de un repo PÚBLICO. Con la clave de servicio o el usuario
-- postgres, quien los robe tiene TODA la base. Con este rol sólo puede: leer y escribir las filas de SUS redes en
-- estaciones / estaciones_obs / pronostico_helada_medicion, y agregar renglones a registro_procesos con SUS procesos.
-- Nada más: no borra, no lee otras tablas, no ve las filas del SNIH ni ningún dato de usuarios.
--
-- Por qué Postgres directo (13/11, con el maker): el proyecto firma los JWT con ECC (P-256) y la HS256 legada quedó
-- sólo como «usada anteriormente»: un JWT propio firmado con ella se cae sin aviso el día que se revoque.
-- Entonces el rol es LOGIN (con contraseña), SIN BYPASSRLS y con CONNECTION LIMIT 3, y el colector entra por el pooler
-- de Supabase en modo transacción (6543) con un solo secreto, SIPAN_PG_URL:
--   postgresql://colector_estaciones.<ref>:<clave>@<host-del-pooler>:6543/postgres
--
-- ⛔ LA CONTRASEÑA NO ESTÁ EN ESTE ARCHIVO. Llega por la variable de psql `clave`, y lo que llega NO es la clave en
--   texto: es su verificador SCRAM-SHA-256 (migracion/scram.mjs), para que la clave tampoco quede en el log de
--   sentencias de la base. Por eso este archivo se aplica con psql (no con el editor SQL ni el MCP, que no tienen
--   variables):  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f 0147b_rol_colector_estaciones.sql
--   Sin `-v clave=…`, psql deja «:'clave'» sin reemplazar, la sentencia da error de sintaxis y (con ON_ERROR_STOP)
--   no se aplica nada más. Ver PRENDER.md, pasos 2 y 3.
--
-- Idempotente (se puede volver a correr para cambiar la contraseña). RLS: las tablas de la 0110/0147 tienen RLS SIN
-- políticas (nadie ve nada salvo el server, que la saltea). Este rol NO la saltea: por eso van políticas, sólo para
-- él, recortadas a sus redes y procesos.
-- ════════════════════════════════════════════════════════════════════════════

-- El rol: se crea si no existe y SIEMPRE se le fijan los atributos (también si ya existía de la versión NOLOGIN).
-- ⚠ PG16+: nombrar SUPERUSER/NOSUPERUSER en CREATE o ALTER ROLE exige ser superusuario, y REPLICATION/BYPASSRLS
--   (aunque sea para negarlos) exige tenerlos; en Supabase `postgres` NO es superusuario. Por eso esos tres atributos
--   NO se nombran (en un rol nuevo ya nacen en false) y se VERIFICAN abajo: si alguno da true, la migración aborta.
select 'create role colector_estaciones login nocreatedb nocreaterole noinherit connection limit 3'
 where not exists (select 1 from pg_roles where rolname = 'colector_estaciones') \gexec
alter role colector_estaciones with login nocreatedb nocreaterole noinherit connection limit 3
  password :'clave';
do $$
declare r record;
begin
  select rolsuper, rolreplication, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolconnlimit
    into r from pg_roles where rolname = 'colector_estaciones';
  if r.rolsuper or r.rolreplication or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolinherit then
    raise exception 'colector_estaciones tiene atributos de más (super=%, replication=%, bypassrls=%, createrole=%, createdb=%, inherit=%): no se sigue; sacárselos con un superusuario o borrar el rol y volver a correr',
      r.rolsuper, r.rolreplication, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolinherit;
  end if;
  if not r.rolcanlogin or r.rolconnlimit <> 3 then
    raise exception 'colector_estaciones quedó sin LOGIN o sin CONNECTION LIMIT 3';
  end if;
end $$;
-- Por si se aplicó antes la versión de PostgREST (NOLOGIN + JWT): ya no hace falta que `authenticator` lo use.
do $$
begin
  if exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles a on a.oid = m.member
              where r.rolname = 'colector_estaciones' and a.rolname = 'authenticator') then
    revoke colector_estaciones from authenticator;
    /* desde PG16 el REVOKE sólo saca lo que otorgó el mismo usuario: si lo otorgó otro, queda y se avisa */
    if exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles a on a.oid = m.member
                where r.rolname = 'colector_estaciones' and a.rolname = 'authenticator') then
      raise warning 'authenticator sigue siendo miembro de colector_estaciones (lo otorgó otro usuario): sacarlo a mano con ese usuario';
    end if;
  end if;
end $$;

grant usage on schema public to colector_estaciones;

-- estaciones: leer (la firma del formato y el último registro guardados) y alta/actualización (upsert). Sin DELETE.
grant select, insert, update on table estaciones to colector_estaciones;
-- estaciones_obs: leer lo ya guardado del día (para no pisar un día más completo) y upsert. Sin DELETE.
grant select, insert, update on table estaciones_obs to colector_estaciones;
-- pronostico_helada_medicion (0147): upsert de la medición diaria. Sin DELETE.
grant select, insert, update on table pronostico_helada_medicion to colector_estaciones;
-- registro_procesos: sólo agregar renglones (el id es bigserial: hace falta la secuencia). Ni leer ni cambiar.
grant insert on table registro_procesos to colector_estaciones;
grant usage on sequence registro_procesos_id_seq to colector_estaciones;

-- Las políticas (sólo para este rol). Las redes que puede tocar: INTA_SIPAN_AV y WEATHERLINK_PUB.
do $$
declare t text;
begin
  foreach t in array array['estaciones', 'estaciones_obs', 'pronostico_helada_medicion'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'colector_estaciones_sus_redes') then
      execute format(
        'create policy colector_estaciones_sus_redes on public.%I for all to colector_estaciones
           using (red in (''INTA_SIPAN_AV'', ''WEATHERLINK_PUB''))
           with check (red in (''INTA_SIPAN_AV'', ''WEATHERLINK_PUB''))', t);
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'registro_procesos' and policyname = 'colector_estaciones_sus_procesos') then
    create policy colector_estaciones_sus_procesos on public.registro_procesos for insert to colector_estaciones
      with check (proceso in ('sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico'));
  end if;
end $$;
-- (Una política «for all» no da DELETE: el rol no tiene el privilegio DELETE, así que igual no puede borrar.)

-- registro_procesos se creó en la 0075 SIN RLS (y la RLS automática de la 0099 vale sólo para tablas posteriores):
-- sin RLS, la política de arriba no rige y el rol podría anotar cualquier `proceso`. Se prende la RLS.
-- ¿Le corta a alguien? Quien escribe hoy ahí son las functions de Netlify por `_lib/registro.js`, con el pool de
-- Postgres (DATABASE_URL, el usuario dueño de la tabla): el DUEÑO saltea la RLS (no hay FORCE) y en Supabase
-- `postgres` además tiene BYPASSRLS; la clave de servicio (service_role) también la saltea. anon/authenticated no
-- tienen permisos sobre la tabla. Por las dudas, sólo se prende si el dueño de la tabla saltea la RLS (dueño sin FORCE:
-- siempre); si la tabla tuviera FORCE ROW LEVEL SECURITY, NO se toca y se avisa (NOTICE) para que local lo mire.
do $$
declare forzada boolean;
begin
  select relforcerowsecurity into forzada from pg_class where oid = 'public.registro_procesos'::regclass;
  if forzada then
    raise notice 'registro_procesos tiene FORCE ROW LEVEL SECURITY: no se toca; revisar a mano antes de usar el rol';
  else
    alter table public.registro_procesos enable row level security;
  end if;
end $$;

-- Verificación (correr a mano después de aplicar; cada una tiene que dar lo que dice):
--   select relrowsecurity from pg_class where oid = 'public.registro_procesos'::regclass;   -- true
--   (y una corrida de cualquier proceso de Netlify sigue anotando: select max(creado_at) from registro_procesos;)
--   Si «set role colector_estaciones» da «permission denied to set role» (en Supabase `postgres` no es superusuario y,
--   desde PG16, quien crea un rol no recibe la opción SET): grant colector_estaciones to postgres; … verificar …;
--   reset role; revoke colector_estaciones from postgres;
--   set role colector_estaciones;
--   select count(*) from estaciones where red = 'SNIH';            -- 0 (no ve otras redes)
--   select count(*) from campana.lotes;                            -- ERROR: permission denied
--   delete from estaciones_obs where red = 'INTA_SIPAN_AV';        -- ERROR: permission denied
--   insert into registro_procesos (proceso, ok) values ('otro', true);   -- ERROR: viola la política
--   reset role;

-- ROLLBACK (comentado a propósito):
-- drop policy if exists colector_estaciones_sus_redes on estaciones;
-- drop policy if exists colector_estaciones_sus_redes on estaciones_obs;
-- drop policy if exists colector_estaciones_sus_redes on pronostico_helada_medicion;
-- drop policy if exists colector_estaciones_sus_procesos on registro_procesos;
-- revoke all on estaciones, estaciones_obs, pronostico_helada_medicion, registro_procesos from colector_estaciones;
-- revoke usage on sequence registro_procesos_id_seq from colector_estaciones;
-- alter table registro_procesos disable row level security;   -- sólo si no la tenía antes de esta migración
-- drop role colector_estaciones;
