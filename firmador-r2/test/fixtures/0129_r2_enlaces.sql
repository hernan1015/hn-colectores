-- HN AGRO · enlaces firmados de Cloudflare R2 (25/10/2026) · APLICADA el 25/10 por la sesión local (MCP).
-- La PC sube un archivo a R2 (depósito privado) y deja acá un enlace firmado que vence a los 7 días.
-- Las funciones de Netlify lo leen por el pool (sin llaves de R2 en Netlify). Sólo servidor: sin acceso anon/authenticated.
create table if not exists public.r2_enlaces (
  clave       text primary key,              -- p. ej. 'tormentas/proyeccion_tormentas.json'
  url         text not null,                 -- GET firmado (SigV4, X-Amz-Expires=604800)
  vence       timestamptz not null,
  emitido     date,                          -- fecha del dato (el «emitido» del JSON)
  bytes       integer,
  actualizado timestamptz not null default now()
);
alter table public.r2_enlaces enable row level security;
revoke all on public.r2_enlaces from anon, authenticated;
comment on table public.r2_enlaces is 'Enlaces firmados a objetos privados de R2 (los escribe la PC; los lee el servidor). 0129.';
