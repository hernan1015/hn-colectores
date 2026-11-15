#!/usr/bin/env node
// HN AGRO · el PARSEO de las estaciones de USO INTERNO: lee de R2 lo que guardó ronda.mjs y lo pasa a estaciones /
// estaciones_obs (hn-agro 0110 + 0147), una red por fuente, con metadatos.mostrar = false. Corre en la nube DESPUÉS de
// cada ronda (workflow estaciones-parseo, con la llave ESTACIONES_PARSEO_ON). NO le pide nada a ninguna fuente: sólo
// lee R2 y escribe la base.
//
// Un módulo por fuente en fuentes/ (FUENTES, abajo). Cada módulo: { id (el prefijo de R2), nombre, proceso, redes:
// { RED: cfg del diario }, leer(objeto) → [{ red, estaciones, lecturas, diarias?, paso?, problemas }] }.
// ⇒ La 138b (WeatherLink, Weathercloud) suma sus módulos acá, con el mismo guardado.
//
// Las reglas (maker y local, 15/11):
//   · los valores imposibles se descartan (HR 0 o 255, 50 °C o más; lib/diario.mjs);
//   · una lectura de más de 12 h (respecto de cuándo la leyó la ronda) no cuenta como nueva;
//   · idempotente: cada fila lleva la firma de su contenido; si no cambió, no se escribe. Correr dos veces no cambia nada;
//   · por defecto mira las rondas de las últimas 3 h (si una corrida falló, la siguiente las levanta); --horas N para más.
// El registro de Actions es PÚBLICO: se imprimen sólo cantidades (nunca nombres, ids ni coordenadas).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { filasEstacion, fechasALeer } from './lib/diario.mjs';
import { conectarPg, crearGuardado } from './lib/base.mjs';
import { localDe, msLocal } from './lib/hora.mjs';
import siga from './fuentes/siga.mjs';
import eeaoc from './fuentes/eeaoc.mjs';
import mendoza from './fuentes/dacc.mjs';
import sanluis from './fuentes/rem.mjs';
import bcp from './fuentes/bcp.mjs';
import entrerios from './fuentes/er.mjs';
import ina from './fuentes/ina.mjs';

export const PREF = 'estaciones-internas/';
export const FUENTES = Object.freeze([siga, eeaoc, mendoza, sanluis, bcp, entrerios, ina]);
export const SECRETO = 'ESTACIONES_PG_URL';

/** El instante (ms) de una clave de ronda.mjs: <fuente>/<día ARG>/<HHMM UTC>.json. null si no tiene esa forma. */
export function instanteDeClave(clave) {
  const m = /\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})\.json$/.exec(clave);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  /* el día es el de Argentina y la hora es UTC: de 00 a 02:59 UTC todavía es el día anterior en Argentina */
  return Number(m[2]) < 3 ? ms + 864e5 : ms;
}

const diaArg = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
const grupo = (m, k) => { if (!m.has(k)) m.set(k, []); return m.get(k); };

/** Las claves de una fuente con rondas de las últimas `horas`. */
async function clavesRecientes(almacen, fuente, ahora, horas) {
  const desde = ahora - horas * 3600e3;
  const dias = new Set([diaArg(ahora), diaArg(desde)]);
  const out = [];
  for (const d of [...dias].sort()) {
    for (const k of await almacen.listar(`${PREF}${fuente.id}/${d}/`)) {
      const t = instanteDeClave(k);
      if (t != null && t >= desde && t <= ahora + 600e3) out.push(k);
    }
  }
  return out.sort();
}

/** Junta lo de todas las rondas recientes de una fuente, por red. La regla de las 12 h se aplica contra el `leido` de
 *  CADA ronda (así una lectura vieja no entra aunque se procese tarde). */
export function juntar(fuente, objetos) {
  const porRed = new Map();
  let problemas = 0, rondas = 0, rotas = 0;
  for (const obj of objetos) {
    let salidas;
    try { salidas = fuente.leer(obj); } catch { rotas++; continue; }
    rondas++;
    const leidoLocal = localDe(obj?.leido);
    for (const s of salidas) {
      const cfg = fuente.redes[s.red];
      if (!cfg) throw new Error(`${fuente.id}: red ${s.red} sin configuración`);
      const r = porRed.get(s.red) || { estaciones: new Map(), lecturas: [], diarias: [], paso: {}, descartadas: 0 };
      porRed.set(s.red, r);
      for (const e of s.estaciones || []) r.estaciones.set(e.estacion_id, e);
      const tope = leidoLocal ? msLocal(leidoLocal) : NaN;
      for (const l of s.lecturas || []) {
        const t = msLocal(l.local);
        if (Number.isFinite(tope) && (tope - t > (cfg.maxEdadH ?? 12) * 3600e3 || t - tope > 15 * 60e3)) { r.descartadas++; continue; }
        r.lecturas.push(l);
      }
      r.diarias.push(...(s.diarias || []));
      Object.assign(r.paso, s.paso || {});
      problemas += s.problemas || 0;
    }
  }
  return { porRed, problemas, rondas, rotas };
}

