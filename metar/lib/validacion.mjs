// HN AGRO · metar · la TABLA DE VALIDACIÓN del ojo del granizo (granizo-vivo de SATCHI) contra los METAR con GR/GS (317, parte 3).
// El criterio es el MISMO de los casos del 13/11, 14/11 y 16/11 (hn-cortex/docs/satchi-granizo-2026-11/caso-*): una celda
// DESTACADA (las 3 patas) a ≤ 30 km del lugar. Acá el lugar es el aeropuerto y la hora es la del METAR, con ±30 min.
//   · METAR con GR/GS en el tiempo presente: la hora del parte, ±30 min.
//   · METAR con REGR/REGS (granizo «reciente»): cayó entre el parte anterior y éste (como mucho 1 h) → [T − 60, T] ± 30 min.
// Resultado por METAR con granizo:
//   ACIERTO   una destacada a ≤ 30 km en la ventana;
//   PÉRDIDA   hubo barridos del ojo en la ventana, el aeropuerto está en su zona y ninguna destacada a ≤ 30 km;
//   SIN DATO  no hay barrido del ojo en la ventana, o el aeropuerto está fuera de la zona del ojo. NUNCA cuenta como pérdida.
// Y al revés, para cada destacada a ≤ 30 km de un aeropuerto con parte en ±30 min SIN granizo: «no confirmada por el METAR».
// Ojo: no es una falsa alarma: el METAR mira el aeródromo (unos pocos km), la celda es de 0,2° (~20 km) y el radio es de 30 km.
// Puras: los datos entran ya leídos.
import { POR_ID } from './estaciones.mjs';
import { normalizar } from './colector.mjs';

export const RADIO_KM = 30, VENTANA_MIN = 30, RECIENTE_MIN = 60;
const MIN = 60000;

export function distanciaKm(a, b, c, d) {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const art = (ms) => { const d = new Date(ms - 3 * 3600e3); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

/** Los partes, vengan de la API (JSON de /api/data/metar) o de los índices del colector → [{ estacion, ms, granizo, crudo }] sin repetidos */
export function partesDe({ api = [], indices = [] } = {}) {
  const out = new Map();
  for (const e of api) {
    const x = normalizar(e);
    if (x.descartado) continue;
    const g = x.parseado.granizo;
    out.set(`${x.est} ${x.ms} ${x.crudo}`, { estacion: x.est, ms: x.ms, crudo: x.crudo, granizo: g.alguno ? { observado: g.observado, reciente: g.reciente, en_rmk: g.en_rmk, tipos: g.tipos, grupos: g.grupos } : null });
  }
  for (const ind of indices) {
    for (const o of Object.values((ind && ind.obs) || {})) {
      const ms = Date.parse(o.hora);
      if (!POR_ID[o.estacion] || !Number.isFinite(ms)) continue;
      const k = `${o.estacion} ${ms} ${o.crudo || o.clave}`;
      if (![...out.values()].some((p) => p.estacion === o.estacion && p.ms === ms && (!o.crudo || p.crudo === o.crudo))) out.set(k, { estacion: o.estacion, ms, crudo: o.crudo || null, granizo: o.granizo || null });
    }
  }
  return [...out.values()].sort((a, b) => a.ms - b.ms || (a.estacion < b.estacion ? -1 : 1));
}

/** Un barrido del archivo (sobre hn-granizo-barrido/1, con el cuerpo de granizo-vivo como texto u objeto) → { ms, zona, celdas, parcial } o null */
export function barridoDe(sobre) {
  if (!sobre) return null;
  let c = sobre.cuerpo !== undefined ? sobre.cuerpo : sobre.r !== undefined ? sobre.r : sobre;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return null; } }
  if (!c || c.ok === false || !Array.isArray(c.celdas)) return null;
  const ms = Date.parse(c.scan_t || sobre.scan_t || '');
  if (!Number.isFinite(ms)) return null;
  return { ms, zona: c.zona || null, parcial: !!c.parcial, celdas: c.celdas };
}
const enZona = (z, lat, lon) => !z || (lat >= z.latMin && lat <= z.latMax && lon >= z.lonMin && lon <= z.lonMax);

/** La ventana de búsqueda del ojo para un parte con granizo */
export function ventana(p) {
  const ini = p.granizo && !p.granizo.observado && p.granizo.reciente ? p.ms - RECIENTE_MIN * MIN : p.ms;
  return { desde: ini - VENTANA_MIN * MIN, hasta: p.ms + VENTANA_MIN * MIN };
}

