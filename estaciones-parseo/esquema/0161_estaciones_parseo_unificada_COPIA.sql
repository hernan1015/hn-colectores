-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- HN AGRO · 0161 · LA CARGA LIMPIA DE LAS ESTACIONES (R2 → base): la 0152 unificada, rehecha.            [19/11/2026]
--   · estaciones_redes: una fila por red, con su marca mostrar / interno (mostrar = false por defecto);
--   · estaciones: la marca por estación (mostrar, false por defecto), la duplicada a < 2 km y la firma del parseo;
--   · estaciones_lecturas: las lecturas de cada estación (temperatura, humedad, lluvia, viento, presión), 8-10 días;
--   · el rol colector_estaciones (0147b) escribe las redes nuevas del parseo, sin borrar nada;
--   · estaciones_comparar_punto(lat, lon): la vista INTERNA para comparar un punto, sólo para el maker.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ PROPUESTA · NO APLICADA. La aplica local, después de revisarla. Se pega ENTERA en el editor SQL de Supabase (o el
--   MCP), como postgres: no tiene variables de psql y va entre BEGIN y COMMIT.
--   Necesita, ya aplicadas: 0020 (is_maker), 0075 (registro_procesos), 0110 (estaciones), 0147 y 0147b (el rol
--   colector_estaciones y sus políticas). Con la 0151 o sin ella, y con la 0152 o sin ella: las listas de redes y de
--   procesos de las políticas se UNEN con lo que ya tengan (no se pisa nada de lo que otra migración haya agregado).
--   El número: la última aplicada es la 0160; ninguna rama de hn-agro ni de hn-colectores tiene una 0161 (19/11).
--   La de la rama feat/parseo-estaciones (0152 unificada, PR #13) NO se aplica: ésta la reemplaza.
--   El parseo que la usa: hn-colectores, estaciones-parseo/ (rama feat/estaciones-parseo-limpio).
--
-- ⛔ INTERNO. Nada de esto se abre al público:
--   · anon no tiene ningún permiso (ni sobre las tablas ni sobre las funciones);
--   · authenticated puede LEER sólo si el JWT dice role = maker (is_maker(), 0020): RLS «sólo el maker»;
--   · la app llega por las functions de Netlify con el pool (el dueño, que saltea la RLS) y la puerta de maker.
--   WeatherLink, Weathercloud y el SIPAN quedan INTERNOS por CHECK: no hay UPDATE que los pase a mostrar.
--   Las demás nacen en interno (Paso 0 de la 139: términos sin leer, «derechos reservados» o sin términos). SMN
--   (CC BY 2.5 AR) y SNIH (apartado 7) PERMITEN mostrar según el Paso 0, pero también nacen en false: lo decide el
--   maker con un UPDATE de estaciones_redes, en otra pieza.
--
-- Reglas que la base hace cumplir (aunque el parseo se equivoque):
--   · mostrar = false por defecto. El rol del colector NO puede poner mostrar = true (el disparador lo fuerza a false
--     al insertar y conserva el valor anterior al actualizar). Nadie puede mostrar una estación de una red interna.
--   · NULL es «no hay dato», nunca 0: no hay DEFAULT 0 en ninguna variable y una lectura sin ninguna variable no entra.
--   · los imposibles no entran: temperatura ≥ 50 °C o ≤ −40 °C, humedad 0 o > 100 (el 255 de las consolas), viento,
--     presión y lluvia fuera de rango. El parseo los deja en NULL con una marca, así no entran en los extremos.
--   · una lectura no puede ser de más de 15 min DESPUÉS de cuando se leyó (relojes corridos), ni de más de 8 días antes.
--     La regla de las 12 h de la 139 la aplica el parseo (las lecturas «instantáneas»); los archivos de consola de
--     Entre Ríos traen ~1 semana y por eso el piso de la base es de 8 días.
--   · idempotente por la firma: el parseo sólo escribe una fila si su firma cambió y no tiene menos datos que la guardada.
--
-- Idempotente: se puede correr dos veces (if not exists, create or replace, políticas que se alteran).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

begin;
-- estaciones es chica (~2.000 filas) y la usan pocos: si algo la tiene tomada, mejor cortar que esperar
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'colector_estaciones') then
    raise exception '0161: falta el rol colector_estaciones (aplicar antes la 0147b)';
  end if;
  if to_regclass('public.estaciones') is null or to_regclass('public.registro_procesos') is null then
    raise exception '0161: faltan estaciones (0110) o registro_procesos (0075)';
  end if;
  if to_regprocedure('public.is_maker()') is null then
    raise exception '0161: falta public.is_maker() (0020)';
  end if;
  if current_user in ('anon', 'authenticated', 'service_role', 'colector_estaciones') then
    raise exception '0161: aplicala como postgres, no como %', current_user;
  end if;