/** Lo que va a la base de UNA red. `viejas` = filas guardadas (con crudo) de esas fechas. */
export function armarFilas(cfg, r, viejas, ahoraLocal, horas) {
  const viejasPor = new Map();
  for (const v of viejas) grupo(viejasPor, v.estacion_id).push(v);
  const filas = []; let descartadas = 0;
  if (cfg.diaria) {
    const porEst = new Map();
    for (const d of r.diarias) grupo(porEst, d.id).push(...d.obs);
    for (const [id, nuevas] of porEst) for (const f of cfg.armar({ nuevas, viejas: viejasPor.get(id) || [] })) filas.push({ ...f, estacion_id: id });
    return { filas, descartadas };
  }
  const porEst = new Map();
  for (const l of r.lecturas) grupo(porEst, l.id).push({ local: l.local, v: l.v });
  for (const [id, nuevas] of porEst) {
    /* la edad ya se filtró por ronda: acá sólo se corta lo que quedó afuera de la ventana de rondas leídas */
    const c = { ...cfg, maxEdadH: (cfg.maxEdadH ?? 12) + horas + 1, ...(r.paso[id] ? { pasoMin: r.paso[id] } : {}) };
    const x = filasEstacion({ nuevas, viejas: viejasPor.get(id) || [], cfg: c, ahoraLocal });
    descartadas += x.descartadas;
    for (const f of x.filas) filas.push({ ...f, estacion_id: id });
  }
  return { filas, descartadas };
}

const mismo = (a, b) => !!a && !!b && (a.nombre ?? null) === (b.nombre ?? null) && Object.is(a.lat ?? null, b.lat ?? null) && Object.is(a.lon ?? null, b.lon ?? null);

export async function correr({ almacen, ejecutor = null, conectar = null, env = process.env, ahora = Date.now(), horas = 3, fuentes = FUENTES, seco = false, log = console.log }) {
  const ahoraLocal = localDe(ahora);
  const total = {};
  let ej = ejecutor;
  let hayError = false;
  try {
    for (const f of fuentes) {
      const res = { rondas: 0, rotas: 0, estaciones_nuevas: 0, filas_escritas: 0, descartadas: 0, problemas: 0, errores: 0 };
      total[f.id] = res;
      let claves;
      try { claves = await clavesRecientes(almacen, f, ahora, horas); } catch { res.errores++; hayError = true; continue; }
      const objetos = [];
      for (const k of claves) { try { const b = await almacen.leer(k); if (b) objetos.push(JSON.parse(b.toString())); } catch { res.rotas++; } }
      const j = juntar(f, objetos);
      Object.assign(res, { rondas: j.rondas, rotas: res.rotas + j.rotas, problemas: j.problemas });
      if (!j.porRed.size) continue;
      if (seco) {
        for (const [red, r] of j.porRed) { const a = armarFilas(f.redes[red], r, [], ahoraLocal, horas); res.filas_escritas += a.filas.length; res.descartadas += r.descartadas + a.descartadas; }
        continue;
      }
      if (!ej) ej = await conectarPg({ url: env[SECRETO], conectar, app: 'parseo-estaciones-internas' });
      const errores = [];
      for (const [red, r] of j.porRed) {
        const g = crearGuardado(ej, red);
        const guardadas = new Map((await g.estaciones()).map((e) => [e.estacion_id, e]));
        /* el catálogo: sólo las nuevas o las que cambiaron de nombre o lugar (no se reescribe todo cada hora) */
        const ids = new Set([...r.estaciones.keys(), ...r.lecturas.map((l) => l.id), ...r.diarias.map((d) => d.id)]);
        const cat = [];
        for (const id of ids) {
          const e = r.estaciones.get(id) || { estacion_id: id, metadatos: { fuente: f.nombre } };
          if (!mismo(guardadas.get(id), e) || guardadas.get(id)?.metadatos?.mostrar !== false) cat.push(e);
        }
        const ge = await g.guardarEstaciones(cat);
        const fechas = cfgFechas(f.redes[red], r);
        const viejas = await g.obsFechas(fechas);
        const a = armarFilas(f.redes[red], r, viejas, ahoraLocal, horas);
        const go = await g.guardarObs(a.filas);
        res.estaciones_nuevas += ge.ok; res.filas_escritas += go.ok; res.descartadas += r.descartadas + a.descartadas;
        errores.push(...ge.errores, ...go.errores);
      }
      res.errores = errores.length;
      if (errores.length) hayError = true;
      try { await crearGuardado(ej, Object.keys(f.redes)[0]).registrar(f.proceso, !errores.length, { ...res, errores: errores.slice(0, 30) }); }
      catch { res.errores++; hayError = true; }
    }
  } finally { if (ej && !ejecutor) await ej.cerrar(); }
  /* SÓLO cantidades: el registro de Actions es público */
  log(JSON.stringify({ parseo: total, seco, horas }));
  return { ok: !hayError, total };
}

function cfgFechas(cfg, r) {
  if (cfg.diaria) return [...new Set(r.diarias.flatMap((d) => d.obs.map((o) => o.fecha)))].sort();
  return fechasALeer(r.lecturas);
}

/* ── línea de comandos (en el workflow) ── */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--horas');
  const horas = i >= 0 ? Math.min(Math.max(Number(args[i + 1]) || 3, 1), 72) : 3;
  const { almacenR2 } = await import('../../sipan-alto-valle/lib/almacen.mjs');
  const almacen = almacenR2({ cuenta: process.env.R2_ACCOUNT_ID, clave: process.env.R2_ACCESS_KEY_ID, secreto: process.env.R2_SECRET_ACCESS_KEY, deposito: process.env.R2_BUCKET });
  correr({ almacen, horas, seco: args.includes('--seco') })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error('parseo: error ' + String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, '[url]').slice(0, 200)); process.exit(1); });
}
