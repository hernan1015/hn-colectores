-- HN AGRO · vigía de SATCHI · lo que ya se avisó (para no repetir). ESCRITA Y SIN APLICAR: la aplica local con el OK
-- del maker (ponerle el número que siga en hn-agro/migrations al copiarla). No guarda datos de nadie: sólo escalas
-- públicas del INA/Prefectura y focos de calor públicos (FIRMS/GOES), con la hora del aviso.
begin;

create table if not exists public.satchi_vigia_avisos (
  clave         text primary key,                     -- 'escala:24:evacuacion' · 'prono:34:evacuacion72' · 'foco:formosa:-25.1:-60.2'
  tipo          text not null check (tipo in ('crecida', 'crecida_pronostico', 'foco')),
  activo        boolean not null default true,        -- crecidas: true mientras siga cruzando (se rearma al bajar)
  detalle       jsonb,                                -- lo que se avisó (altura, cota, lugar del foco…)
  primer_aviso  timestamptz not null default now(),
  ultimo_aviso  timestamptz not null default now(),
  actualizado   timestamptz not null default now()
);
create index if not exists satchi_vigia_avisos_ultimo on public.satchi_vigia_avisos (ultimo_aviso desc);

-- Nadie de la app la lee ni la escribe: RLS prendida y SIN políticas para anon/authenticated.
alter table public.satchi_vigia_avisos enable row level security;
revoke all on public.satchi_vigia_avisos from anon, authenticated;

-- El vigía entra con un rol PROPIO que sólo ve esta tabla (en vez de la service_role, que ve toda la base).
-- El rol NO tiene clave acá: con PostgREST se usa un JWT firmado con el JWT secret del proyecto con
-- {"role": "satchi_vigia"} (lo arma local; ver vigia/LEEME.md). Si se prefiere, se puede usar la service_role.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'satchi_vigia') then
    create role satchi_vigia nologin;
  end if;
end $$;
grant satchi_vigia to authenticator;
grant usage on schema public to satchi_vigia;
grant select, insert, update on public.satchi_vigia_avisos to satchi_vigia;
drop policy if exists satchi_vigia_todo on public.satchi_vigia_avisos;
create policy satchi_vigia_todo on public.satchi_vigia_avisos for all to satchi_vigia using (true) with check (true);

commit;
