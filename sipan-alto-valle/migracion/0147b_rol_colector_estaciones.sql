-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0147b · el rol propio del colector de estaciones (SIPAN y, después, WeatherLink público)   [13/11/2026]
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE DE APLICAR: la aplica local, DESPUÉS de la 0147 (necesita pronostico_helada_medicion).
-- Por qué: el colector corre en Actions de un repo PÚBLICO. Con la clave de servicio, quien la robe tiene TODA la base.
-- Con este rol, sólo puede: leer y escribir las filas de SUS redes en estaciones / estaciones_obs /
-- pronostico_helada_medicion, y agregar renglones a registro_procesos con SUS procesos. Nada más: no borra, no lee
-- otras tablas, no ve las filas del SNIH ni ningún dato de usuarios.
--
-- Cómo lo usa PostgREST (la API REST de Supabase): PostgREST entra como `authenticator` y cambia al rol que dice el
-- claim `role` del JWT del encabezado Authorization. Por eso:
--   1. el rol es NOLOGIN y se le da a `authenticator` (grant … to authenticator);
--   2. el colector manda   apikey: <la clave anon/publishable del proyecto>   y
--                          Authorization: Bearer <un JWT con {"role":"colector_estaciones"}>;
--   3. ese JWT se firma UNA vez con el JWT secret del proyecto (Dashboard → Project Settings → API / JWT Keys →
--      «Legacy JWT secret», HS256). Ver PRENDER.md, paso 2: `node sipan-alto-valle/migracion/firmar-jwt.mjs` lo arma
--      en la PC de local con el secreto en una variable de entorno; el secreto no se guarda en ningún lado.
--   Si el proyecto ya no acepta el JWT secret legado (sólo claves asimétricas), la alternativa es darle LOGIN y una
--   contraseña a este rol y conectarse por el pooler con Postgres directo: ver PRENDER.md, «Plan B».
--
-- Idempotente. RLS: las tablas de la 0110/0147 tienen RLS SIN políticas (nadie ve nada salvo el server, que la
-- saltea). Este rol NO la saltea: por eso van políticas, sólo para él, recortadas a sus redes y procesos.
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'colector_estaciones') then
    create role colector_estaciones nologin noinherit;
  end if;
end $$;
grant colector_estaciones to authenticator;

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
-- revoke colector_estaciones from authenticator; drop role colector_estaciones;
