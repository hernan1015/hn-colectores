// HN AGRO · estaciones-parseo · EL JOB: lee de R2 las rondas de estaciones-privadas/ronda.mjs de las últimas N horas y las
// carga en la base (estaciones + estaciones_lecturas, migración 0161). USO INTERNO: nada se muestra.
//   · SÓLO LEE R2 (token de sólo lectura y, además, un almacén congelado con leer/listar). No le pide nada a ninguna fuente.
//   · Las reglas de calidad de la 139 (lib/calidad.mjs), iguales para las 9 fuentes. Idempotente por la firma.
//   · EL LOG DE ACTIONS ES PÚBLICO: se imprime sólo un resumen de CANTIDADES y CATEGORÍAS (nunca nombres, ids ni
//     coordenadas). `soloCantidades` lo verifica antes de imprimir.
//
// Uso:
//   node estaciones-parseo/parsear.mjs                       real: R2 → base (PARSEO_PG_URL, el rol colector_estaciones)
//   node estaciones-parseo/parsear.mjs --seco                seco: R2 → PGlite en memoria (no toca la base)
//   node estaciones-parseo/parsear.mjs --seco --carpeta D    seco: una carpeta con la forma de R2 → PGlite
//   opciones: --horas N (8 por defecto: la cadena de la ronda dura ~5 h; máx. 72) · --ahora ISO · --fuentes a,b
import { fileURLToPath } from 'node:url';
import { FUENTES } from './fuentes/index.mjs';
import { limpiar } from './lib/calidad.mjs';
import { instante, diaArg, sumar } from './lib/comun.mjs';
import { guardarRed, cerrarCorrida } from './lib/guardar.mjs';

export const PREF = 'estaciones-internas/';

/** El instante UTC (ms) de una clave de ronda: <día ARG>/<HHMM UTC>. Las de 00:00-02:59 UTC son del día ARG anterior. */
export function instanteDeClave(clave) {
  const m = /\/(\d{4})-(\d{2})-(\d{2})\/(\d{2})(\d{2})\.jsonl?$/.exec(clave);
  if (!m) return null;
  const [, a, mes, d, h, mi] = m.map(Number);
  if (h > 23 || mi > 59) return null;
  let t = Date.UTC(a, mes - 1, d, h, mi);
  if (h < 3) t += 864e5;
  return t;
}

/** Las claves de rondas de una fuente entre (ahora − horas, ahora], en orden. */
export async function clavesDeVentana(almacen, fuente, ahoraMs, horas) {
  const desde = ahoraMs - horas * 3600e3;
  const dias = new Set();
  for (let t = desde; t <= ahoraMs + 3600e3; t += 6 * 3600e3) dias.add(diaArg(t));
  dias.add(diaArg(ahoraMs));
  const ext = fuente.ext || /\.json$/;
  const claves = [];
  for (const dia of [...dias].sort()) {
    for (const k of await almacen.listar(`${PREF}${fuente.id}/${dia}/`)) {
      if (!ext.test(k)) continue;
      const t = instanteDeClave(k);
      if (t != null && t > desde && t <= ahoraMs) claves.push({ clave: k, t });
    }
  }
  return { claves: claves.sort((a, b) => a.t - b.t), dias: [...dias] };
}

/** El log público: sólo números, booleanos y categorías (texto corto en minúscula). Lanza si hay otra cosa. */
export function soloCantidades(o, camino = 'resumen') {
  if (o == null || typeof o === 'number' || typeof o === 'boolean') return o;
  if (typeof o === 'string') {
    if (!/^[a-z][a-z0-9_:.]{0,39}$/.test(o)) throw new Error(`el resumen trae un texto que no es una categoría en ${camino}`);
    return o;
  }
  if (Array.isArray(o)) throw new Error(`el resumen no lleva listas (${camino})`);
  for (const [k, v] of Object.entries(o)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || /\d{3,}/.test(k)) throw new Error(`clave no permitida en el resumen (${camino})`);
    soloCantidades(v, camino + '.' + k);
  }
  return o;
}

