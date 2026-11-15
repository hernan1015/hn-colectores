// HN AGRO · 226 · GRANIZO β · Fase B · EL VEREDICTO DE P2, escrito ANTES de bajar nada (SELLO-B.json manda).
// Puro: recibe la partición y las filas de instantes.jsonl de los 29 casos; devuelve las métricas y el veredicto.
import { casos, H } from './plan.mjs';
import { dist } from './celdas.mjs';

export const RADIO_KM = 30;
export const SALTO = { N_MIN: 30, FACTOR: 2, DIF_MIN: 20 };
export const V2_RAYOS = 80;
export const CRITERIO = { nuevos_min: 3, controles_nuevos_max: 1, dPSS_min: 0.15, C_dias_min: 3, C_hora_min: 3, C_hora_n_min: 12, sin_dato_max: 3, desarreglos: 200, semilla: 226 };
export const I1_ESPERADO = { confirmados: ['2022-02-27', '2023-05-25', '2023-10-29', '2025-05-17'], controles: ['2026-04-01'] };

export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function wilson(k, n) {
  if (!n) return null; const z = 1.959964, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { k, n, p: +p.toFixed(3), ic: [+(c - h).toFixed(3), +(c + h).toFixed(3)] };
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const salto = (n1, n0) => n1 != null && n0 != null && n1 >= SALTO.N_MIN && n1 >= SALTO.FACTOR * n0 && n1 - n0 >= SALTO.DIF_MIN;

/** 200 desarreglos de n (Fisher-Yates con mulberry32, se rechaza el que deje a alguno en su lugar) */
export function desarreglos(n, cuantos = CRITERIO.desarreglos, semilla = CRITERIO.semilla) {
  const rnd = mulberry32(semilla), out = [];
  while (out.length < cuantos) {
    const p = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    if (p.every((v, i) => v !== i)) out.push(p);
  }
  return out;
}

/** señales por variante de un caso (modo con_fase): [{ t, creado, publicado, lat, lon }] */
export function senales(filas) {
  const porK = new Map(filas.map((f) => [f.k10, f]));
  const S = { V0: [], V1: [], V2: [] };
  for (const f of filas) {
    const cf = f.con_fase;
    if (!cf || !cf.valido) continue;
    const t = Date.parse(f.t), base = { t, creado: f.creado ? Date.parse(f.creado) : null, publicado: f.publicado ? Date.parse(f.publicado) : null };
    const ant = porK.get(f.k10 - 1);
    const puedeSalto = !!(cf.glm_completo && ant && ant.con_fase && ant.con_fase.valido && ant.con_fase.glm_completo && cf.t10_disponible);
    for (const c of cf.celdas || []) {
      if (c.incompleta) continue;
      const s = { ...base, lat: c.lat, lon: c.lon };
      if (c.destacada) { S.V0.push(s); S.V1.push(s); S.V2.push(s); continue; }
      if (!(c.patas >= 2) || !(c.patas_cuales || []).includes('altura')) continue;
      if ((c.rayos ?? 0) >= V2_RAYOS) S.V2.push(s);
      if (puedeSalto && salto(c.n25_t, c.n25_t10)) S.V1.push({ ...s, via: 'salto' });
    }
  }
  for (const k of Object.keys(S)) S[k].sort((a, b) => a.t - b.t);
  return S;
}
const validosEn = (filas, desde, hasta) => filas.filter((f) => f.con_fase && f.con_fase.valido && Date.parse(f.t) >= desde && Date.parse(f.t) <= hasta).length;
function primera(sen, desde, hasta, lat, lon) {
  for (const s of sen) if (s.t >= desde && s.t <= hasta && dist(lat, lon, s.lat, s.lon) <= RADIO_KM) return s;
  return null;
}

/* ── I1: la cuenta de la 19, tal cual (evaluar.mjs de la 19) sobre el modo como_19 ── */
const km19 = (a, b, c, d) => { const r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r; return 6371 * Math.sqrt(x * x + y * y); };
function ventana19(filas, desde, hasta, lat, lon) {
  const sc = filas.filter((x) => x.como_19 && x.como_19.scan_t && Date.parse(x.como_19.scan_t) >= desde - 60000 && Date.parse(x.como_19.scan_t) <= hasta);
  const usados = sc.filter((x) => x.como_19.valido);
  let hit = false;
  for (const x of usados) for (const c of x.como_19.destacadas) if (km19(lat, lon, c.lat, c.lon) <= 30) hit = true;
  return { completos: usados.length, hit };
}
export function identidad19(P, porCaso, esperado = I1_ESPERADO) {
  const conf = [], ctrl = [];
  for (const e of P.confirmados) {
    const f = porCaso.get(e.episodio) || [];
    const ev = e.eventos.map((v) => ventana19(f, Date.parse(v.ini) - 2 * H, Date.parse(v.fin), v.lat, v.lon)).filter((w) => w.completos);
    if (ev.length && ev.some((w) => w.hit)) conf.push(e.episodio);
  }
  for (const c of P.controles) {
    const f = porCaso.get(c.episodio) || [];
    const hs = c.horas.map((h) => ventana19(f, Date.parse(h.ini) - 2 * H, Date.parse(h.fin), h.lat, h.lon)).filter((w) => w.completos);
    if (hs.length && hs.some((w) => w.hit)) ctrl.push(c.episodio);
  }
  conf.sort(); ctrl.sort();
  const ok = JSON.stringify(conf) === JSON.stringify([...esperado.confirmados].sort()) && JSON.stringify(ctrl) === JSON.stringify([...esperado.controles].sort());
  return { en_regla: ok, confirmados_acertados: conf, controles_con_alarma: ctrl, esperado };
}

/** filas: todas las de los 29 casos (se agrupan por caso; repetidas por partes → una por k10) */
export function evaluar(P, filas, { instantes19 = null, esperadoI1 = I1_ESPERADO } = {}) {
  const porCaso = new Map();
  for (const f of filas) {
    if (!porCaso.has(f.caso)) porCaso.set(f.caso, new Map());
    porCaso.get(f.caso).set(f.k10, f);
  }
  for (const [k, m] of porCaso) porCaso.set(k, [...m.values()].sort((a, b) => a.k10 - b.k10));
  const C = casos(P);
  const SEN = new Map(C.map((c) => [c.caso, senales(porCaso.get(c.caso) || [])]));
  const real = (c) => c.ventanas.filter((v) => v.rol === 'real');

  /* por episodio y variante */
  const V = ['V0', 'V1', 'V2'];
  const conf = C.filter((c) => c.tipo === 'confirmado'), ctrl = C.filter((c) => c.tipo === 'control');
  function evalConf(c, sen, ventanasDe = real(c), filasDe = porCaso.get(c.caso) || []) {
    const ev = ventanasDe.map((v) => {
      const dato = validosEn(filasDe, v.desde, v.hasta) > 0;
      const p = dato ? primera(sen, v.desde, v.hasta, v.lat, v.lon) : null;
      return { id: v.id, dato, acierto: !!p, p, t_utc: v.t_utc };
    });
    const conDato = ev.filter((x) => x.dato);
    return { dato: conDato.length > 0, acierto: conDato.some((x) => x.acierto), eventos: ev };
  }
  const R = {};
  for (const v of V) {
    const ce = conf.map((c) => ({ caso: c.caso, ...evalConf(c, SEN.get(c.caso)[v]) }));
    const ke = ctrl.map((c) => {
      const f = porCaso.get(c.caso) || [];
      const hs = real(c).map((w) => { const dato = validosEn(f, w.desde, w.hasta) > 0; return { id: w.id, dato, alarma: dato && !!primera(SEN.get(c.caso)[v], w.desde, w.hasta, w.lat, w.lon) }; });
      const cd = hs.filter((x) => x.dato);
      return { caso: c.caso, dato: cd.length > 0, alarma: cd.some((x) => x.alarma) };
    });
    const cd = ce.filter((x) => x.dato), kd = ke.filter((x) => x.dato);
    const pod = wilson(cd.filter((x) => x.acierto).length, cd.length), pofd = wilson(kd.filter((x) => x.alarma).length, kd.length);
    const ants = ce.flatMap((e) => e.eventos.filter((x) => x.acierto && x.p.creado != null).map((x) => Math.round((Date.parse(x.t_utc) - x.p.creado) / 60000)));
    const antsLM = ce.flatMap((e) => e.eventos.filter((x) => x.acierto && x.p.publicado != null).map((x) => Math.round((Date.parse(x.t_utc) - x.p.publicado) / 60000)));
    R[v] = { POD: pod, POFD: pofd, PSS: pod && pofd ? +(pod.p - pofd.p).toFixed(3) : null,
      acertados: cd.filter((x) => x.acierto).map((x) => x.caso), con_alarma: kd.filter((x) => x.alarma).map((x) => x.caso),
      sin_dato: { confirmados: ce.filter((x) => !x.dato).map((x) => x.caso), controles: ke.filter((x) => !x.dato).map((x) => x.caso) },
      anticipacion_min: { vs_creacion: { valores: ants, mediana: med(ants), ic95: bootMed(ants) }, vs_lastmodified: { valores: antsLM, mediana: med(antsLM) } } };
  }

  /* C_dias: cada confirmado con los barridos de otro episodio, en las ventanas de ese otro */
  const E = [...conf, ...ctrl];
  const conDato = new Set(conf.map((c) => c.caso).filter((x) => !R.V1.sin_dato.confirmados.includes(x)));
  const Cdias = {};
  for (const v of V) {
    const podB = desarreglos(E.length).map((sig) => {
      let n = 0;
      conf.forEach((c, i) => {
        if (!conDato.has(c.caso)) return;
        const otro = E[sig[i]], sen = SEN.get(otro.caso)[v];
        const hit = real(c).some((ev) => real(otro).some((w) => primera(sen, w.desde, w.hasta, ev.lat, ev.lon)));
        if (hit) n++;
      });
      return n;
    });
    const k = R[v].acertados.length;
    Cdias[v] = { real: k, mediana_barajado: med(podB), diferencia: k - med(podB), en_regla: k - med(podB) >= CRITERIO.C_dias_min };
  }
  /* C_hora: las ventanas −6 h de los 15 */
  const Chora = {};
  for (const v of V) {
    let n = 0, kr = 0, kc = 0;
    for (const c of conf) {
      const f = porCaso.get(c.caso) || [], sen = SEN.get(c.caso)[v];
      const r1 = evalConf(c, sen, real(c), f), r2 = evalConf(c, sen, c.ventanas.filter((w) => w.rol === 'menos6h'), f);
      if (!r1.dato || !r2.dato) continue;
      n++; if (r1.acierto) kr++; if (r2.acierto) kc++;
    }
    Chora[v] = { episodios_con_dato_en_las_dos: n, real: kr, corrida: kc, diferencia: kr - kc, en_regla: n >= CRITERIO.C_hora_n_min && kr - kc >= CRITERIO.C_hora_min };
  }

  const I1 = identidad19(P, porCaso, esperadoI1);
  const I1b = { V0_con_fase: { confirmados: [...R.V0.acertados].sort(), controles: [...R.V0.con_alarma].sort() }, V0_como_19: { confirmados: I1.confirmados_acertados, controles: I1.controles_con_alarma } };
  I1b.iguales = JSON.stringify(I1b.V0_con_fase) === JSON.stringify(I1b.V0_como_19);
  let I1c = null;
  if (instantes19) {
    const m19 = new Map(instantes19.map((x) => [x.scan_pedido, x]));
    let n = 0, iguales = 0;
    const clave = (d) => d.map((c) => c.lat + ',' + c.lon).sort().join(';');
    for (const f of filas) { const x = m19.get(f.scan_pedido); if (!x || !f.como_19) continue; n++; if (clave(x.destacadas) === clave(f.como_19.destacadas)) iguales++; }
    I1c = { comparados: n, identicos: iguales, p: n ? +(iguales / n).toFixed(3) : null };
  }

  const nuevos = R.V1.acertados.filter((x) => !R.V0.acertados.includes(x));
  const ctrlNuevos = R.V1.con_alarma.filter((x) => !R.V0.con_alarma.includes(x));
  const dPSS = R.V1.PSS != null && R.V0.PSS != null ? +(R.V1.PSS - R.V0.PSS).toFixed(3) : null;
  const sinDato = { confirmados: R.V1.sin_dato.confirmados.length, controles: R.V1.sin_dato.controles.length };
  const crit = {
    a_nuevos: { valor: nuevos.length, cuales: nuevos, en_regla: nuevos.length >= CRITERIO.nuevos_min },
    b_controles_nuevos: { valor: ctrlNuevos.length, cuales: ctrlNuevos, en_regla: ctrlNuevos.length <= CRITERIO.controles_nuevos_max },
    c_dPSS: { valor: dPSS, en_regla: dPSS != null && dPSS >= CRITERIO.dPSS_min - 1e-9 },
    d_controles: { C_dias: Cdias.V1.en_regla, C_hora: Chora.V1.en_regla, en_regla: Cdias.V1.en_regla && Chora.V1.en_regla },
    e_I1: { en_regla: I1.en_regla }
  };
  let veredicto;
  if (!I1.en_regla || sinDato.confirmados > CRITERIO.sin_dato_max || sinDato.controles > CRITERIO.sin_dato_max) veredicto = 'NO_INFORMA';
  else if (crit.a_nuevos.en_regla && crit.b_controles_nuevos.en_regla && crit.c_dPSS.en_regla && crit.d_controles.en_regla) veredicto = 'MEJORA';
  else veredicto = 'NO_MEJORA';
  const falla = Object.entries(crit).filter(([, x]) => !x.en_regla).map(([k]) => k);
  return { veredicto, falla, criterio: crit, sin_dato: sinDato, variantes: R, C_dias: Cdias, C_hora: Chora, I1, I1b, I1c,
    nota: 'Medición. El V1 no va a ningún aviso ni a la app (SELLO-B.json, no_se_hace); con MEJORA sólo se propone un ítem aparte.' };
}

/* bootstrap de la mediana con el LCG de semilla 19 de la 19 (2000 réplicas) */
function bootMed(a) {
  if (!a.length) return null;
  let s = 19; const azar = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const b = [];
  for (let i = 0; i < 2000; i++) b.push(med(a.map(() => a[Math.floor(azar() * a.length)])));
  b.sort((x, y) => x - y);
  return [b[50], b[1949]];
}
