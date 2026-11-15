#!/usr/bin/env node
// HN AGRO · el PARSEO de las estaciones de USO INTERNO: el crudo que deja ronda.mjs en R2 → estaciones / estaciones_obs
// (hn-agro 0110 + 0147) y estaciones_ultima_lectura. UN SOLO JOB para las 9 fuentes (138b: WeatherLink y Weathercloud;
// 139: SIGA, EEAOC, Mendoza, San Luis, BCP, Entre Ríos e INA), un módulo por fuente (fuentes/index.mjs).
// Corre en Actions DESPUÉS de cada ronda (workflow_run; ver estaciones-privadas-parseo.workflow.yml.txt), detrás de la
// llave ESTACIONES_PARSEO_ON.
//
// SÓLO LEE R2 (leer / listar) y escribe en la base con el rol colector_estaciones. No le pide nada a ninguna fuente.
// Las reglas (maker y local, 15/11), las mismas para las 9:
//   · mostrar = false siempre (lo fuerza el SQL de lib/base.mjs);
//   · los imposibles afuera (HR 0 o 255, 50 °C o más: lib/diario.mjs · LIMITES; NULL nunca es 0);
//   · LA EDAD, una regla por red (cfg.maxEdadH), medida contra el `leido` de la ronda que la trajo (en WeatherLink, el de
//     cada renglón): 12 h por defecto; 2 h en WeatherLink y Weathercloud (consolas de particulares en un mapa: con una
//     pasada por hora, algo de más de 2 h ya no es de esta hora); 240 h en Entre Ríos (la consola sube un archivo de una
//     semana cuando puede). Más de 15 min en el futuro tampoco entra;
//   · IDEMPOTENTE: cada fila une lo guardado (las lecturas de su crudo) con lo nuevo, deduplica por (estación, instante)
//     y lleva la firma de su contenido; si la firma no cambió, no se escribe. Como lo guardado entra en la unión, una
//     corrida con menos crudo nunca pisa un día más completo. La última lectura nunca retrocede;
//   · la ventana: las rondas de las últimas --horas (6 por defecto: si fallan hasta 5 corridas seguidas, la siguiente
//     las levanta; hasta 72). --desde AAAA-MM-DD para levantar días enteros, p. ej. el lote de la notebook del 15/11.
// El registro de Actions es PÚBLICO: se imprime una sola línea con cantidades (nunca nombres, ids, coordenadas ni valores).
//
// Uso:  node parseo.mjs                 SECO: lee R2 y arma, no se conecta a la base
//       node parseo.mjs --real          guarda (PARSEO_PG_URL)
//       --fuentes weatherlink,eeaoc · --horas 6 · --desde 2026-11-15 · --ahora ISO (pruebas)
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { FUENTES } from './fuentes/index.mjs';
import { filasEstacion, fechasALeer, controlar } from './lib/diario.mjs';
import { conectarPg, crearGuardado } from './lib/base.mjs';
import { localDe, msLocal, sumarDias, utcDe } from './lib/hora.mjs';

export const PREF = 'estaciones-internas/';
export const SECRETO = 'PARSEO_PG_URL';
export const HORAS = 6;

/** Sólo leer y listar: lo demás no existe en el objeto que ven los módulos. */
export function soloLectura(almacen) {
  return Object.freeze({ leer: (k) => almacen.leer(k), listar: (p) => almacen.listar(p) });
}

export function leerArgs(argv, ahora = Date.now()) {
  const a = { real: false, fuentes: null, horas: HORAS, ahora: null };
  let desde = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--real') a.real = true;
    else if (k === '--seco') a.real = false;
    else if (k === '--fuentes') a.fuentes = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--horas') a.horas = Number(argv[++i]);
    else if (k === '--desde') desde = String(argv[++i] || '');
    else if (k === '--ahora') a.ahora = argv[++i];
    else throw new Error(`opción desconocida: ${k}`);
  }
  if (!(Number.isInteger(a.horas) && a.horas >= 1 && a.horas <= 72)) throw new Error('--horas: de 1 a 72');
  if (desde != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error('--desde: AAAA-MM-DD');
    const t = a.ahora ? Date.parse(a.ahora) : ahora;
    const h = Math.ceil((t - Date.parse(desde + 'T03:00:00Z')) / 3600e3);
    if (!(h >= 1 && h <= 31 * 24)) throw new Error('--desde: de hoy a 31 días atrás');
    a.horas = Math.max(a.horas, h);
  }
  return a;
}

