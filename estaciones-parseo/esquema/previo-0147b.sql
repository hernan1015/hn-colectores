-- COPIA para los tests: las políticas y los grants de la 0147b (sin el rol con contraseña, que crea previo.sql).
grant select, insert, update on table estaciones to colector_estaciones;
grant select, insert, update on table estaciones_obs to colector_estaciones;
grant select, insert, update on table pronostico_helada_medicion to colector_estaciones;
grant insert on table registro_procesos to colector_estaciones;
grant usage on sequence registro_procesos_id_seq to colector_estaciones;
do $$
declare t text;
begin
  foreach t in array array['estaciones', 'estaciones_obs', 'pronostico_helada_medicion'] loop
    execute format(
      'create policy colector_estaciones_sus_redes on public.%I for all to colector_estaciones
         using (red in (''INTA_SIPAN_AV'', ''WEATHERLINK_PUB''))
         with check (red in (''INTA_SIPAN_AV'', ''WEATHERLINK_PUB''))', t);
  end loop;
  create policy colector_estaciones_sus_procesos on public.registro_procesos for insert to colector_estaciones
    with check (proceso in ('sipan_alto_valle', 'sipan_medicion_heladas', 'weatherlink_publico'));
end $$;
alter table public.registro_procesos enable row level security;
