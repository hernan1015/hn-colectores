// HN AGRO · firmador-r2 · firma los GET de R2 (7 días) y los deja en public.r2_enlaces. Ver firmador-r2/LEEME.md.
// Variables (secretos de Actions; nunca se imprimen): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
// SUPABASE_FIRMADOR_URL (rol firmador_r2) y SUPABASE_FIRMADOR_CA (PEM, OBLIGATORIO: sin él no se conecta).
// Entradas: DIAS_RAYOS (3; 1..7).
// Salida: 0 = todo firmado, verificado y escrito; 1 = errores o faltantes (lo verificado se escribe igual);
// 2 = no arrancó (faltan secretos, URL o CA inválidos). Nunca se imprime e.message: sólo códigos.
import fs from 'node:fs';
import { r2Firmador } from './lib/r2.mjs';
import { upsertEnlaces, conectar, opcionesConexion } from './lib/base.mjs';
import { correr, resumenMd, DIAS_RAYOS } from './lib/firmador.mjs';
import { codigoDe } from './lib/errores.mjs';

const env = process.env;
const salir = (codigo, texto) => { console.error('firmador-r2: ' + texto); process.exit(codigo); };
process.on('unhandledRejection', (e) => salir(2, 'error inesperado (' + codigoDe(e) + ')'));
process.on('uncaughtException', (e) => salir(2, 'error inesperado (' + codigoDe(e) + ')'));

let r2;
try {
  r2 = r2Firmador({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET });
  opcionesConexion(env.SUPABASE_FIRMADOR_URL, env.SUPABASE_FIRMADOR_CA);   // antes de tocar R2: sin CA/URL válidas no se arranca
} catch (e) { salir(2, 'no arrancó (' + codigoDe(e) + ')'); }

let db = null;
const res = await correr({
  listar: (p) => r2.listar(p),
  presignar: (k, f) => r2.presignar(k, f),
  fetchFn: fetch,
  upsert: async (filas) => {
    db = await conectar(env.SUPABASE_FIRMADOR_URL, { ca: env.SUPABASE_FIRMADOR_CA });
    return upsertEnlaces(db.query, filas);
  },
}, { diasRayos: Number(env.DIAS_RAYOS || DIAS_RAYOS) });
if (db) await db.cerrar().catch(() => {});

const md = resumenMd(res);
console.log(md);
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
process.exit(res.codigo);
