// HN AGRO · goes-serie · una corrida de la serie: guarda en R2 las imágenes GOES-19 FDCF que falten de las últimas
// `horas` h, actualiza el índice de cada día y al final rota (borra lo de más de 30 días, sólo bajo goes-serie/).
//
// REGLAS
//  - Una imagen que no se pudo bajar o subir NO corta la serie: se anota como faltante (con su motivo) y se sigue
//    con la próxima. La próxima corrida la vuelve a intentar mientras siga dentro de la ventana.
//  - Un turno que NOAA todavía no publicó y que no cerró (menos de 30 min) es «pendiente», no faltante.
//  - Lo que ya está en R2 no se vuelve a bajar (idempotente).
//  - La rotación sólo borra claves con forma de imagen o de índice de goes-serie/ (aRotar). Nunca goes-eventos/.
//    Freno: si la serie está parada (esta corrida no guardó nada y no hay ninguna imagen de las últimas 24 h), NO se
//    rota: así un colector caído no termina borrando los 30 días enteros sin reponer nada.
import crypto from 'node:crypto';
import {
  PREFIJO_SERIE, RETENCION_DIAS, PASO_MS, MARGEN_CIERRE_MS, TIPO,
  turnosEntre, partes, isoTurno, claveImagen, claveIndice, prefijoDia, tDeClave, aRotar,
} from './claves.mjs';
import { codigoDe } from './r2.mjs';
import { BUCKET, PRODUCTO, SATELITE } from './noaa.mjs';

export const HORAS = 3;
export const MAX_HORAS = 24;
const PARALELO = 2;                         // de a 2 bajadas por vez (pedido: no golpear de más)

async function enParalelo(lista, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => { while (i < lista.length) { const j = i++; await fn(lista[j]); } }));
}
const diaIso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** PURA. Junta el índice que había con lo de esta corrida. listadoDia = [{clave, bytes}] de ese día en R2. */
export function fusionarIndice(previo, { diaMs, nuevas = [], faltantes = [], listadoDia = [], ahoraMs }) {
  const img = new Map(((previo && Array.isArray(previo.imagenes)) ? previo.imagenes : []).map((e) => [e.hhmm, e]));
  for (const e of nuevas) img.set(e.hhmm, e);
  for (const o of listadoDia) {
    const t = tDeClave(o.clave);
    if (t == null) continue;
    const { hhmm } = partes(t);
    if (!img.has(hhmm)) img.set(hhmm, { turno: isoTurno(t), hhmm, clave: o.clave, archivo: null, t_scan: null, bytes: o.bytes, sha256: null, nota: 'recuperada del listado de R2' });
  }
  const fal = new Map(((previo && Array.isArray(previo.faltantes)) ? previo.faltantes : []).map((f) => [f.hhmm, f]));
  for (const f of faltantes) {
    const ant = fal.get(f.hhmm);
    fal.set(f.hhmm, { ...f, intentos: (ant ? ant.intentos || 1 : 0) + 1 });
  }
  for (const h of img.keys()) fal.delete(h);
  const orden = (a, b) => (a.hhmm < b.hhmm ? -1 : 1);
  return {
    v: 1,
    dia: diaIso(diaMs),
    producto: `${SATELITE} ${PRODUCTO} (focos de calor, disco completo; el archivo de NOAA entero, sin tocar)`,
    fuente: BUCKET,
    paso_min: PASO_MS / 60e3,
    retencion_dias: RETENCION_DIAS,
    imagenes: [...img.values()].sort(orden),
    faltantes: [...fal.values()].sort(orden),
    nota: 'Una imagen que falta es «sin dato», no «sin fuego». Las imágenes de más de 30 días se borran (las de los eventos se copian aparte, a goes-eventos/).',
    actualizado: new Date(ahoraMs).toISOString(),
  };
}

/**
 * dep: { r2: {listar, leer, escribir, borrar}, noaa: {listarHora(ms), bajar(obj)}, log? }
 * → resumen { guardadas, ya_estaban, faltantes:[{turno, motivo}], pendientes, borradas, bytes_subidos, avisos, errores, codigo }
 */
