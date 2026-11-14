// HN AGRO · ARCHIVO DE BARRIDOS DE GRANIZO (147). Una corrida = UN pedido a satchi-publico?que=granizo y su respuesta
// ENTERA a la release diaria `granizo-AAAA-MM-DD` de hn-radar (privado). Ver PRENDER.md y lib/barrido.mjs.
// Uso:
//   node granizo-archivo/archivar.mjs            → real: pide, sube el barrido (si no estaba) y el índice
//   node granizo-archivo/archivar.mjs --seco     → pide y mira el release, pero NO crea ni sube nada
// Entorno: GRANIZO_TOKEN (= secrets.RADAR_TOKEN; nunca se imprime), GRANIZO_REPO (dueño/repo, hoy hernan1015/hn-radar),
//          GRANIZO_URL (opcional; por defecto el de SATCHI).
// El registro de Actions es PÚBLICO: se imprime sólo estado, scan, nombre y tamaños (nada de celdas ni cabeceras).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clienteReleases } from '../lib/releases.mjs';
import { pedirGranizo, URL_GRANIZO, UA } from './lib/barrido.mjs';
import { archivar } from './lib/flujo.mjs';

const redactar = (s, token) => { let t = String(s == null ? '' : s); if (token && token.length >= 8) t = t.split(token).join('[token]'); return t; };

async function main() {
  const seco = process.argv.includes('--seco');
  const token = process.env.GRANIZO_TOKEN, repo = process.env.GRANIZO_REPO;
  const cliente = clienteReleases({ token, repo, userAgent: UA });
  const pedido = await pedirGranizo({ url: process.env.GRANIZO_URL || URL_GRANIZO });
  const colector = { run_id: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, evento: process.env.GITHUB_EVENT_NAME || 'local' };
  const r = await archivar({ cliente, pedido, colector, seco });
  const linea = `granizo-archivo${r.seco ? ' (SECO)' : ''}: ${r.estado}${r.motivo ? ' [' + r.motivo + ']' : ''} · HTTP ${r.http ?? '—'} · scan ${r.scan_t || '—'} · ` +
    `${r.tag}/${r.nombre} · ${r.repetido ? 'REPETIDO (ya estaba)' : r.seco ? 'se subiría' : 'NUEVO'} · ${(r.bytes / 1024).toFixed(0)} KB gz · índice: ${r.indice}`;
  console.log(redactar(linea, token));
  if (r.errorIndice) console.log('índice:', redactar(r.errorIndice, token));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Granizo · archivo\n- ${redactar(linea, token)}\n`);
  if (r.indice === 'falló') process.exit(1);   // el barrido quedó, pero que se vea en rojo
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => { console.error('granizo-archivo: error', redactar(e && e.message, process.env.GRANIZO_TOKEN)); process.exit(1); });
}