end $$;

-- ── 1. Las redes, con su marca ──────────────────────────────────────────────────────────────────────────────────
create table if not exists public.estaciones_redes (
  red            text         primary key,
  nombre         text         not null,                 -- la fuente, para la vista interna
  mostrar        boolean      not null default false,   -- false = INTERNO
  terminos       text,                                  -- lo que dice el Paso 0 de la 139 (resumen)
  terminos_url   text,
  prioridad      smallint     not null default 50,      -- la preferida entre duplicadas: la de número MENOR
  actualizado_en timestamptz  not null default now(),
  constraint estaciones_redes_privadas_internas
    check (not mostrar or red not in ('WEATHERLINK_PUB', 'WEATHERCLOUD_PUB', 'INTA_SIPAN_AV'))
);
comment on table public.estaciones_redes is
  'Una fila por red de estaciones, con su marca mostrar (false = interno, el default). WeatherLink, Weathercloud y SIPAN: interno por CHECK.';

insert into public.estaciones_redes (red, nombre, terminos, terminos_url, prioridad) values
  ('SMN_ABIERTO',      'SMN, datos abiertos',            'CC BY 2.5 AR: permite mostrar con cita (Paso 0 139, fila 5a). Nace interno: lo decide el maker.', 'https://argentina.gob.ar/normativa/361173_disp25_pdf/archivo', 5),
  ('SIGA_RT',          'INTA SIGA',                      'Términos no leídos (el sitio no respondió el 13/11): interno.', null, 10),
  ('INTA_SIPAN_AV',    'INTA SIPAN Alto Valle',          'Términos no leídos: interno hasta el permiso del INTA.', null, 10),
  ('SNIH',             'SNIH',                           'Apartado 7: permite mostrar con cita (Paso 0 139, fila 15). Nace interno: lo decide el maker.', 'https://snih.hidricosargentina.gob.ar/Terminos.aspx', 15),
  ('INA_ALERTA',       'INA, sistema de alerta (a5)',    'Sin términos publicados para la a5: interno.', null, 20),
  ('EEAOC',            'EEAOC Tucumán',                  '«Todos los derechos reservados»: interno.', null, 30),
  ('DACC_MZA',         'Mendoza DACC',                   'Sin términos publicados: interno.', null, 30),
  ('REM_SL',           'San Luis REM',                   'Sin términos publicados: interno.', null, 30),
  ('BCP_RT',           'BCP Bahía Blanca',               'Interno (decisión del maker, 13/10).', null, 30),
  ('BCP',              'BCP Bahía Blanca (diario)',      'Interno (decisión del maker, 13/10).', null, 30),
  ('ER_HIDRAULICA',    'Entre Ríos, Hidráulica',         'Sin términos publicados; dato crudo sin validar: interno.', null, 30),
  ('WEATHERLINK_PUB',  'WeatherLink (Davis)',            'Los términos de Davis prohíben los robots: interno hasta el permiso escrito.', 'https://www.davisinstruments.com/policies/terms-of-service', 80),
  ('WEATHERCLOUD_PUB', 'Weathercloud',                   'Sus términos prohíben el scraping: interno hasta el permiso escrito.', 'https://weathercloud.net/legal/tos', 90)
on conflict (red) do nothing;
-- las redes que ya tengan estaciones y no estén en la lista: también, en interno (las necesita la FK de abajo)
insert into public.estaciones_redes (red, nombre)
  select distinct e.red, e.red from public.estaciones e
on conflict (red) do nothing;

