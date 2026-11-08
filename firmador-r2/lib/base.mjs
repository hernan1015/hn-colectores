// HN AGRO · firmador-r2 · upsert en public.r2_enlaces (migración 0129 de hn-agro).
// Columnas reales de 0129: clave (pk), url, vence, emitido (date), bytes (integer), actualizado (default now()).
// Reglas:
//  - nunca se borra una fila;
//  - un enlace sólo se reemplaza por otro que vence igual o más tarde (si la PC de local firmó después, queda el suyo);
//  - emitido desconocido (null) no pisa el que había;
//  - idempotente: correrlo dos veces con la misma fecha deja la tabla igual.
// `query(sql, params)` → { rows } o el array de filas (pg y PGlite devuelven { rows }).

export const SQL_UPSERT = `insert into public.r2_enlaces as t (clave, url, vence, emitido, bytes, actualizado)
select x.clave, x.url, x.vence, x.emitido, x.bytes, now()
  from unnest($1::text[], $2::text[], $3::timestamptz[], $4::date[], $5::integer[]) as x(clave, url, vence, emitido, bytes)
on conflict (clave) do update
   set url = excluded.url,
       vence = excluded.vence,
       emitido = coalesce(excluded.emitido, t.emitido),
       bytes = coalesce(excluded.bytes, t.bytes),
       actualizado = now()
 where t.vence <= excluded.vence
returning t.clave, (xmax = 0) as nueva`;

const MAX_INT = 2147483647;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** filas [{clave, url, vence: Date, emitido: 'AAAA-MM-DD'|null, bytes: number|null}] → { nuevas, actualizadas, sinCambio } */
export async function upsertEnlaces(query, filas) {
  if (!filas.length) return { nuevas: 0, actualizadas: 0, sinCambio: 0 };
  const claves = new Set();
  for (const f of filas) {
    if (!f || typeof f.clave !== 'string' || !f.clave) throw new Error('upsert: fila sin clave');
    if (claves.has(f.clave)) throw new Error('upsert: clave repetida ' + f.clave);
    claves.add(f.clave);
    if (typeof f.url !== 'string' || !f.url.startsWith('https://')) throw new Error('upsert: url inválida en ' + f.clave);
    if (!(f.vence instanceof Date) || Number.isNaN(f.vence.getTime())) throw new Error('upsert: vence inválido en ' + f.clave);
  }
  const r = await query(SQL_UPSERT, [
    filas.map((f) => f.clave),
    filas.map((f) => f.url),
    filas.map((f) => f.vence.toISOString()),
    filas.map((f) => (ISO.test(String(f.emitido || '')) ? f.emitido : null)),
    filas.map((f) => (Number.isInteger(f.bytes) && f.bytes >= 0 && f.bytes <= MAX_INT ? f.bytes : null)),
  ]);
  const rows = Array.isArray(r) ? r : (r && r.rows) || [];
  const nuevas = rows.filter((x) => x.nueva === true || x.nueva === 't').length;
  return { nuevas, actualizadas: rows.length - nuevas, sinCambio: filas.length - rows.length };
}

/** Cliente pg para SUPABASE_FIRMADOR_URL. Se saca sslmode de la URL para que mande el objeto ssl de acá
    (si no, pg-connection-string lo pisa). Con SUPABASE_FIRMADOR_CA (PEM) verifica el certificado; sin él, como el
    resto de los repos (hn-agro, hn-agro-modelos): TLS sin verificar la cadena. */
export async function conectar(url, { ca = '' } = {}) {
  const { default: pg } = await import('pg');
  const u = new URL(url);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(p);
  const cliente = new pg.Client({
    connectionString: u.toString(),
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    statement_timeout: 30000,
    connectionTimeoutMillis: 20000,
    application_name: 'hn-firmador-r2',
  });
  await cliente.connect();
  return { query: (sql, params) => cliente.query(sql, params), cerrar: () => cliente.end() };
}
