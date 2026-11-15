// HN AGRO · ARCHIVO DEL ÍNDICE CAP DEL SMN (225). Una corrida = UN pedido al índice CAP, los XML de los avisos nuevos
// (de a uno, con pausa y tope) y el sobre de la corrida a la release diaria `smn-cap-AAAA-MM-DD` de hn-radar (privado).
// Ver cap-archivo/LEEME.md y cap-archivo/PRENDER.md.
// Uso:
//   node cap-archivo/archivar.mjs            → real: pide, guarda, anota en registro_procesos
//   node cap-archivo/archivar.mjs --seco     → UN pedido al índice y nada más: no pide XML, no sube, no anota
// Entorno: CAP_TOKEN (= secrets.RADAR_TOKEN), CAP_REPO (dueño/repo, hoy hernan1015/hn-radar), CAP_PG_URL (rol colector_cap).
//          Ninguno se imprime. CAP_TOPE (opcional): XML por corrida, entre 1 y 150.
// Salida: 0 bien (o sólo avisos de estado) · 1 falló GitHub · 2 alguna falla (el SMN cortó, el índice raro, una carpeta
// nueva, el registro sin anotar…). El registro de Actions es PÚBLICO: se imprimen sólo cantidades.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clienteReleases } from '../lib/releases.mjs';
import { crearPedidor, UA, TOPE_XML } from './lib/smn.mjs';
import { correr, esFalla } from './lib/flujo.mjs';
import { crearBase } from './lib/base.mjs';

export function redactar(s, secretos = []) {
  let t = String(s == null ? '' : s);
  for (const x of secretos) if (x && x.length >= 8) t = t.split(x).join('[secreto]');
  return t.replace(/postgres(ql)?:\/\/\S+/g, '[url]');
}

export function lineaResumen(r) {
  const x = r.resumen;
  return `cap-archivo${x.modo === 'seco' ? ' (SECO)' : ''}: índice HTTP ${x.indice.http ?? '—'} · ${(x.indice.bytes / 1024).toFixed(0)} KB · ` +
    `${x.indice.nuevo == null ? '—' : x.indice.nuevo ? 'NUEVO' : 'igual al anterior'} · ${x.indice.items} ítems, ${x.xml.en_indice} XML en la lista blanca · ` +
    `pedidos ${x.pedidos} · XML nuevos ${x.xml.nuevos}, repetidos por hash ${x.xml.repetidos_hash}, ya guardados ${x.xml.ya_guardados}, ` +
    `no disponibles ${x.xml.no_disponibles}, cortados ${x.xml.cortados}, sin pedir ${x.xml.sin_pedir} · ${x.tag}/${x.asset || '—'} · ` +
    `fallas ${x.fallas} · errores ${x.errores}`;
}

async function main() {
  const seco = process.argv.includes('--seco');
  const token = process.env.CAP_TOKEN, repo = process.env.CAP_REPO, pgUrl = process.env.CAP_PG_URL;
  const secretos = [token, pgUrl];
  const tope = Math.max(1, Math.min(TOPE_XML, Number(process.env.CAP_TOPE) || TOPE_XML));
  const cliente = clienteReleases({ token, repo, userAgent: UA });
  let base = null;
  if (!seco && pgUrl) {
    try { base = await crearBase({ url: pgUrl }); }
    catch (e) { console.log('::warning::cap-archivo: la base no conectó: ' + redactar(e && e.message, secretos)); }
  }
  const colector = { run_id: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, evento: process.env.GITHUB_EVENT_NAME || 'local' };
  const r = await correr({ cliente, pedidor: crearPedidor(), base, seco, tope, colector });
  if (base) await base.cerrar();
  const linea = redactar(lineaResumen(r), secretos);
  console.log(linea);
  const t = (a) => a.tipo + (a.motivo ? ' (' + a.motivo + ')' : '') + (a.carpeta ? ' ' + a.carpeta : '') + (a.n ? ' ×' + a.n : '');
  const est = r.avisos.filter((a) => !esFalla(a)), fal = r.avisos.filter(esFalla);
  if (est.length) console.log('::warning::cap-archivo (aviso, no falla): ' + redactar(est.map(t).join(', '), secretos));
  if (fal.length) console.log('::error::cap-archivo (FALLA): ' + redactar(fal.map(t).join(', '), secretos));
  for (const e of r.errores) console.log('::error::cap-archivo (GitHub): ' + redactar(e, secretos));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### SMN · archivo CAP\n- ${linea}\n`);
  process.exitCode = r.codigo;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => { console.error('cap-archivo: error ' + redactar(e && e.message, [process.env.CAP_TOKEN, process.env.CAP_PG_URL])); process.exitCode = 1; });
}