-- ── 2. La marca por estación, la duplicada y la firma del parseo ───────────────────────────────────────────────
alter table public.estaciones add column if not exists mostrar          boolean not null default false;
alter table public.estaciones add column if not exists duplicado_de_red text;
alter table public.estaciones add column if not exists duplicado_de_id  text;
alter table public.estaciones add column if not exists parseo_firma     text;
comment on column public.estaciones.mostrar is 'false = interno (el default). Sólo puede ser true si la red está en mostrar.';
comment on column public.estaciones.duplicado_de_red is
  'Si hay otra estación de OTRA red a < 2 km, la preferida (estaciones_marcar_duplicados). NULL = ésta es la preferida o no tiene duplicada. Se guardan las dos.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'estaciones_privadas_internas') then
    alter table public.estaciones add constraint estaciones_privadas_internas
      check (not mostrar or red not in ('WEATHERLINK_PUB', 'WEATHERCLOUD_PUB', 'INTA_SIPAN_AV'));
  end if;
  -- [Codex n3 0161 §2] toda estación tiene su red en estaciones_redes: no hay estación visible de una red que no existe.
  -- Sin ON UPDATE/DELETE: una red con estaciones no se borra ni se renombra (además lo prohíbe el disparador de redes).
  if not exists (select 1 from pg_constraint where conname = 'estaciones_red_fk') then
    alter table public.estaciones add constraint estaciones_red_fk foreign key (red) references public.estaciones_redes (red);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'estaciones_duplicado_forma') then
    alter table public.estaciones add constraint estaciones_duplicado_forma
      check ((duplicado_de_red is null) = (duplicado_de_id is null)
             and (duplicado_de_red is null or duplicado_de_red <> red));
  end if;
end $$;

-- El disparador de la marca: el colector no la puede cambiar; nadie puede mostrar una estación de una red interna.
-- SECURITY INVOKER a propósito: current_user es quien escribe (con DEFINER sería siempre el dueño).
create or replace function public.estaciones_mostrar_guardia() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
declare red_mostrar boolean;
begin
  if current_user = 'colector_estaciones' then
    if tg_op = 'INSERT' then
      new.mostrar := false;
      new.duplicado_de_red := null;
      new.duplicado_de_id := null;
    else
      new.mostrar := old.mostrar;
      new.duplicado_de_red := old.duplicado_de_red;
      new.duplicado_de_id := old.duplicado_de_id;
    end if;
  end if;
  if new.mostrar then
    -- [Codex n3 0161 §2] FOR SHARE: se serializa con el cambio de visibilidad de la red (el UPDATE de la red espera a
    -- esta transacción, y ésta espera a la que la esté cambiando y relee su valor). Sólo llega acá quien quiere mostrar:
    -- el colector nunca (su mostrar es siempre false), así que no le hace falta permiso de bloqueo.
    select r.mostrar into red_mostrar from public.estaciones_redes r where r.red = new.red for share;
    if not coalesce(red_mostrar, false) then
      raise exception 'estaciones: la estación no se puede mostrar porque su red (%) es interna', new.red using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists estaciones_mostrar_guardia on public.estaciones;
create trigger estaciones_mostrar_guardia before insert or update on public.estaciones
  for each row execute function public.estaciones_mostrar_guardia();

-- Si una red vuelve a interno, sus estaciones también. Una red NO se renombra (con estaciones o sin ellas): se crea otra.
create or replace function public.estaciones_redes_a_interno() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.red is distinct from old.red then
    raise exception 'estaciones_redes: una red no se renombra (crear otra)' using errcode = '23514';
  end if;
  if not new.mostrar then
    update public.estaciones set mostrar = false where red = new.red and mostrar;
  end if;
  new.actualizado_en := now();
  return new;
end $$;
drop trigger if exists estaciones_redes_a_interno on public.estaciones_redes;
create trigger estaciones_redes_a_interno before update on public.estaciones_redes
  for each row execute function public.estaciones_redes_a_interno();

