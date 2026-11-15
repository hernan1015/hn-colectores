// HN AGRO · 226 · GRANIZO β · Fase B · EL PLAN DE UN CASO: ventanas, instantes y partes.
// Manda hn-cortex docs/satchi-granizo-2026-11/226-beta/SELLO-B.json (sellado y empujado antes de bajar nada).
// Puro: sin red ni disco (los tests lo llaman con listados falsos).

export const CAMBIO_SAT_MS = Date.UTC(2025, 3, 7, 0, 0, 0);    // GOES-19 es GOES-Este desde el 7/4/2025 (como la 19)
export const H = 3600000, MIN = 60000;
export const K10 = (ms) => Math.round(ms / 600000);             // índice de 10 min (el de la Fase A)
export const RE_CASO = /^\d{4}-\d{2}-\d{2}$/;

/** Los 29 casos de la partición de la 19: un caso = un episodio (15 confirmados + 14 controles). */
export function casos(P) {
  const out = [];
  for (const e of P.confirmados) {
    const vs = [];
    for (const v of e.eventos) {
      const desde = Date.parse(v.ini) - 2 * H, hasta = Date.parse(v.fin);
      vs.push({ id: v.id, rol: 'real', desde, hasta, lat: v.lat, lon: v.lon, t_utc: v.t });
      vs.push({ id: v.id, rol: 'menos6h', desde: desde - 6 * H, hasta: hasta - 6 * H, lat: v.lat, lon: v.lon, t_utc: v.t });   // C_hora
    }
    out.push({ caso: e.episodio, tipo: 'confirmado', ventanas: vs });
  }
  for (const c of P.controles) {
    out.push({ caso: c.episodio, tipo: 'control',
      ventanas: c.horas.map((h) => ({ id: h.id, rol: 'real', desde: Date.parse(h.ini) - 2 * H, hasta: Date.parse(h.fin), lat: h.lat, lon: h.lon, estacion: h.estacion })) });
  }
  for (const c of out) {
    const d0 = Math.min(...c.ventanas.map((v) => v.desde));
    c.sat = d0 < CAMBIO_SAT_MS ? 'goes16' : 'goes19';
  }
  return out;
}

/** Los lugares distintos de la muestra (eventos y estaciones), para guardar los flashes cercanos. */
export function lugares(P) {
  const m = new Map();
  for (const e of P.confirmados) for (const v of e.eventos) m.set(v.lat + ',' + v.lon, [v.lat, v.lon]);
  for (const c of P.controles) for (const h of c.horas) m.set(h.lat + ',' + h.lon, [h.lat, h.lon]);
  return [...m.values()];
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export const diaJul = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
/** prefijo S3 de una hora: ABI-L2-ACHAF/AAAA/DDD/HH/ */
export function prefijoHora(ms, producto = 'ABI-L2-ACHAF') {
  const d = new Date(ms);
  return producto + '/' + d.getUTCFullYear() + '/' + pad(diaJul(d), 3) + '/' + pad(d.getUTCHours()) + '/';
}
/** Las horas a listar para las ventanas del caso (con 15 min antes para el scan de t−10). */
export function horasAListar(c) {
  const s = new Set();
  for (const v of c.ventanas) for (let h = Math.floor((v.desde - 15 * MIN) / H) * H; h <= v.hasta; h += H) s.add(h);
  return [...s].sort((a, b) => a - b);
}

/** _sAAAADDDHHMMSS → ms (al segundo, como la 19) */
export function tDeClave(k, letra = 's') {
  const m = new RegExp('_' + letra + '(\\d{4})(\\d{3})(\\d{2})(\\d{2})(\\d{2})').exec(k);
  return m ? Date.UTC(+m[1], 0, 1, +m[3], +m[4], +m[5]) + (+m[2] - 1) * 864e5 : null;
}
/** Un listado ListObjectsV2 → [{ clave, t, creado, publicado, bytes }] */
export function leerListado(xml) {
  const out = [];
  for (const c of String(xml).match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const k = (/<Key>([^<]+)<\/Key>/.exec(c) || [])[1];
    if (!k) continue;
    const t = tDeClave(k);
    if (t == null) continue;
    out.push({ clave: k, t, creado: tDeClave(k, 'c'), publicado: (/<LastModified>([^<]+)<\/LastModified>/.exec(c) || [])[1] || null,
      bytes: +((/<Size>(\d+)<\/Size>/.exec(c) || [])[1] || 0) });
  }
  return out;
}

/** Los instantes del caso: los scans con inicio en alguna ventana, más el de t−10 del primero de cada tramo seguido. */
export function instantesDe(c, scans) {
  const uno = new Map();
  for (const s of scans) if (!uno.has(K10(s.t))) uno.set(K10(s.t), s);
  const elegidos = new Map();
  for (const s of uno.values()) {
    const vs = c.ventanas.filter((v) => s.t >= v.desde && s.t <= v.hasta);
    if (vs.length) elegidos.set(K10(s.t), { ...s, k10: K10(s.t), ventanas: [...new Set(vs.map((v) => v.rol + ':' + v.id))], extra_t10: false });
  }
  for (const k of [...elegidos.keys()]) {
    if (elegidos.has(k - 1)) continue;
    const prev = uno.get(k - 1);
    if (prev) elegidos.set(k - 1, { ...prev, k10: k - 1, ventanas: [], extra_t10: true });
  }
  return [...elegidos.values()].sort((a, b) => a.t - b.t);
}

/** Parte i de n (contigua). La primera de cada parte > 1 lleva el instante anterior como t−10 (se baja dos veces: es uno). */
export function parte(inst, i, n) {
  if (!(Number.isInteger(i) && Number.isInteger(n) && n >= 1 && i >= 1 && i <= n)) throw new Error('parte inválida: ' + i + '/' + n);
  if (n === 1) return inst;
  const tam = Math.ceil(inst.length / n), a = (i - 1) * tam, b = Math.min(inst.length, i * tam);
  const tramo = inst.slice(a, b);
  if (a > 0 && tramo.length && inst[a - 1].k10 === tramo[0].k10 - 1) tramo.unshift({ ...inst[a - 1], ventanas: [], extra_t10: true });
  return tramo;
}

/** Desde un instante (ISO o ms): los que empiezan en él o después (el anterior va como t−10). */
export function desde(inst, d) {
  if (d == null || d === '') return inst;
  const ms = typeof d === 'number' ? d : Date.parse(d);
  if (!isFinite(ms)) throw new Error('desde inválido');
  const i = inst.findIndex((x) => x.t >= ms);
  if (i < 0) return [];
  const out = inst.slice(i);
  if (i > 0 && inst[i - 1].k10 === out[0].k10 - 1) out.unshift({ ...inst[i - 1], ventanas: [], extra_t10: true });
  return out;
}
