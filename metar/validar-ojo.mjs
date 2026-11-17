// HN AGRO · metar · la tabla de validación del ojo del granizo contra los METAR con GR/GS (317, parte 3). Ver metar/LEEME.md.
//   node metar/validar-ojo.mjs --barridos <carpeta> [--api <archivo.json>]… [--indices <carpeta>] [--r2-dias AAAA-MM-DD,…] [--md salida.md] [--json salida.json]
// --barridos: los barridos del archivo de granizo (la release granizo-AAAA-MM-DD de hn-radar: *.json.gz o *.json), o un .json
//             con una lista de { pedido_utc, r } (como datos/ojo/barridos-cuyo.json de los casos).
// --api:      respuestas JSON de /api/data/metar (fixtures o lo que bajó el relleno).
// --indices:  una carpeta con los indice.json del colector (metar/AAAA/MM/DD/indice.json).
// --r2-dias:  lee los índices de esos días de R2 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).
// Imprime sólo cantidades; la tabla va a los archivos (el registro de Actions es público; el archivo del ojo es interno).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { almacenR2 } from '../rayos-hora/lib/almacen.mjs';
import { partesDe, barridoDe, validar, tablaMd } from './lib/validacion.mjs';
import { claveIndiceDia } from './lib/colector.mjs';

const args = process.argv.slice(2);
const todos = (k) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));
const uno = (k) => todos(k)[0] || null;
const leer = (f) => { const b = fs.readFileSync(f); return JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8')); };
const archivos = (d, re) => { const out = []; const ir = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) ir(p); else if (re.test(e.name)) out.push(p); } }; if (fs.existsSync(d)) ir(d); return out.sort(); };

const barridos = [];
for (const b of todos('--barridos')) {
  const lista = fs.statSync(b).isDirectory() ? archivos(b, /\.json(\.gz)?$/) : [b];
  for (const f of lista) {
    const j = leer(f);
    for (const x of Array.isArray(j) ? j : [j]) { const y = barridoDe(x); if (y) barridos.push(y); }
  }
}
const api = todos('--api').flatMap((f) => leer(f));
const indices = todos('--indices').flatMap((d) => archivos(d, /^indice\.json$/).map(leer));
const dias = (uno('--r2-dias') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (dias.length) {
  const env = process.env;
  const r2 = almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET });
  for (const d of dias) { const b = await r2.leer(claveIndiceDia(Date.parse(d + 'T12:00:00Z'))); if (b) indices.push(JSON.parse(b.toString('utf8'))); }
}
const v = validar({ partes: partesDe({ api, indices }), barridos });
console.log(`validar-ojo: ${v.partes} partes · ${v.con_granizo} con granizo · ${v.barridos} barridos del ojo · ${v.aciertos} aciertos · ${v.perdidas} pérdidas · ${v.sin_dato} sin dato · ${v.no_confirmadas.length} destacadas no confirmadas por el METAR`);
if (uno('--md')) fs.writeFileSync(uno('--md'), tablaMd(v) + '\n');
if (uno('--json')) fs.writeFileSync(uno('--json'), JSON.stringify(v, null, 1));
// en Actions: la tabla va al depósito PRIVADO (metar/validacion/<nombre>.md y .json), no al registro ni a un artefacto
if (uno('--r2-guardar')) {
  const env = process.env;
  const r2 = almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET });
  const base = 'metar/validacion/' + uno('--r2-guardar').replace(/[^A-Za-z0-9_.-]/g, '_');
  await r2.escribir(base + '.md', tablaMd(v) + '\n', { tipo: 'text/markdown; charset=utf-8' });
  await r2.escribir(base + '.json', JSON.stringify(v, null, 1));
  console.log('validar-ojo: guardado en R2 (' + base + '.md y .json)');
}
