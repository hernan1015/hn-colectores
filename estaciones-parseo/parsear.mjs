// HN AGRO · estaciones-parseo · EL JOB: lee de R2 las rondas de estaciones-privadas/ronda.mjs de las últimas N horas y las
// carga en la base (estaciones + estaciones_lecturas, migración 0161). USO INTERNO: nada se muestra.
//   · SÓLO LEE R2 (token de sólo lectura y, además, un almacén congelado con leer/listar). No le pide nada a ninguna fuente.
//   · Las reglas de calidad de la 139 (lib/calidad.mjs), iguales para las 9 fuentes. Idempotente por la firma.
//   · EL LOG DE ACTIONS ES PÚBLICO: se imprime sólo un resumen de CANTIDADES y CATEGORÍAS (nunca nombres, ids ni
//     coordenadas). `soloCantidades` lo verifica antes de imprimir, con una lista CERRADA de claves (PERMITIDAS).
//   · [0152 obs. 2, 20/11] Los NOMBRES de las claves desconocidas del crudo (WeatherLink, SIGA, EEAOC) NO van al log:
//     el log lleva sólo cuántas son por fuente (`claves_desconocidas`). Los nombres van a registro_procesos (la base,
//     privada) bajo `privado.claves_desconocidas`; en --seco, si se pide, a un archivo FUERA del repo (--claves-a).
//
// Uso:
//   node estaciones-parseo/parsear.mjs                       real: R2 → base (PARSEO_PG_URL, el rol colector_estaciones)
//   node estaciones-parseo/parsear.mjs --seco                seco: R2 → PGlite en memoria (no toca la base)
//   node estaciones-parseo/parsear.mjs --seco --carpeta D    seco: una carpeta con la forma de R2 → PGlite
//   opciones: --horas N (8 por defecto: la cadena de la ronda dura ~5 h; máx. 72) · --ahora ISO · --fuentes a,b
//             --claves-a ARCHIVO (sólo con --seco; fuera del repo): los nombres de las claves desconocidas, en JSON
import fs from 'node:fs';
import path from 'node:path';
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

/** Las ÚNICAS claves que puede llevar el log público: las del resumen, los ids de las fuentes y los motivos de descarte
 *  que escribe el código (un test controla que cada `sumar(descartadas, '…')` del código esté acá). Una clave que no
 *  está, aunque sea de letras, frena el log: así un nombre que venga del crudo nunca sale. */
export const PERMITIDAS = new Set([
  // el resumen
  'horas', 'fuentes', 'total', 'ok', 'modo', 'error', 'error_cierre',
  'estaciones', 'lecturas', 'nuevas', 'cambiadas', 'iguales', 'duplicadas_cambiadas', 'lecturas_podadas',
  'rondas', 'rondas_rotas', 'imposibles', 'descartadas', 'claves_desconocidas', 'guardado',
  'estaciones_escritas', 'lecturas_nuevas', 'lecturas_cambiadas', 'lecturas_iguales', 'sin_estacion',
  // las fuentes
  ...FUENTES.map((f) => f.id),
  // los motivos de descarte (fuentes/*.mjs y lib/calidad.mjs)
  'sin_id', 'sin_instante', 'sin_detalle', 'sin_parte', 'sin_fecha', 'sin_valor', 'sin_variables', 'sin_unidad',
  'no_es_json', 'no_es_device', 'formato_cambiado', 'formato_sin_verificar', 'renglon_roto', 'serie_desconocida',
  'lluvia_sin_dia', 'deshabilitada', 'de_prueba', 'fuera_de_linea', 'fila_corta', 'pronostico', 'repetida',
  'futura', 'vieja_12h', 'vieja_8d', 'ronda_sin_hora',
]);

/** El log público: sólo números, booleanos y categorías (texto corto en minúscula), con claves de PERMITIDAS. Lanza si hay otra cosa. */
export function soloCantidades(o, camino = 'resumen') {
  if (o == null || typeof o === 'number' || typeof o === 'boolean') return o;
  if (typeof o === 'string') {
    if (!/^[a-z][a-z0-9_:.]{0,39}$/.test(o)) throw new Error(`el resumen trae un texto que no es una categoría en ${camino}`);
    return o;
  }
  if (Array.isArray(o)) throw new Error(`el resumen no lleva listas (${camino})`);
  for (const [k, v] of Object.entries(o)) {
    if (!PERMITIDAS.has(k)) throw new Error(`clave no permitida en el resumen (${camino})`);
    soloCantidades(v, camino + '.' + k);
  }
  return o;
}

