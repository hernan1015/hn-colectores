// HN AGRO · colector de METAR de los aeropuertos argentinos, en R2 (317). Ver metar/LEEME.md.
// Fuente: la Data API de aviationweather.gov (NOAA/NWS, Aviation Weather Center), /api/data/metar. Sin llave.
// La idea (METAR con GR como verdad de campo del granizo) es de familygw/chusmeteo (MIT); el código es propio.
//
// Una corrida normal = UN pedido con las 93 estaciones juntas y las últimas HORAS_NORMAL horas (la API acepta una lista de
// OACI separada por comas). Si la respuesta llega al tope de la API (400 partes), se parte la lista en dos (2 pedidos más).
// Cada parte se guarda UNA vez (la clave lleva un sha256 del texto): correr dos veces no duplica nada, y un COR (corrección)
// es otro parte con otra clave. Las horas sin parte de una estación quedan como FALTANTES del índice del día: «sin dato», no
// «sin granizo». El almacén (R2 o carpeta) y fetch vienen de afuera, para probar sin red.
import crypto from 'node:crypto';
import { IDS, POR_ID, FUENTE_LISTA } from './estaciones.mjs';
import { parsear, horaParte } from './metar.mjs';

export const BASE = 'https://aviationweather.gov';
export const UA = 'hn-colector/1.0';
export const RAIZ = 'metar';
export const CITA = 'METAR · aviationweather.gov (NOAA)';
export const FUENTE = Object.freeze({ texto: CITA, url: `${BASE}/data/api/`, api: `${BASE}/api/data/metar`, estaciones: FUENTE_LISTA,
  idea: 'familygw/chusmeteo (MIT): los METAR con GR como verdad de campo del granizo' });
export const TOPE_API = 400;            // «Most endpoints return a maximum of 400 entries» (aviationweather.gov/data/api/)
export const HORAS_NORMAL = 3;          // cada corrida mira 3 h: cubre los atrasos del cron de GitHub y los SPECI
export const HORAS_TRAMO = 3;           // el relleno pide de a 3 h (93 estaciones × 3 h ≈ 150-300 partes < 400)
export const DIAS_HISTORIA = 30;        // «up to the previous 30 days of data» (aviationweather.gov/data/api/)
export const TOPE_DEFECTO = 3, TOPE_MIN = 1, TOPE_MAX = 10;
export const TOPE_RELLENO_DEFECTO = 30, TOPE_RELLENO_MAX = 120;
export const PAUSA_MS = 2000;           // la API pide no pasar de 100 pedidos por minuto: acá, como mucho 30
export const FALLAS_SEGUIDAS_CORTE = 3;
export const VENTANA_PUBLICA_H = 24;    // el derivado público trae las últimas 24 h
const HORA = 3600000, MIN = 60000;

const p2 = (n) => String(n).padStart(2, '0');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const partes = (ms) => { const d = new Date(ms); return { a: d.getUTCFullYear(), m: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()), h: p2(d.getUTCHours()), mi: p2(d.getUTCMinutes()) }; };
export const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

export const claveIndiceDia = (ms) => { const { a, m, d } = partes(ms); return `${RAIZ}/${a}/${m}/${d}/indice.json`; };
/** la clave de un parte: el día y la hora UTC del PARTE (no de la corrida), la estación, el tipo y un sha256 del texto */
export const claveParte = (est, tipo, ms, crudo) => { const { a, m, d, h, mi } = partes(ms); return `${RAIZ}/${a}/${m}/${d}/${est}/${h}${mi}-${tipo}-${sha8(crudo)}.json`; };
export const idParte = (est, tipo, ms, crudo) => `${est} ${iso(ms)} ${tipo} ${sha8(crudo)}`;
export const CLAVE_ALERTAS = `${RAIZ}/alertas.txt`;
export const CLAVE_RELLENO = `${RAIZ}/relleno.json`;
export const CLAVE_PUBLICA = `${RAIZ}/v1/ultimas.json`;
export const CACHE_PUBLICA = 'public, max-age=300';

