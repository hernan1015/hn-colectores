-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0152 · UNIFICADA para el parseo de estaciones-privadas (R2 → estaciones_obs), la 139 y la 138b juntas:
--                  el rol colector_estaciones (0147b) escribe también SIGA_RT, EEAOC, DACC_MZA, REM_SL, ER_HIDRAULICA,
--                  INA_METEO, INA_ALERTA y BCP_RT (139) y WEATHERCLOUD_PUB (138b), con sus procesos, y la última
--                  lectura (estaciones_ultima_lectura, 138b).                                          [15/11/2026]
--   Es la ÚNICA 0152 del parseo unificado (rama feat/parseo-estaciones, que reemplaza a los PR #11 y #12): la que
--   proponía la 138b (0152_parseo_estaciones_privadas_rol_PROPUESTA.sql) ya no existe; su parte está acá, igual.
--   El job (estaciones-privadas/parseo/parseo.mjs) escribe las 10 redes de lib/base.mjs · REDES, que son éstas menos
--   las de otros colectores (INTA_SIPAN_AV, SMN_ABIERTO); un test lo compara.
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA · NO APLICADA. La aplica local, DESPUÉS de la 0147b (ya aplicada) y DESPUÉS de la 0151 (SMN_ABIERTO).
--   El número: 0150 es de la 176 y 0151 de la 139 SMN; ninguna rama de hn-agro, hn-colectores ni hn-radar tiene otra
--   0152 (git ls-tree de todas las ramas, 15/11). La 0153 de la 257 (zona) va después y NO toca estas políticas (crea
--   su propio rol clasificador_zona con funciones). Local confirma el número antes de aplicar.
--   El archivo vive en hn-colectores (estaciones-privadas/parseo/migracion/); local lo copia a hn-agro/migrations/.
--   ⚠ ORDEN: esta lista INCLUYE la de la 0151. Si se aplicara la 0151 DESPUÉS de ésta, la 0151 sacaría las 8 internas
--   (fija la lista sin ellas). Aplicar 0151 y después 0152; si la 0151 ya está, ésta sola alcanza.
--
-- ADITIVA: no crea tablas ni columnas (las internas usan estaciones / estaciones_obs con las columnas de la 0110 y la
-- 0147). Sólo AMPLÍA las dos políticas de la 0147b. Lo que ya estaba (INTA_SIPAN_AV, WEATHERLINK_PUB, SMN_ABIERTO y sus
-- procesos) queda igual. No cambia grants, atributos del rol ni la contraseña. Sin variables de psql.
--
-- ⛔ INTERNO (maker, 15/11): estas 8 redes NO se muestran. El parseo escribe metadatos.mostrar = false en cada
-- estación (lo fuerza su SQL). Esta migración NO abre nada al navegador: RLS sigue sin políticas para anon/authenticated.
--
-- Idempotente: se puede correr dos veces. Si falta la 0147b, se corta con un error.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  t text;
  redes constant text := $r$red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO', 'SIGA_RT', 'EEAOC', 'DACC_MZA', 'REM_SL', 'ER_HIDRAULICA', 'INA_METEO', 'INA_ALERTA', 'BCP_RT', 'WEATHERCLOUD_PUB')$r$;
begin
  if not exists (select 1 from pg_roles where rolname = 'colector_estaciones') then
    raise exception '0152: falta el rol colector_estaciones (aplicar antes la 0147b)';
  end if;
  if to_regclass('public.estaciones_ultima_lectura') is null then
    raise exception '0152: falta estaciones_ultima_lectura (aplicar antes la 0147)';
  end if;
  if current_user in ('anon', 'authenticated', 'service_role', 'colector_estaciones') then
    raise exception '0152: aplicala como postgres, no como %', current_user;
  end if;
  foreach t in array array['estaciones', 'estaciones_obs', 'pronostico_helada_medicion'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'colector_estaciones_sus_redes') then
      raise exception '0152: falta la política colector_estaciones_sus_redes en % (aplicar antes la 0147b)', t;
    end if;
    execute format('alter policy colector_estaciones_sus_redes on public.%I using (%s) with check (%s)', t, redes, redes);
  end loop;
  /* [138b] la última lectura (WeatherLink): la 0147b no se la daba al rol */
  grant select, insert, update on table public.estaciones_ultima_lectura to colector_estaciones;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estaciones_ultima_lectura' and policyname = 'colector_estaciones_sus_redes') then
    execute format('alter policy colector_estaciones_sus_redes on public.estaciones_ultima_lectura using (%s) with check (%s)', redes, redes);
  else
    execute format('create policy colector_estaciones_sus_redes on public.estaciones_ultima_lectura for all to colector_estaciones using (%s) with check (%s)', redes, redes);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'registro_procesos' and policyname = 'colector_estaciones_sus_procesos') then
    raise exception '0152: falta la política colector_estaciones_sus_procesos en registro_procesos (aplicar antes la 0147b)';
  end if;
  alter policy colector_estaciones_sus_procesos on public.registro_procesos
    with check (proceso in ('sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico', 'smn_abierto',
                            'interna_siga_rt', 'interna_eeaoc', 'interna_dacc_mza', 'interna_rem_sl', 'interna_er_hidraulica', 'interna_ina', 'interna_bcp_rt', 'estaciones_privadas_parseo'));
end $$;

-- Verificación (a mano, después de aplicar):
--   select tablename, qual, with_check from pg_policies where policyname like 'colector_estaciones_sus_%' order by 1;
--     → las tres de redes con las 11 redes; registro_procesos con los 11 procesos.
--   Con la URL del colector (el mismo rol):
--   insert into estaciones (red, estacion_id, metadatos) values ('EEAOC', 'PRUEBA_NO_VA', '{"mostrar": false}');  -- INSERT 0 1
--     (borrarla después con el usuario de administración:
--      delete from estaciones where red = 'EEAOC' and estacion_id = 'PRUEBA_NO_VA';)
--   insert into estaciones (red, estacion_id) values ('SNIH', 'prueba-no-va');   -- ERROR … row-level security

-- ROLLBACK (comentado a propósito): volver a las listas de la 0151.
-- alter policy colector_estaciones_sus_redes on public.estaciones using (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO')) with check (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO'));
-- alter policy colector_estaciones_sus_redes on public.estaciones_obs using (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO')) with check (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO'));
-- alter policy colector_estaciones_sus_redes on public.pronostico_helada_medicion using (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO')) with check (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO'));
-- alter policy colector_estaciones_sus_procesos on public.registro_procesos with check (proceso in ('sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico', 'smn_abierto'));
