// Falsos para los tests (SIN red): un GitHub de releases en memoria y respuestas de SATCHI sintéticas.
// Nada de datos reales en este repo público: las celdas son inventadas.

/** GitHub falso. `fallar` = { subir: (nombre) => bool, borrar: (nombre) => bool, crear422: bool }. */
export function githubFalso({ ahora = () => Date.now(), fallar = {} } = {}) {
  const rels = new Map();   // tag → { id, tag_name, assets: [{ id, name, state, created_at, data }] }
  const llamadas = [];
  let sig = 100;
  const resp = (status, cuerpo, binario) => ({ status, ok: status >= 200 && status < 300,
    text: async () => (cuerpo == null ? '' : typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    arrayBuffer: async () => { const b = Buffer.from(binario || ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  const porId = (id) => { for (const r of rels.values()) { const a = r.assets.find((x) => x.id === id); if (a) return { r, a }; } return null; };
  const vista = (a) => ({ id: a.id, name: a.name, state: a.state, size: a.data.length, created_at: a.created_at });
  async function fetchFn(url, { method = 'GET', headers = {}, body } = {}) {
    const u = new URL(url);
    const p = u.pathname;
    llamadas.push({ metodo: method, ruta: p + u.search, nombre: u.searchParams.get('name'), auth: headers.Authorization });
    let m;
    if (method === 'GET' && (m = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(p))) {
      const r = rels.get(decodeURIComponent(m[1]));
      return r ? resp(200, { id: r.id, tag_name: r.tag_name }) : resp(404, { message: 'Not Found' });
    }
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/releases$/.test(p)) {
      const j = JSON.parse(body);
      if (fallar.crear422) { fallar.crear422 = false; rels.set(j.tag_name, { id: sig++, tag_name: j.tag_name, assets: [], pedido: null }); return resp(422, { message: 'already_exists' }); }
      if (rels.has(j.tag_name)) return resp(422, { message: 'already_exists' });
      const r = { id: sig++, tag_name: j.tag_name, assets: [], pedido: j };
      rels.set(j.tag_name, r);
      return resp(201, { id: r.id, tag_name: r.tag_name });
    }
    if (method === 'GET' && (m = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/.exec(p))) {
      const r = [...rels.values()].find((x) => x.id === +m[1]);
      const pp = +u.searchParams.get('per_page') || 30, pag = +u.searchParams.get('page') || 1;
      return resp(200, r ? r.assets.slice((pag - 1) * pp, pag * pp).map(vista) : []);
    }
    if (method === 'GET' && (m = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(p))) {
      const x = porId(+m[1]);
      return x ? resp(200, null, x.a.data) : resp(404, null);
    }
    if (method === 'DELETE' && (m = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(p))) {
      const x = porId(+m[1]);
      if (!x) return resp(404, null);
      if (fallar.borrar && fallar.borrar(x.a.name)) return resp(500, { message: 'boom' });
      x.r.assets = x.r.assets.filter((a) => a !== x.a);
      return resp(204, null);
    }
    if (method === 'POST' && u.host === 'uploads.github.com' && (m = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/.exec(p))) {
      const r = [...rels.values()].find((x) => x.id === +m[1]);
      const nombre = u.searchParams.get('name');
      if (fallar.subir && fallar.subir(nombre)) return resp(500, { message: 'boom' });
      if (r.assets.some((a) => a.name === nombre)) return resp(422, { errors: [{ code: 'already_exists' }] });
      const a = { id: sig++, name: nombre, state: 'uploaded', created_at: new Date(ahora()).toISOString(), data: Buffer.from(body) };
      r.assets.push(a);
      return resp(201, vista(a));
    }
    return resp(500, { message: 'ruta no prevista en el falso: ' + method + ' ' + p });
  }
  /** carga un asset a mano (para armar estados previos: starter, índices repetidos, muchos assets) */
  function poner(tag, nombre, data, { state = 'uploaded', created_at = new Date(ahora()).toISOString() } = {}) {
    if (!rels.has(tag)) rels.set(tag, { id: sig++, tag_name: tag, assets: [] });
    const a = { id: sig++, name: nombre, state, created_at, data: Buffer.from(data) };
    rels.get(tag).assets.push(a);
    return a;
  }
  return { fetchFn, rels, llamadas, poner, nombres: (tag) => (rels.get(tag) ? rels.get(tag).assets.map((a) => a.name).sort() : []) };
}

/** Una respuesta de granizo-vivo SINTÉTICA (pocas celdas inventadas). */
export function respuestaGranizo({ ok = true, parcial = false, scan_t = '2026-11-13T22:10:20.700Z', faltantes = [], extra = {} } = {}) {
  return { ok, parcial, scan_t, scan_t20: scan_t, edad_min: 12, h0_fuente: 'open-meteo',
    celdas: [{ lat: -33.1, lon: -61.5, I: 81.2, P: 1, T: 1, G: 0.9, L: 0.6, patas: 3, h_km: 16.1, rayos: 40 }],
    sin_dato: [{ lat: -37.7, lon: -65.9, motivo: 'despejado' }], faltantes, fuente: 'sintético', nota: 'sintético', ...extra };
}

/** fetch falso de SATCHI: cuerpo (texto u objeto), estado, o `error` para simular la red caída. */
export function satchiFalso({ status = 200, cuerpo = respuestaGranizo(), error = null, headers = { 'cache-control': 'public, max-age=60', 'x-secreto': 'no-va' } } = {}) {
  const vistos = [];
  const fetchFn = async (url, init = {}) => {
    vistos.push({ url, init });
    if (error) throw error;
    const texto = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k in headers ? headers[k] : null) }, text: async () => texto };
  };
  return { fetchFn, vistos };
}