/** El pedido a la API: las estaciones juntas, JSON, las horas hacia atrás y (en el relleno) la hora final. */
export function urlMetar(ids, { horas = HORAS_NORMAL, hastaMs = null } = {}) {
  const q = [`ids=${ids.join(',')}`, 'format=json', `hours=${horas}`];
  if (hastaMs != null) { const { a, m, d, h, mi } = partes(hastaMs); q.push(`date=${a}${m}${d}_${h}${mi}`); }
  return `${BASE}/api/data/metar?${q.join('&')}`;
}

export const acotarTope = (x, modo = 'real') => {
  const def = modo === 'relleno' ? TOPE_RELLENO_DEFECTO : TOPE_DEFECTO, max = modo === 'relleno' ? TOPE_RELLENO_MAX : TOPE_MAX;
  const n = Number.parseInt(x, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(TOPE_MIN, n));
};

const leerJSON = async (almacen, clave) => {
  const b = await almacen.leer(clave);
  if (!b) return null;
  try { return JSON.parse(b.toString('utf8')); } catch { return null; }
};
async function alertar(almacen, texto, ahoraMs) {
  const previo = (await almacen.leer(CLAVE_ALERTAS))?.toString('utf8') || '';
  const lineas = previo.split('\n').filter(Boolean);
  lineas.push(`${iso(ahoraMs)} ${texto}`);
  await almacen.escribir(CLAVE_ALERTAS, lineas.slice(-500).join('\n') + '\n', { tipo: 'text/plain; charset=utf-8' });
}

/**
 * Un elemento de la respuesta JSON de la API → el parte listo para guardar, o { descartado: motivo }.
 * Se exige: una estación de la lista, el texto crudo, una reportTime válida y que la hora del texto coincida con ella (±70 min).
 */
export function normalizar(e) {
  if (!e || typeof e !== 'object') return { descartado: 'no es un objeto' };
  const est = String(e.icaoId || '');
  if (!POR_ID[est]) return { descartado: 'estación fuera de la lista' };
  if (typeof e.rawOb !== 'string' || !e.rawOb.trim()) return { descartado: 'sin texto crudo' };
  const ref = Date.parse(e.reportTime || '');
  if (!Number.isFinite(ref)) return { descartado: 'sin reportTime' };
  const p = parsear(e.rawOb);
  if (!p.ok) return { descartado: 'no se entiende: ' + p.motivo };
  if (p.estacion !== est) return { descartado: 'el texto es de otra estación' };
  const ms = horaParte(p, ref);
  if (ms == null || Math.abs(ms - ref) > 70 * MIN) return { descartado: 'la hora del texto no coincide con reportTime' };
  const tipo = p.tipo || (e.metarType === 'SPECI' ? 'SPECI' : 'METAR');
  return { est, tipo, ms, crudo: p.crudo, parseado: p, api: e };
}

const resumenIndice = (x) => ({
  estacion: x.est, tipo: x.tipo, hora: iso(x.ms), cor: x.parseado.cor,
  ...(x.parseado.nil ? { nil: true } : {}),   // [n3-317col P2] NIL = «no hubo parte»: se guarda para auditar, pero no es dato
  granizo: x.parseado.granizo.alguno ? { observado: x.parseado.granizo.observado, reciente: x.parseado.granizo.reciente, en_rmk: x.parseado.granizo.en_rmk,
    tipos: x.parseado.granizo.tipos, grupos: x.parseado.granizo.grupos, intenso: x.parseado.granizo.intenso } : null,
  tormenta: x.parseado.granizo.tormenta, tormenta_cerca: x.parseado.granizo.tormenta_cerca,
  ...(x.parseado.granizo.alguno ? { crudo: x.crudo } : {}),
});
const indiceVacio = (ms) => ({ v: 1, dia: iso(ms).slice(0, 10), fuente: { ...FUENTE }, estaciones: IDS.length, obs: {}, horas: {}, actualizado: null });

