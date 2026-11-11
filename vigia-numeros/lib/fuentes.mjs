// HN AGRO · VIGÍA DE NÚMEROS · DE DÓNDE LEE. Sólo páginas y endpoints PÚBLICOS, sin claves ni sesión:
//   · la app:   precios-granos (el mismo endpoint público que usa la pantalla de precios; responde sin sesión)
//   · BNA:      la página pública de cotizaciones del Banco Nación (tabla «Cotización Divisas»)
//   · MAGyP:    precios FOB oficiales del día (la misma fuente que declara la app), por fecha
//   · BCR:      la pizarra de la Cámara Arbitral de Cereales de Rosario (página pública)
// Un pedido por fuente y por corrida. Si una fuente no contesta, devuelve { ok:false } y esa comparación no se hace.
export const URLS = {
  app: 'https://app.hnagroapp.com/.netlify/functions/precios-granos',
  bna: 'https://www.bna.com.ar/Personas',
  magyp: [
    'https://monitorsiogranos.magyp.gob.ar/ws/ssma/precios_fob.php',
    'https://www.magyp.gob.ar/sitio/areas/ss_mercados_agropecuarios/ws/ssma/precios_fob.php',
  ],
  bcr: 'https://www.cac.bcr.com.ar/es/precios-de-pizarra',
};
export const PEDIDO_MS = 30000;
const UA = 'HN-AGRO-vigia-numeros';

/* número argentino («313.300,00», «1545.5000», «1520,00») → Number */
export function numeroAR(s) {
  const t = String(s || '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'));      // 313.300,00 · 1520,00
  return Number(t);                                                                // 1545.5000
}
/* «5/11/2026» o «06/11/2026» → 'AAAA-MM-DD' */
export function fechaAR(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/* BNA: la tabla de DIVISAS (no la de billetes): fecha, compra y venta del dólar */
export function parsearBNA(html) {
  const i = String(html || '').indexOf('id="divisas"');
  if (i < 0) return { ok: false, motivo: 'sin tabla de divisas' };
  const bloque = html.slice(i, i + 4000);
  const fecha = fechaAR((/class="fechaCot">([^<]+)</.exec(bloque) || [])[1]);
  const fila = /Dolar U\.S\.A<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>/.exec(bloque);
  if (!fecha || !fila) return { ok: false, motivo: 'no se encontró el dólar en divisas' };
  const compra = numeroAR(fila[1]), venta = numeroAR(fila[2]);
  if (!(compra > 0 && venta > 0)) return { ok: false, motivo: 'dólar ilegible' };
  return { ok: true, fecha, compra, venta };
}

/* BCR: «Precios Pizarra del día dd/mm/aaaa» y el precio de cada tablero. «S/C» = sin cotización (el estimado (E) NO se usa) */
export function parsearBCR(html) {
  const s = String(html || '');
  const fecha = fechaAR((/Precios Pizarra del d[ií]a\s*([0-9/]+)/i.exec(s) || [])[1]);
  if (!fecha) return { ok: false, motivo: 'sin fecha de pizarra' };
  const precios = {};
  for (const [cultivo, clase] of [['trigo', 'board-trigo'], ['soja', 'board-soja'], ['maiz', 'board-maiz'], ['girasol', 'board-girasol']]) {
    const i = s.indexOf('board ' + clase); if (i < 0) continue;
    const m = /<div class="price">([\s\S]*?)<\/div>/.exec(s.slice(i, i + 1500)); if (!m) continue;
    const txt = m[1];
    precios[cultivo] = /S\/C/.test(txt) ? { sin_cotizacion: true } : { ars: numeroAR(txt.replace(/<[^>]+>/g, '')) };
  }
  return { ok: true, fecha, precios };
}

/* MAGyP FOB: los precios del día para un prefijo NCM */
export function preciosFOB(json, prefijo) {
  const posts = json && Array.isArray(json.posts) ? json.posts : [];
  return posts.filter((p) => String(p.posicion || '').startsWith(prefijo) && typeof p.precio === 'number').map((p) => p.precio);
}

export function crearLector({ fetchFn = globalThis.fetch, urls = URLS } = {}) {
  const cuenta = { pedidos: 0, bytes: 0, errores: 0 };
  async function pedir(url, comoJson) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), PEDIDO_MS);
    try {
      const r = await fetchFn(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: comoJson ? 'application/json' : 'text/html' } });
      const txt = await r.text(); cuenta.pedidos++; cuenta.bytes += txt.length;
      if (!r.ok) { cuenta.errores++; return { ok: false, motivo: 'HTTP ' + r.status }; }
      return { ok: true, txt };
    } catch (e) { cuenta.errores++; return { ok: false, motivo: e && e.name === 'AbortError' ? 'tiempo' : 'error' }; }
    finally { clearTimeout(t); }
  }
  return {
    cuenta,
    async app() { const r = await pedir(urls.app, true); if (!r.ok) return r; try { const j = JSON.parse(r.txt); return j && j.ok ? { ok: true, ...j } : { ok: false, motivo: 'la app contestó ok:false' }; } catch { return { ok: false, motivo: 'JSON ilegible' }; } },
    async bna() { const r = await pedir(urls.bna, false); return r.ok ? parsearBNA(r.txt) : r; },
    async bcr() { const r = await pedir(urls.bcr, false); return r.ok ? parsearBCR(r.txt) : r; },
    /* fecha 'dd/mm/aaaa' (la de la app): primaria y, si no, la alternativa */
    async magyp(fechaDMY) {
      for (const base of urls.magyp) {
        const r = await pedir(base + '?Fecha=' + encodeURIComponent(fechaDMY), true);
        if (!r.ok) continue;
        try { const j = JSON.parse(r.txt); if (j && Array.isArray(j.posts) && j.posts.length) return { ok: true, posts: j.posts }; } catch { /* la otra */ }
      }
      return { ok: false, motivo: 'MAGyP no contestó' };
    },
  };
}