/** El instante (ms) de una clave de ronda.mjs: <fuente>/<día ARG>/<HHMM UTC>.json(l). null si no tiene esa forma. */
export function instanteDeClave(clave) {
  const m = /\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})\.jsonl?$/.exec(clave);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  /* el día es el de Argentina y la hora es UTC: de 00 a 02:59 UTC todavía es el día anterior en Argentina */
  return Number(m[2]) < 3 ? ms + 864e5 : ms;
}

const diaArg = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
const grupo = (m, k) => { if (!m.has(k)) m.set(k, []); return m.get(k); };

/** Los días ARG que toca la ventana (todos, del primero al de hoy). */
export function diasVentana(ahora, horas) {
  const dias = [];
  for (let d = diaArg(ahora - horas * 3600e3); d <= diaArg(ahora); d = sumarDias(d, 1)) dias.push(d);
  return dias;
}

/** Las claves de una fuente: las rondas de la ventana y los lotes (p. ej. local.jsonl.gz) de sus días. */
export async function clavesVentana(r2, fuente, ahora, horas) {
  const desde = ahora - horas * 3600e3;
  const ext = fuente.ext || /\.json$/;
  const out = [];
  for (const d of diasVentana(ahora, horas)) {
    for (const k of await r2.listar(`${PREF}${fuente.id}/${d}/`)) {
      if (fuente.lote && fuente.lote.test(k)) { out.push(k); continue; }
      if (!ext.test(k)) continue;
      const t = instanteDeClave(k);
      if (t != null && t >= desde && t <= ahora + 600e3) out.push(k);
    }
  }
  return out.sort();
}

/** El contenido de una clave → los objetos que lee el módulo (los .gz se descomprimen acá). */
function abrirClave(fuente, clave, b) {
  const texto = (/\.gz$/.test(clave) ? zlib.gunzipSync(b) : b).toString('utf8');
  return fuente.abrir ? fuente.abrir(texto, clave) : [JSON.parse(texto)];
}

function sumarCuentas(dst, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (typeof v === 'number') dst[k] = (dst[k] || 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) sumarCuentas((dst[k] = dst[k] && typeof dst[k] === 'object' ? dst[k] : {}), v);
    else if (typeof v === 'boolean') dst[k] = v;
  }
  return dst;
}

/** Junta lo de todos los objetos de una fuente, por red. La regla de la edad se aplica contra el `leido` de CADA ronda
 *  (o de cada lectura, si lo trae): así una lectura vieja no entra aunque se procese tarde. */
export function juntar(fuente, objetos, ctx) {
  const porRed = new Map();
  let problemas = 0, rondas = 0, rotas = 0;
  for (const obj of objetos) {
    let salidas;
    try { salidas = fuente.leer(obj, ctx); } catch { rotas++; continue; }
    rondas++;
    const leidoLocal = localDe(obj?.leido);
    for (const s of salidas) {
      const cfg = fuente.redes[s.red];
      if (!cfg) throw new Error(`${fuente.id}: red ${s.red} sin configuración`);
      const r = porRed.get(s.red) || { estaciones: new Map(), lecturas: [], diarias: [], paso: {}, descartadas: 0, cuentas: {}, claves: {}, presentes: null, avisos: new Set() };
      porRed.set(s.red, r);
      /* la misma estación en varias rondas: lo que trae cada una se suma (una ronda sin nombre no borra el de otra) */
      for (const e of s.estaciones || []) {
        const prev = r.estaciones.get(e.estacion_id);
        r.estaciones.set(e.estacion_id, prev ? { ...prev, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v != null)) } : e);
      }
      for (const l of s.lecturas || []) {
        const ll = l.leido != null ? localDe(l.leido) : leidoLocal;
        const tope = ll ? msLocal(ll) : NaN;
        const t = msLocal(l.local);
        if (Number.isFinite(tope) && (tope - t > (cfg.maxEdadH ?? 12) * 3600e3 || t - tope > 15 * 60e3)) { r.descartadas++; continue; }
        r.lecturas.push(l);
      }
      r.diarias.push(...(s.diarias || []));
      Object.assign(r.paso, s.paso || {});
      sumarCuentas(r.cuentas, s.cuentas);
      for (const [m, c] of Object.entries(s.claves_descartadas || {})) if (!r.claves[m]) r.claves[m] = c;
      if (s.presentes) r.presentes = [...new Set([...(r.presentes || []), ...s.presentes])];
      for (const a of s.avisos || []) r.avisos.add(a);
      problemas += s.problemas || 0;
    }
  }
  return { porRed, problemas, rondas, rotas };
}

