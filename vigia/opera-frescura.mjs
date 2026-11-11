// HN AGRO · VIGÍA DE FRESCURA DE LOS MOSAICOS OPERA (diseño; el workflow está apagado).
// Una vez por día lee el índice PÚBLICO de pasadas OPERA de SATCHI (sin llaves) y avisa por mail si:
//   · hoy (UTC) − `hasta` > 3 días  → los mosaicos de R2 se atrasaron (la cadena se cortó, no el satélite);
//   · `fuente` no es `r2`           → el índice de R2 no contesta (¿vencieron los enlaces?) y la app cae al de deploy;
//   · `ok:false` o no contesta     → SATCHI no da el índice.
// NO REPITE: la clave del aviso lleva `hasta` (opera-atraso-<hasta>). El workflow guarda la clave en la caché de
// Actions SÓLO después de mandar el mail; si la clave ya está, no se manda. Un `hasta` nuevo que se vuelve a trabar
// avisa otra vez. Diagnóstico: hn-cortex docs/opera-mosaicos-2026-11-11/DIAGNOSTICO.md §7 (opción B, con mail).
// El registro de Actions es PÚBLICO: se imprime sólo el veredicto y la clave (datos públicos), nunca destinos ni claves.
// Uso:
//   node vigia/opera-frescura.mjs evaluar [--fixture archivo.json] [--hoy AAAA-MM-DD]  → escribe avisar/clave en GITHUB_OUTPUT
//   node vigia/opera-frescura.mjs mandar  [--clave C] [--fixture archivo.json] [--hoy AAAA-MM-DD]  → manda el mail (SATCHI_SMTP_*)
//     y deja .opera-frescura-aviso/clave sólo si salió; con --clave no manda si la clave cambió desde evaluar
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mandar, desdeEntorno } from './lib/correo.mjs';

export const URL_INDICE = 'https://app.hnagroapp.com/.netlify/functions/satchi-publico?que=opera&zona=corrientes&pasadas=1';
export const DIAS_MAX = 3;
const DIA = 864e5;

/** Regla pura. `resp` es el JSON del índice (o null si no contestó). `hoy` es AAAA-MM-DD (UTC). */
export function evaluar(resp, hoy) {
  if (!resp || resp.ok !== true) {
    return { avisar: true, tipo: 'caido', clave: 'opera-caido-' + ((resp && resp.hasta) || 'sin-hasta'),
      asunto: 'SATCHI: el índice de mosaicos OPERA no contesta', detalle: 'satchi-publico?que=opera&pasadas=1 respondió ' + (resp ? 'ok:false' : 'nada (error de red o HTTP)') };
  }
  const hasta = resp.hasta;
  if (resp.fuente !== 'r2') {
    return { avisar: true, tipo: 'fuente', clave: 'opera-fuente-' + String(resp.fuente || 'nula') + '-' + (hasta || 'sin-hasta'),
      asunto: 'SATCHI: el índice OPERA no sale de R2 (fuente: ' + String(resp.fuente) + ')', detalle: '¿vencieron los enlaces firmados de R2? hasta = ' + hasta };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hasta || ''))) {
    return { avisar: true, tipo: 'caido', clave: 'opera-caido-sin-hasta', asunto: 'SATCHI: el índice OPERA no trae «hasta»', detalle: 'respuesta sin fecha' };
  }
  const dias = Math.round((Date.parse(hoy + 'T00:00:00Z') - Date.parse(hasta + 'T00:00:00Z')) / DIA);
  if (dias > DIAS_MAX) {
    return { avisar: true, tipo: 'atraso', clave: 'opera-atraso-' + hasta, dias,
      asunto: 'SATCHI: mosaicos OPERA sin actualizar desde ' + hasta + ' (' + dias + ' días)',
      detalle: 'El último mosaico del índice de R2 es del ' + hasta + '. La cuenca tiene pasadas todos los días: más de ' + DIAS_MAX + ' días sin uno nuevo es una falla de la cadena (bajada, conversión, subida o índice).' };
  }
  return { avisar: false, tipo: 'ok', clave: null, dias };
}

export async function leerIndice({ fixture = null, url = URL_INDICE, tiempoMs = 20000 } = {}) {
  if (fixture) return JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const c = new AbortController(); const t = setTimeout(() => c.abort(), tiempoMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'hn-colectores-opera-frescura', Accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

function args(argv) {
  const o = { modo: argv[0] };
  for (let i = 1; i < argv.length; i++) { if (argv[i] === '--fixture') o.fixture = argv[++i]; else if (argv[i] === '--hoy') o.hoy = argv[++i]; else if (argv[i] === '--clave') o.clave = argv[++i]; }
  o.hoy = o.hoy || new Date().toISOString().slice(0, 10);
  return o;
}

async function main() {
  const a = args(process.argv.slice(2));
  const resp = await leerIndice({ fixture: a.fixture });
  const v = evaluar(resp, a.hoy);
  if (a.modo === 'evaluar') {
    console.log('opera-frescura:', v.tipo, v.avisar ? 'AVISA' : 'sin aviso', v.clave || '', v.dias != null ? '(' + v.dias + ' días)' : '');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'avisar=' + (v.avisar ? 'si' : 'no') + '\nclave=' + (v.clave || 'ninguna') + '\n');
    return;
  }
  if (a.modo === 'mandar') {
    if (!v.avisar) { console.log('opera-frescura: nada que mandar'); return; }
    if (a.clave && a.clave !== v.clave) { console.log('opera-frescura: la clave cambió entre evaluar y mandar; no se manda (la próxima corrida decide)'); return; }
    const cfg = desdeEntorno();
    const r = await mandar({ ...cfg, asunto: v.asunto, cuerpo: v.detalle + '\n\nÍndice: ' + URL_INDICE + '\nClave del aviso: ' + v.clave + '\n\n(vigía opera-frescura, hn-colectores)' });
    console.log('opera-frescura: mail enviado a', r.destinatarios, 'destinatario(s)');
    // la marca para la caché de Actions: SÓLO si el mail salió (el workflow guarda la clave sólo si existe este archivo)
    fs.mkdirSync('.opera-frescura-aviso', { recursive: true }); fs.writeFileSync('.opera-frescura-aviso/clave', v.clave + '\n');
    return;
  }
  throw new Error('modo: evaluar | mandar');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => { console.error('opera-frescura: error', e.message); process.exit(1); });
}
