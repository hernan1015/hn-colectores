// HN AGRO · firmador-r2 · upsert en public.r2_enlaces (migración 0129 de hn-agro).
// Columnas reales de 0129: clave (pk), url, vence, emitido (date), bytes (integer), actualizado (default now()).
// Reglas:
//  - nunca se borra una fila;
//  - un enlace sólo se reemplaza por otro que vence igual o más tarde (si la PC de local firmó después, queda el suyo);
//  - emitido desconocido (null) no pisa el que había;
//  - idempotente: correrlo dos veces con la misma fecha deja la tabla igual.
// `query(sql, params)` → { rows } o el array de filas (pg y PGlite devuelven { rows }).

import { errorCodigo, codigoDe } from "./errores.mjs";

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
    if (!f || typeof f.clave !== 'string' || !f.clave) throw errorCodigo('upsert_fila_sin_clave');
    if (claves.has(f.clave)) throw errorCodigo('upsert_clave_repetida');
    claves.add(f.clave);
    if (typeof f.url !== 'string' || !f.url.startsWith('https://')) throw errorCodigo('upsert_url_invalida');
    if (!(f.vence instanceof Date) || Number.isNaN(f.vence.getTime())) throw errorCodigo('upsert_vence_invalido');
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

const PEM = /-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]{64,}-----END CERTIFICATE-----/;

/** PURA. Opciones de pg.Client para SUPABASE_FIRMADOR_URL. TLS OBLIGATORIO Y VERIFICADO (2.ª vuelta, Codex n3):
    sin SUPABASE_FIRMADOR_CA (PEM) no hay conexión; siempre ssl: { ca, rejectUnauthorized: true }.
    Se sacan de la URL todos los parámetros ssl* (y uselibpqcompat): pg-connection-string pisa el objeto ssl con lo que
    diga la URL, y un «sslmode=disable» o «sslmode=no-verify» apagaría la verificación. Errores: sólo códigos. */
export function opcionesConexion(url, ca) {
  if (typeof ca !== 'string' || !PEM.test(ca)) throw errorCodigo('base_sin_ca');
  let u;
  try { u = new URL(String(url || '')); } catch { throw errorCodigo('base_url_invalida'); }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw errorCodigo('base_url_invalida');
  for (const p of [...u.searchParams.keys()]) if (/^ssl/i.test(p) || p === 'uselibpqcompat') u.searchParams.delete(p);
  return {
    connectionString: u.toString(),
    ssl: { ca, rejectUnauthorized: true },
    statement_timeout: 30000,
    connectionTimeoutMillis: 20000,
    application_name: 'hn-firmador-r2',
  };
}

/** Cliente pg. Valida antes de importar pg o abrir el socket: sin CA no sale ni un paquete. */
export async function conectar(url, { ca = '', Cliente = null } = {}) {
  const opciones = opcionesConexion(url, ca);
  const C = Cliente || (await import('pg')).default.Client;
  const cliente = new C(opciones);
  try { await cliente.connect(); } catch (e) { throw errorCodigo('base_no_conecta_' + codigoDe(e).toLowerCase()); }
  return { query: (sql, params) => cliente.query(sql, params), cerrar: () => cliente.end() };
}