/** Qué horas cerradas de [desdeMs, hastaMs] se pueden revisar: las que empiezan en el tramo y terminaron hace 10 min o más. */
export function horasRevisables(desdeMs, hastaMs, ahoraMs) {
  const out = [];
  for (let h = Math.ceil(desdeMs / HORA) * HORA; h + HORA <= Math.min(hastaMs, ahoraMs - 10 * MIN) + 1; h += HORA) out.push(h);
  return out;
}

/** Guarda los partes nuevos (una vez cada uno) y revisa las horas del tramo. Devuelve los índices tocados. */
async function ingerir({ almacen, entradas, horas, ahoraMs, res, indices }) {
  const cargar = async (k) => { if (!indices.has(k)) indices.set(k, { ind: (await leerJSON(almacen, k)), cambio: false }); return indices.get(k); };
  for (const e of entradas) {
    const x = normalizar(e);
    if (x.descartado) { res.descartados++; continue; }
    const ki = claveIndiceDia(x.ms);
    const c = await cargar(ki);
    if (!c.ind) { c.ind = indiceVacio(x.ms); c.cambio = true; }
    const id = idParte(x.est, x.tipo, x.ms, x.crudo);
    if (c.ind.obs[id]) { res.repetidos++; continue; }               // idempotencia: ya está en el índice, no se escribe nada
    const clave = claveParte(x.est, x.tipo, x.ms, x.crudo);
    const sobre = { v: 1, estacion: x.est, nombre: POR_ID[x.est].nombre, lat: POR_ID[x.est].lat, lon: POR_ID[x.est].lon, tipo: x.tipo,
      hora: iso(x.ms), recibido: x.api.receiptTime || null, crudo: x.crudo, parseado: x.parseado, api: x.api, fuente: CITA, guardado: iso(ahoraMs) };
    const nuevo = await almacen.escribir(clave, JSON.stringify(sobre), { soloSiNoExiste: true });
    if (nuevo) res.guardados++; else res.recuperados++;               // ya estaba (una corrida cortada antes de escribir el índice)
    c.ind.obs[id] = { ...resumenIndice(x), clave };
    c.cambio = true;
    if (x.parseado.granizo.alguno) res.con_granizo++;
  }
  // los faltantes: por hora cerrada, qué estaciones no tienen ningún parte. Lo que ya tenía dato no se borra nunca.
  for (const h of horas) {
    const ki = claveIndiceDia(h);
    const c = await cargar(ki);
    if (!c.ind) { c.ind = indiceVacio(h); c.cambio = true; }
    const hh = partes(h).h;
    const con = new Set((c.ind.horas[hh]?.con_dato) || []);
    for (const o of Object.values(c.ind.obs)) { const t = Date.parse(o.hora); if (!o.nil && t >= h && t < h + HORA) con.add(o.estacion); }
    const sin = IDS.filter((i) => !con.has(i));
    const previo = c.ind.horas[hh];
    const nuevo = { con_dato: [...con].sort(), sin_dato: sin, revisada: iso(ahoraMs) };
    if (!previo || previo.con_dato.length !== nuevo.con_dato.length || previo.sin_dato.length !== nuevo.sin_dato.length) { c.ind.horas[hh] = nuevo; c.cambio = true; }
    res.horas_revisadas++;
    res.faltantes += sin.length;
  }
}

async function guardarIndices(almacen, indices, ahoraMs) {
  let n = 0;
  for (const [k, c] of indices) {
    if (!c.cambio || !c.ind) continue;
    c.ind.actualizado = iso(ahoraMs);
    await almacen.escribir(k, JSON.stringify(c.ind, null, 1));
    c.cambio = false; n++;
  }
  return n;
}

/**
 * El derivado PÚBLICO para SATCHI: las últimas 24 h, sólo lo que hace falta para la marca y para el «sin dato».
 *   { v, generado, ventana_h, fuente, estaciones: [{ id, nombre, lat, lon, ultima }], granizo: [{ estacion, nombre, lat, lon, hora, tipo, observado, reciente, en_rmk, tipos, grupos, crudo }] }
 * `ultima` es la hora del último parte LEÍDO de la estación (null si en 24 h no hubo ninguno: «sin dato»).
 */
