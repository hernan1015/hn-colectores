// HN AGRO · firmador-r2 · firma los GET de R2 (7 días) y los deja en public.r2_enlaces. Ver firmador-r2/LEEME.md.
// Variables (secretos de Actions; nunca se imprimen): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
// SUPABASE_FIRMADOR_URL (rol firmador_r2) y, opcional, SUPABASE_FIRMADOR_CA (PEM). Entradas: DIAS_RAYOS (3; 1..7).
// Sale con 1 si hubo errores o falta un objeto esperado de tormentas/escenarios/OPERA (lo que había se escribe igual).
import fs from 'node:fs';
import { r2Firmador } from './lib/r2.mjs';
import { upsertEnlaces, conectar } from './lib/base.mjs';
import { correr, resumenMd, DIAS_RAYOS } from './lib/firmador.mjs';

const env = process.env;
const r2 = r2Firmador({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET });
if (!env.SUPABASE_FIRMADOR_URL) { console.error('falta SUPABASE_FIRMADOR_URL'); process.exit(2); }

let db = null;
const res = await correr({
  listar: (p) => r2.listar(p),
  presignar: (k, f) => r2.presignar(k, f),
  fetchFn: fetch,
  upsert: async (filas) => {
    db = await conectar(env.SUPABASE_FIRMADOR_URL, { ca: env.SUPABASE_FIRMADOR_CA || '' });
    return upsertEnlaces(db.query, filas);
  },
}, { diasRayos: Number(env.DIAS_RAYOS || DIAS_RAYOS) });
if (db) await db.cerrar().catch(() => {});

const md = resumenMd(res);
console.log(md);
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
process.exit(res.codigo);
