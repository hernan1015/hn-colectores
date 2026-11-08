// HN AGRO · caché horaria de rayos GLM: qué horas faltan, cómo se arma cada hora, candado y alertas.
// Todo recibe el almacén y el lector GLM por parámetro, así los tests corren con una carpeta y archivos sintéticos.
import * as GLM from './glm.mjs';

export const PREFIJO = 'rayos-hora/';
export const CANDADO = PREFIJO + 'candado.json';
export const ALERTAS = PREFIJO + 'alertas.txt';
export const HORA = 3600000;
export const MARGEN_MS = 15 * 60000;         // una hora se da por cerrada 15 min después de terminar (NOAA publica con 1-2 min de atraso)
export const VENTANA_H = 48;                 // ponerse al día hasta 48 h atrás, no más
export const MAX_INTENTOS = 3;               // una hora incompleta se reintenta como mucho 3 veces (en corridas distintas)
export const REINTENTO_RECIENTE_MS = 6 * HORA; // si faltaban archivos en NOAA, sólo vale reintentar mientras la hora es reciente
export const VENCE_CANDADO_MS = 50 * 60000;  // el trabajo se corta a los 45 min: un candado más viejo es de una corrida muerta
const SLOT_MS = 20000;

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function claveHora(horaMs) {
  const d = new Date(horaMs);
  return `${PREFIJO}${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}.json`;
}
const prefijoDia = (horaMs) => claveHora(horaMs).slice(0, -'HH.json'.length);
export const isoHora = (ms) => new Date(ms).toISOString().slice(0, 13) + ':00Z';

/** Última hora UTC cerrada (su inicio, en ms). */
export function ultimaCerrada(ahoraMs) {
  return Math.floor((ahoraMs - MARGEN_MS) / HORA) * HORA - HORA;
}

/** Interpreta 'AAAA-MM-DD' o 'AAAA-MM-DDTHH' (UTC). `fin` = true → última hora del día si no trae hora. */
export function parsearHora(s, fin = false) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}))?/);
  if (!m) throw new Error(`fecha inválida «${s}» (usar AAAA-MM-DD o AAAA-MM-DDTHH, en UTC)`);
  const h = m[4] != null ? +m[4] : (fin ? 23 : 0);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], h);
}

/** ¿Vale la pena volver a intentar una hora guardada como incompleta? */
export function debeReintentar(meta, ahoraMs) {
  if (!meta || meta.estado === 'completa') return false;
  if ((meta.intentos || 1) >= MAX_INTENTOS) return false;
  if ((meta.archivos?.fallidos || 0) > 0) return true;                       // fallas de bajada: puede andar la próxima
  return ahoraMs - (Date.parse(meta.hora) + HORA) < REINTENTO_RECIENTE_MS;   // NOAA puede publicar tarde
}

