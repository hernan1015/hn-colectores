-- ════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0147 · estaciones_obs: el diario completo (ET), la mínima de la NOCHE con su hora, cuántos
--                  registros hubo, y la marca de muestreo; + la tabla de la medición del pronóstico de heladas.
--                  Para la red del INTA Alto Valle (SIPAN, `INTA_SIPAN_AV`, cola 138) y las Davis públicas de
--                  WeatherLink (`WEATHERLINK_PUB`, cola 138b).                               [13/11/2026]
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE DE APLICAR: la aplica local. NO la aplicó la sesión que la escribió.
--   Número: 0143 está en main; 0144 (r19), 0145 (mejora/134) y 0146 (propuesta de fix/agua-lote-rls) están tomados en
--   ramas (git ls-remote + ls-tree de todas las ramas, 13/11 16:40). Esta es la 0147. Va después de la 0110 y la 0075.
--   El archivo vive en hn-colectores (sipan-alto-valle/migracion/); local lo copia a hn-agro/migrations/.
--
-- ⛔ DATO INTERNO (decisión del maker, 13/11): no se muestra al productor ni en SATCHI hasta que el INTA (y, para
--   WeatherLink, cada dueño) lo autorice. Mismo criterio que la 0110: RLS activa SIN políticas.
--
-- ADITIVA y legible por la 3.x: sólo agrega columnas NULLables y una tabla nueva. No cambia ni borra nada; los
-- escritores de hoy (snih-lecturas-background, snih-toma) nombran sus columnas en el INSERT y siguen igual.
--
-- Qué se guarda dónde (y por qué los crudos NO van acá):
--   · estaciones_obs, una fila por (red, estación, día local): el diario y la noche. Es chico.
--   · Los crudos (10 min del SIPAN; instantes de WeatherLink) van FUERA de la base, un archivo por estación y día: hoy a
--     releases diarias del repo privado hn-radar (sipan-AAAA-MM-DD); R2 privado queda como opción futura, apagada. Con números: SIPAN 7 estaciones × 144 registros × 365 = 368.000 filas/año; WeatherLink 435 × 24 + 18 × 72
--     = 11.700 instantes/día = 4,3 millones/año. A ~200 B por fila con su índice: 75 MB/año el SIPAN y ~850 MB/año
--     WeatherLink, contra 500 MB de TODA la base en el plan gratis de Supabase. Comprimidos (gz): ~20 MB/año el SIPAN y
--     ~150 MB/año WeatherLink.
--
-- Columnas nuevas de estaciones_obs (todas NULL = no hay dato; NUNCA 0 por falta):
--   eto_mm               ET del día (SIPAN: suma de la columna ET de la consola Davis), mm.
--   tmin_noche_c         la mínima de la NOCHE que termina la mañana de `fecha`: de fecha−1 18:00 a fecha 09:00, hora
--                        local (UTC−3). Así una helada que cae a las 23:40 cuenta para la mañana siguiente.
--   tmin_noche_en        el instante (timestamptz) en que ocurrió esa mínima (fin del registro de 10 min).
--   noche_registros      registros válidos en la ventana de la noche · noche_esperados: los que tendría que haber
--                        (SIPAN: 90 de 10 min). La medición usa sólo noches con ≥ 90 %.
--   registros_validos    registros con temperatura válidos en el día · registros_esperados: los que tendría que haber.
--   muestreo_min         NULL = tmin/tmax son los extremos de la CONSOLA (SIPAN: «Low/Hi Temp» de cada registro).
--                        N = tmin/tmax son MUESTREADOS: el menor/mayor de lecturas tomadas cada ~N min (WeatherLink
--                        público): la mínima verdadera puede ser más baja. Nunca se mezclan sin decirlo.
--   lluvia_origen        'suma_registros' (SIPAN: suma de la lluvia de cada 10 min) o 'acumulado_consola' (WeatherLink:
--                        la lluvia del día que la consola reinicia a medianoche local; se toma la última lectura del día).
-- ════════════════════════════════════════════════════════════════════════════

