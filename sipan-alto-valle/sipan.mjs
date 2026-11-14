#!/usr/bin/env node
// HN AGRO · colector de la red agrometeorológica del INTA EEA Alto Valle (SIPAN). Corre en GitHub Actions cada 6 h
// (sipan-alto-valle.workflow.yml.txt). ⛔ USO INTERNO: nada de esto se muestra en SATCHI ni en HN AGRO hasta que el
// INTA lo autorice.
//
//   node sipan-alto-valle/sipan.mjs [--seco] [--ids 10,40] [--barrer] [--aceptar-formato 45=firma] [--archivo id=ruta]
//     --seco      baja y calcula, pero no escribe en la base ni en R2 (imprime sólo cantidades)
//     --barrer    además, UN pedido a clima.htm para listar los ids que aparecen y probar los que no conocemos (tope 15)
//     --archivo   no baja nada: lee el downld02 de un archivo (pruebas con fixtures reales)
//
// ⛔ NO SATURAR AL INTA: un pedido por vez, ≥ 30 s entre pedidos, tope de pedidos por corrida, y ante un corte, 403,
//    429 o 5xx se deja de pedir en esa corrida. User-Agent genérico (sin datos de nadie).
// Controles: dedup por estación y hora (el crudo de cada día se une con lo ya guardado), faltante = null (nunca 0),
// valores imposibles marcados (no entran en los resúmenes), formato cambiado → registro_procesos con aviso y NO se carga,
// estación sin registros nuevos en más de 24 h → aviso. Con avisos el proceso sale con código 2 (Actions avisa).
// El registro de Actions es PÚBLICO: se imprimen sólo cantidades, nunca valores ni claves.
import zlib from 'node:zlib';
import { leerDavis } from './lib/davis.mjs';
import { controlar, resumenDia, resumenNoche, fechasDe, unir, sumarDias } from './lib/resumen.mjs';
import { ESTACIONES, urlDe, filaEstacion, idsDePagina, BASE_URL } from './lib/estaciones.mjs';
import { crearBase, RED } from './lib/base.mjs';
import { almacenR2 } from './lib/almacen.mjs';
import { almacenReleases } from './lib/releases.mjs';

export const PAUSA_MS = 30000;
export const TOPE_PEDIDOS = 12;          // 5 estaciones + clima.htm + margen; el barrido suma hasta 15 (con su propio tope)
export const TOPE_BARRIDO = 15;
export const QUIETA_H = 24;
export const USER_AGENT = 'Mozilla/5.0 (compatible; colector-agrometeorologico/1.0)';
const PROCESO = 'sipan_alto_valle';

const ahoraLocal = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16);     // UTC−3
const msLocal = (local) => Date.parse(local + ':00Z') + 3 * 3600e3;                  // local → UTC real
const diaDe = (local) => new Date(Date.parse(local + ':00Z') - 60e3).toISOString().slice(0, 10);   // «0:00» es del día anterior