-- ── 3. Las lecturas ─────────────────────────────────────────────────────────────────────────────────────────────
-- Una fila por (red, estación, instante). Unidades ya convertidas: °C, %, mm, m/s, grados, hPa.
-- Volumen: ~1.300 estaciones × 24 lecturas/día × 10 días ≈ 310.000 filas (~60 MB con el índice). La poda
-- (estaciones_lecturas_podar) deja 10 días: alcanza para la serie de 7 y no crece.
create table if not exists public.estaciones_lecturas (
  red                 text         not null,
  estacion_id         text         not null,
  instante            timestamptz  not null,               -- cuándo midió la estación
  temp_c              numeric,
  hum_pct             numeric,
  lluvia_mm           numeric,                             -- la lluvia del PERÍODO que termina en `instante`
  lluvia_periodo_min  smallint,                            -- su largo: 10 (registro de consola), 1440 (INA, de 9 a 9)
  lluvia_dia_mm       numeric,                             -- el acumulado del día que da la consola (se reinicia a las 00)
  viento_ms           numeric,
  racha_ms            numeric,
  viento_dir_gr       numeric,
  presion_hpa         numeric,
  marcas              text[]       not null default '{}',  -- 'temp_imposible', 'hum_imposible', … (el valor queda en crudo)
  crudo               jsonb        not null default '{}'::jsonb,  -- sólo lo que no entró (imposibles, unidad sin confirmar)
  firma               text         not null,               -- la del contenido: si no cambia, no se vuelve a escribir
  leido_en            timestamptz  not null,               -- cuándo la leyó la ronda (el `leido` de R2)
  primary key (red, estacion_id, instante),
  foreign key (red, estacion_id) references public.estaciones (red, estacion_id),
  constraint el_temp      check (temp_c is null or (temp_c > -40 and temp_c < 50)),
  constraint el_hum       check (hum_pct is null or (hum_pct > 0 and hum_pct <= 100)),
  constraint el_lluvia    check (lluvia_mm is null or (lluvia_mm >= 0 and lluvia_mm < 500)),
  constraint el_lluvia_periodo check ((lluvia_mm is null or lluvia_periodo_min is not null)
                                      and (lluvia_periodo_min is null or lluvia_periodo_min between 1 and 1440)),
  constraint el_lluvia_dia check (lluvia_dia_mm is null or (lluvia_dia_mm >= 0 and lluvia_dia_mm < 500)),
  constraint el_viento    check (viento_ms is null or (viento_ms >= 0 and viento_ms < 100)),
  constraint el_racha     check (racha_ms is null or (racha_ms >= 0 and racha_ms < 100)),
  constraint el_dir       check (viento_dir_gr is null or (viento_dir_gr >= 0 and viento_dir_gr <= 360)),
  constraint el_presion   check (presion_hpa is null or (presion_hpa >= 850 and presion_hpa <= 1100)),
  constraint el_algo      check (num_nonnulls(temp_c, hum_pct, lluvia_mm, lluvia_dia_mm, viento_ms, racha_ms, viento_dir_gr, presion_hpa) > 0),
  constraint el_no_futura check (instante <= leido_en + interval '15 minutes'),
  constraint el_no_vieja  check (instante >= leido_en - interval '8 days'),
  constraint el_firma     check (firma ~ '^[0-9a-f]{16,64}$')
);
comment on table public.estaciones_lecturas is
  'Lecturas de las estaciones (parseo R2 → base, hn-colectores estaciones-parseo). NULL = sin dato, nunca 0. Interno: RLS sólo el maker.';
create index if not exists estaciones_lecturas_instante_idx on public.estaciones_lecturas (instante);

-- ── 4. Las funciones ────────────────────────────────────────────────────────────────────────────────────────────
-- La distancia (haversine, km). Sin PostGIS.
create or replace function public.estaciones_distancia_km(lat1 double precision, lon1 double precision,
                                                         lat2 double precision, lon2 double precision)
returns double precision language sql immutable strict set search_path = public, pg_temp as $$
  select 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2))))
$$;

-- La poda: deja `p_dias` días (mínimo 8, para que siempre esté la serie de 7). La llama el parseo.
create or replace function public.estaciones_lecturas_podar(p_dias integer default 10) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.estaciones_lecturas where instante < now() - make_interval(days => greatest(coalesce(p_dias, 10), 8));
  get diagnostics n = row_count;
  return n;
end $$;

-- Las duplicadas: dos estaciones de redes DISTINTAS a menos de p_radio_km (2 km) son, probablemente, la misma (o
-- miden lo mismo). Se guardan las DOS; la no preferida apunta a la preferida. La preferida: la red de menor
-- `prioridad` (las institucionales antes que las de particulares), después la que más lecturas tuvo en 7 días, y
-- después el orden de red e id (para que el resultado no dependa del azar). Sólo escribe lo que cambia.
-- [Codex n3 0161 §1] SIN tablas temporales (el que llama podría prepararlas con un disparador propio y hacerlo correr
-- con los permisos del dueño): los pares se calculan en una consulta y el reparto, en una variable de la función.
create or replace function public.estaciones_marcar_duplicados(p_radio_km double precision default 2) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  par record; n integer := 0;
  radio double precision := least(greatest(coalesce(p_radio_km, 2), 0.1), 5);
  pref jsonb := '{}'::jsonb;          -- clave de la reclamada → [red, id] de la preferida
  sep constant text := chr(31);
