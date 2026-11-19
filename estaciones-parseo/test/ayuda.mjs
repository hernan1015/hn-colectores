// HN AGRO · estaciones-parseo · lo común de los tests (no es un test).
// PGlite va FUERA del repo: HN_PGLITE=<…>/node_modules/@electric-sql/pglite. Sin él, los tests de la base se saltean.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIX = path.join(RAIZ, 'test', 'fixtures', 'r2');
export const AHORA = Date.parse('2026-01-10T16:30:00Z');
export const HAY_PGLITE = !!process.env.HN_PGLITE && fs.existsSync(path.join(process.env.HN_PGLITE, 'dist', 'index.js'));
export const SIN_PGLITE = HAY_PGLITE ? false : 'falta PGlite (HN_PGLITE → node_modules/@electric-sql/pglite, fuera del repo)';
export async function PGlite() {
  return (await import(pathToFileURL(path.join(process.env.HN_PGLITE, 'dist', 'index.js')).href)).PGlite;
}
/** Una ronda de las fixtures, ya abierta como la abre parsear.mjs. */
export function ronda(rel, abrir) {
  const t = fs.readFileSync(path.join(FIX, 'estaciones-internas', rel), 'utf8');
  return abrir ? abrir(t) : JSON.parse(t);
}
/** Todos los archivos de texto de una carpeta (para los controles de lo que hay en el repo). */
export function archivos(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, out); else out.push(p);
  }
  return out;
}
