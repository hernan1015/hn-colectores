// HN AGRO · VIGÍA DE FRESCURA DE LOS MOSAICOS OPERA (diseño; el workflow está apagado).
// Una vez por día lee el índice PÚBLICO de pasadas OPERA de SATCHI (sin llaves) y avisa por mail si:
//   · hoy (UTC) − `hasta` > 3 días  → los mosaicos de R2 se atrasaron (la cadena se cortó, no el satélite);
//   · `fuente` no es `r2`           → el índice de R2 no contesta (¿vencieron los enlaces?) y la app cae al de deploy;
//   · `ok:false` o no contesta     → SATCHI no da el índice.
// UNA SOLA CONSULTA por corrida (revisión de Codex, 1.ª vuelta): `evaluar` lee el índice y guarda la evaluación en un
// archivo; `mandar` NO vuelve a consultar: manda exactamente lo que se evaluó.
// NO REPITE, POR EPISODIO:
//   · atraso → clave `opera-atraso-<hasta>`: un `hasta` nuevo que se vuelve a trabar avisa otra vez;
//   · fuente → clave `opera-fuente-<fuente>-<hasta>`;
//   · caída  → clave `opera-caido-tras-<último día sano>`: cada corrida con el índice sano deja su fecha en la caché de
//     Actions (opera-frescura-sano-<día>); una caída nueva, después de recuperarse, tiene otro «último día sano» y
//     otra clave. Mientras dura la caída, el último día sano no cambia y no se repite.
//   El workflow guarda la clave del aviso en la caché SÓLO si el mail salió; si la clave ya está, no se manda.
// El registro de Actions es PÚBLICO: se imprime sólo el veredicto y la clave (datos públicos). Los errores se REDACTAN
// (host, usuario, clave, remitente y destinos del SMTP, y cualquier dirección de mail) antes de imprimirlos.
// Uso:
//   node vigia/opera-frescura.mjs evaluar --salida eval.json [--sano-archivo f] [--fixture archivo.json] [--hoy AAAA-MM-DD]
//       → escribe la evaluación en --salida y avisar/clave/sano en GITHUB_OUTPUT
//   node vigia/opera-frescura.mjs mandar --evaluacion eval.json
//       → manda el mail de esa evaluación (SATCHI_SMTP_*), sin consultar de nuevo; deja .opera-frescura-aviso/clave si salió
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mandar, desdeEntorno } from './lib/correo.mjs';

export const URL_INDICE = 'https://app.hnagroapp.com/.netlify/functions/satchi-publico?que=opera&zona=corrientes&pasadas=1';
export const DIAS_MAX = 3;
const DIA = 864e5;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Regla pura. `resp` es el JSON del índice (o null si no contestó). `hoy` es AAAA-MM-DD (UTC).
 *  `ultimoSano` = el último día (AAAA-MM-DD) en que el índice contestó bien, o null si no hay registro. */
export function evaluar(resp, hoy, { ultimoSano = null } = {}) {
  const sano = !!(resp && resp.ok === true && FECHA.test(String(resp.hasta || '')));
  if (!sano) {
    const tras = FECHA.test(String(ultimoSano || '')) ? ultimoSano : 'sin-registro';
    const que = !resp ? 'nada (error de red, HTTP o JSON)' : resp.ok !== true ? 'ok:false' : 'una respuesta sin «hasta»';
    return { avisar: true, sano: false, tipo: 'caido', clave: 'opera-caido-tras-' + tras,
      asunto: 'SATCHI: el índice de mosaicos OPERA no contesta', detalle: 'satchi-publico?que=opera&pasadas=1 respondió ' + que + '. Último día sano registrado: ' + tras + '.' };
  }
  const hasta = resp.hasta;
  if (resp.fuente !== 'r2') {
    return { avisar: true, sano: true, tipo: 'fuente', clave: 'opera-fuente-' + String(resp.fuente || 'nula').replace(/[^a-z0-9_-]/gi, '') + '-' + hasta,
      asunto: 'SATCHI: el índice OPERA no sale de R2 (fuente: ' + String(resp.fuente) + ')', detalle: '¿Vencieron los enlaces firmados de R2? hasta = ' + hasta };
  }
  const dias = Math.round((Date.parse(hoy + 'T00:00:00Z') - Date.parse(hasta + 'T00:00:00Z')) / DIA);
  if (dias > DIAS_MAX) {
    return { avisar: true, sano: true, tipo: 'atraso', clave: 'opera-atraso-' + hasta, dias,
      asunto: 'SATCHI: mosaicos OPERA sin actualizar desde ' + hasta + ' (' + dias + ' días)',
      detalle: 'El último mosaico del índice de R2 es del ' + hasta + '. La cuenca tiene pasadas todos los días: más de ' + DIAS_MAX + ' días sin uno nuevo es una falla de la cadena (bajada, conversión, subida o índice).' };
  }
  return { avisar: false, sano: true, tipo: 'ok', clave: null, dias };
}