begin
  for par in
    with s as (
      select e.red, e.estacion_id, e.lat::float8 as lat, e.lon::float8 as lon,
             row_number() over (order by coalesce(r.prioridad, 50),
               (select count(*) from public.estaciones_lecturas l where l.red = e.red and l.estacion_id = e.estacion_id
                  and l.instante > now() - interval '7 days') desc, e.red, e.estacion_id) as orden
      from public.estaciones e left join public.estaciones_redes r on r.red = e.red
      where e.lat is not null and e.lon is not null and e.activa
    )
    select a.red as a_red, a.estacion_id as a_id, b.red as b_red, b.estacion_id as b_id
      from s a join s b on b.orden > a.orden and b.red <> a.red
       and b.lat between a.lat - radio / 110.0 and a.lat + radio / 110.0
       and b.lon between a.lon - radio / 60.0 and a.lon + radio / 60.0
     where public.estaciones_distancia_km(a.lat, a.lon, b.lat, b.lon) < radio
     order by a.orden, b.orden
  loop
    -- en orden de preferencia: la que ya fue reclamada no reclama; la que no, se queda con las de después a < 2 km
    continue when pref ? (par.a_red || sep || par.a_id);
    continue when pref ? (par.b_red || sep || par.b_id);
    pref := pref || jsonb_build_object(par.b_red || sep || par.b_id, jsonb_build_array(par.a_red, par.a_id));
  end loop;
  with nuevo as (
    select e.red, e.estacion_id, pref -> (e.red || sep || e.estacion_id) ->> 0 as pr, pref -> (e.red || sep || e.estacion_id) ->> 1 as pi
      from public.estaciones e
  )
  update public.estaciones e set duplicado_de_red = nv.pr, duplicado_de_id = nv.pi
    from nuevo nv
   where e.red = nv.red and e.estacion_id = nv.estacion_id
     and (e.duplicado_de_red is distinct from nv.pr or e.duplicado_de_id is distinct from nv.pi);
  get diagnostics n = row_count;
  return n;
end $$;

-- LA VISTA INTERNA para comparar un punto: las estaciones a ≤ p_radio_km (25 km como máximo) de (p_lat, p_lon), con
-- la distancia, la fuente, la marca, la última lectura, la serie de 7 días (UNA lectura por hora, la última de cada
-- hora: 168 puntos como mucho) y el resumen por día local (UTC−3). Como mucho, las 50 más cercanas. Las lecturas de
-- cada estación se leen UNA vez (→ la última, la horaria y el diario). SECURITY INVOKER: con RLS, quien no es el maker
-- no ve ninguna fila. [Codex n3 0161 §5] El punto se acota a la Argentina (lat −56…−20, lon −75…−52): no hay
-- antimeridiano ni polos.
create or replace function public.estaciones_comparar_punto(p_lat double precision, p_lon double precision,
                                                           p_radio_km double precision default 25,
                                                           p_hasta timestamptz default now())
returns table (red text, estacion_id text, nombre text, fuente text, mostrar boolean, preferida boolean, duplicado_de text,
               distancia_km numeric, lat numeric, lon numeric, ultima jsonb, serie jsonb, diario jsonb)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  dlat double precision; dlon double precision; desde timestamptz;
