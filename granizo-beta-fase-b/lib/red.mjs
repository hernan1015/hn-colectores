// HN AGRO · 226 · GRANIZO β · Fase B · EL FETCH DEL JOB: de a poco con S3 de NOAA (público, sin credenciales).
//   · como mucho CONCURRENCIA pedidos a la vez (4): el GLM de la lib pide 24 en paralelo y acá hacen fila;
//     el cuerpo se lee entero DENTRO del turno, así la fila limita la bajada de verdad;
//   · reintento ante 5xx, 429, 403 (SlowDown de S3) o error de red: 5 intentos con espera 2, 4, 8, 16, 32 s
//     (o el Retry-After, hasta 120 s);
//   · goes16 antes del 7/4/2025: cambia noaa-goes19 por noaa-goes16 en la URL (como la 19);
//   · modo «como_19»: la fase (ABI-L2-ACTPF) responde 404 (como la 19); modo «con_fase»: se baja;
//   · caché EN MEMORIA de lo bajado en el instante y en los 2 anteriores (el t−20 y los dos modos salen de los mismos
//     bytes); nada crudo va al disco;
//   · el H0 de Open-Meteo: el pedido de la lib se responde con el historical-forecast del día (h0Dia de la 19): primero
//     el archivo del colector (los días que bajó la 19), si no, se baja UNA vez con pausa ≥ 8 s;
//   · cualquier otro host: error (el job no habla con nadie más).
import fs from 'node:fs';
import path from 'node:path';

export const CONCURRENCIA = 4;
export const ESPERAS_MS = [2000, 4000, 8000, 16000, 32000];
export const RETRY_AFTER_MAX_MS = 120000;
export const PAUSA_OM_MS = 8000;
const S3 = /^https:\/\/noaa-goes1[69]\.s3\.amazonaws\.com\//;
const OM_APP = 'api.open-meteo.com/v1/forecast';
const OM_HIST = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const reintentable = (st) => st >= 500 || st === 429 || st === 403;

