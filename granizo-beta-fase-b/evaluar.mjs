// HN AGRO · 226 · GRANIZO β · Fase B · EL VEREDICTO, sin red, sobre los artefactos bajados.
//   node evaluar.mjs <carpeta con los artefactos> [--19 instantes.jsonl de la 19] [--salida resultado-fase-b.json]
// Busca todos los instantes.jsonl.gz debajo de la carpeta (un artefacto por caso o por parte) y aplica SELLO-B.json.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { leerParticion } from './medir-caso.mjs';
import { evaluar } from './lib/evaluar.mjs';

const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const dir = a[0];
if (!dir || !fs.existsSync(dir)) { console.error('uso: node evaluar.mjs <carpeta> [--19 instantes.jsonl] [--salida f.json]'); process.exit(2); }
const archivos = [];
(function rec(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else if (e.name === 'instantes.jsonl.gz') archivos.push(p); } })(dir);
const shas = {}, filas = [];
for (const f of archivos) {
  const b = fs.readFileSync(f); shas[path.relative(dir, f)] = crypto.createHash('sha256').update(b).digest('hex');
  for (const l of zlib.gunzipSync(b).toString('utf8').split('\n')) if (l.trim()) filas.push(JSON.parse(l));
}
let i19 = null;
if (arg('--19')) i19 = fs.readFileSync(arg('--19'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const r = evaluar(leerParticion(), filas, { instantes19: i19 });
r.entradas = { archivos: shas, filas: filas.length, casos: [...new Set(filas.map((f) => f.caso))].length,
  instantes19_sha256: arg('--19') ? crypto.createHash('sha256').update(fs.readFileSync(arg('--19'))).digest('hex') : null };
const salida = arg('--salida') || path.join(path.dirname(fileURLToPath(import.meta.url)), 'resultado-fase-b.json');
fs.writeFileSync(salida, JSON.stringify(r, null, 1));
console.log(`veredicto ${r.veredicto}${r.falla.length ? ' (falla: ' + r.falla.join(', ') + ')' : ''} · casos ${r.entradas.casos} · filas ${filas.length}`);
for (const v of ['V0', 'V1', 'V2']) {
  const x = r.variantes[v];
  console.log(`${v}: POD ${x.POD ? x.POD.k + '/' + x.POD.n : '-'} · POFD ${x.POFD ? x.POFD.k + '/' + x.POFD.n : '-'} · PSS ${x.PSS} · C_dias ${r.C_dias[v].diferencia} · C_hora ${r.C_hora[v].diferencia} (n ${r.C_hora[v].episodios_con_dato_en_las_dos})`);
}
console.log(`I1 ${r.I1.en_regla ? 'en regla' : 'NO'} · I1b ${r.I1b.iguales ? 'iguales' : 'difieren'}${r.I1c ? ' · I1c ' + r.I1c.identicos + '/' + r.I1c.comparados : ''}`);