/** Un pedidor educado: de a uno, pausa entre pedidos, tope, y se corta ante la primera señal de bloqueo. */
export function crearPedidor({ fetchFn = globalThis.fetch, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), pausaMs = PAUSA_MS, tope = TOPE_PEDIDOS, ahora = Date.now, ultimoPedido = null } = {}) {
  /* ultimoPedido: el instante del último pedido de OTRO pedidor (el barrido sigue al principal: la pausa de 30 s vale entre los dos) */
  let ultimo = ultimoPedido, pedidos = 0, cortado = null;
  return {
    get pedidos() { return pedidos; }, get cortado() { return cortado; }, get ultimo() { return ultimo; },
    async pedir(url) {
      if (cortado) return { estado: 'cortado' };
      if (pedidos >= tope) return { estado: 'tope' };
      const falta = ultimo == null ? 0 : ultimo + pausaMs - ahora();
      if (falta > 0) await dormir(falta);
      pedidos++;
      let r;
      try { r = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain,text/html;q=0.9' }, signal: AbortSignal.timeout(60000) }); }
      catch (e) { cortado = 'corte de conexión'; return { estado: 'cortado' }; }
      finally { ultimo = ahora(); }
      if (r.status === 403 || r.status === 429 || r.status >= 500) { cortado = 'HTTP ' + r.status; return { estado: 'cortado', status: r.status }; }
      if (!r.ok) return { estado: 'no', status: r.status };
      return { estado: 'ok', status: r.status, texto: Buffer.from(await r.arrayBuffer()).toString('latin1') };
    },
  };
}

const claveCrudo = (id, dia) => `sipan-alto-valle/${id}/${dia.slice(0, 4)}/${dia}.json.gz`;

async function leerCrudos(almacen, id, dias) {
  const out = [];
  if (!almacen) return out;
  for (const d of dias) {
    const b = await almacen.leer(claveCrudo(id, d));
    if (b) out.push(...JSON.parse(zlib.gunzipSync(b).toString('utf8')).registros);
  }
  return out;
}

async function guardarCrudos(almacen, id, registros, p) {
  const porDia = new Map();
  for (const r of registros) { const d = diaDe(r.local); (porDia.get(d) || porDia.set(d, []).get(d)).push({ local: r.local, v: r.v, texto: r.texto }); }
  for (const [d, rs] of porDia) {
    const cuerpo = zlib.gzipSync(JSON.stringify({ red: RED, estacion_id: id, dia: d, firma: p.firma, columnas: p.columnas, registros: rs }));
    await almacen.escribir(claveCrudo(id, d), cuerpo, { tipo: 'application/gzip' });
  }
  return porDia.size;
}

/** La fila de estaciones_obs para la fecha D, juntando lo nuevo con lo que ya había (gana lo más completo, por parte). */
export function filaObs({ id, fecha, dia, noche, firma, viejo = null, intervalo }) {
  const usarDia = !viejo || (dia.registros_validos >= (viejo.registros_validos ?? -1));
  const usarNoche = !viejo || (noche.registros_validos >= (viejo.noche_registros ?? -1));
  const vc = (viejo && viejo.crudo) || {};
  const fila = {
    red: RED, estacion_id: id, fecha, hora_corte: '00:00', url: urlDe(id),
    muestreo_min: null, lluvia_origen: 'suma_registros',      // 0147: extremos de la consola; lluvia = suma de los 10 min
    ...(usarDia
      ? { lluvia_mm: dia.lluvia_mm, horas_validas: dia.horas_validas, tmin_c: dia.tmin_c, tmax_c: dia.tmax_c, eto_mm: dia.eto_mm, rad_mj_m2: dia.rad_mj_m2, rad_registros: dia.rad_registros,
          registros_validos: dia.registros_validos, registros_esperados: dia.registros_esperados }
      : { lluvia_mm: viejo.lluvia_mm, horas_validas: viejo.horas_validas, tmin_c: viejo.tmin_c, tmax_c: viejo.tmax_c, eto_mm: viejo.eto_mm, rad_mj_m2: viejo.rad_mj_m2 ?? null, rad_registros: viejo.rad_registros ?? null,
          registros_validos: viejo.registros_validos, registros_esperados: viejo.registros_esperados }),
    ...(usarNoche
      ? { tmin_noche_c: noche.tmin_noche_c, tmin_noche_en: noche.tmin_noche_en, noche_registros: noche.registros_validos, noche_esperados: noche.registros_esperados }
      : { tmin_noche_c: viejo.tmin_noche_c, tmin_noche_en: viejo.tmin_noche_en, noche_registros: viejo.noche_registros, noche_esperados: viejo.noche_esperados }),
    crudo: {
      fuente: 'INTA EEA Alto Valle · SIPAN (uso interno)', toma: 'github-actions', formato_firma: firma, intervalo_min: intervalo,
      dia: usarDia ? dia : vc.dia || null, noche: usarNoche ? noche : vc.noche || null,
    },
    leido_en: new Date().toISOString(),
  };
  return fila;
}

/** Una estación: baja (o lee), controla, une con lo guardado y arma las filas. No escribe: devuelve lo que escribiría. */
export async function procesarEstacion({ e, texto, meta = {}, aceptar = {}, almacen = null, base = null, ahoraMs = Date.now() }) {
  const p = leerDavis(texto);
  if (!p.ok) return { id: e.id, estado: 'formato', aviso: { tipo: 'formato_no_se_entiende', id: e.id, motivo: p.motivo, detalle: p.detalle, columnas: p.columnas } };
  const previa = meta.formato_firma;
  if (previa && previa !== p.firma && aceptar[e.id] !== p.firma) {
    return { id: e.id, estado: 'formato', aviso: { tipo: 'formato_cambiado', id: e.id, firma_previa: previa, firma_nueva: p.firma, columnas: p.columnas } };
  }
  const { dias, noches } = fechasDe(p.registros);
  const tocados = [...new Set([...dias, ...noches.map((n) => sumarDias(n, -1)), ...noches])].sort();
  const guardados = await leerCrudos(almacen, e.id, tocados);
  const todos = unir(guardados, p.registros);
  const ctrl = controlar(todos);
  const fechas = [...new Set([...dias, ...noches])].sort();
  const viejos = base ? new Map((await base.obs(e.id, fechas)).map((f) => [String(f.fecha).slice(0, 10), f])) : new Map();
  const filas = fechas.map((f) => filaObs({ id: e.id, fecha: f, dia: resumenDia(ctrl, f, p.intervalo_min), noche: resumenNoche(ctrl, f, p.intervalo_min), firma: p.firma, viejo: viejos.get(f) || null, intervalo: p.intervalo_min }));
  const ultimo = p.registros[p.registros.length - 1].local;
  const marcas = {};
  for (const r of ctrl) for (const m of r.marcas) marcas[m] = (marcas[m] || 0) + 1;
  const horasQuieta = (ahoraMs - msLocal(ultimo)) / 3600e3;
  return {
    id: e.id, estado: 'ok', p, filas, todos, ultimo, marcas, nuevos: p.registros.length, unidos: todos.length - guardados.length,
    aviso: horasQuieta > QUIETA_H ? { tipo: 'estacion_quieta', id: e.id, horas: Math.round(horasQuieta), ultimo_registro: ultimo } : null,
    meta: { formato_firma: p.firma, columnas: p.columnas, ultimo_registro: ultimo, intervalo_min: p.intervalo_min, ultima_lectura: new Date(ahoraMs).toISOString() },
  };
}

/** Dónde van los crudos de 10 min. HOY: releases diarias del repo privado (SIPAN_CRUDOS_REPO + SIPAN_CRUDOS_TOKEN).
 *  R2 queda como opción futura APAGADA: sólo con SIPAN_R2_ON=si y sus 4 variables. Sin ninguno, no se guardan crudos
 *  (el resumen diario igual se guarda). */
export function almacenDeEntorno(env, fetchFn = globalThis.fetch) {
  if (env.SIPAN_CRUDOS_REPO) return almacenReleases({ token: env.SIPAN_CRUDOS_TOKEN, repo: env.SIPAN_CRUDOS_REPO, fetchFn });
  if (env.SIPAN_R2_ON === 'si' && env.SIPAN_R2_DEPOSITO) {
    return almacenR2({ cuenta: env.SIPAN_R2_CUENTA, clave: env.SIPAN_R2_ACCESS_KEY_ID, secreto: env.SIPAN_R2_SECRET_ACCESS_KEY, deposito: env.SIPAN_R2_DEPOSITO, fetchFn });
  }
  return null;
}

async function correrInterno({ seco = true, ids = null, barrer = false, aceptar = {}, archivos = {}, env = process.env, fetchFn = globalThis.fetch,
  dormir, reloj, ahoraMs = Date.now(), log = console.log, base: baseDada = null, almacen: almacenDado = null } = {}) {
  const base = seco ? null : baseDada;   // la abre y la cierra correr() (abajo)
  const almacen = seco ? null : almacenDado || almacenDeEntorno(env, fetchFn);
  const opPed = { fetchFn, ...(dormir ? { dormir } : {}), ...(reloj ? { ahora: reloj } : {}) };
  const pedidor = crearPedidor(opPed);
  const lista = ESTACIONES.filter((e) => !ids || ids.includes(e.id));
  const estado = base ? new Map((await base.estaciones()).map((f) => [f.estacion_id, f.metadatos || {}])) : new Map();
  const avisos = []; const porEstacion = {};
  let filasObs = 0, crudosDias = 0; const errores = [];
  /* la fila de `estaciones` va ANTES que sus datos: estaciones_obs tiene FK a estaciones (0110). Si no se pudo
     guardar la estación, no se intentan sus datos (darían 409) y queda en errores. */
  const guardarEstacion = async (e, meta) => {
    try { await base.guardarEstaciones([filaEstacion(e, meta)]); return true; }
    catch (err) { errores.push(`${e.id} estaciones: ${String(err && err.message).slice(0, 80)}`); return false; }
  };

  for (const e of lista) {
    let texto;
    if (archivos[e.id] != null) texto = archivos[e.id];
    else {
      const r = await pedidor.pedir(urlDe(e.id));
      if (r.estado !== 'ok') {
        porEstacion[e.id] = r.estado + (r.status ? ' ' + r.status : '');
        if (r.estado === 'no') avisos.push({ tipo: 'no_responde', id: e.id, status: r.status });
        continue;
      }
      texto = r.texto;
    }
    const meta = estado.get(e.id) || {};
    /* una falla de GitHub o de la base en UNA estación no corta la corrida: queda en errores y se sigue */
    try {
      const x = await procesarEstacion({ e, texto, meta, aceptar, almacen, base, ahoraMs });
      if (x.aviso) avisos.push(x.aviso);
      if (x.estado !== 'ok') {
        porEstacion[e.id] = x.aviso.tipo;
        if (!seco) await guardarEstacion(e, { ...meta, formato_nuevo_visto: x.aviso.firma_nueva || x.aviso.motivo, formato_nuevo_en: new Date(ahoraMs).toISOString() });
        continue;
      }
      porEstacion[e.id] = { registros: x.nuevos, nuevos_unidos: x.unidos, fechas: x.filas.length, marcados: Object.values(x.marcas).reduce((s, n) => s + n, 0), horas_desde_ultimo: Math.round((ahoraMs - msLocal(x.ultimo)) / 3600e3) };
      if (seco) { filasObs += x.filas.length; continue; }
      if (!(await guardarEstacion(e, { ...meta, ...x.meta }))) continue;
      if (almacen) {
        try { crudosDias += await guardarCrudos(almacen, e.id, x.todos, x.p); }
        catch (err) { errores.push(`${e.id} crudos: ${String(err && err.message).slice(0, 80)}`); }
      }
      const g = await base.guardarObs(x.filas);
      filasObs += g.ok; errores.push(...g.errores);
    } catch (err) {
      porEstacion[e.id] = 'error';
      errores.push(`${e.id}: ${String(err && err.message).slice(0, 80)}`);
    }
  }
  /* las que no se pudieron leer en esta corrida: quieta según lo guardado */
  for (const e of lista) {
    if (typeof porEstacion[e.id] === 'object') continue;
    const u = (estado.get(e.id) || {}).ultimo_registro;
    if (u && (ahoraMs - msLocal(u)) / 3600e3 > QUIETA_H && !avisos.some((a) => a.id === e.id && a.tipo === 'estacion_quieta')) {
      avisos.push({ tipo: 'estacion_quieta', id: e.id, horas: Math.round((ahoraMs - msLocal(u)) / 3600e3), ultimo_registro: u });
    }
  }
  if (pedidor.cortado) avisos.push({ tipo: 'sipan_corto', motivo: pedidor.cortado, pedidos: pedidor.pedidos });

  /* el barrido: su propio tope, pero la pausa de 30 s se cuenta desde el ÚLTIMO pedido del principal. Sólo prueba los
     ids (no guarda datos de estaciones nuevas): si encuentra alguna, se suma a mano al catálogo y desde la corrida
     siguiente entra por el camino de arriba, con su fila de `estaciones` antes que sus datos. */
  let barrido = null, pb = null;
  if (barrer && !pedidor.cortado) {
    pb = crearPedidor({ ...opPed, tope: TOPE_BARRIDO + 1, ultimoPedido: pedidor.ultimo });
    const pag = await pb.pedir(BASE_URL + 'clima.htm');
    if (pag.estado === 'ok') {
      const vistos = idsDePagina(pag.texto);
      const conocidos = new Set(ESTACIONES.map((e) => e.id));
      barrido = { en_pagina: vistos, probados: {} };
      for (const v of vistos.filter((v) => !conocidos.has(v.id)).slice(0, TOPE_BARRIDO)) {
        const r = await pb.pedir(urlDe(v.id));
        const p = r.estado === 'ok' ? leerDavis(r.texto) : null;
        barrido.probados[v.id] = p && p.ok ? { davis: true, columnas: p.columnas.length, ultimo: p.registros.at(-1).local } : r.estado + (r.status ? ' ' + r.status : '');
        if (pb.cortado) break;
      }
    } else barrido = { clima_htm: pag.estado + (pag.status ? ' ' + pag.status : '') };
    if (pb.cortado) avisos.push({ tipo: 'sipan_corto', motivo: 'barrido: ' + pb.cortado, pedidos: pb.pedidos });
  }

  const resumen = { modo: seco ? 'seco' : 'real', pedidos: pedidor.pedidos, pedidos_barrido: pb ? pb.pedidos : 0, estaciones: porEstacion, filas_obs: filasObs, crudos_dias: crudosDias, crudos: almacen ? almacen.tipo : 'sin destino (sólo el resumen diario)', errores: errores.length, avisos, barrido };
  if (!seco) { try { await base.registrar(PROCESO, avisos.length === 0 && errores.length === 0, { ...resumen, errores_detalle: errores.slice(0, 20) }); } catch (e) { resumen.registro = 'no se pudo anotar'; } }
  /* al registro público: sólo cantidades y tipos (nada de valores medidos) */
  log(JSON.stringify({ ...resumen, avisos: avisos.map((a) => `${a.tipo}${a.id ? ' ' + a.id : ''}`) }));
  return { resumen, avisos, errores };
}

/** La corrida: abre la base (Postgres directo, SIPAN_PG_URL, rol colector_estaciones) sólo en modo real, y la cierra
 *  siempre al final, aunque algo falle. `conectar` se inyecta en los tests (una base falsa con la misma forma). */
export async function correr(op = {}) {
  const { seco = true, env = process.env, base: baseDada = null, conectar } = op;
  const base = seco ? null : baseDada || await crearBase({ url: env.SIPAN_PG_URL, ...(conectar ? { conectar } : {}) });
  try { return await correrInterno({ ...op, base }); }
  finally { if (base && !baseDada && base.cerrar) await base.cerrar(); }
}

const esPrincipal = import.meta.url === 'file://' + process.argv[1] || import.meta.url.endsWith(String(process.argv[1] || '').replace(/\\/g, '/'));
if (esPrincipal) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const pares = (s) => Object.fromEntries(String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('=')));
  const fs = await import('node:fs');
  const archivos = Object.fromEntries(Object.entries(pares(val('--archivo'))).map(([k, v]) => [k, fs.readFileSync(v, 'latin1')]));
  const ids = val('--ids') ? val('--ids').split(',') : (Object.keys(archivos).length ? Object.keys(archivos) : null);
  correr({ seco: a.includes('--seco'), ids, barrer: a.includes('--barrer'), aceptar: pares(val('--aceptar-formato') || process.env.SIPAN_ACEPTAR_FORMATO), archivos })
    .then((r) => { if (r.avisos.length || r.errores.length) { console.log('::warning::SIPAN: ' + r.avisos.map((x) => x.tipo + (x.id ? ' ' + x.id : '')).join(', ') + (r.errores.length ? ` · ${r.errores.length} filas no se guardaron` : '')); process.exitCode = 2; } })
    .catch((e) => { console.error('sipan: ' + String(e && e.message).slice(0, 160)); process.exitCode = 1; });
}