begin
  if p_lat is null or p_lon is null or p_lat < -56 or p_lat > -20 or p_lon < -75 or p_lon > -52 then
    raise exception 'estaciones_comparar_punto: el punto está fuera de la Argentina (lat −56…−20, lon −75…−52)' using errcode = '22023';
  end if;
  if p_radio_km is null or p_radio_km <= 0 or p_radio_km > 25 then
    raise exception 'estaciones_comparar_punto: el radio va de 0 a 25 km' using errcode = '22023';
  end if;
  if p_hasta is null then p_hasta := now(); end if;
  desde := p_hasta - interval '7 days';
  dlat := p_radio_km / 110.0;
  dlon := p_radio_km / (110.0 * cos(radians(p_lat)));
  return query
  with cerca as (
    select x.* from (
      select s.red as e_red, s.estacion_id as e_id, s.nombre as e_nombre, s.mostrar as e_mostrar, s.lat as e_lat, s.lon as e_lon,
             s.duplicado_de_red as e_dup_red, s.duplicado_de_id as e_dup_id,
             -- haversine en línea: la función de distancia no se le da a authenticated
             2 * 6371.0088 * asin(least(1, sqrt(power(sin(radians(s.lat::float8 - p_lat) / 2), 2)
               + cos(radians(p_lat)) * cos(radians(s.lat::float8)) * power(sin(radians(s.lon::float8 - p_lon) / 2), 2)))) as d
      from public.estaciones s
      where s.lat is not null and s.lon is not null
        and s.lat between p_lat - dlat and p_lat + dlat
        and s.lon between p_lon - dlon and p_lon + dlon
    ) x
    where x.d <= p_radio_km
    order by x.d, x.e_red, x.e_id
    limit 50
  ),
  lect as materialized (
    select c.e_red, c.e_id, l.instante, l.temp_c, l.hum_pct, l.lluvia_mm, l.lluvia_periodo_min, l.lluvia_dia_mm,
           l.viento_ms, l.racha_ms, l.viento_dir_gr, l.presion_hpa, l.marcas
      from cerca c join public.estaciones_lecturas l
        on l.red = c.e_red and l.estacion_id = c.e_id and l.instante > desde and l.instante <= p_hasta
  ),
  ult as (
    select distinct on (q.e_red, q.e_id) q.e_red, q.e_id,
           jsonb_build_object('instante', q.instante, 'temp_c', q.temp_c, 'hum_pct', q.hum_pct, 'lluvia_mm', q.lluvia_mm,
             'lluvia_periodo_min', q.lluvia_periodo_min, 'lluvia_dia_mm', q.lluvia_dia_mm, 'viento_ms', q.viento_ms,
             'racha_ms', q.racha_ms, 'viento_dir_gr', q.viento_dir_gr, 'presion_hpa', q.presion_hpa, 'marcas', q.marcas) as j
      from lect q order by q.e_red, q.e_id, q.instante desc
  ),
  hor as (
    select h.e_red, h.e_id, jsonb_agg(jsonb_build_object('instante', h.instante, 'temp_c', h.temp_c, 'hum_pct', h.hum_pct,
             'lluvia_mm', h.lluvia_mm, 'lluvia_periodo_min', h.lluvia_periodo_min, 'lluvia_dia_mm', h.lluvia_dia_mm,
             'viento_ms', h.viento_ms, 'racha_ms', h.racha_ms) order by h.instante) as j
      from (select u2.*, row_number() over (partition by u2.e_red, u2.e_id order by u2.instante desc) as k
              from (select distinct on (q.e_red, q.e_id, date_trunc('hour', q.instante at time zone 'UTC')) q.*
                      from lect q order by q.e_red, q.e_id, date_trunc('hour', q.instante at time zone 'UTC'), q.instante desc) u2) h
     where h.k <= 168                      -- las 168 horas más nuevas, como mucho
     group by h.e_red, h.e_id
  ),
  dia as (
    select dd.e_red, dd.e_id, jsonb_agg(to_jsonb(dd) - 'e_red' - 'e_id' order by dd.dia) as j
      from (select q.e_red, q.e_id, ((q.instante at time zone 'UTC') - interval '3 hours')::date as dia,
                   min(q.temp_c) as tmin_c, max(q.temp_c) as tmax_c, round(avg(q.hum_pct), 1) as hum_media_pct,
                   max(q.viento_ms) as viento_max_ms,
                   coalesce(max(q.lluvia_dia_mm), sum(q.lluvia_mm) filter (where q.lluvia_periodo_min < 1440)) as lluvia_mm,
                   case when max(q.lluvia_dia_mm) is not null then 'acumulado_consola'
                        when count(q.lluvia_mm) filter (where q.lluvia_periodo_min < 1440) > 0 then 'suma_registros' end as lluvia_origen,
                   sum(q.lluvia_mm) filter (where q.lluvia_periodo_min = 1440) as lluvia_9a9_mm,
                   count(*) as lecturas
              from lect q group by 1, 2, 3) dd
     group by dd.e_red, dd.e_id
  )
  select c.e_red, c.e_id, c.e_nombre, coalesce(r.nombre, c.e_red), c.e_mostrar, c.e_dup_red is null,
         case when c.e_dup_red is null then null else c.e_dup_red || ' · ' || c.e_dup_id end,
         round(c.d::numeric, 2), c.e_lat, c.e_lon, u.j, coalesce(h.j, '[]'::jsonb), coalesce(dd.j, '[]'::jsonb)
  from cerca c
  left join public.estaciones_redes r on r.red = c.e_red
  left join ult u on u.e_red = c.e_red and u.e_id = c.e_id
  left join hor h on h.e_red = c.e_red and h.e_id = c.e_id
  left join dia dd on dd.e_red = c.e_red and dd.e_id = c.e_id
  order by c.d, c.e_red, c.e_id;