/** Horas a procesar: [{hora, previa}] de la más nueva a la más vieja. */
export async function pendientes(almacen, { ahoraMs, desdeMs = null, hastaMs = null }) {
  const ult = ultimaCerrada(ahoraMs);
  let h0, h1;
  if (desdeMs != null || hastaMs != null) {             // relleno bajo pedido
    h0 = desdeMs ?? (ult - (VENTANA_H - 1) * HORA);
    h1 = Math.min(hastaMs ?? ult, ult);
  } else {                                              // normal: las últimas 48 h cerradas
    h0 = ult - (VENTANA_H - 1) * HORA;
    h1 = ult;
  }
  h0 = Math.floor(h0 / HORA) * HORA;
  const dias = new Set();
  for (let h = h0; h <= h1; h += HORA) dias.add(prefijoDia(h));
  const existentes = new Set();
  for (const p of dias) for (const k of await almacen.listar(p)) existentes.add(k);
  const out = [];
  for (let h = h1; h >= h0; h -= HORA) {
    const k = claveHora(h);
    if (!existentes.has(k)) { out.push({ hora: h, previa: null }); continue; }
    let meta = null;
    try { meta = JSON.parse((await almacen.leer(k)).toString('utf8')); } catch { meta = null; }
    if (!meta) { out.push({ hora: h, previa: null }); continue; }   // ilegible: se rehace
    if (debeReintentar(meta, ahoraMs)) out.push({ hora: h, previa: meta });
  }
  return out;
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/** Lista, baja y recorta una hora. Devuelve {doc, error}. error = falla del listado de NOAA (no se escribe nada). */
export async function procesarHora(horaMs, { glm = GLM, caja = GLM.CAJA_AR, paralelo = 8, intentos = 1, ahoraMs = Date.now() } = {}) {
  const sat = GLM.satelitePara(horaMs);
  let lst;
  try { lst = await glm.listarHora(horaMs); }
  catch (e) { return { error: `listado ${GLM.nombreSatelite(sat)} ${isoHora(horaMs)}: ${String(e?.message || e).slice(0, 120)}` }; }

  // un archivo por casillero de 20 s; si NOAA tiene dos versiones del mismo, se queda la de creación más nueva
  const porSlot = new Map();
  for (const a of lst.archivos) {
    const t = GLM.instantesDe(a.clave);
    if (!t || t.t0 < horaMs || t.t0 >= horaMs + HORA) continue;
    const s = Math.floor((t.t0 - horaMs) / SLOT_MS);
    const prev = porSlot.get(s);
    if (!prev || (t.c || 0) > (prev.c || 0)) porSlot.set(s, { ...a, c: t.c, slot: s });
  }
  const tareas = [...porSlot.values()].sort((a, b) => a.slot - b.slot);
  const leidos = new Set();
  let fallidos = 0, bytes = 0, nDisco = 0, i = 0;
  const flashes = [];
  const obrero = async () => {
    while (i < tareas.length) {
      const a = tareas[i++];
      try {
        const buf = await glm.bajarEntero(lst.url, a.clave, a.tam);
        bytes += buf.length;
        const r = await glm.leerArchivo(buf, a.clave, caja);
        nDisco += r.n_disco;
        for (const f of r.flashes) flashes.push(f);
        leidos.add(a.slot);
      } catch { fallidos++; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(paralelo, tareas.length)) }, obrero));

  const faltantes = [];
  for (let s = 0; s < GLM.ARCHIVOS_POR_HORA; s++) {
    if (!leidos.has(s)) faltantes.push(`${pad(Math.floor(s / 3))}:${pad((s % 3) * 20)}`);
  }
  const filas = flashes
    .map((f) => [f.t == null ? null : f.t - horaMs, r4(f.lat), r4(f.lon),
      f.energia_J == null ? null : r1(f.energia_J * 1e15), f.area_m2 == null ? null : r2(f.area_m2 / 1e6), f.calidad])
    .sort((a, b) => (a[0] ?? -1) - (b[0] ?? -1) || a[1] - b[1] || a[2] - b[2]);
  const completa = faltantes.length === 0;
  const doc = {
    v: 1,
    hora: isoHora(horaMs),
    estado: completa ? 'completa' : 'incompleta',
    satelite: GLM.nombreSatelite(sat),
    producto: GLM.PRODUCTO + ' (flashes)',
    caja: { lat_min: caja.latMin, lat_max: caja.latMax, lon_min: caja.lonMin, lon_max: caja.lonMax },
    archivos: { esperados: GLM.ARCHIVOS_POR_HORA, listados: tareas.length, leidos: leidos.size, fallidos },
    faltantes,
    intentos,
    n: filas.length,
    columnas: ['t_ms', 'lat', 'lon', 'energia_fJ', 'area_km2', 'calidad'],
    flashes: filas,
    nota: completa ? 'Hora completa.' : 'Hora INCOMPLETA: faltan archivos de NOAA. No leer como «sin rayos» en los minutos faltantes.',
    generado: new Date(ahoraMs).toISOString(),
    bytes_bajados: bytes,
    flashes_disco: nDisco,
  };
  return { doc };
}

