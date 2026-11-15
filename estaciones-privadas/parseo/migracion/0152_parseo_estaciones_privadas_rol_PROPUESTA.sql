-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0152 · el rol colector_estaciones (0147b) para el PARSEO de las estaciones internas (138b):
--                  la red WEATHERCLOUD_PUB, el proceso 'estaciones_privadas_parseo' y estaciones_ultima_lectura. [15/11/2026]
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA · NO APLICADA. La aplica local (editor SQL o MCP, como postgres; sin variables de psql).
--   EL NÚMERO: 0152 es el primero libre al 15/11 (git ls-tree de TODAS las ramas de hn-agro y hn-colectores):
--   0147/0147b y 0148 aplicadas; 0149 (196-2), 0150 (176), 0151/0151b (139 SMN, rama feat/smn-datos-abiertos).
--   Local lo confirma; si está tomado, se renombra (el texto no depende del número).
--   ⚠ ORDEN CON LA 0151: las dos fijan la lista ENTERA de redes de la política. Esta ya incluye SMN_ABIERTO, así que
--   el orden correcto es 0151 → 0152. Si la 0151 se aplica DESPUÉS, volver a correr esta (es idempotente).
--   El archivo vive en hn-colectores (estaciones-privadas/parseo/migracion/); local lo copia a hn-agro/migrations/.
--
-- ⛔ USO INTERNO: WeatherLink y Weathercloud prohíben los robots en sus términos; el maker autorizó la bajada el 15/11
--   para uso interno. ESTA MIGRACIÓN NO ABRE NADA AL NAVEGADOR: las tablas siguen con RLS sin políticas para
--   anon/authenticated. Las estaciones llevan metadatos.mostrar = false.
--
-- ADITIVA: no crea tablas ni columnas. AMPLÍA las políticas de la 0147b (y de la 0151, si está):
--   · redes: INTA_SIPAN_AV, WEATHERLINK_PUB, SMN_ABIERTO + WEATHERCLOUD_PUB;
--   · procesos: sipan_alto_valle, sipan_medicion_heladas, weatherlink_publico, smn_abierto + estaciones_privadas_parseo;
--   · estaciones_ultima_lectura (0147): select/insert/update para el rol, con la misma política de redes (la 0147b no
--     le había dado nada). Sin DELETE en ninguna.
-- Para las redes de la 139 (SIGA, EEAOC, DACC, REM, BCP, INA, Entre Ríos): otra migración que repita este patrón con
--   la lista entera (estas cuatro + las nuevas).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  t text;
  redes constant text := $r$red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO', 'WEATHERCLOUD_PUB')$r$;
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
    with check (proceso in ('sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico', 'smn_abierto', 'estaciones_privadas_parseo'));
end $$;

-- Verificación (a mano):
--   select tablename, qual, with_check from pg_policies where policyname like 'colector_estaciones_sus_%' order by 1;
--     → cuatro tablas de redes con 'WEATHERCLOUD_PUB' (y las otras tres), registro_procesos con 'estaciones_privadas_parseo'.
--   Con la URL del rol:  select count(*) from estaciones_ultima_lectura;          -- sin error
--                        delete from estaciones_ultima_lectura;                    -- ERROR: permission denied

-- ROLLBACK (comentado a propósito): volver a la lista de la 0151 (o de la 0147b) y sacar estaciones_ultima_lectura.
-- drop policy if exists colector_estaciones_sus_redes on public.estaciones_ultima_lectura;
-- revoke all on public.estaciones_ultima_lectura from colector_estaciones;
-- (y alter policy … con la lista de antes en las otras tres y en registro_procesos)