export function armarPublico(indicesDias, ahoraMs, { completo = true } = {}) {
  const desde = ahoraMs - VENTANA_PUBLICA_H * HORA;
  const ultima = {}; const granizo = [];
  for (const ind of indicesDias) {
    if (!ind || !ind.obs) continue;
    for (const o of Object.values(ind.obs)) {
      const t = Date.parse(o.hora);
      if (!(t >= desde && t <= ahoraMs + 5 * MIN)) continue;
      if (!o.nil && (!ultima[o.estacion] || t > Date.parse(ultima[o.estacion]))) ultima[o.estacion] = o.hora;   // [n3-317col P2] un NIL no es «última lectura»
      if (o.granizo) {
        const e = POR_ID[o.estacion];
        granizo.push({ estacion: o.estacion, nombre: e.nombre, lat: e.lat, lon: e.lon, hora: o.hora, tipo: o.tipo,
          observado: !!o.granizo.observado, reciente: !!o.granizo.reciente, en_rmk: !!o.granizo.en_rmk, tipos: o.granizo.tipos, grupos: o.granizo.grupos, crudo: o.crudo });
      }
    }
  }
  granizo.sort((a, b) => (a.hora < b.hora ? 1 : a.hora > b.hora ? -1 : a.estacion < b.estacion ? -1 : 1));
  return {
    // [n3-317 P2/P4] leido = la hora de la lectura de la API que produjo este archivo; completo = false si vino truncada
    // (entonces nadie puede concluir «ninguno»). Sólo lo escribe una corrida real con lectura buena.
    v: 1, generado: iso(ahoraMs), leido: iso(ahoraMs), completo: !!completo, ventana_h: VENTANA_PUBLICA_H, fuente: { ...FUENTE },
    estaciones: IDS.map((id) => ({ id, nombre: POR_ID[id].nombre, lat: POR_ID[id].lat, lon: POR_ID[id].lon, ultima: ultima[id] || null })),
    granizo,
    nota: 'Observación oficial de aeropuerto (METAR/SPECI). Una estación sin parte en la ventana es «sin dato», nunca «sin granizo». Lejos del aeropuerto, el METAR no dice nada.',
  };
}

async function publicar({ almacen, publico, ahoraMs, log, completo }) {
  const dias = [];
  for (let d = ahoraMs - VENTANA_PUBLICA_H * HORA; d <= ahoraMs + 24 * HORA; d += 24 * HORA) {
    const k = claveIndiceDia(Math.min(d, ahoraMs));
    if (!dias.includes(k)) dias.push(k);
  }
  const inds = [];
  for (const k of dias) inds.push(await leerJSON(almacen, k));
  const pub = armarPublico(inds, ahoraMs, { completo });
  await publico.escribir(CLAVE_PUBLICA, JSON.stringify(pub), { tipo: 'application/json', cache: CACHE_PUBLICA });
  log(`metar: público ${CLAVE_PUBLICA} · ${pub.granizo.length} partes con granizo en 24 h · ${pub.estaciones.filter((e) => e.ultima).length} de ${pub.estaciones.length} estaciones con dato`);
  return pub;
}

/** Los tramos de 3 h del relleno, del más viejo al más nuevo, dentro de los 30 días de la API. Cada uno: la hora FINAL en ms. */
export function tramosRelleno(desdeMs, hastaMs, ahoraMs, hechos = {}) {
  const piso = ahoraMs - DIAS_HISTORIA * 24 * HORA + HORA;            // con una hora de margen: lo de más atrás la API ya no lo tiene
  const ini = Math.max(Math.ceil(desdeMs / (HORAS_TRAMO * HORA)) * HORAS_TRAMO * HORA, Math.ceil(piso / (HORAS_TRAMO * HORA)) * HORAS_TRAMO * HORA);
  const fin = Math.min(hastaMs, ahoraMs - HORA);
  const out = [];
  for (let t = ini + HORAS_TRAMO * HORA; t <= fin; t += HORAS_TRAMO * HORA) {
    const k = iso(t).slice(0, 13).replace(/[-T]/g, '');
    if (hechos[k] === 'hecho') continue;
    out.push(t);
  }
  return out;
}