/** Lee el índice. Cualquier error (red, tiempo, HTTP no 2xx, JSON roto) da null: es una caída, no una excepción. */
export async function leerIndice({ fixture = null, url = URL_INDICE, tiempoMs = 20000, _fetch = globalThis.fetch } = {}) {
  if (fixture) { try { return JSON.parse(fs.readFileSync(fixture, 'utf8')); } catch { return null; } }
  const c = new AbortController(); const t = setTimeout(() => c.abort(), tiempoMs);
  try {
    const r = await _fetch(url, { signal: c.signal, headers: { 'User-Agent': 'hn-colectores-opera-frescura', Accept: 'application/json' } });
    if (!r || !r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/** Saca de un texto los datos del SMTP (host, usuario, clave, remitente, destinos) y cualquier dirección de mail. */
export function redactar(texto, env = process.env) {
  let s = String(texto == null ? '' : texto);
  const valores = [env.SATCHI_SMTP_HOST, env.SATCHI_SMTP_USER, env.SATCHI_SMTP_PASS, env.SATCHI_SMTP_FROM,
    ...String(env.SATCHI_VIGIA_DESTINO || '').split(',')].map((v) => String(v || '').trim()).filter((v) => v.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const v of valores) s = s.split(v).join('[redactado]');
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[mail]');
}

/** Manda el mail de una evaluación YA HECHA (no consulta el índice). `enviar` se inyecta en los tests. */
export async function ejecutarMandar(ev, { enviar = mandar, cfg = desdeEntorno(), marcaDir = '.opera-frescura-aviso' } = {}) {
  if (!ev || !ev.avisar) return { enviado: false, motivo: 'nada que mandar' };
  const r = await enviar({ ...cfg, asunto: ev.asunto, cuerpo: ev.detalle + '\n\nÍndice: ' + URL_INDICE + '\nClave del aviso: ' + ev.clave + '\n\n(vigía opera-frescura, hn-colectores)' });
  // la marca para la caché de Actions: SÓLO si el mail salió (el workflow guarda la clave sólo si existe este archivo)
  fs.mkdirSync(marcaDir, { recursive: true }); fs.writeFileSync(path.join(marcaDir, 'clave'), ev.clave + '\n');
  return { enviado: true, destinatarios: r && r.destinatarios };
}

function args(argv) {
  const o = { modo: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--fixture') o.fixture = argv[++i]; else if (k === '--hoy') o.hoy = argv[++i];
    else if (k === '--salida') o.salida = argv[++i]; else if (k === '--evaluacion') o.evaluacion = argv[++i];
    else if (k === '--sano-archivo') o.sanoArchivo = argv[++i];
  }
  o.hoy = o.hoy || new Date().toISOString().slice(0, 10);
  return o;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.modo === 'evaluar') {
    let ultimoSano = null;
    if (a.sanoArchivo) { try { ultimoSano = fs.readFileSync(a.sanoArchivo, 'utf8').trim(); } catch { ultimoSano = null; } }
    const v = { ...evaluar(await leerIndice({ fixture: a.fixture }), a.hoy, { ultimoSano }), hoy: a.hoy };
    console.log('opera-frescura:', v.tipo, v.avisar ? 'AVISA' : 'sin aviso', v.clave || '', v.dias != null ? '(' + v.dias + ' días)' : '');
    if (a.salida) fs.writeFileSync(a.salida, JSON.stringify(v));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'avisar=' + (v.avisar ? 'si' : 'no') + '\nclave=' + (v.clave || 'ninguna') + '\nsano=' + (v.sano ? 'si' : 'no') + '\n');
    return;
  }
  if (a.modo === 'mandar') {
    if (!a.evaluacion) throw new Error('mandar necesita --evaluacion (la de evaluar): no se vuelve a consultar el índice');
    const r = await ejecutarMandar(JSON.parse(fs.readFileSync(a.evaluacion, 'utf8')));
    console.log('opera-frescura:', r.enviado ? 'mail enviado a ' + r.destinatarios + ' destinatario(s)' : r.motivo);
    return;
  }
  throw new Error('modo: evaluar | mandar');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => { console.error('opera-frescura: error', redactar(e && e.message)); process.exit(1); });
}
