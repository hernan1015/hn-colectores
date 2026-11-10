// HN AGRO · vigía de SATCHI · DE DÓNDE LEE: sólo de satchi-publico (la misma página pública de SATCHI, con su caché
// de la red de Netlify). No usa claves: ni FIRMS ni INA directo (eso lo hace SATCHI una vez por ciclo de su caché).
// Cuenta las invocaciones REALES de la function: una respuesta servida por la caché («Netlify Durable»; hit, o
// «Netlify Edge»; hit) no invoca; un fwd=miss, fwd=stale o fwd=bypass del Durable sí.
export const BASE = 'https://app.hnagroapp.com/.netlify/functions/satchi-publico';
export const PEDIDO_MS = 30000;

/** ¿esta respuesta invocó la function? (por las cabeceras Cache-Status de Netlify) */
export function invoco(cacheStatus) {
  const s = String(cacheStatus || '');
  if (!s) return null;                                 // sin cabecera: no se sabe
  if (/"Netlify Edge";\s*hit/i.test(s)) return false;
  if (/"Netlify Durable";\s*hit/i.test(s)) return false;
  return true;                                         // miss, stale (revalida), bypass, vary-miss
}

export function crearLector({ fetchFn = globalThis.fetch, base = BASE } = {}) {
  const cuenta = { pedidos: 0, invocaciones: 0, sin_saber: 0, bytes: 0, detalle: [] };
  async function leer(que, extra = {}) {
    const q = new URLSearchParams({ que, ...extra }).toString();
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), PEDIDO_MS);
    try {
      const r = await fetchFn(base + '?' + q, { signal: ctrl.signal, headers: { 'User-Agent': 'HN-AGRO-vigia-satchi', Accept: 'application/json' } });
      const txt = await r.text();
      cuenta.pedidos++; cuenta.bytes += txt.length;
      const cs = r.headers && r.headers.get ? r.headers.get('cache-status') : null;
      const inv = invoco(cs);
      if (inv === true) cuenta.invocaciones++; else if (inv == null) cuenta.sin_saber++;
      cuenta.detalle.push({ que: q, status: r.status, invoco: inv });
      if (!r.ok) return { ok: false, motivo: 'HTTP ' + r.status };
      return JSON.parse(txt);
    } catch (e) {
      cuenta.detalle.push({ que: q, error: String(e && e.name === 'AbortError' ? 'tiempo' : 'error') });
      return { ok: false, motivo: e && e.name === 'AbortError' ? 'tiempo' : 'error' };
    } finally { clearTimeout(t); }
  }
  return { leer, cuenta };
}