/** Lo que va a la base de UNA red. `viejas` = filas guardadas (con crudo) de esas fechas. */
export function armarFilas(cfg, r, viejas, ahoraLocal, horas) {
  const viejasPor = new Map();
  for (const v of viejas) grupo(viejasPor, v.estacion_id).push(v);
  const filas = []; let descartadas = 0, repetidas = 0;
  if (cfg.diaria) {
    const porEst = new Map();
    for (const d of r.diarias) grupo(porEst, d.id).push(...d.obs);
    for (const [id, nuevas] of porEst) for (const f of cfg.armar({ nuevas, viejas: viejasPor.get(id) || [] })) filas.push({ ...f, estacion_id: id });
    return { filas, descartadas, repetidas };
  }
  const porEst = new Map();
  for (const l of r.lecturas) grupo(porEst, l.id).push({ local: l.local, v: l.v });
  for (const [id, nuevas] of porEst) {
    /* la edad ya se filtró por ronda: acá sólo se corta lo que quedó afuera de la ventana de rondas leídas */
    const c = { ...cfg, maxEdadH: (cfg.maxEdadH ?? 12) + horas + 1, ...(r.paso[id] ? { pasoMin: r.paso[id] } : {}) };
    const x = filasEstacion({ nuevas, viejas: viejasPor.get(id) || [], cfg: c, ahoraLocal });
    descartadas += x.descartadas; repetidas += x.repetidas;
    for (const f of x.filas) filas.push({ ...f, estacion_id: id });
  }
  return { filas, descartadas, repetidas };
}

/** La última lectura de cada estación, con la misma regla de imposibles (lib/diario.mjs), para estaciones_ultima_lectura. */
export function ultimaFila(lecturas) {
  const m = new Map();
  for (const l of lecturas) { const v = m.get(l.id); if (!v || msLocal(l.local) > msLocal(v.local) || (l.local === v.local && l.instante > v.instante)) m.set(l.id, l); }
  return [...m.values()].map((l) => {
    const [c] = controlar([{ local: l.local, v: l.v }]);
    const x = l.v?.x || {};
    return { id: l.id, instante: l.instante || utcDe(l.local), edad_s: l.edad_s ?? null, temp_c: c.ok.temp, hum_pct: c.ok.hum, lluvia_dia_mm: c.ok.lluvia_acum,
      viento_ms: x.viento_ms ?? null, racha_ms: x.racha_ms ?? null, viento_dir_gr: x.viento_dir_gr ?? null, presion_hpa: x.presion_hpa ?? null,
      marcas: [...new Set([...(l.marcas || []), ...c.marcas])] };
  });
}

const mismo = (a, b) => !!a && !!b && (a.nombre ?? null) === (b.nombre ?? null) && Object.is(a.lat ?? null, b.lat ?? null) && Object.is(a.lon ?? null, b.lon ?? null)
  && a.activa === (b.activa !== false);
const sinUrl = (e) => String(e && e.message || e).slice(0, 120).replace(/https?:\/\/\S+/g, '<url>').replace(/postgres(ql)?:\/\/\S+/g, '<url>');

/**
 * Una corrida. Con `ejecutor` (o `real` y PARSEO_PG_URL) guarda; si no, SECO (no se conecta a nada).
 * Devuelve { ok, modo, horas, fuentes: { <id>: cantidades } } e imprime UNA línea con eso por `log`.
 */
