// Las reglas del test ESTÁTICO de la 264: ningún colector abre Postgres sin pasar por lib/pg-tls.mjs.
// Separadas del test para poder probarlas con textos inventados (el control negativo) sin tocar el repo.
import fs from 'node:fs';
import path from 'node:path';

const IMPORTA_PG = /from\s*['"]postgres['"]|import\(\s*['"]postgres['"]\s*\)|require\(\s*['"]postgres['"]\s*\)/;
const IMPORTA_TLS = /from\s*['"](?:\.\.?\/)+(?:[\w.-]+\/)*lib\/pg-tls\.mjs['"]|from\s*['"]\.\/pg-tls\.mjs['"]/;
const USA_TLS = /\b(?:conTls|pgTls)\s*\(/;
/* lo que baja la verificación, en cualquier archivo (no sólo en los que importan postgres) */
const PROHIBIDOS = [
  [/rejectUnauthorized\s*:\s*(?:false|0|null|undefined|!1|['"])/, 'rejectUnauthorized que no es true'],
  [/NODE_TLS_REJECT_UNAUTHORIZED/, 'NODE_TLS_REJECT_UNAUTHORIZED'],
  [/\bssl\s*:\s*(?:false|0|null|['"](?:require|prefer|allow|disable|verify-ca)['"])/, "ssl: false/'require'/'prefer'/'allow' (no verifica)"],
  [/sslmode=(?:disable|allow|prefer|require|verify-ca)\b/, 'sslmode sin verify-full'],
];

/** Las violaciones de un archivo (lista vacía = pasa). `rel`: la ruta relativa, para el mensaje. */
export function revisar(texto, rel = '?') {
  const v = [];
  if (/\.(?:mjs|cjs|js)$/.test(rel) || rel === '?') {
    if (IMPORTA_PG.test(texto)) {
      if (!IMPORTA_TLS.test(texto)) v.push(`${rel}: importa postgres y no importa lib/pg-tls.mjs`);
      if (!USA_TLS.test(texto)) v.push(`${rel}: importa postgres y no arma el ssl con conTls/pgTls`);
      if (/\bssl\s*:/.test(texto)) v.push(`${rel}: arma un «ssl:» propio (tiene que salir de lib/pg-tls.mjs)`);
    } else if (/\bpostgres\s*\(\s*[^)]/.test(texto) && !USA_TLS.test(texto)) {
      v.push(`${rel}: llama a postgres( sin conTls/pgTls`);
    }
  }
  if (/\.py$/.test(rel) && /\b(?:psycopg2?|asyncpg|pg8000)\b/.test(texto) && !/verify-full/.test(texto)) {
    v.push(`${rel}: abre Postgres desde Python sin sslmode=verify-full`);
  }
  for (const [re, que] of PROHIBIDOS) if (re.test(texto)) v.push(`${rel}: ${que}`);
  return v;
}

const SALTAR = new Set(['node_modules', '.git', '.mutante', 'test']);
/** Recorre el repo (sin node_modules, .git, .mutante ni carpetas test/) y devuelve { archivos, abrenPg, violaciones }. */
export function revisarRepo(raiz) {
  const archivos = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SALTAR.has(e.name)) andar(path.join(d, e.name)); }
      else if (/\.(?:mjs|cjs|js|py|ya?ml|sh)$/.test(e.name)) archivos.push(path.join(d, e.name));
    }
  };
  andar(raiz);
  const abrenPg = []; const violaciones = [];
  for (const f of archivos) {
    const rel = path.relative(raiz, f).split(path.sep).join('/');
    if (rel === 'lib/pg-tls.mjs') continue;                         // el helper mismo (nombra lo prohibido en comentarios)
    const t = fs.readFileSync(f, 'utf8');
    if (IMPORTA_PG.test(t)) abrenPg.push(rel);
    violaciones.push(...revisar(t, rel));
  }
  return { archivos, abrenPg, violaciones };
}
