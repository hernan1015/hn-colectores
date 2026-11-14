// HN AGRO · archivo de granizo (147) · EL ÍNDICE DEL DÍA: una línea por PEDIDO (también los repetidos, que no suben
// el cuerpo otra vez). Sirve para leer el día sin bajar 150 archivos y para que el vigía distinga «el colector no corre»
// de «SATCHI repite el mismo scan».
// Va como asset `indice__<sello UTC>.json` y se reemplaza con lib/releases.mjs: el NUEVO se sube antes de borrar el
// viejo. Si quedaran dos (un borrado cortado), al leer se UNEN por la hora del pedido: no se pierde ninguna línea.
export const RE_INDICE = /^indice__\d{8}T\d{6}\.json$/;
export const FORMATO_INDICE = 'hn-granizo-indice/1';

export function unirIndices(textos, tag) {
  const porPedido = new Map();
  for (const t of textos) {
    let j = null;
    try { j = JSON.parse(Buffer.isBuffer(t) ? t.toString('utf8') : t); } catch { j = null; }
    for (const e of (j && Array.isArray(j.pedidos) ? j.pedidos : [])) if (e && typeof e.pedido_utc === 'string') porPedido.set(e.pedido_utc, e);
  }
  return { formato: FORMATO_INDICE, tag, pedidos: [...porPedido.values()].sort((a, b) => (a.pedido_utc < b.pedido_utc ? -1 : 1)) };
}

export function entrada(s, asset, nuevo) {
  return { pedido_utc: s.pedido_utc, pedido_art: s.pedido_art, http: s.http, estado: s.estado, motivo: s.motivo,
    scan_t: s.scan_t, scan_art: s.scan_art, asset, nuevo: !!nuevo, run_id: (s.colector && s.colector.run_id) || null };
}

export function agregar(ind, e) {
  const resto = ind.pedidos.filter((x) => x.pedido_utc !== e.pedido_utc);
  ind.pedidos = [...resto, e].sort((a, b) => (a.pedido_utc < b.pedido_utc ? -1 : 1));
  return ind;
}
