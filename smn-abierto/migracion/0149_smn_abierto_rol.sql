-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0149 · el rol colector_estaciones (0147b) también para la red del SMN, datos abiertos (`SMN_ABIERTO`, 139)
--                  y su proceso `smn_abierto` en registro_procesos.                                   [14/11/2026]
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA · NO APLICADA. La aplica local, DESPUÉS de la 0147b (ya aplicada) y con la 0148 o sin ella (no la usa).
--   El número: 0148 es el disparo (mejora/0148-disparo-colectores). Ninguna rama de hn-agro ni de hn-colectores tiene
--   una 0149 (git ls-tree de todas las ramas, 14/11 03:40); local confirma el número antes de aplicar.
--   El archivo vive en hn-colectores (smn-abierto/migracion/); local lo copia a hn-agro/migrations/.
--
-- ADITIVA: no crea tablas ni columnas (el SMN usa estaciones / estaciones_obs con las columnas de la 0110 y la 0147).
-- Sólo AMPLÍA las dos políticas de la 0147b: suma la red 'SMN_ABIERTO' y el proceso 'smn_abierto'. Las redes y los
-- procesos que ya estaban quedan IGUAL. No cambia grants ni atributos del rol ni la contraseña: se aplica con el editor
-- SQL o el MCP (no lleva variables de psql).
--
-- MOSTRAR (139b): la red SMN_ABIERTO es Dato Abierto del SMN, CC BY 2.5 AR (política de datos del SMN, §4.A). El
-- colector lo deja escrito en cada fila de `estaciones`: metadatos.mostrar = true, metadatos.licencia, .licencia_url,
-- .cita, .politica_url y .cambios. ESTA MIGRACIÓN NO ABRE NADA AL NAVEGADOR: las tablas siguen con RLS sin políticas
-- para anon/authenticated. Mostrarlas en HN AGRO es otra pieza (la maqueta de la 139b), con su propia migración.
--
-- Idempotente: si la política existe, se ALTERA; si no existe (base sin la 0147b), se corta con un error.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  t text;
  redes constant text := $r$red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO')$r$;
begin
  if not exists (select 1 from pg_roles where rolname = 'colector_estaciones') then
    raise exception '0149: falta el rol colector_estaciones (aplicar antes la 0147b)';
  end if;
  foreach t in array array['estaciones', 'estaciones_obs', 'pronostico_helada_medicion'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'colector_estaciones_sus_redes') then
      raise exception '0149: falta la política colector_estaciones_sus_redes en % (aplicar antes la 0147b)', t;
    end if;
    execute format('alter policy colector_estaciones_sus_redes on public.%I using (%s) with check (%s)', t, redes, redes);
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'registro_procesos' and policyname = 'colector_estaciones_sus_procesos') then
    raise exception '0149: falta la política colector_estaciones_sus_procesos en registro_procesos (aplicar antes la 0147b)';
  end if;
  alter policy colector_estaciones_sus_procesos on public.registro_procesos
    with check (proceso in ('sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico', 'smn_abierto'));
end $$;

-- Verificación (a mano, después de aplicar):
--   select tablename, qual, with_check from pg_policies where policyname like 'colector_estaciones_sus_%' order by 1;
--     → las tres de redes con 'SMN_ABIERTO' y las otras dos; registro_procesos con 'smn_abierto' y los otros tres.
--   Con la URL del colector (SIPAN_PG_URL, el mismo rol):
--   insert into estaciones (red, estacion_id) values ('SMN_ABIERTO', 'PRUEBA_NO_VA');   -- INSERT 0 1 (borrarla después
--     con el usuario de administración: delete from estaciones where red = 'SMN_ABIERTO' and estacion_id = 'PRUEBA_NO_VA';)
--   insert into estaciones (red, estacion_id) values ('SNIH', 'prueba-no-va');          -- ERROR … row-level security
--   select count(*) from estaciones where red = 'SNIH';                                  -- 0

-- ROLLBACK (comentado a propósito): volver a las listas de la 0147b.
-- alter policy colector_estaciones_sus_redes on public.estaciones using (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB')) with check (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB'));
-- alter policy colector_estaciones_sus_redes on public.estaciones_obs using (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB')) with check (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB'));
-- alter policy colector_estaciones_sus_redes on public.pronostico_helada_medicion using (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB')) with check (red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB'));
-- alter policy colector_estaciones_sus_procesos on public.registro_procesos with check (proceso in ('sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico'));