/** Lo mejor que vio el ojo cerca del aeropuerto en la ventana */
function mirar(barridos, est, v) {
  const en = barridos.filter((b) => b.ms >= v.desde && b.ms <= v.hasta && enZona(b.zona, est.lat, est.lon));
  let dest = null, maxPatas = null, incompletas = 0;
  for (const b of en) {
    for (const c of b.celdas) {
      const d = distanciaKm(est.lat, est.lon, c.lat, c.lon);
      if (d > RADIO_KM) continue;
      if (c.incompleta) incompletas++;
      const pt = c.patas == null ? c.patas_min : c.patas;
      if (pt != null && (maxPatas == null || pt > maxPatas.patas)) maxPatas = { patas: pt, km: Math.round(d), ms: b.ms, incompleta: !!c.incompleta };
      if (c.destacada && (!dest || d < dest.km)) dest = { km: Math.round(d * 10) / 10, ms: b.ms };
    }
  }
  return { barridos: en.length, parciales: en.filter((b) => b.parcial).length, dest, maxPatas, incompletas };
}

/** La tabla. partes: los de partesDe(); barridos: los de barridoDe(). */
export function validar({ partes, barridos }) {
  const B = barridos.filter(Boolean).sort((a, b) => a.ms - b.ms);
  const filas = [];
  for (const p of partes.filter((x) => x.granizo)) {
    const est = POR_ID[p.estacion];
    const v = ventana(p);
    const m = mirar(B, est, v);
    const resultado = m.dest ? 'ACIERTO' : m.barridos === 0 ? 'SIN DATO' : 'PÉRDIDA';
    filas.push({ estacion: p.estacion, nombre: est.nombre, hora: iso(p.ms), hora_art: art(p.ms), crudo: p.crudo, grupos: p.granizo.grupos,
      tipo: p.granizo.observado ? 'presente' : p.granizo.reciente ? 'reciente' : 'rmk', ventana: { desde: iso(v.desde), hasta: iso(v.hasta) },
      barridos: m.barridos, parciales: m.parciales, destacada: m.dest ? { km: m.dest.km, hora: iso(m.dest.ms) } : null,
      mejor: m.maxPatas ? { patas: m.maxPatas.patas, km: m.maxPatas.km, hora: iso(m.maxPatas.ms), incompleta: m.maxPatas.incompleta } : null,
      incompletas: m.incompletas, resultado,
      motivo: resultado === 'SIN DATO' ? 'no hay barrido del ojo en la ventana (o el aeropuerto está fuera de su zona)' : null });
  }
  // al revés: destacadas a ≤ 30 km de un aeropuerto que tiene parte en ±30 min y ese parte NO dice granizo
  const noConfirmadas = [];
  for (const b of B) {
    for (const c of b.celdas) {
      if (!c.destacada) continue;
      for (const id of Object.keys(POR_ID)) {
        const est = POR_ID[id];
        const d = distanciaKm(est.lat, est.lon, c.lat, c.lon);
        if (d > RADIO_KM) continue;
        const cerca = partes.filter((p) => p.estacion === id && Math.abs(p.ms - b.ms) <= VENTANA_MIN * MIN);
        if (!cerca.length) continue;                                   // sin parte: sin dato del METAR, no se cuenta
        if (cerca.some((p) => p.granizo)) continue;
        noConfirmadas.push({ estacion: id, nombre: est.nombre, barrido: iso(b.ms), celda: { lat: c.lat, lon: c.lon }, km: Math.round(d * 10) / 10, partes: cerca.map((p) => p.crudo).filter(Boolean) });
      }
    }
  }
  const cuenta = (r) => filas.filter((f) => f.resultado === r).length;
  return { criterio: { radio_km: RADIO_KM, ventana_min: VENTANA_MIN, reciente_min: RECIENTE_MIN, destacada: 'las 3 patas (granizo-vivo)' },
    partes: partes.length, con_granizo: filas.length, barridos: B.length,
    aciertos: cuenta('ACIERTO'), perdidas: cuenta('PÉRDIDA'), sin_dato: cuenta('SIN DATO'), filas, no_confirmadas: noConfirmadas };
}

/** La tabla en Markdown (para docs/satchi-granizo-2026-11/317-validacion.md) */
export function tablaMd(v) {
  const l = ['| aeropuerto | hora UTC (ART) | METAR | qué dice | barridos en la ventana | destacada ≤ 30 km | lo mejor ≤ 30 km | resultado |', '|---|---|---|---|---|---|---|---|'];
  for (const f of v.filas) {
    l.push(`| ${f.estacion} (${f.nombre}) | ${f.hora.slice(5, 16).replace('T', ' ')} (${f.hora_art}) | \`${f.crudo || ''}\` | ${f.grupos.join(', ')} (${f.tipo}) | ${f.barridos}${f.parciales ? ` (${f.parciales} parciales)` : ''} | ${f.destacada ? `${f.destacada.km} km, ${f.destacada.hora.slice(11, 16)}Z` : 'ninguna'} | ${f.mejor ? `${f.mejor.patas} pata(s) a ${f.mejor.km} km, ${f.mejor.hora.slice(11, 16)}Z${f.mejor.incompleta ? ' (incompleta)' : ''}` : '—'} | **${f.resultado}** |`);
  }
  return l.join('\n');
}
