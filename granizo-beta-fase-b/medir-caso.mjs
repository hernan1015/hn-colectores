// HN AGRO · 226 · GRANIZO β · Fase B · UN CASO (un episodio de la 19) por corrida.
// Manda hn-cortex docs/satchi-granizo-2026-11/226-beta/SELLO-B.json (sha256 20e8fee1…, empujado antes de bajar nada).
//   node medir-caso.mjs --caso AAAA-MM-DD [--parte i/n] [--desde ISO] [--seco] [--salida DIR] [--lib DIR]
// --seco: lista S3 (los ACHAF de las horas del caso), arma el plan y no baja ningún archivo.
// Lo crudo no toca el disco (ver lib/red.mjs); queda sólo lo que pide el sello (lib/celdas.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { casos, lugares, horasAListar, prefijoHora, leerListado, instantesDe, parte, desde as desdeDe, RE_CASO } from './lib/plan.mjs';
import { crearRed } from './lib/red.mjs';
import { celdasDe, destacadasDe, flashesCerca, validoConFase, validoComo19 } from './lib/celdas.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const SHA_PARTICION = '37bd26f11b95332b9f1cc6f6cc2fdd776815f5273cbd1133dbcc0aa05fc02bbf';
export const LIB_COMMIT = '148a59b48c6a8e25d917c26ff21ff82bb229e469';
export const SHAS_LIB = {
  'granizo-vivo.mjs': '7bcc5299158f56235e6086307ce49946cd083b556ff1bd1ab66c373b40b0822d',
  'goes-focos.mjs': 'c9a7a40366e7ca5f9b3c74075194184eade8da5a5dc44a8d6257011905f172a0',
  'goes-rayos.mjs': 'a0b49d56b480866d449175f8eb51986951b7c78c3de9c0d66a9af0a70c8296df',
  'localidades-granizo.mjs': '3d8a413a32c05276725eddcfcfd6cd1c53e6d96f565bf863e01c27f960cf4cc4'
};
export const PRESUPUESTO_MS = 330 * 60000;        // 5 h 30 min: corta limpio (el job tiene 350 min)
export const TOPE_ESTIMADO_MS = 300 * 60000;      // si a los 10 instantes estima > 5 h, corta y pide partes
export const PAUSA_ENTRE_INSTANTES_MS = 1000;
export const MODOS = ['como_19', 'con_fase'];
const BUCKET = 'https://noaa-goes19.s3.amazonaws.com';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function verificarLib(dir, shas = SHAS_LIB) {
  const out = {};
  for (const [f, s] of Object.entries(shas)) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error('falta la lib: ' + f);
    const h = sha(fs.readFileSync(p));
    if (h !== s) throw new Error('la lib cambió: ' + f + ' ' + h.slice(0, 12));
    out[f] = h;
  }
  return out;
}
export function leerParticion(f = path.join(AQUI, 'datos', 'PARTICION.json')) {
  const b = fs.readFileSync(f);
  if (sha(b) !== SHA_PARTICION) throw new Error('la partición cambió');
  return JSON.parse(b.toString('utf8'));
}
/** /tmp/hn-goes: donde h5wasm escribe el HDF5 (la lib lo borra; esto es por las dudas) */
function vaciarTmp(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) { try { fs.rmSync(path.join(dir, f), { force: true, recursive: true }); n++; } catch { /* nada */ } } } catch { /* no existe */ }
  return n;
}
function libreGB(dir) { try { const s = fs.statfsSync(dir); return Math.round(s.bavail * s.bsize / 1e8) / 10; } catch { return null; } }

/**
 * @param o.P particion · o.caso · o.parte 'i/n' · o.desde ISO · o.seco · o.salida · o.libDir
 *        o.fetchReal / o.esperar / o.ahora (tests) · o.verificar (false sólo en tests: la lib falsa no tiene esos sha)
 */