/** Una corrida: para cada fuente, lee sus rondas de la ventana, limpia, une y guarda. → el resumen (sólo cantidades). */
/** `privado` (opcional) se llena con lo que NO va al log: { claves_desconocidas: { <fuente>: { <clave del crudo>: n } } }. */
export async function correr({ almacen, db, ahora = Date.now(), horas = 8, fuentes = FUENTES, privado = {} }) {
  const resumen = { horas, fuentes: {}, total: { estaciones: 0, lecturas: 0, nuevas: 0, cambiadas: 0, iguales: 0 } };
  privado.claves_desconocidas = {};
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
          const c = (privado.claves_desconocidas[f.id] ||= {});
          for (const [k, n] of Object.entries(res.claves_vistas)) sumar(c, k, n);
          r.claves_desconocidas = Object.keys(c).length;     // al log, SÓLO la cantidad
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
    /* a la base: el resumen público (verificado) y, aparte, los nombres (privado: registro_procesos no se publica) */
    const aLaBase = { ...soloCantidades(structuredClone(resumen)), privado: { claves_desconocidas: privado.claves_desconocidas } };
    Object.assign(resumen.total, await cerrarCorrida(db, { ok, resumen: aLaBase, podar: Math.abs(Date.now() - ahora) < 3 * 3600e3 }));
  } catch (e) {
    ok = false;
    resumen.total.error_cierre = e && e.codigo ? 'base:' + e.codigo : 'error';
  }
  resumen.ok = ok;
  return soloCantidades(resumen);
}

/** La raíz del repo (la carpeta de arriba de estaciones-parseo/). Un archivo con nombres del crudo no puede caer adentro. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function dentroDelRepo(p) {
  const rel = path.relative(REPO.toLowerCase(), path.resolve(p).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function opciones(argv) {
  const o = { seco: false, carpeta: null, horas: 8, ahora: Date.now(), fuentes: null, clavesA: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seco') o.seco = true;
    else if (a === '--carpeta') o.carpeta = argv[++i];
    else if (a === '--horas') o.horas = Math.min(72, Math.max(1, Number(argv[++i]) || 8));
    else if (a === '--ahora') { const t = Date.parse(argv[++i]); if (Number.isFinite(t)) o.ahora = t; else throw new Error('--ahora no es una fecha'); }
    else if (a === '--fuentes') o.fuentes = String(argv[++i]).split(',');
    else if (a === '--claves-a') o.clavesA = argv[++i];
    else throw new Error('opción desconocida');
  }
  return o;
}

async function principal() {
  const o = opciones(process.argv.slice(2));
  const { almacenDeR2, almacenDeCarpeta } = await import('./lib/almacen.mjs');
  const { conectarPg, conectarPglite } = await import('./lib/base.mjs');
  if (o.carpeta && !o.seco) throw new Error('--carpeta va sólo con --seco');
  if (o.clavesA && !o.seco) throw new Error('--claves-a va sólo con --seco');
  if (o.clavesA && dentroDelRepo(o.clavesA)) throw new Error('--claves-a no puede ir dentro del repo');
  const almacen = o.carpeta ? almacenDeCarpeta(o.carpeta) : almacenDeR2();
  const db = o.seco ? await conectarPglite() : await conectarPg({ url: process.env.PARSEO_PG_URL });
  const fuentes = o.fuentes ? FUENTES.filter((f) => o.fuentes.includes(f.id)) : FUENTES;
  try {
    const privado = {};
    const r = await correr({ almacen, db, ahora: o.ahora, horas: o.horas, fuentes, privado });
    if (o.clavesA) fs.writeFileSync(o.clavesA, JSON.stringify(privado, null, 1) + '\n');   // nunca al stdout
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
      : /otro usuario/.test(m) ? 'usuario_de_la_base_no_es_el_rol' : /^--claves-a /.test(m) ? 'claves_a_no_permitido' : (/^R2 \w+: HTTP (\d{3})$/.exec(m) ? 'r2_http_' + /\d{3}$/.exec(m)[0] : 'error_al_arrancar');
    console.log(JSON.stringify({ ok: false, error: cat }));
    process.exitCode = 1;
  });
}