export async function correrSerie(dep, { ahora = new Date(), horas = HORAS } = {}) {
  const { r2, noaa } = dep;
  const log = dep.log || (() => {});
  const ahoraMs = ahora.getTime();
  horas = Math.max(1, Math.min(MAX_HORAS, Math.trunc(Number(horas)) || HORAS));
  const res = { ventana_h: horas, guardadas: 0, ya_estaban: 0, faltantes: [], pendientes: 0, borradas: 0, bytes_subidos: 0, avisos: [], errores: [], codigo: 0 };

  const turnos = turnosEntre(ahoraMs - horas * 3600e3, ahoraMs);
  const dias = [...new Set(turnos.map((t) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())))];

  // 1 · qué hay en R2
  const enR2 = new Map();
  for (const d of dias) {
    try { for (const o of await r2.listar(prefijoDia(d))) enR2.set(o.clave, o); }
    catch (e) { res.errores.push(`listar ${prefijoDia(d)}: ${codigoDe(e)}`); res.codigo = 2; return res; }
  }

  // 2 · qué publicó NOAA (una hora por pedido, de a una)
  const enNoaa = new Map();
  const horasNoaa = [...new Set(turnos.map((t) => Math.floor(t / 3600e3) * 3600e3))];
  const noaaFalla = new Map();
  for (const h of horasNoaa) {
    try {
      for (const o of await noaa.listarHora(h)) {
        if (enNoaa.has(o.turno)) { res.avisos.push(`dos archivos para ${isoTurno(o.turno)}: se usa el primero`); continue; }
        enNoaa.set(o.turno, o);
      }
    } catch (e) { noaaFalla.set(h, codigoDe(e)); }
  }

  // 3 · cada turno
  const nuevasPorDia = new Map(), faltPorDia = new Map();
  const anotar = (mapa, t, x) => { const d = prefijoDia(t); if (!mapa.has(d)) mapa.set(d, []); mapa.get(d).push(x); };
  const faltante = (t, motivo) => {
    res.faltantes.push({ turno: isoTurno(t), motivo });
    anotar(faltPorDia, t, { turno: isoTurno(t), hhmm: partes(t).hhmm, motivo, visto: new Date(ahoraMs).toISOString() });
  };
  const aBajar = [];
  for (const t of turnos) {
    if (enR2.has(claveImagen(t))) { res.ya_estaban++; continue; }
    const o = enNoaa.get(t);
    const cerrado = t + MARGEN_CIERRE_MS <= ahoraMs;
    if (o) { aBajar.push([t, o]); continue; }
    if (!cerrado) { res.pendientes++; continue; }
    const fh = noaaFalla.get(Math.floor(t / 3600e3) * 3600e3);
    faltante(t, fh ? fh : 'noaa_sin_archivo');
  }
  await enParalelo(aBajar, PARALELO, async ([t, o]) => {
    let buf;
    try { buf = await noaa.bajar(o); }
    catch (e) { faltante(t, codigoDe(e)); log(`falta ${isoTurno(t)} (${codigoDe(e)})`); return; }
    const clave = claveImagen(t);
    try { await r2.escribir(clave, buf, { tipo: TIPO }); }
    catch (e) { faltante(t, codigoDe(e)); log(`falta ${isoTurno(t)} (${codigoDe(e)})`); return; }
    res.guardadas++;
    res.bytes_subidos += buf.length;
    enR2.set(clave, { clave, bytes: buf.length });
    anotar(nuevasPorDia, t, { turno: isoTurno(t), hhmm: partes(t).hhmm, clave, archivo: o.archivo, t_scan: new Date(o.t_scan).toISOString(), bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  });

  // 4 · el índice de cada día tocado
  for (const d of dias) {
    const pref = prefijoDia(d);
    const nuevas = nuevasPorDia.get(pref) || [], faltantes = faltPorDia.get(pref) || [];
    const kIdx = claveIndice(d);
    let previo = null;
    try {
      const b = await r2.leer(kIdx);
      if (b) { try { previo = JSON.parse(b.toString('utf8')); } catch { res.avisos.push(`${kIdx}: ilegible, se rehace desde el listado`); } }
    } catch (e) { res.errores.push(`leer ${kIdx}: ${codigoDe(e)} (no se reescribe: no se pisa lo que no se leyó)`); continue; }
    if (previo && !nuevas.length && !faltantes.length) continue;      // nada nuevo: no se reescribe
    const listadoDia = [...enR2.values()].filter((o) => o.clave.startsWith(pref));
    const idx = fusionarIndice(previo, { diaMs: d, nuevas, faltantes, listadoDia, ahoraMs });
    try { await r2.escribir(kIdx, JSON.stringify(idx)); }
    catch (e) { res.errores.push(`escribir ${kIdx}: ${codigoDe(e)}`); }
  }

  // 5 · rotación (sólo goes-serie/)
  try {
    const todo = await r2.listar(PREFIJO_SERIE);
    const reciente = todo.some((o) => { const t = tDeClave(o.clave); return t != null && t >= ahoraMs - 24 * 3600e3; });
    const borrar = aRotar(todo.map((o) => o.clave), ahoraMs);
    if (borrar.length && !res.guardadas && !reciente) {
      res.avisos.push(`rotación frenada: la serie está parada (ninguna imagen de las últimas 24 h); quedaban ${borrar.length} por borrar`);
    } else {
      for (const k of borrar) {
        if (!k.startsWith(PREFIJO_SERIE)) continue;                         // nunca, pero por las dudas
        try { await r2.borrar(k); res.borradas++; }
        catch (e) { res.errores.push(`borrar ${k}: ${codigoDe(e)}`); }
      }
    }
  } catch (e) { res.errores.push(`listar ${PREFIJO_SERIE}: ${codigoDe(e)} (no se rotó)`); }

  if (res.errores.length || res.faltantes.length) res.codigo = Math.max(res.codigo, 1);
  return res;
}