/** Una corrida: para cada fuente, lee sus rondas de la ventana, limpia, une y guarda. → el resumen (sólo cantidades). */
export async function correr({ almacen, db, ahora = Date.now(), horas = 8, fuentes = FUENTES }) {
  const resumen = { horas, fuentes: {}, total: { estaciones: 0, lecturas: 0, nuevas: 0, cambiadas: 0, iguales: 0 } };
  let ok = true;
  for (const f of fuentes) {
    const r = { rondas: 0, rondas_rotas: 0, estaciones: 0, lecturas: 0, imposibles: 0, descartadas: {} };
    resumen.fuentes[f.id] = r;
    try {
      const { claves, dias } = await clavesDeVentana(almacen, f, ahora, horas);
      const ctx = f.contexto ? await f.contexto({ almacen, dias }) : {};
      const ests = new Map(); const lects = new Map();
      for (const { clave, t } of claves) {
        const b = await almacen.leer(clave);
        if (!b) continue;
        let obj;
        try { obj = f.abrir ? f.abrir(b.toString('utf8')) : JSON.parse(b.toString('utf8')); } catch { r.rondas_rotas++; continue; }
        r.rondas++;
        const leido = instante(obj?.leido) ?? t;
        const res = f.leer(obj, ctx);
        for (const [k, n] of Object.entries(res.descartadas || {})) sumar(r.descartadas, k, n);
        if (res.claves_vistas && Object.keys(res.claves_vistas).length) {
          r.claves_sin_instante ||= {};
          for (const [k, n] of Object.entries(res.claves_vistas)) sumar(r.claves_sin_instante, k, n);
        }
        for (const e of res.estaciones) ests.set(e.estacion_id, e);
        const l = limpiar(res.lecturas, leido, r.descartadas);
        r.imposibles += l.imposibles;
        for (const x of l.lecturas) {
          const k = x.estacion_id + '|' + x.instante;
          const v = lects.get(k);
          const llenas = (y) => ['temp_c', 'hum_pct', 'lluvia_mm', 'lluvia_dia_mm', 'viento_ms', 'presion_hpa'].filter((c) => y[c] != null).length;
          if (!v || llenas(x) >= llenas(v)) lects.set(k, x);
        }
      }
      r.estaciones = ests.size;
      r.lecturas = lects.size;
      if (ests.size || lects.size) {
        const g = await guardarRed(db, { red: f.red, estaciones: [...ests.values()], lecturas: [...lects.values()] });
        r.guardado = g;
        resumen.total.estaciones += g.estaciones_escritas;
        resumen.total.nuevas += g.lecturas_nuevas;
        resumen.total.cambiadas += g.lecturas_cambiadas;
        resumen.total.iguales += g.lecturas_iguales;
      }
      resumen.total.lecturas += lects.size;
    } catch (e) {
      ok = false;
      r.error = e && e.codigo ? 'base:' + e.codigo : 'error';
    }
  }
  try {
    Object.assign(resumen.total, await cerrarCorrida(db, { ok, resumen: soloCantidades(structuredClone(resumen)),
      podar: Math.abs(Date.now() - ahora) < 3 * 3600e3 }));
  } catch (e) {
    ok = false;
    resumen.total.error_cierre = e && e.codigo ? 'base:' + e.codigo : 'error';
  }
  resumen.ok = ok;
  return soloCantidades(resumen);
}

function opciones(argv) {
  const o = { seco: false, carpeta: null, horas: 8, ahora: Date.now(), fuentes: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seco') o.seco = true;
    else if (a === '--carpeta') o.carpeta = argv[++i];
    else if (a === '--horas') o.horas = Math.min(72, Math.max(1, Number(argv[++i]) || 8));
    else if (a === '--ahora') { const t = Date.parse(argv[++i]); if (Number.isFinite(t)) o.ahora = t; else throw new Error('--ahora no es una fecha'); }
    else if (a === '--fuentes') o.fuentes = String(argv[++i]).split(',');
    else throw new Error('opción desconocida');
  }
  return o;
}

async function principal() {
  const o = opciones(process.argv.slice(2));
  const { almacenDeR2, almacenDeCarpeta } = await import('./lib/almacen.mjs');
  const { conectarPg, conectarPglite } = await import('./lib/base.mjs');
  if (o.carpeta && !o.seco) throw new Error('--carpeta va sólo con --seco');
  const almacen = o.carpeta ? almacenDeCarpeta(o.carpeta) : almacenDeR2();
  const db = o.seco ? await conectarPglite() : await conectarPg({ url: process.env.PARSEO_PG_URL });
  const fuentes = o.fuentes ? FUENTES.filter((f) => o.fuentes.includes(f.id)) : FUENTES;
  try {
    const r = await correr({ almacen, db, ahora: o.ahora, horas: o.horas, fuentes });
    console.log(JSON.stringify({ modo: o.seco ? 'seco' : 'real', ...r }));
    if (!r.ok) process.exitCode = 1;
  } finally { await db.cerrar(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().catch((e) => {
    /* el mensaje puede traer cosas de la base o de R2: sólo una categoría */
    const m = String(e && e.message || '');
    const cat = e && e.codigo ? 'base:' + String(e.codigo).slice(0, 16)
      : /^faltan? /.test(m) ? 'falta_secreto' : /PARSEO_PG_URL/.test(m) ? 'url_de_la_base_no_permitida'
      : /otro usuario/.test(m) ? 'usuario_de_la_base_no_es_el_rol' : (/^R2 \w+: HTTP (\d{3})$/.exec(m) ? 'r2_http_' + /\d{3}$/.exec(m)[0] : 'error_al_arrancar');
    console.log(JSON.stringify({ ok: false, error: cat }));
    process.exitCode = 1;
  });
}