end $$;
comment on function public.estaciones_comparar_punto(double precision, double precision, double precision, timestamptz) is
  'Vista INTERNA: estaciones a ≤ 25 km de un punto, con distancia, fuente, marca, última lectura y 7 días. Sólo el maker (RLS).';

-- ── 5. Permisos y RLS ───────────────────────────────────────────────────────────────────────────────────────────
alter table public.estaciones_redes enable row level security;
alter table public.estaciones_lecturas enable row level security;
-- Supabase da permisos por defecto a anon/authenticated sobre lo nuevo: se sacan todos y se da sólo lo de abajo.
revoke all on table public.estaciones_redes, public.estaciones_lecturas from anon, authenticated;
revoke all on table public.estaciones from anon;

grant select on table public.estaciones_redes to colector_estaciones;
grant select, insert, update on table public.estaciones_lecturas to colector_estaciones;
-- el maker (JWT role = maker) puede leer; nadie más de authenticated ve filas
grant select on table public.estaciones_redes, public.estaciones, public.estaciones_lecturas to authenticated;

drop policy if exists colector_estaciones_lee_redes on public.estaciones_redes;
create policy colector_estaciones_lee_redes on public.estaciones_redes for select to colector_estaciones using (true);
drop policy if exists solo_maker_lee on public.estaciones_redes;
create policy solo_maker_lee on public.estaciones_redes for select to authenticated using (public.is_maker());
drop policy if exists solo_maker_lee on public.estaciones;
create policy solo_maker_lee on public.estaciones for select to authenticated using (public.is_maker());
drop policy if exists solo_maker_lee on public.estaciones_lecturas;
create policy solo_maker_lee on public.estaciones_lecturas for select to authenticated using (public.is_maker());