// ---------- candado ----------
export async function tomarCandado(almacen, { dueno, ahoraMs = Date.now() }) {
  const previo = await almacen.leer(CANDADO);
  if (previo) {
    let c = null;
    try { c = JSON.parse(previo.toString('utf8')); } catch { c = null; }
    if (c && Date.parse(c.vence) > ahoraMs) return { ok: false, de: c.dueno, vence: c.vence };
    await almacen.borrar(CANDADO);                                    // vencido o ilegible: corrida muerta
  }
  const cuerpo = JSON.stringify({ dueno, desde: new Date(ahoraMs).toISOString(), vence: new Date(ahoraMs + VENCE_CANDADO_MS).toISOString() });
  if (!(await almacen.escribir(CANDADO, cuerpo, { soloSiNoExiste: true }))) return { ok: false, de: '?' };
  const leido = await almacen.leer(CANDADO);                         // por si el almacén ignora la condición
  let c = null;
  try { c = JSON.parse(leido.toString('utf8')); } catch { c = null; }
  return c && c.dueno === dueno ? { ok: true } : { ok: false, de: c?.dueno || '?' };
}
export async function soltarCandado(almacen, dueno) {
  const b = await almacen.leer(CANDADO);
  if (!b) return;
  try { if (JSON.parse(b.toString('utf8')).dueno !== dueno) return; } catch {}
  await almacen.borrar(CANDADO);
}

// ---------- alertas ----------
export async function alertar(almacen, linea, ahoraMs = Date.now()) {
  const b = await almacen.leer(ALERTAS);
  const previas = b ? b.toString('utf8').split('\n').filter(Boolean) : [];
  previas.push(`${new Date(ahoraMs).toISOString()} ${linea}`);
  await almacen.escribir(ALERTAS, previas.slice(-1000).join('\n') + '\n', { tipo: 'text/plain; charset=utf-8' });
}

/**
 * Una corrida. Devuelve un resumen (sólo cantidades).
 * maxHoras: tope de horas bajadas por corrida (48 alcanza para ponerse al día; el relleno grande va en varias).
 */
export async function correr({ almacen, ahoraMs = Date.now(), desdeMs = null, hastaMs = null, glm = GLM, maxHoras = 48, paralelo = 8, dueno = 'local', log = () => {} }) {
  const res = { candado: false, pendientes: 0, procesadas: 0, completas: 0, incompletas: 0, flashes: 0, bytes: 0, alertas: 0, cortada: null };
  const cand = await tomarCandado(almacen, { dueno, ahoraMs });
  if (!cand.ok) { res.cortada = 'candado tomado por otra corrida'; log(`candado tomado (vence ${cand.vence || '?'}): no hago nada`); return res; }
  res.candado = true;
  try {
    const lista = await pendientes(almacen, { ahoraMs, desdeMs, hastaMs });
    res.pendientes = lista.length;
    log(`${lista.length} horas pendientes`);
    for (const { hora, previa } of lista.slice(0, maxHoras)) {
      const intentos = (previa?.intentos || 0) + 1;
      const { doc, error } = await procesarHora(hora, { glm, paralelo, intentos, ahoraMs });
      if (error) {
        await alertar(almacen, `NOAA: ${error}. Se corta la corrida; la próxima vuelve a probar.`, ahoraMs);
        res.alertas++; res.cortada = 'error de NOAA';
        log(`NOAA falló en ${isoHora(hora)}: corto (anotado en alertas)`);
        break;
      }
      await almacen.escribir(claveHora(hora), JSON.stringify(doc));
      res.procesadas++; res.flashes += doc.n; res.bytes += doc.bytes_bajados;
      if (doc.estado === 'completa') res.completas++; else res.incompletas++;
      log(`${doc.hora} ${doc.satelite} ${doc.estado} · archivos ${doc.archivos.leidos}/${doc.archivos.esperados} · ${doc.n} flashes en la caja`);
      if (doc.estado === 'incompleta') {
        await alertar(almacen, `${doc.hora} incompleta: ${doc.archivos.leidos}/${doc.archivos.esperados} archivos (fallidos ${doc.archivos.fallidos}, intento ${intentos}/${MAX_INTENTOS}).`, ahoraMs);
        res.alertas++;
        if (doc.archivos.fallidos > doc.archivos.listados / 2) {   // NOAA no está entregando: no seguir golpeando
          res.cortada = 'NOAA no entrega archivos';
          log('más de la mitad de los archivos fallaron: corto (anotado en alertas)');
          break;
        }
      }
    }
    if (lista.length > maxHoras && !res.cortada) log(`quedan ${lista.length - maxHoras} horas para la próxima corrida (tope ${maxHoras})`);
  } finally {
    await soltarCandado(almacen, dueno);
  }
  return res;
}
