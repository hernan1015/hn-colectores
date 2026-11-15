-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0225 · el rol `colector_cap` del archivo del índice CAP del SMN (hn-colectores/cap-archivo).
-- El mismo molde que la 0147b (colector_estaciones, SIPAN). La aplica LOCAL, con psql, cuando decida prenderlo.
--
-- Por qué un rol propio: el colector corre en Actions de un repo PÚBLICO. Con este rol, quien robe el secreto sólo
-- puede AGREGAR renglones a registro_procesos con proceso = 'smn_cap_archivo'. Nada más: no lee ninguna tabla, no
-- cambia ni borra nada. Los datos del archivo NO van a la base: van a releases de hn-radar (privado).
--
-- Un solo secreto, CAP_PG_URL (secrets.* del repo; nunca en el código):
--   postgresql://colector_cap.<ref>:<clave>@<host-del-pooler>:6543/postgres
--
-- ⛔ LA CONTRASEÑA NO ESTÁ EN ESTE ARCHIVO. Llega por la variable de psql `clave`, y lo que llega NO es la clave en
--   texto: es su verificador SCRAM-SHA-256 (sipan-alto-valle/migracion/scram.mjs, el mismo de la 0147b):
--     VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)
--     psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f cap-archivo/migracion/0225_rol_colector_cap.sql
--   Sin `-v clave=…`, psql deja «:'clave'» sin reemplazar, la sentencia da error y (con ON_ERROR_STOP) no se aplica nada.
--
-- Idempotente (se puede volver a correr para cambiar la contraseña).
-- ════════════════════════════════════════════════════════════════════════════

-- ⚠ PG16+: SUPERUSER/REPLICATION/BYPASSRLS no se nombran (ver la 0147b); se VERIFICAN abajo.
select 'create role colector_cap login nocreatedb nocreaterole noinherit connection limit 2'
 where not exists (select 1 from pg_roles where rolname = 'colector_cap') \gexec
alter role colector_cap with login nocreatedb nocreaterole noinherit connection limit 2
  password :'clave';
do $$
declare r record;
begin
  select rolsuper, rolreplication, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin, rolconnlimit
    into r from pg_roles where rolname = 'colector_cap';
  if r.rolsuper or r.rolreplication or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolinherit then
    raise exception 'colector_cap tiene atributos de más (super=%, replication=%, bypassrls=%, createrole=%, createdb=%, inherit=%): no se sigue',
      r.rolsuper, r.rolreplication, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolinherit;
  end if;
  if not r.rolcanlogin or r.rolconnlimit <> 2 then
    raise exception 'colector_cap quedó sin LOGIN o sin CONNECTION LIMIT 2';
  end if;
end $$;

grant usage on schema public to colector_cap;
-- registro_procesos: sólo agregar renglones (el id es bigserial: hace falta la secuencia). Ni leer ni cambiar.
grant insert on table registro_procesos to colector_cap;
grant usage on sequence registro_procesos_id_seq to colector_cap;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'registro_procesos' and policyname = 'colector_cap_su_proceso') then
    create policy colector_cap_su_proceso on public.registro_procesos for insert to colector_cap
      with check (proceso = 'smn_cap_archivo');
  end if;
end $$;

-- La RLS de registro_procesos: la prende la 0147b. Si la 0147b todavía no se aplicó, se prende acá con la MISMA
-- regla (sólo si la tabla no tiene FORCE; el dueño y service_role la saltean, así que las functions de Netlify siguen
-- anotando igual). Sin RLS, la política de arriba no rige y el rol podría anotar cualquier `proceso`.
do $$
declare forzada boolean; prendida boolean;
begin
  select relforcerowsecurity, relrowsecurity into forzada, prendida from pg_class where oid = 'public.registro_procesos'::regclass;
  if forzada then
    raise notice 'registro_procesos tiene FORCE ROW LEVEL SECURITY: no se toca; revisar a mano antes de usar el rol';
  elsif not prendida then
    alter table public.registro_procesos enable row level security;
  end if;
end $$;

-- Verificación (a mano, después de aplicar):
--   select relrowsecurity from pg_class where oid = 'public.registro_procesos'::regclass;     -- true
--   (si «set role» da «permission denied to set role»: grant colector_cap to postgres; …; reset role; revoke colector_cap from postgres;)
--   set role colector_cap;
--   insert into registro_procesos (proceso, ok) values ('smn_cap_archivo', true);          -- INSERT 0 1 (borrarlo después como postgres)
--   insert into registro_procesos (proceso, ok) values ('otro', true);                     -- ERROR: viola la política
--   select count(*) from registro_procesos;                                                -- ERROR: permission denied
--   select count(*) from estaciones;                                                       -- ERROR: permission denied
--   reset role;
--
-- ROLLBACK (comentado a propósito):
-- drop policy if exists colector_cap_su_proceso on registro_procesos;
-- revoke all on registro_procesos from colector_cap;
-- revoke usage on sequence registro_procesos_id_seq from colector_cap;
-- revoke usage on schema public from colector_cap;
-- drop role if exists colector_cap;
