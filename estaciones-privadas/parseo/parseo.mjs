#!/usr/bin/env node
// HN AGRO · el PARSEO de las estaciones internas: el crudo que deja ronda.mjs en R2 → estaciones_obs. USO INTERNO.
// Corre en Actions DESPUÉS de cada ronda (workflow_run; ver estaciones-privadas-parseo.workflow.yml.txt), detrás de la
// llave ESTACIONES_PARSEO_ON. Un solo job para todas las fuentes, un módulo por fuente (fuentes/index.mjs).
//
// SÓLO LEE R2 (leer / listar) y escribe en la base con el rol colector_estaciones. No le pide nada a ninguna fuente.
// IDEMPOTENTE: cada corrida vuelve a armar los días objetivo (ayer y hoy, ARG) desde todo el crudo de esos días (y el
// de anteayer, para la noche de ayer), deduplicando por (estación, instante); lo guardado sólo se reemplaza por algo
// igual o más completo (lib/dia.mjs · combinar).
// El registro de Actions es PÚBLICO: se imprimen sólo cantidades, nunca ids, nombres, coordenadas ni valores.
//
// Uso:  node parseo.mjs                 SECO: lee R2 y arma, no escribe en la base
//       node parseo.mjs --real          guarda (PARSEO_PG_URL)
//       --fuentes weatherlink,weathercloud · --objetivo 2 (días: hoy y ayer) · --ahora ISO (pruebas)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUENTES } from './fuentes/index.mjs';
import { deduplicar, armarDias, combinar, ultimas } from './lib/dia.mjs';
import { crearGuardado } from './lib/guardar.mjs';
import { local, sumarDias } from './lib/convertir.mjs';

/** Sólo leer y listar: lo demás no existe en el objeto que ven los módulos. */
export function soloLectura(almacen) {
  return Object.freeze({ leer: (k) => almacen.leer(k), listar: (p) => almacen.listar(p) });
}

export function leerArgs(argv) {
  const a = { real: false, fuentes: null, objetivo: 2, ahora: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--real') a.real = true;
    else if (k === '--seco') a.real = false;
    else if (k === '--fuentes') a.fuentes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--objetivo') a.objetivo = Number(argv[++i]);
    else if (k === '--ahora') a.ahora = argv[++i];
    else throw new Error(`opción desconocida: ${k}`);
  }
  if (!(Number.isInteger(a.objetivo) && a.objetivo >= 1 && a.objetivo <= 7)) throw new Error('--objetivo: de 1 a 7 días');
  return a;
}

/** Los días: los objetivo (los que se escriben) y los que se leen (uno más atrás, por la noche). */
export function diasDe(ahoraMs, objetivo) {
  const hoy = local(ahoraMs).fecha;
  const obj = []; for (let i = objetivo - 1; i >= 0; i--) obj.push(sumarDias(hoy, -i));
  return { objetivo: obj, leer: [sumarDias(obj[0], -1), ...obj] };
}

/** Una corrida. `guardado` = crearGuardado(q) o null (seco). Devuelve el resumen (sólo cantidades). */
export async function correr({ r2, guardado = null, ahora = Date.now(), fuentes = null, objetivo = 2, modulos = FUENTES }) {
  const { objetivo: obj, leer } = diasDe(ahora, objetivo);
  const resumen = { modo: guardado ? 'real' : 'seco', dias: obj, fuentes: {} };
  let ok = true;
  for (const m of modulos) {
    if (fuentes && !fuentes.includes(m.fuente)) continue;
    const r = { };
    try {
      const res = await m.leer({ r2, dias: leer });
      const { lecturas, repetidas } = deduplicar(res.lecturas);
      const filas = armarDias(lecturas, { red: m.red, fechas: obj, muestreo_min: m.muestreo_min, fuente: m.fuente });
      Object.assign(r, res.cuentas, { repetidas, estaciones: res.estaciones.length, filas_obs: filas.length });
      if (res.avisos?.length) r.avisos = res.avisos;
      if (Object.keys(res.claves_descartadas || {}).length) r.claves_descartadas = res.claves_descartadas;   // sólo NOMBRES de claves
      if (guardado) {
        await guardado.estaciones(m.red, res.estaciones);
        if (res.presentes) r.inactivas = await guardado.inactivas(m.red, res.presentes, obj.at(-1));
        const viejas = new Map((await guardado.obsDe(m.red, obj)).map((f) => [`${f.estacion_id}|${f.fecha}`, f]));
        const g = await guardado.obs(m.red, filas.map((f) => combinar(viejas.get(`${f.estacion_id}|${f.fecha}`), f)));
        r.guardadas = g.ok;
        if (g.errores.length) { r.errores = g.errores.length; ok = false; }
        r.ultimas = await guardado.ultimas(m.red, ultimas(lecturas), m.fuente);
      }
    } catch (e) {
      r.error = String(e && e.message || e).slice(0, 120).replace(/https?:\/\/\S+/g, '<url>');
      ok = false;
    }
    resumen.fuentes[m.fuente] = r;
  }
  if (guardado) await guardado.registrar(ok, resumen);
  resumen.ok = ok;
  return resumen;
}

async function main() {
  const a = leerArgs(process.argv.slice(2));
  const { almacenR2 } = await import('../../sipan-alto-valle/lib/almacen.mjs');
  const r2 = soloLectura(almacenR2({ cuenta: process.env.R2_ACCOUNT_ID, clave: process.env.PARSEO_R2_ACCESS_KEY_ID,
    secreto: process.env.PARSEO_R2_SECRET_ACCESS_KEY, deposito: process.env.R2_BUCKET }));
  let base = null;
  if (a.real) {
    const { conectarPg } = await import('./lib/guardar.mjs');
    base = await conectarPg({ url: process.env.PARSEO_PG_URL });
  }
  try {
    const res = await correr({ r2, guardado: base ? crearGuardado(base.q) : null, ahora: a.ahora ? Date.parse(a.ahora) : Date.now(),
      fuentes: a.fuentes, objetivo: a.objetivo });
    console.log(JSON.stringify(res));
    process.exitCode = res.ok ? 0 : 2;
  } finally {
    if (base) await base.cerrar();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(String(e && e.message || e).replace(/https?:\/\/\S+/g, '<url>')); process.exitCode = 1; });
}