export async function correrCaso(o) {
  const t0 = (o.ahora || Date.now)();
  const reloj = () => (o.ahora || Date.now)() - t0;
  const esperar = o.esperar || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log || ((...a) => console.log(...a));
  if (!RE_CASO.test(String(o.caso))) throw new Error('caso inválido');
  const C = casos(o.P).find((x) => x.caso === o.caso);
  if (!C) throw new Error('el caso no está en la partición');
  const [pi, pn] = String(o.parte || '1/1').split('/').map(Number);
  fs.mkdirSync(o.salida, { recursive: true });
  const shasLib = o.verificar === false ? null : verificarLib(o.libDir);
  const GV = await import(pathToFileURL(path.join(o.libDir, 'granizo-vivo.mjs')).href);
  const GR = await import(pathToFileURL(path.join(o.libDir, 'goes-rayos.mjs')).href);
  const red = crearRed({ fetchReal: o.fetchReal || globalThis.fetch, esperar, ahora: o.ahora, h0Dir: o.h0Dir ?? path.join(AQUI, 'datos', 'h0'),
    h0Lats: GV.H0_LATS, h0Lons: GV.H0_LONS });
  red.ponerSat(C.sat);
  const LUG = lugares(o.P);
  const tmpDir = o.tmpDir ?? '/tmp/hn-goes';

  /* 1 · el plan: los ACHAF de las horas del caso (listados de S3, chicos) */
  const scans = [], listadosFallidos = [];
  for (const h of horasAListar(C)) {
    const r = await red.fetch(BUCKET + '/?list-type=2&prefix=' + encodeURIComponent(prefijoHora(h)) + '&max-keys=1000');
    if (!r.ok) { listadosFallidos.push({ hora: new Date(h).toISOString(), http: r.status }); continue; }
    scans.push(...leerListado(await r.text()));
  }
  const todos = instantesDe(C, scans);
  let inst = desdeDe(parte(todos, pi, pn), o.desde);
  const plan = { caso: C.caso, tipo: C.tipo, sat: C.sat, parte: pi + '/' + pn, desde: o.desde || null, ventanas: C.ventanas.map((v) => ({ ...v, desde: new Date(v.desde).toISOString(), hasta: new Date(v.hasta).toISOString() })),
    instantes_del_caso: todos.length, instantes_de_esta_corrida: inst.length, extra_t10: inst.filter((x) => x.extra_t10).length,
    listados_fallidos: listadosFallidos, estimado_mb: Math.round(inst.length * 20), primero: inst[0] ? new Date(inst[0].t).toISOString() : null,
    ultimo: inst.length ? new Date(inst.at(-1).t).toISOString() : null };
  fs.writeFileSync(path.join(o.salida, 'plan.json'), JSON.stringify(plan, null, 1));
  log(`plan ${C.caso} (${C.tipo}, ${C.sat}) parte ${plan.parte}: ${inst.length} instantes de ${todos.length} (t−10: ${plan.extra_t10}), ~${plan.estimado_mb} MB a bajar, listados fallidos ${listadosFallidos.length}`);
  const resumen = { formato: 'hn-granizo-beta-fase-b/1', sello_b: 'SELLO-B.json 20e8fee1664a49356e321302026ebb01b3409e754a51d67fe64411235cae78c6',
    caso: C.caso, parte: plan.parte, seco: !!o.seco, lib_commit: LIB_COMMIT, sha_lib: shasLib, sha_particion: SHA_PARTICION, instantes_plan: inst.length,
    hechos: 0, validos: { como_19: 0, con_fase: 0 }, cortado: null, siguiente_desde: null, disco_libre_gb_min: libreGB(o.salida), tmp_borrados: 0 };
  if (o.seco || !inst.length) {
    resumen.red = red.stats;
    fs.writeFileSync(path.join(o.salida, 'resumen.json'), JSON.stringify(resumen, null, 1));
    return resumen;
  }

  /* 2 · instante por instante, los dos modos con los mismos bytes */
  const fInst = path.join(o.salida, 'instantes.jsonl'), fCerca = path.join(o.salida, 'flashes_cerca.jsonl');
  fs.writeFileSync(fInst, ''); fs.writeFileSync(fCerca, '');
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = red.fetch;            // goes-rayos usa el fetch global para el GLM (como en la 19)
  let prev = null;
  try {
    for (let i = 0; i < inst.length; i++) {
      const s = inst[i];
      if (reloj() > (o.presupuestoMs ?? PRESUPUESTO_MS)) { resumen.cortado = 'presupuesto_5h30'; resumen.siguiente_desde = new Date(s.t).toISOString(); break; }
      if (i === 10) {
        const est = reloj() / 10 * inst.length;
        resumen.estimado_h = Math.round(est / 36e5 * 10) / 10;
        if (est > (o.topeEstimadoMs ?? TOPE_ESTIMADO_MS)) {
          resumen.cortado = 'estimado_mayor_a_5h'; resumen.siguiente_desde = new Date(s.t).toISOString();
          resumen.partes_sugeridas = Math.ceil(est / (4 * 36e5));
          break;
        }
      }
      const a = reloj();
      red.nuevoInstante();
      const res = {}, fl = {};
      for (const m of MODOS) {
        red.ponerModo(m);
        GV._vaciarCache({ menosH0: true }); GR._vaciarCache();
        const fv = async (x) => { const y = await GR.flashesVentana(x); fl[m] = y; return y; };
        try { res[m] = await GV.armar({ ahora: s.t + 60000, plazo_ms: 600000, fetch: red.fetch, flashesVentana: fv }); }
        catch (e) { res[m] = { ok: false, motivo: 'excepcion: ' + String(e && e.message).slice(0, 100) }; }
      }
      const rF = res.con_fase, r9 = res.como_19, gF = fl.con_fase;
      const glmCompleto = !!(gF && gF.ok && gF.completo && rF.rayos_ventana && rF.rayos_ventana.completo);
      const flT = glmCompleto ? gF.flashes : null;
      const flT10 = prev && prev.k10 === s.k10 - 1 ? prev.flT : null;
      const vF = validoConFase(rF), v9 = validoComo19(r9);
      const fila = {
        caso: C.caso, tipo: C.tipo, sat: C.sat, scan_pedido: C.sat + '|' + new Date(s.t).toISOString(), t: new Date(s.t).toISOString(), k10: s.k10,
        achaf: s.clave.split('/').pop(), creado: s.creado ? new Date(s.creado).toISOString() : null, publicado: s.publicado, ventanas: s.ventanas, extra_t10: s.extra_t10,
        como_19: { ok: !!r9.ok, parcial: !!r9.parcial, faltantes: r9.faltantes || [], valido: v9, scan_t: r9.scan_t || null, motivo: r9.motivo || null, destacadas: destacadasDe(r9) },
        con_fase: { ok: !!rF.ok, parcial: !!rF.parcial, faltantes: rF.faltantes || [], valido: vF, scan_t: rF.scan_t || null, scan_t20: rF.scan_t20 || null,
          glm_completo: glmCompleto, glm: rF.rayos_ventana ? { completo: !!rF.rayos_ventana.completo, minutos: rF.rayos_ventana.minutos_cubiertos ?? null, archivos: rF.rayos_ventana.archivos || null } : null,
          h0_fuente: rF.h0_fuente || null, resumen: rF.resumen || null, motivo: rF.motivo || null,
          n_flashes: flT ? flT.length : null, t10_disponible: !!flT10, celdas: celdasDe(rF, flT, flT10) },
        seg: Math.round((reloj() - a) / 100) / 10
      };
      fs.appendFileSync(fInst, JSON.stringify(fila) + '\n');
      fs.appendFileSync(fCerca, JSON.stringify({ t: fila.t, completo: glmCompleto, f: flashesCerca(gF && gF.flashes, LUG) }) + '\n');
      prev = { k10: s.k10, flT };
      resumen.hechos++; if (v9) resumen.validos.como_19++; if (vF) resumen.validos.con_fase++;
      resumen.tmp_borrados += vaciarTmp(tmpDir);
      if (i % 10 === 0) {
        const lg = libreGB(o.salida); if (lg != null) resumen.disco_libre_gb_min = Math.min(resumen.disco_libre_gb_min ?? lg, lg);
        const c = red.enCache();
        log(`${fila.t} ${i + 1}/${inst.length} · válido ${v9 ? 's' : 'n'}/${vF ? 's' : 'n'} · celdas ${fila.con_fase.celdas.length} · ${fila.seg} s · pedidos ${red.stats.pedidos} · ${Math.round(red.stats.bytes / 1e6)} MB · reintentos ${red.stats.reintentos} · caché ${c.archivos} (${Math.round(c.bytes / 1e6)} MB) · libre ${resumen.disco_libre_gb_min} GB`);
      }
      if (i < inst.length - 1) await esperar(PAUSA_ENTRE_INSTANTES_MS);
    }
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const f of [fInst, fCerca]) if (fs.existsSync(f)) { fs.writeFileSync(f + '.gz', zlib.gzipSync(fs.readFileSync(f))); fs.rmSync(f); }
    resumen.red = red.stats;
    resumen.minutos = Math.round(reloj() / 6000) / 10;
    fs.writeFileSync(path.join(o.salida, 'resumen.json'), JSON.stringify(resumen, null, 1));
  }
  log(`fin ${C.caso}: ${resumen.hechos} instantes (válidos ${resumen.validos.como_19} como_19 / ${resumen.validos.con_fase} con_fase), ${Math.round(red.stats.bytes / 1e6)} MB, ${red.stats.pedidos} pedidos, ${red.stats.reintentos} reintentos, ${resumen.minutos} min` +
    (resumen.cortado ? ` · CORTADO (${resumen.cortado}): seguir con desde=${resumen.siguiente_desde}` : ''));
  return resumen;
}

/* ── CLI ── */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const o = { P: leerParticion(), caso: arg('--caso'), parte: arg('--parte') || '1/1', desde: arg('--desde') || null, seco: a.includes('--seco'),
    salida: arg('--salida') || path.join(AQUI, 'salida'), libDir: arg('--lib') || path.join(AQUI, '_app', 'netlify', 'functions', 'lib') };
  if (!/^\d+\/\d+$/.test(o.parte)) { console.error('parte inválida'); process.exit(2); }
  if (o.desde && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(o.desde)) { console.error('desde inválido'); process.exit(2); }
  correrCaso(o).then((r) => { process.exitCode = r.cortado ? 3 : 0; }, (e) => { console.error('error:', String(e && e.message).slice(0, 200)); process.exitCode = 1; });
}