/**
 * Una corrida. Devuelve un resumen con cantidades (el registro de Actions es público: no se imprime nada más).
 * @param {object} o
 * @param {object} o.almacen        el privado: leer / escribir / listar (rayos-hora/lib/almacen.mjs)
 * @param {object} [o.publico]      el público de SATCHI (o null: no se copia)
 * @param {string} o.llave          METAR_ON: sólo «si» hace algo
 * @param {'real'|'seco'|'relleno'} [o.modo]
 */
export async function correr({
  almacen, publico = null, fetchFn = fetch, ahoraMs = Date.now(), llave, modo = 'real', tope, desdeMs = null, hastaMs = null,
  pausaMs = PAUSA_MS, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log,
}) {
  const res = { estado: 'ok', modo, pedidos: 0, partes_api: 0, guardados: 0, recuperados: 0, repetidos: 0, descartados: 0, con_granizo: 0,
    horas_revisadas: 0, faltantes: 0, indices: 0, partidos: 0, truncados: 0, tramos: 0 };
  if (llave !== 'si') {
    log('metar: llave apagada (METAR_ON no vale «si»): no hago nada');
    return { ...res, estado: 'apagado' };
  }
  const maxPedidos = acotarTope(tope, modo);
  let fallasSeguidas = 0, cortar = null;
  const pedir = async (url) => {
    if (res.pedidos > 0 && pausaMs > 0) await esperar(pausaMs);
    res.pedidos++;
    let r;
    try {
      const x = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      r = { status: x.status, texto: await x.text() };
    } catch (e) { r = { status: 0, error: String(e?.name || e) }; }
    if (r.status === 0 || r.status >= 500) fallasSeguidas++; else if (r.status !== 200) fallasSeguidas = 0;   // un 200 se juzga después, al leerlo
    if (r.status === 429 || r.status === 403) cortar = `aviationweather respondió ${r.status}`;
    else if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;
    return r;
  };
  /** Un tramo (horas hasta hastaMs, o las últimas): pide, y si llega al tope de 400 parte la lista en dos. */
  const traer = async (ids, opciones) => {
    if (res.pedidos >= maxPedidos) return { ok: false, motivo: 'tope' };
    const r = await pedir(urlMetar(ids, opciones));
    if (r.status === 204) return { ok: true, entradas: [] };          // la API contesta 204 cuando no hay ningún parte
    if (r.status !== 200) return { ok: false, motivo: r.status ? `HTTP ${r.status}` : `red: ${r.error}` };
    // [n3-317col P7] un 200 que no es una lista JSON también es una falla, y cuenta para el corte
    const invalida = (motivo) => { fallasSeguidas++; if (!cortar && fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`; return { ok: false, motivo }; };
    let j;
    try { j = r.texto.trim() ? JSON.parse(r.texto) : []; } catch { return invalida('la respuesta no es JSON'); }
    if (!Array.isArray(j)) return invalida('la respuesta no es una lista');
    fallasSeguidas = 0;
    if (j.length >= TOPE_API) {
      if (ids.length > 1 && res.pedidos + 2 <= maxPedidos && !cortar) {
        res.partidos++;
        const mitad = Math.ceil(ids.length / 2);
        const a = await traer(ids.slice(0, mitad), opciones);
        const b = cortar ? { ok: false, motivo: cortar } : await traer(ids.slice(mitad), opciones);
        if (a.ok && b.ok) return { ok: true, entradas: [...a.entradas, ...b.entradas], truncado: a.truncado || b.truncado };
        return { ok: true, entradas: [...j, ...(a.entradas || []), ...(b.entradas || [])], truncado: true };
      }
      res.truncados++;
      return { ok: true, entradas: j, truncado: true };
    }
    return { ok: true, entradas: j };
  };

  const indices = new Map();
  let completo = false;
  if (modo === 'real' || modo === 'seco') {
    const t = await traer(IDS, { horas: HORAS_NORMAL });
    if (!t.ok) {
      if (modo !== 'seco') await alertar(almacen, `aviationweather /api/data/metar: ${t.motivo}. No se guardó nada; la corrida siguiente vuelve a probar.`, ahoraMs);
      log(`metar: la API no contestó bien (${t.motivo}); ${modo === 'seco' ? 'seco: no anoto nada' : 'anotado'}, corto`);
      return { ...res, estado: 'api-caida' };
    }
    res.partes_api = t.entradas.length;
    if (modo === 'seco') {
      const ok = t.entradas.map(normalizar).filter((x) => !x.descartado);
      log(`metar (SECO): ${res.pedidos} pedido(s) · ${t.entradas.length} partes · ${new Set(ok.map((x) => x.est)).size} estaciones con parte · ${ok.filter((x) => x.parseado.granizo.alguno).length} con granizo · no guardo nada`);
      return { ...res, estado: 'seco' };
    }
    completo = !t.truncado;
    if (t.truncado) await alertar(almacen, `la respuesta llegó al tope de ${TOPE_API} partes y no se pudo partir: puede faltar algo (queda como faltante).`, ahoraMs);
    await ingerir({ almacen, entradas: t.entradas, horas: t.truncado ? [] : horasRevisables(ahoraMs - HORAS_NORMAL * HORA, ahoraMs, ahoraMs), ahoraMs, res, indices });
  } else if (modo === 'relleno') {
    const prog = (await leerJSON(almacen, CLAVE_RELLENO)) || { v: 1, tramos: {} };
    const cola = tramosRelleno(desdeMs ?? ahoraMs - DIAS_HISTORIA * 24 * HORA, hastaMs ?? ahoraMs, ahoraMs, prog.tramos);
    log(`metar (RELLENO): ${cola.length} tramos de ${HORAS_TRAMO} h por pedir (del más viejo al más nuevo), tope ${maxPedidos} pedidos`);
    for (const fin of cola) {
      if (cortar || res.pedidos >= maxPedidos) break;
      const t = await traer(IDS, { horas: HORAS_TRAMO, hastaMs: fin });
      if (!t.ok) { if (t.motivo === 'tope') break; continue; }       // falló: queda pendiente para la próxima corrida
      res.partes_api += t.entradas.length;
      await ingerir({ almacen, entradas: t.entradas, horas: t.truncado ? [] : horasRevisables(fin - HORAS_TRAMO * HORA, fin, ahoraMs), ahoraMs, res, indices });
      prog.tramos[iso(fin).slice(0, 13).replace(/[-T]/g, '')] = t.truncado ? 'truncado' : 'hecho';
      res.tramos++;
    }
    res.indices = await guardarIndices(almacen, indices, ahoraMs);
    prog.actualizado = iso(ahoraMs);
    await almacen.escribir(CLAVE_RELLENO, JSON.stringify(prog, null, 1));
  } else {
    throw new Error('modo desconocido: ' + modo);
  }
  if (modo === 'real') res.indices = await guardarIndices(almacen, indices, ahoraMs);
  if (cortar) { await alertar(almacen, `aviationweather: ${cortar}. Se cortó la corrida; lo que falta se pide en la próxima.`, ahoraMs); res.estado = 'cortada'; }
  // [n3-317col P7] el derivado público sólo lo escribe una corrida REAL que leyó la API (el relleno y una API caída no lo tocan:
  // así su `leido` envejece y SATCHI pasa a «sin dato» a los 90 min)
  if (publico && modo === 'real') { const pub = await publicar({ almacen, publico, ahoraMs, log, completo }); res.publico_granizo = pub.granizo.length; res.publico_completo = completo; }
  log(`metar: ${res.pedidos} pedidos · ${res.partes_api} partes de la API · ${res.guardados} nuevos · ${res.recuperados} recuperados · ${res.repetidos} ya estaban · ${res.descartados} descartados · ${res.con_granizo} con granizo · ${res.horas_revisadas} horas revisadas · ${res.faltantes} faltantes (estación-hora sin parte)${res.partidos ? ' · partido ' + res.partidos : ''}${res.truncados ? ' · TRUNCADO ' + res.truncados : ''}${cortar ? ' · CORTADA: ' + cortar : ''}`);
  return res;
}
