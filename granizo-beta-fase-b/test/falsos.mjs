// S3 FALSO de NOAA (ACHAF, ACTPF y GLM) para los tests: sin red. Cuenta pedidos y simultaneidad, y puede fallar a propósito.
// Los «HDF5» son bytes de relleno (ACHAF/ACTPF) o JSON (GLM): sólo los lee la lib FALSA de test/lib-falsa/.
import { prefijoHora, diaJul } from '../lib/plan.mjs';

const pad = (n, w = 2) => String(n).padStart(w, '0');
export const sello = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + pad(diaJul(d), 3) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + '0'; };
export const ZONA_A = { lat: -32.9, lon: -60.7 };      // la celda de 2 patas (cerca de Rosario Aero en el caso falso)

/**
 * @param o.flashesPorVentana (tMs) → [[lat, lon]] los flashes de la ventana [t−10, t) (se reparten en 10 archivos de 1 min)
 * @param o.falla (url, n) → status | null : para inyectar 503/429
 */
export function s3Falso(o = {}) {
  const log = [], porUrl = new Map();
  let activos = 0, max = 0;
  const flv = o.flashesPorVentana || (() => []);
  function listado(bucket, prefijo) {
    const m = /^(ABI-L2-ACHAF|ABI-L2-ACTPF|GLM-L2-LCFA)\/(\d{4})\/(\d{3})\/(\d{2})\//.exec(prefijo);
    if (!m) return '<ListBucketResult></ListBucketResult>';
    const h0 = Date.UTC(+m[2], 0, 1, +m[4]) + (+m[3] - 1) * 864e5;
    const items = [];
    if (m[1] === 'GLM-L2-LCFA') {
      for (let mi = 0; mi < 60; mi++) { const t = h0 + mi * 60000; items.push(`GLM-L2-LCFA/${m[2]}/${m[3]}/${m[4]}/OR_GLM-L2-LCFA_G19_s${sello(t)}_e${sello(t + 60000)}_c${sello(t + 80000)}.nc`); }
    } else {
      const p = m[1] === 'ABI-L2-ACHAF' ? 'ACHAF' : 'ACTPF';
      for (let mi = 0; mi < 60; mi += 10) { const t = h0 + mi * 60000 + 20000; items.push(`${m[1]}/${m[2]}/${m[3]}/${m[4]}/OR_ABI-L2-${p}-M6_G19_s${sello(t)}_e${sello(t + 560000)}_c${sello(t + 720000)}.nc`); }
    }
    return '<ListBucketResult>' + items.map((k) => `<Contents><Key>${k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>${k.includes('GLM') ? 0 : 1500}</Size></Contents>`).join('') + '</ListBucketResult>';
  }
  function objeto(clave) {
    if (clave.includes('GLM-L2-LCFA')) {
      const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/.exec(clave);
      const t = Date.UTC(+m[1], 0, 1, +m[3], +m[4], +m[5]) + (+m[2] - 1) * 864e5;
      const fin = (Math.floor((t - 20000) / 600000) + 1) * 600000 + 20000;   // el scan (:x0:20) cuya ventana [t−10, t) lo contiene
      const todos = flv(fin);
      const i = Math.floor((t - (fin - 600000)) / 60000);
      return new TextEncoder().encode(JSON.stringify({ t0: t, t1: t + 60000, flashes: todos.filter((_, j) => j % 10 === i).map(([lat, lon]) => ({ lat, lon, t: t + 1000 })) }));
    }
    return new Uint8Array(1500).fill(7);
  }
  async function fetchFalso(url, opt) {
    const u = new URL(String(url));
    log.push(String(url));
    const n = (porUrl.get(String(url)) || 0) + 1; porUrl.set(String(url), n);
    activos++; max = Math.max(max, activos);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const f = o.falla && o.falla(String(url), n);
      if (f) return new Response('falla', { status: f, headers: f === 429 ? { 'retry-after': '7' } : {} });
      if (!/^noaa-goes1[69]\.s3\.amazonaws\.com$/.test(u.host)) throw new Error('host inesperado en el S3 falso: ' + u.host);
      if (u.searchParams.get('list-type') === '2') return new Response(listado(u.host, u.searchParams.get('prefix')), { status: 200 });
      const b = objeto(decodeURIComponent(u.pathname.slice(1)));
      return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
    } finally { activos--; }
  }
  return { fetch: fetchFalso, log, porUrl, get max() { return max; }, objetos: () => log.filter((x) => !x.includes('list-type')) };
}
export { prefijoHora };
