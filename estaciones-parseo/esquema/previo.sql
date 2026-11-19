-- COPIA para los tests (PGlite) de la 0161, NO se aplica. Lo que la base de producción ya tiene antes de la 0161:
--   · los roles de Supabase con sus privilegios por defecto (por eso cada migración revoca a mano);
--   · los ayudantes de la 0020 (current_user_role, is_maker), copiados;
--   · el rol colector_estaciones y las políticas de la 0147b (hn-colectores sipan-alto-valle/migracion/), sin la parte
--     de psql (la contraseña). La 0075, la 0110 y la 0147 las lee el test de sus archivos.
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create role colector_estaciones nologin;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role, colector_estaciones;

create or replace function public.current_user_role() returns text language sql stable as $$
  select current_setting('request.jwt.claims', true)::jsonb ->> 'role';
$$;
create or replace function public.is_maker() returns boolean language sql stable as $$
  select coalesce(public.current_user_role() = 'maker', false);
$$;
