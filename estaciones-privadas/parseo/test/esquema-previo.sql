-- COPIA para los tests (PGlite), NO se aplica. hn-agro main 1cc6afd3: migrations/0075_registro_procesos.sql y 0110_estaciones_comun.sql,
-- más los roles de Supabase con sus privilegios por defecto (por eso cada migración revoca a mano).
create role anon nologin; create role authenticated nologin; create role service_role nologin; create role colector_estaciones nologin;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- ════════════════════════════════════════════════════════════════════════════
-- 0075 · REGISTRO DE PROCESOS QUE CORREN SOLOS
-- ════════════════════════════════════════════════════════════════════════════
-- ⛔ POR QUÉ (medido el 20/08/2026, tres corridas seguidas contra producción):
--   los logs de una background function NO LLEGAN a `netlify logs`. Se ve la marca
--   de invocación y nada más: ni el console.log del resumen, ni un hito puesto en
--   la primera línea del handler, ni a los 40 minutos. Todas las demás functions
--   dejan su salida y su línea de Duration; las background, no.
--
--   El recálculo semanal ES una background function: corre el lunes 05:00 ART sin
--   nadie mirando. Sin esta tabla, la única forma de saber qué hizo es deducirlo de
--   si aparecen filas en historico_motor_q — y ahí no se puede distinguir "no había
--   nada que hacer" de "se rompió". Es la misma falla silenciosa que nos costó el
--   día: todo verde y nada atrás.
--
-- ⚠ NO es una tabla de auditoría ni de facturación: es para MIRARLA. Por eso el
--   resumen va recortado a 60 KB desde el código y hay una poda por antigüedad.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS registro_procesos (
  id         BIGSERIAL PRIMARY KEY,
  proceso    TEXT NOT NULL,
  ok         BOOLEAN NOT NULL,
  resumen    JSONB,
  creado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La consulta que se va a hacer siempre: "las últimas corridas de este proceso".
CREATE INDEX IF NOT EXISTS registro_procesos_proceso_fecha_idx
  ON registro_procesos (proceso, creado_at DESC);

-- ⚠ Sin datos personales adentro: acá van resúmenes técnicos (cuántos lotes, qué
--   motivo, cuánto tardó). Los nombres de lote que hoy trae el resumen de fallos
--   son el mínimo para poder ir a mirar el lote, y no salen de la cuenta del maker.
COMMENT ON TABLE registro_procesos IS
  'Rastro de los procesos que corren solos (cron/background), porque sus logs no llegan a netlify logs. Para mirar, no para archivar.';
COMMENT ON COLUMN registro_procesos.resumen IS
  'El JSON que se habría logueado. Recortado a 60 KB desde el codigo, DECLARANDO el recorte.';

-- ROLLBACK (comentado a proposito):
-- DROP TABLE IF EXISTS registro_procesos;
-- ════════════════════════════════════════════════════════════════
-- HN AGRO · 0110 · Tabla común de estaciones meteorológicas
--                  (primera red: pluviómetros del SNIH)        [_v873]
-- ════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE DE APLICAR (la escribió una sesión sin acceso a la base).
--   Va DESPUÉS de 0108. El número 0109 lo tiene tomado
--   0109_rio_zonas_colon_cdu.sql (rama feat/v870-puertos-colon-cdu, sin
--   commitear al 14/10): por eso ésta es la 0110.
--
-- Dos tablas para TODAS las redes de estaciones (SNIH hoy; la BCP y las
-- que vengan, después):
--   · estaciones      una fila por (red, estacion_id): el catálogo.
--   · estaciones_obs  una fila por (red, estacion_id, fecha): el día.
--
-- ⛔ DATO INTERNO (OK del maker 14/10/2026): no se muestra al productor.
--   La escribe la programada snih-lecturas-background (o el respaldo de la
--   PC, HN-AGRO-analisis/estaciones/tomar_snih.mjs); la lee
--   tools/validar-lluvia-estaciones.mjs.
--
-- Reglas que la tabla respeta:
--   · NULL es «no hay dato». NUNCA se guarda 0 por falta de dato: 0 quiere
--     decir «la estación midió 0 mm». −999, vacío, N/D y NaN llegan como NULL.
--   · `fecha` es el DÍA LOCAL de Argentina (UTC−3), cortado a `hora_corte`
--     (hora local). SNIH no declara corte: 00:00. El día D son las horas
--     que terminan entre D hora_corte (excluida) y D+1 hora_corte (incluida).
--   · horas_validas dice cuántas de las 24 horas trajeron dato. Un día con
--     menos de 24 NO es completo (lluvia_mm es la suma parcial); con 0
--     horas, lluvia_mm es NULL (lo exige un CHECK).
--   · Ausencia de fila = sin dato, nunca «no llovió».
--   · La migración de bcp_lecturas a esta tabla queda para DESPUÉS (no se
--     toca bcp_lecturas ni su escritor acá).
--
-- Idempotente (create if not exists). RLS activa SIN políticas y sin
-- permisos para anon/authenticated: sólo el server con el pool.
-- ════════════════════════════════════════════════════════════════

create table if not exists estaciones (
  red                  text         not null,              -- 'SNIH', 'BCP', …
  estacion_id          text         not null,              -- ID del proveedor (texto: admite IDs no numéricos)
  nombre               text,
  partido              text,
  provincia            text,
  lat                  numeric,                            -- con signo (SNIH las da sin signo: se agrega)
  lon                  numeric,
  precision_ubicacion  text,                               -- 'declarada por la red', 'medida', …
  fuente_ubicacion     text,                               -- de dónde salió la coordenada
  activa               boolean      not null default true,
  metadatos            jsonb        not null default '{}'::jsonb,  -- red interna, tipo, alta/baja, mide_lluvia, licencia…
  actualizado_en       timestamptz  not null default now(),
  primary key (red, estacion_id),
  constraint estaciones_lat_rango check (lat is null or (lat between -90 and 90)),
  constraint estaciones_lon_rango check (lon is null or (lon between -180 and 180))
);

comment on table estaciones is
  'Catálogo común de estaciones meteorológicas de todas las redes (SNIH desde _v873). Dato INTERNO:
   no se muestra al productor. RLS activa SIN políticas: anon/authenticated no ven nada.';

create table if not exists estaciones_obs (
  red            text         not null,
  estacion_id    text         not null,
  fecha          date         not null,                    -- día local de Argentina (UTC−3)
  lluvia_mm      numeric,                                  -- NULL = sin dato (nunca 0 por falta)
  horas_validas  smallint,                                 -- 0..24; < 24 = día incompleto
  hora_corte     time,                                     -- hora LOCAL de corte del día (SNIH: 00:00)
  tmin_c         numeric,                                  -- °C (SNIH: no se pide; NULL)
  tmax_c         numeric,                                  -- °C
  leido_en       timestamptz  not null default now(),
  url            text,                                     -- endpoint del que salió
  crudo          jsonb        not null,                    -- pedido + horas tal como vinieron + marcas
  primary key (red, estacion_id, fecha),
  foreign key (red, estacion_id) references estaciones (red, estacion_id),
  constraint estaciones_obs_lluvia_rango check (lluvia_mm is null or (lluvia_mm >= 0 and lluvia_mm < 500)),
  constraint estaciones_obs_horas_rango  check (horas_validas is null or (horas_validas between 0 and 24)),
  constraint estaciones_obs_sin_horas_sin_lluvia check (horas_validas is distinct from 0 or lluvia_mm is null),
  constraint estaciones_obs_tmin_rango   check (tmin_c is null or (tmin_c > -40 and tmin_c < 60)),
  constraint estaciones_obs_tmax_rango   check (tmax_c is null or (tmax_c > -40 and tmax_c < 60))
);

comment on table estaciones_obs is
  'Una fila por red, estación y día local (UTC−3) cortado a hora_corte. NULL = faltante, NUNCA 0.
   horas_validas < 24 = día incompleto (lluvia_mm es parcial); 0 horas = lluvia NULL.
   SNIH: lluvia horaria cruda del sensor (no validada), sumada por día; licencia SNIH ap. 7 (citar
   fuente y fecha). Dato INTERNO: no se muestra al productor. RLS activa SIN políticas.';

create index if not exists estaciones_obs_fecha_idx on estaciones_obs (fecha);

-- RLS: sin políticas a propósito. Sólo el server con el pool (que bypasea RLS);
-- desde el navegador (anon / authenticated) las tablas quedan cerradas.
alter table estaciones enable row level security;
alter table estaciones_obs enable row level security;
revoke all on table estaciones, estaciones_obs from anon, authenticated;
