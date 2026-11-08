-- 0141 · rol mínimo firmador_r2 para el firmador de enlaces R2 en la nube (hn-colectores, firmador-r2/)
-- PROPUESTA PREPARADA POR pc-nanci el 7/11/2026 · NO APLICADA. La aplica local, a mano, con su OK.
--
-- Qué hace: crea el rol de login firmador_r2 con SELECT, INSERT y UPDATE sobre public.r2_enlaces (0129) y NADA más:
--   - sin DELETE, sin TRUNCATE, sin REFERENCES/TRIGGER;
--   - sin acceso a ninguna otra tabla (USAGE en el schema public sólo para poder nombrar la tabla);
--   - r2_enlaces tiene RLS activa y sin políticas (0129), así que se agregan 3 políticas SÓLO para firmador_r2
--     (select, insert, update). anon y authenticated siguen sin ver nada; service_role/postgres no cambian.
-- Lo usa el paso de Actions con el secreto SUPABASE_FIRMADOR_URL (lo carga local).
--
-- LA CONTRASEÑA NO VA EN ESTE ARCHIVO (ni en el repo, ni en el canal). Después de aplicar, local la pone así:
--   - en psql:              \password firmador_r2
--   - o en el SQL editor:   alter role firmador_r2 with password '<CONTRASEÑA>';   (sin guardar la consulta)
--   y arma SUPABASE_FIRMADOR_URL con el pooler (las máquinas de Actions no tienen IPv6 para la conexión directa):
--     postgresql://firmador_r2.<ref-del-proyecto>:<CONTRASEÑA>@<host-del-pooler>:5432/postgres
--   Hasta que tenga contraseña el rol no puede entrar (login sin contraseña = rechazado por scram).
--
-- Cómo mirar: select grantee, privilege_type from information_schema.role_table_grants where grantee = 'firmador_r2';
-- Cómo sacarlo:  drop policy firmador_r2_lee on public.r2_enlaces; drop policy firmador_r2_agrega on public.r2_enlaces;
--                drop policy firmador_r2_cambia on public.r2_enlaces; revoke all on public.r2_enlaces from firmador_r2;
--                revoke usage on schema public from firmador_r2; drop role firmador_r2;
-- Probada en pc-nanci con PGlite (Postgres 16, sin red): hn-colectores, firmador-r2/test/base.test.mjs.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'firmador_r2') then
    create role firmador_r2 with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 3;
  end if;
end
$$;
alter role firmador_r2 set statement_timeout = '30s';
alter role firmador_r2 set idle_in_transaction_session_timeout = '60s';

grant usage on schema public to firmador_r2;
revoke all on table public.r2_enlaces from firmador_r2;
grant select, insert, update on table public.r2_enlaces to firmador_r2;

drop policy if exists firmador_r2_lee on public.r2_enlaces;
drop policy if exists firmador_r2_agrega on public.r2_enlaces;
drop policy if exists firmador_r2_cambia on public.r2_enlaces;
create policy firmador_r2_lee on public.r2_enlaces for select to firmador_r2 using (true);
create policy firmador_r2_agrega on public.r2_enlaces for insert to firmador_r2 with check (clave ~ '^(tormentas|escenarios|opera/cog|rayos-hora)/');
create policy firmador_r2_cambia on public.r2_enlaces for update to firmador_r2 using (true) with check (clave ~ '^(tormentas|escenarios|opera/cog|rayos-hora)/');

comment on role firmador_r2 is 'Firmador de enlaces R2 en la nube (hn-colectores/firmador-r2): sólo select/insert/update en public.r2_enlaces. 0141.';