alter table estaciones_obs add column if not exists eto_mm               numeric;
alter table estaciones_obs add column if not exists tmin_noche_c         numeric;
alter table estaciones_obs add column if not exists tmin_noche_en        timestamptz;
alter table estaciones_obs add column if not exists noche_registros      smallint;
alter table estaciones_obs add column if not exists noche_esperados      smallint;
alter table estaciones_obs add column if not exists registros_validos    smallint;
alter table estaciones_obs add column if not exists registros_esperados  smallint;
alter table estaciones_obs add column if not exists muestreo_min         smallint;
alter table estaciones_obs add column if not exists lluvia_origen        text;
-- [138c] la radiación global del día donde la estación la mide (SIPAN: «Solar Rad.», W/m² medio de cada 10 min ×
-- 600 s), para el Q fototermal medido aparte (motor-q.mjs NO se toca). WeatherLink público no trae radiación: NULL.
alter table estaciones_obs add column if not exists rad_mj_m2            numeric;
alter table estaciones_obs add column if not exists rad_registros        smallint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'estaciones_obs_eto_rango') then
    alter table estaciones_obs add constraint estaciones_obs_eto_rango check (eto_mm is null or (eto_mm >= 0 and eto_mm < 30));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estaciones_obs_tmin_noche_rango') then
    alter table estaciones_obs add constraint estaciones_obs_tmin_noche_rango check (tmin_noche_c is null or (tmin_noche_c > -40 and tmin_noche_c < 60));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estaciones_obs_noche_registros') then
    alter table estaciones_obs add constraint estaciones_obs_noche_registros check (
      (noche_registros is null or noche_registros >= 0) and (noche_esperados is null or noche_esperados > 0)
      and (noche_registros is null or noche_esperados is null or noche_registros <= noche_esperados)
      and (noche_registros is distinct from 0 or tmin_noche_c is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estaciones_obs_registros') then
    alter table estaciones_obs add constraint estaciones_obs_registros check (
      (registros_validos is null or registros_validos >= 0) and (registros_esperados is null or registros_esperados > 0)
      and (registros_validos is null or registros_esperados is null or registros_validos <= registros_esperados));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estaciones_obs_muestreo') then
    alter table estaciones_obs add constraint estaciones_obs_muestreo check (muestreo_min is null or muestreo_min between 1 and 1440);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estaciones_obs_rad_rango') then
    alter table estaciones_obs add constraint estaciones_obs_rad_rango check ((rad_mj_m2 is null or (rad_mj_m2 >= 0 and rad_mj_m2 < 45))
      and (rad_registros is distinct from 0 or rad_mj_m2 is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estaciones_obs_lluvia_origen') then
    alter table estaciones_obs add constraint estaciones_obs_lluvia_origen check (lluvia_origen is null or lluvia_origen in ('suma_registros', 'acumulado_consola'));
  end if;
end $$;

comment on column estaciones_obs.tmin_noche_c is
  'Mínima de la noche que termina la mañana de fecha: (fecha−1 18:00, fecha 09:00] hora local UTC−3. NULL = sin dato.';
comment on column estaciones_obs.muestreo_min is
  'NULL = tmin/tmax son extremos de la consola. N = muestreados cada ~N min (WeatherLink público): la mínima real puede ser menor.';

-- La medición diaria del pronóstico de heladas (lo que usa SATCHI HELADAS) contra la noche observada.
create table if not exists pronostico_helada_medicion (
  red                 text         not null,
  estacion_id         text         not null,
  noche               date         not null,      -- la mañana en que termina la noche (= estaciones_obs.fecha)
  fuente              text         not null,      -- 'open-meteo best_match · punto' | 'open-meteo best_match · localidad <nombre>'
  anticipacion_dias   smallint     not null,      -- 1 = la corrida de ~24 h antes (Previous Runs API, previous_day1)
  tmin_pron_c         numeric,                    -- mínima del día local del pronóstico (de las 24 horas)
  tmin_obs_noche_c    numeric,
  tmin_obs_dia_c      numeric,
  noche_registros     smallint,
  leido_en            timestamptz  not null default now(),
  crudo               jsonb        not null default '{}'::jsonb,   -- celda del modelo, URL, localidad y distancia
  primary key (red, estacion_id, noche, fuente, anticipacion_dias),
  foreign key (red, estacion_id) references estaciones (red, estacion_id),
  constraint phm_anticipacion check (anticipacion_dias between 0 and 7),
  constraint phm_pron_rango check (tmin_pron_c is null or (tmin_pron_c > -40 and tmin_pron_c < 60)),
  constraint phm_obs_rango  check (tmin_obs_noche_c is null or (tmin_obs_noche_c > -40 and tmin_obs_noche_c < 60))
);
comment on table pronostico_helada_medicion is
  'Medición interna: mínima pronosticada (lo que usa SATCHI HELADAS) contra la observada por noche y estación. RLS sin políticas.';
create index if not exists pronostico_helada_medicion_noche_idx on pronostico_helada_medicion (noche);

alter table pronostico_helada_medicion enable row level security;
revoke all on table pronostico_helada_medicion from anon, authenticated;

-- [138b/138c] LA ÚLTIMA LECTURA de cada estación: una fila por estación (≤ ~500 filas, chica). Sirve para:
--   · el dedup de WeatherLink por `lastTimestamp` (si `instante` no cambió, la lectura no es nueva) y la edad
--     (`ageInSeconds` > 2 h = vieja, no cuenta);
--   · las lecturas A DEMANDA del semáforo de aplicación con caché de 15 min (`leido_en`): si hay una de menos de
--     15 min, no se le pide de nuevo al servicio.
-- Las unidades se guardan ya convertidas (°C, %, m/s, hPa, mm); el crudo tal como vino va en `crudo`.
create table if not exists estaciones_ultima_lectura (
  red            text         not null,
  estacion_id    text         not null,
  instante       timestamptz  not null,      -- cuándo midió la estación (WeatherLink: lastTimestamp; SIPAN: fin del registro)
  leido_en       timestamptz  not null default now(),   -- cuándo la leímos nosotros (caché de 15 min)
  edad_s         integer,                    -- WeatherLink: ageInSeconds al leer
  temp_c         numeric,
  hum_pct        numeric,
  viento_ms      numeric,
  racha_ms       numeric,
  viento_dir_gr  numeric,
  presion_hpa    numeric,
  lluvia_dia_mm  numeric,                    -- acumulado del día de la consola (se reinicia a medianoche local)
  rad_wm2        numeric,                    -- SIPAN sí; WeatherLink público, NULL
  marcas         text[]       not null default '{}',
  crudo          jsonb        not null default '{}'::jsonb,
  primary key (red, estacion_id),
  foreign key (red, estacion_id) references estaciones (red, estacion_id),
  constraint eul_temp check (temp_c is null or (temp_c > -40 and temp_c < 60)),
  constraint eul_hum  check (hum_pct is null or (hum_pct >= 0 and hum_pct <= 100)),
  constraint eul_edad check (edad_s is null or edad_s >= 0)
);
comment on table estaciones_ultima_lectura is
  'Última lectura por estación (dedup por instante, caché de 15 min para lecturas a demanda). Dato INTERNO. RLS sin políticas.';
alter table estaciones_ultima_lectura enable row level security;
revoke all on table estaciones_ultima_lectura from anon, authenticated;

-- ROLLBACK (comentado a propósito):
-- drop table if exists estaciones_ultima_lectura;
-- drop table if exists pronostico_helada_medicion;
-- alter table estaciones_obs drop column if exists eto_mm, drop column if exists tmin_noche_c, drop column if exists tmin_noche_en,
--   drop column if exists noche_registros, drop column if exists noche_esperados, drop column if exists registros_validos,
--   drop column if exists registros_esperados, drop column if exists muestreo_min, drop column if exists lluvia_origen,
--   drop column if exists rad_mj_m2, drop column if exists rad_registros;