export function crearRed({ fetchReal = globalThis.fetch, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), ahora = () => Date.now(),
  concurrencia = CONCURRENCIA, h0Dir = null, h0Lats = null, h0Lons = null, bajarH0 = true } = {}) {
  let sat = 'goes19', modo = 'con_fase', instante = 0, ultimoOM = -Infinity;
  const stats = { pedidos: 0, bytes: 0, reintentos: 0, por_estado: {}, de_cache: 0, actpf_404: 0, max_a_la_vez: 0, h0: {} };
  const cache = new Map();        // url → { status, headers, bytes, usado }
  const listados = new Map();     // url → texto (ListObjectsV2: chicos, valen todo el job)
  const h0Mem = new Map();
  let activos = 0;
  const fila = [];
  const tomar = () => new Promise((r) => { if (activos < concurrencia) { activos++; r(); } else fila.push(r); });
  const soltar = () => { const s = fila.shift(); if (s) s(); else activos--; };

  async function conReintento(url, o) {
    for (let i = 0; ; i++) {
      let r = null, err = null;
      try { r = await fetchReal(url, o); } catch (e) { err = e; }
      if (r) { stats.por_estado[r.status] = (stats.por_estado[r.status] || 0) + 1; }
      const otra = i < ESPERAS_MS.length && (err ? !(o && o.signal && o.signal.aborted) : reintentable(r.status));
      if (!otra) {
        if (err) throw err;
        return r;
      }
      let w = ESPERAS_MS[i];
      const ra = r && r.headers && r.headers.get && r.headers.get('retry-after');
      if (ra && /^\d+$/.test(ra)) w = Math.min(RETRY_AFTER_MAX_MS, Math.max(w, +ra * 1000));
      if (r && r.body && r.body.cancel) { try { await r.body.cancel(); } catch { /* nada */ } }
      stats.reintentos++;
      await esperar(w);
    }
  }
  /** un pedido a S3 con turno: el cuerpo se lee adentro */
  async function aS3(url, o) {
    await tomar();
    stats.max_a_la_vez = Math.max(stats.max_a_la_vez, activos);
    try {
      const r = await conReintento(url, o);
      const bytes = new Uint8Array(await r.arrayBuffer());
      stats.pedidos++; stats.bytes += bytes.length;
      const headers = {};
      for (const h of ['content-length', 'last-modified', 'content-type', 'retry-after']) { const v = r.headers.get(h); if (v != null) headers[h] = v; }
      return { status: r.status, headers, bytes };
    } finally { soltar(); }
  }
  const respuesta = (e) => new Response(e.status === 204 || e.status === 304 ? null : e.bytes, { status: e.status, headers: e.headers });

  function diaH0(dia) {
    if (h0Mem.has(dia)) return h0Mem.get(dia);
    const p = (async () => {
      const f = h0Dir ? path.join(h0Dir, dia + '.json') : null;
      if (f && fs.existsSync(f)) { stats.h0[dia] = 'colector'; return JSON.parse(fs.readFileSync(f, 'utf8')); }
      if (!bajarH0 || !h0Lats || !h0Lons) throw new Error('h0 sin archivo para ' + dia);
      const lat = [], lon = [];
      for (const la of h0Lats) for (const lo of h0Lons) { lat.push(la); lon.push(lo); }
      const w = PAUSA_OM_MS - (ahora() - ultimoOM); if (w > 0) await esperar(w);
      const u = OM_HIST + '?latitude=' + lat.join(',') + '&longitude=' + lon.join(',') + '&hourly=freezing_level_height&start_date=' + dia + '&end_date=' + dia + '&timezone=GMT';
      const r = await conReintento(u); ultimoOM = ahora(); stats.pedidos++;
      if (!r.ok) throw new Error('open-meteo historical ' + r.status);
      const j = await r.json();
      stats.h0[dia] = 'bajado';
      return j;
    })();
    h0Mem.set(dia, p);
    p.catch(() => h0Mem.delete(dia));
    return p;
  }

  async function fetchRed(url, o) {
    let u = String(url);
    if (u.includes(OM_APP)) {      // el H0 de la lib: start_hour=AAAA-MM-DDTHH:00
      const hh = (/start_hour=([0-9T:-]+)/.exec(u) || [])[1];
      if (!hh) throw new Error('pedido de H0 sin start_hour');
      const dia = hh.slice(0, 10), hora = +hh.slice(11, 13);
      const j = await diaH0(dia);
      const arr = (Array.isArray(j) ? j : [j]).map((x) => ({ hourly: { time: [hh], freezing_level_height: [x.hourly.freezing_level_height[hora]] } }));
      return new Response(JSON.stringify(arr), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!S3.test(u)) throw new Error('host no permitido en la Fase B');
    if (u.includes('ABI-L2-ACTPF') && modo === 'como_19') { stats.actpf_404++; return new Response('no se baja (modo como_19)', { status: 404 }); }
    if (sat === 'goes16') u = u.replace('noaa-goes19', 'noaa-goes16');
    if (u.includes('list-type=2')) {
      if (listados.has(u)) { stats.de_cache++; return new Response(listados.get(u), { status: 200 }); }
      const e = await aS3(u, o);
      if (e.status === 200) listados.set(u, Buffer.from(e.bytes).toString('utf8'));
      return respuesta(e);
    }
    const c = cache.get(u);
    if (c) { c.usado = instante; stats.de_cache++; return respuesta(c); }
    const e = await aS3(u, o);
    if (e.status === 200) cache.set(u, { ...e, usado: instante });
    return respuesta(e);
  }

  return {
    fetch: fetchRed,
    ponerSat(s) { if (s !== 'goes16' && s !== 'goes19') throw new Error('satélite inválido'); sat = s; },
    ponerModo(m) { if (m !== 'como_19' && m !== 'con_fase') throw new Error('modo inválido'); modo = m; },
    /** pasa al instante siguiente: se va lo que no se usó en los 2 anteriores */
    nuevoInstante() { instante++; for (const [u, c] of cache) if (c.usado < instante - 2) cache.delete(u); },
    enCache() { let b = 0; for (const c of cache.values()) b += c.bytes.length; return { archivos: cache.size, bytes: b }; },
    stats
  };
}