export async function correr({ r2, ejecutor = null, real = false, conectar = null, env = process.env, ahora = Date.now(), horas = HORAS,
  fuentes = FUENTES, solo = null, log = console.log }) {
  const ro = soloLectura(r2);
  const ahoraLocal = localDe(ahora);
  const modo = ejecutor || real ? 'real' : 'seco';
  const resumen = { modo, horas, fuentes: {} };
  let ej = ejecutor;
  let ok = true;
  try {
    for (const f of fuentes) {
      if (solo && !solo.includes(f.id)) continue;
      const res = { rondas: 0, rotas: 0, lecturas: 0, repetidas: 0, descartadas: 0, problemas: 0, estaciones: 0, estaciones_nuevas: 0, filas_escritas: 0, errores: 0 };
      resumen.fuentes[f.id] = res;
      try {
        const claves = await clavesVentana(ro, f, ahora, horas);
        const ctx = f.contexto ? await f.contexto({ r2: ro, dias: diasVentana(ahora, horas) }) : null;
        const objetos = [];
        for (const k of claves) { try { const b = await ro.leer(k); if (b) objetos.push(...abrirClave(f, k, b)); } catch { res.rotas++; } }
        const j = juntar(f, objetos, ctx);
        Object.assign(res, { rondas: j.rondas, rotas: res.rotas + j.rotas, problemas: j.problemas });
        for (const r of j.porRed.values()) {
          res.lecturas += r.lecturas.length; res.estaciones += r.estaciones.size;
          if (Object.keys(r.cuentas).length) sumarCuentas((res.cuentas ||= {}), r.cuentas);
          if (Object.keys(r.claves).length) res.claves_descartadas = { ...(res.claves_descartadas || {}), ...r.claves };   // sólo NOMBRES de claves
          if (r.avisos.size) res.avisos = [...r.avisos];
        }
        if (!j.porRed.size) continue;
        if (modo === 'seco') {
          for (const [red, r] of j.porRed) {
            const a = armarFilas(f.redes[red], r, [], ahoraLocal, horas);
            res.filas_escritas += a.filas.length; res.descartadas += r.descartadas + a.descartadas; res.repetidas += a.repetidas;
          }
          continue;
        }
        if (!ej) {
          if (!env[SECRETO]) throw new Error(`falta ${SECRETO}`);
          ej = await conectarPg({ url: env[SECRETO], conectar, app: 'parseo-estaciones' });
        }
        const errores = [];
        for (const [red, r] of j.porRed) {
          const cfg = f.redes[red];
          const g = crearGuardado(ej, red);
          const guardadas = new Map((await g.estaciones()).map((e) => [e.estacion_id, e]));
          /* el catálogo: sólo las nuevas o las que cambiaron de nombre, lugar o actividad (no se reescribe todo cada hora) */
          const ids = new Set([...r.estaciones.keys(), ...r.lecturas.map((l) => l.id), ...r.diarias.map((d) => d.id)]);
          const cat = [];
          for (const id of ids) {
            const e = r.estaciones.get(id) || { estacion_id: id, metadatos: { fuente: f.nombre } };
            if (!mismo(guardadas.get(id), e) || guardadas.get(id)?.metadatos?.mostrar !== false) cat.push(e);
          }
          const ge = await g.guardarEstaciones(cat);
          if (r.presentes) res.inactivas = (res.inactivas || 0) + await g.inactivas(r.presentes, diaArg(ahora));
          const fechas = cfg.diaria ? [...new Set(r.diarias.flatMap((d) => d.obs.map((o) => o.fecha)))].sort() : fechasALeer(r.lecturas);
          const viejas = await g.obsFechas(fechas);
          const a = armarFilas(cfg, r, viejas, ahoraLocal, horas);
          const go = await g.guardarObs(a.filas);
          res.estaciones_nuevas += ge.ok; res.filas_escritas += go.ok; res.descartadas += r.descartadas + a.descartadas; res.repetidas += a.repetidas;
          if (cfg.ultima) res.ultimas = (res.ultimas || 0) + await g.ultimas(ultimaFila(r.lecturas), f.id);
          errores.push(...ge.errores, ...go.errores);
        }
        res.errores = errores.length;
        if (errores.length) ok = false;
        try { await crearGuardado(ej, Object.keys(f.redes)[0]).registrar(f.proceso, !errores.length, { fuente: f.id, ...res, errores: errores.slice(0, 30) }); }
        catch { res.errores++; ok = false; }
      } catch (e) {
        res.error = sinUrl(e);
        ok = false;
      }
    }
  } finally { if (ej && !ejecutor) await ej.cerrar(); }
  resumen.ok = ok;
  /* SÓLO cantidades: el registro de Actions es público */
  log(JSON.stringify(resumen));
  return resumen;
}

async function main() {
  const a = leerArgs(process.argv.slice(2));
  const { almacenR2 } = await import('../../sipan-alto-valle/lib/almacen.mjs');
  const r2 = almacenR2({ cuenta: process.env.R2_ACCOUNT_ID, clave: process.env.PARSEO_R2_ACCESS_KEY_ID,
    secreto: process.env.PARSEO_R2_SECRET_ACCESS_KEY, deposito: process.env.R2_BUCKET });
  const res = await correr({ r2, real: a.real, ahora: a.ahora ? Date.parse(a.ahora) : Date.now(), horas: a.horas, solo: a.fuentes });
  process.exitCode = res.ok ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('parseo: ' + sinUrl(e)); process.exitCode = 1; });
}
