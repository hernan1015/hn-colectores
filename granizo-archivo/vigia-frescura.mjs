// HN AGRO · VIGÍA DE FRESCURA DEL ARCHIVO DE GRANIZO (147). Ver lib/frescura.mjs y PRENDER.md.
// Igual que vigia/opera-frescura.mjs: `evaluar` lee UNA vez y guarda la evaluación; `mandar` manda ESO, sin volver a leer.
//   node granizo-archivo/vigia-frescura.mjs evaluar --salida eval.json   → avisar/clave en GITHUB_OUTPUT
//   node granizo-archivo/vigia-frescura.mjs mandar --evaluacion eval.json → el mail (SATCHI_SMTP_*); deja .granizo-frescura-aviso/clave si salió
// Entorno: GRANIZO_TOKEN (= secrets.RADAR_TOKEN, sólo lectura acá), GRANIZO_REPO. Se imprime sólo el veredicto y la clave.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clienteReleases } from '../lib/releases.mjs';
import { mandar, desdeEntorno } from '../vigia/lib/correo.mjs';
import { redactar } from '../vigia/opera-frescura.mjs';
import { UA } from './lib/barrido.mjs';
import { evaluarFrescura, leerEstado, sinLectura } from './lib/frescura.mjs';

export async function evaluarAhora({ cliente, ahoraMs = Date.now() }) {
  const est = cliente ? await leerEstado(cliente, ahoraMs) : null;
  return est ? evaluarFrescura({ ahoraMs, ...est }) : sinLectura(ahoraMs);
}

export async function ejecutarMandar(ev, { enviar = mandar, cfg = desdeEntorno(), marcaDir = '.granizo-frescura-aviso' } = {}) {
  if (!ev || !ev.avisar) return { enviado: false, motivo: 'nada que mandar' };
  const r = await enviar({ ...cfg, asunto: ev.asunto, cuerpo: ev.detalle + '\n\nClave del aviso: ' + ev.clave + '\n\n(vigía granizo-frescura, hn-colectores)' });
  fs.mkdirSync(marcaDir, { recursive: true }); fs.writeFileSync(path.join(marcaDir, 'clave'), ev.clave + '\n');   // SÓLO si salió
  return { enviado: true, destinatarios: r && r.destinatarios };
}

function arg(nombre) { const i = process.argv.indexOf(nombre); return i > 0 ? process.argv[i + 1] : null; }

async function main() {
  const modo = process.argv[2];
  if (modo === 'evaluar') {
    let cliente = null;
    try { cliente = clienteReleases({ token: process.env.GRANIZO_TOKEN, repo: process.env.GRANIZO_REPO, userAgent: UA }); } catch { cliente = null; }
    const v = await evaluarAhora({ cliente });
    console.log('granizo-frescura:', v.tipo, v.avisar ? 'AVISA' : 'sin aviso', v.clave || '', v.nuevos != null ? `(nuevos ${v.nuevos}, pedidos ${v.pedidos}, último ${v.ultimo || '—'})` : '');
    const salida = arg('--salida');
    if (salida) fs.writeFileSync(salida, JSON.stringify(v));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'avisar=' + (v.avisar ? 'si' : 'no') + '\nclave=' + (v.clave || 'ninguna') + '\n');
    return;
  }
  if (modo === 'mandar') {
    const f = arg('--evaluacion');
    if (!f) throw new Error('mandar necesita --evaluacion (la de evaluar): no se vuelve a leer');
    const r = await ejecutarMandar(JSON.parse(fs.readFileSync(f, 'utf8')));
    console.log('granizo-frescura:', r.enviado ? 'mail enviado a ' + r.destinatarios + ' destinatario(s)' : r.motivo);
    return;
  }
  throw new Error('modo: evaluar | mandar');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => { console.error('granizo-frescura: error', redactar(e && e.message)); process.exit(1); });
}