-- Las funciones: anon nada. La vista, authenticated (con RLS: el maker) y service_role. La poda y las duplicadas, sólo el colector.
-- [Codex n3 0161 §3] TODAS las funciones nuevas: sin EXECUTE para PUBLIC, anon ni authenticated. La única excepción es la
-- vista, que authenticated necesita (y la RLS la deja vacía para quien no es el maker).
revoke all on function public.estaciones_distancia_km(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.estaciones_comparar_punto(double precision, double precision, double precision, timestamptz) from public, anon, authenticated;
grant execute on function public.estaciones_comparar_punto(double precision, double precision, double precision, timestamptz) to authenticated, service_role;
revoke all on function public.estaciones_lecturas_podar(integer) from public, anon, authenticated;
revoke all on function public.estaciones_marcar_duplicados(double precision) from public, anon, authenticated;
grant execute on function public.estaciones_lecturas_podar(integer) to colector_estaciones;
grant execute on function public.estaciones_marcar_duplicados(double precision) to colector_estaciones;
revoke all on function public.estaciones_mostrar_guardia() from public, anon, authenticated;
revoke all on function public.estaciones_redes_a_interno() from public, anon, authenticated;

-- Las políticas del colector: sus redes y sus procesos se UNEN con lo que ya tenían (0147b, 0151, 0152 si estaban).
do $$
declare
  nuevas constant text[] := array['WEATHERLINK_PUB', 'WEATHERCLOUD_PUB', 'SIGA_RT', 'EEAOC', 'DACC_MZA', 'REM_SL',
                                  'BCP_RT', 'ER_HIDRAULICA', 'INA_ALERTA'];
  redes text[] := nuevas; procesos text[] := array['estaciones_parseo']; expr text; p record; m text[]; actual text[];
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estaciones'
                  and policyname = 'colector_estaciones_sus_redes') then
    raise exception '0161: falta la política colector_estaciones_sus_redes en estaciones (aplicar antes la 0147b)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'registro_procesos'
                  and policyname = 'colector_estaciones_sus_procesos') then
    raise exception '0161: falta la política colector_estaciones_sus_procesos en registro_procesos (aplicar antes la 0147b)';
  end if;
  -- La lista que ya tiene cada política: Postgres la guarda como «x = ANY (ARRAY['a'::text, …])» o «x = ANY ('{a,…}'::text[])».
  -- Se evalúa ESE arreglo (es texto del catálogo, lo escribió postgres) y se une con lo nuevo. Si la forma es otra, se corta.
  for p in select pp.tablename, pp.qual, pp.with_check from pg_policies pp
            where pp.schemaname = 'public' and pp.policyname = 'colector_estaciones_sus_redes'
              and pp.tablename in ('estaciones', 'estaciones_lecturas') loop
    foreach expr in array array[p.qual, p.with_check] loop
      continue when expr is null;
      m := regexp_match(expr, '^\(red = ANY \((.*)\)\)$');
      if m is null then raise exception '0161: no entiendo la política de % (%): revisarla a mano', p.tablename, expr; end if;
      execute format('select (%s)::text[]', m[1]) into actual;
      redes := redes || actual;
    end loop;
  end loop;
  select array_agg(distinct x order by x) into redes from unnest(redes) x;
  expr := format('red = any (%L::text[])', redes);
  execute format('alter policy colector_estaciones_sus_redes on public.estaciones using (%s) with check (%s)', expr, expr);
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estaciones_lecturas'
              and policyname = 'colector_estaciones_sus_redes') then
    execute format('alter policy colector_estaciones_sus_redes on public.estaciones_lecturas using (%s) with check (%s)', expr, expr);
  else
    execute format('create policy colector_estaciones_sus_redes on public.estaciones_lecturas for all to colector_estaciones using (%s) with check (%s)', expr, expr);
  end if;
  select pp.with_check into expr from pg_policies pp
   where pp.schemaname = 'public' and pp.tablename = 'registro_procesos' and pp.policyname = 'colector_estaciones_sus_procesos';
  m := regexp_match(coalesce(expr, ''), '^\(proceso = ANY \((.*)\)\)$');
  if m is null then raise exception '0161: no entiendo la política de registro_procesos (%): revisarla a mano', expr; end if;
  execute format('select (%s)::text[]', m[1]) into actual;
  select array_agg(distinct x order by x) into procesos from unnest(procesos || actual) x;
  execute format('alter policy colector_estaciones_sus_procesos on public.registro_procesos with check (proceso = any (%L::text[]))', procesos);
end $$;

commit;

-- Verificación (a mano, después de aplicar):
--   select red, mostrar, prioridad from estaciones_redes order by prioridad, red;            -- todas en false
--   select tablename, qual from pg_policies where policyname like 'colector_estaciones_sus_%' order by 1;
--   update estaciones_redes set mostrar = true where red = 'WEATHERLINK_PUB';                -- ERROR: CHECK
--   select * from estaciones_comparar_punto(-34.6, -58.4);                                   -- como postgres: las de 25 km
--
-- ROLLBACK (comentado a propósito):
-- drop function if exists public.estaciones_comparar_punto(double precision, double precision, double precision, timestamptz);
-- drop function if exists public.estaciones_marcar_duplicados(double precision);
-- drop function if exists public.estaciones_lecturas_podar(integer);
-- drop function if exists public.estaciones_distancia_km(double precision, double precision, double precision, double precision);
-- drop table if exists public.estaciones_lecturas;
-- drop trigger if exists estaciones_mostrar_guardia on public.estaciones; drop function if exists public.estaciones_mostrar_guardia();
-- drop policy if exists solo_maker_lee on public.estaciones; revoke select on public.estaciones from authenticated;
-- alter table public.estaciones drop constraint if exists estaciones_privadas_internas, drop constraint if exists estaciones_duplicado_forma,
--   drop column if exists mostrar, drop column if exists duplicado_de_red, drop column if exists duplicado_de_id, drop column if exists parseo_firma;
-- drop table if exists public.estaciones_redes;  (y las políticas del colector vuelven a la lista de antes)
