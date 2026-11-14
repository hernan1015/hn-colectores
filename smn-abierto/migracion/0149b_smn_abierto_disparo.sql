-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0149b · el disparo del colector del SMN (datos abiertos) desde pg_cron: su LLAVE en colector_llaves y sus
--                   dos jobs, con public.gh_colector_disparo() de la 0148.                              [14/11/2026]
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA · NO APLICADA. Va DESPUÉS de la 0148 (usa colector_llaves y gh_colector_disparo) y de la 0149 (el rol
--   tiene que poder escribir SMN_ABIERTO). Se aplica como postgres (editor SQL o MCP), igual que la 0148.
--
-- LA LLAVE NACE APAGADA (activa = false): el workflow se instala y se prueba a mano en seco; recién con el OK de local
-- se prende con el update de abajo. Volver a correr esta migración NO la prende (on conflict do nothing).
--   Prender:  update public.colector_llaves set activa = true,  cambiada_en = now() where etiqueta = 'smn-abierto';
--   Apagar:   update public.colector_llaves set activa = false, cambiada_en = now() where etiqueta = 'smn-abierto';
--
-- LA FRECUENCIA: el SMN publica el archivo «datos horarios» UNA vez por día (las lecturas del día anterior). El 14/11
-- a las 03:29 el ZIP traía el .txt del 13/11 VACÍO: todavía no estaba. Por eso dos intentos por día, y el segundo NO
-- pide nada si el primero ya lo cargó (el colector mira metadatos.ultimo_archivo antes de pedir):
--   smn-abierto-disparo        17 13 * * *   (10:17 de Argentina)  {"modo":"real"}
--   smn-abierto-disparo-tarde  17 19 * * *   (16:17 de Argentina)  {"modo":"real","ultimo":"si"}   ← si sigue vacío, avisa
-- Es el MÍNIMO: 1 pedido por día si el archivo está a las 10, 2 si no. Nunca más seguido que lo que el SMN actualiza.
-- Si las primeras corridas muestran que el archivo llega más tarde, se mueve el horario (no se suman intentos).
-- Los inputs van como TEXTO (la API de workflow_dispatch los quiere así).
-- ════════════════════════════════════════════════════════════════════════════

do $do$
begin
  if to_regclass('public.colector_llaves') is null or to_regprocedure('public.gh_colector_disparo(text, jsonb, text)') is null then
    raise exception '0149b: falta la 0148 (colector_llaves / gh_colector_disparo): aplicarla antes';
  end if;
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception '0149b: aplicala como postgres (el editor SQL o el MCP), no como %', current_user;
  end if;
end
$do$;

insert into public.colector_llaves (etiqueta, activa, nota) values
  ('smn-abierto', false, 'smn-abierto.yml · SMN datos abiertos (datos horarios), CC BY 2.5 AR · nace APAGADA (0149b)')
on conflict (etiqueta) do nothing;

do $do$
declare v_job text;
begin
  foreach v_job in array array['smn-abierto-disparo', 'smn-abierto-disparo-tarde'] loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;
end
$do$;

select cron.schedule('smn-abierto-disparo',       '17 13 * * *',
  $cron$select public.gh_colector_disparo('smn-abierto.yml', '{"modo":"real"}'::jsonb, 'smn-abierto')$cron$);
select cron.schedule('smn-abierto-disparo-tarde', '17 19 * * *',
  $cron$select public.gh_colector_disparo('smn-abierto.yml', '{"modo":"real","ultimo":"si"}'::jsonb, 'smn-abierto')$cron$);

-- Verificación:
--   select jobname, schedule, command, username, active from cron.job where jobname like 'smn-abierto%';   -- 2, de postgres
--   select * from public.colector_llaves where etiqueta = 'smn-abierto';                                    -- activa = false
--   (con la llave apagada, la bitácora anota «llave apagada: no se llamó a GitHub» en cada horario: es lo esperado)
--   select * from public.colector_disparo_bitacora where etiqueta = 'smn-abierto' order by id desc limit 5;

-- ROLLBACK (comentado a propósito):
-- select cron.unschedule('smn-abierto-disparo'); select cron.unschedule('smn-abierto-disparo-tarde');
-- delete from public.colector_llaves where etiqueta = 'smn-abierto';
