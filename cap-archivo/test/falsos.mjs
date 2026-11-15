// Falsos para los tests del archivo CAP (225): el SMN (con el índice real del 14/11 14:26) y el almacén de releases.
// Sin red: ningún test le pide nada al SMN ni a GitHub.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const INDICE_1426 = zlib.gunzipSync(fs.readFileSync(path.join(AQUI, 'fixtures', 'cap_indice_1426.xml.gz'))).toString('utf8');

/** Un CAP mínimo para una URL (los XML de cada aviso del 14/11 no se guardaron: justamente por eso existe la 225). */
export const capDe = (url, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">` +
  `<identifier>${url.split('/').pop()}</identifier><sent>2026-11-14T15:41:19-03:00</sent><msgType>Alert</msgType>${extra}</alert>\n`;

/** Un índice RSS con estos links (uno por ítem), con la forma del real. */
export function indiceCon(links) {
  const items = links.map((l) => `<item>\n<title>T</title>\n<link>${l}</link>\n<description>d</description>\n<guid>${l}</guid>\n<pubDate></pubDate>\n</item>\n`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n<title>SMN</title>\n<link>https://ssl.smn.gob.ar/CAP/AR.php</link>\n${items}</channel>\n</rss>\n`;
}

/**
 * El SMN falso. `rutas`: url → { status, cuerpo, headers } o una función (url, n) → eso. Sin ruta, un XML de la carpeta
 * de avisos contesta un CAP mínimo y el índice contesta `indice`. Anota cada pedido (url, User-Agent).
 * Un 3xx con `Location` se SIGUE (como fetch por defecto: otro pedido, anotado) salvo que el pedido traiga
 * redirect: 'manual'. `cuerpo` puede ser un Buffer (para probar bytes exactos).
 */
export function smnFalso({ indice = INDICE_1426, rutas = {} } = {}) {
  const pedidos = [];
  const fetchFn = async (url, opts = {}) => {
    pedidos.push({ url, ua: opts.headers && opts.headers['User-Agent'] });
    const n = pedidos.filter((p) => p.url === url).length;
    let r = rutas[url];
    if (typeof r === 'function') r = r(url, n);
    if (r && r.lanzar) throw Object.assign(new Error('fetch failed'), { cause: { code: r.lanzar } });
    if (!r) r = url === 'https://ssl.smn.gob.ar/CAP/AR.php' ? { status: 200, cuerpo: indice } : /\/feeds\/CAP\/[\w-]+\/[\w.-]+\.xml$/.test(url) ? { status: 200, cuerpo: capDe(url) } : { status: 404, cuerpo: 'no' };
    const buf = Buffer.isBuffer(r.cuerpo) ? r.cuerpo : Buffer.from(r.cuerpo || '', 'utf8');
    const h = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (r.status >= 300 && r.status < 400 && h.get('location') && opts.redirect !== 'manual') return fetchFn(new URL(h.get('location'), url).href, opts);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, arrayBuffer: async () => buf };
  };
  return { fetchFn, pedidos };
}

/** El almacén de releases falso, con la interfaz de lib/releases.mjs (release/assets/subir/reemplazar/leerVarios/bajar). */
export function almacenFalso({ fallarSubida = false, previos = {} } = {}) {
  const rels = new Map();   // tag → { id, tag, archivos: Map(nombre → Buffer), notas }
  let id = 1;
  const llamadas = [];
  const cliente = {
    async release(tag, { crear = false, notas = '' } = {}) {
      llamadas.push('release ' + tag + (crear ? ' (crear)' : ''));
      if (!rels.has(tag) && crear) rels.set(tag, { id: id++, tag, archivos: new Map(Object.entries(previos[tag] || {})), notas });
      return rels.get(tag) || null;
    },
    async assets(rel) { return rel ? [...rel.archivos.keys()].map((name) => ({ id: rel.tag + '/' + name, name, state: 'uploaded' })) : []; },
    async bajar(a) { const [tag, ...n] = a.id.split('/'); return rels.get(tag).archivos.get(n.join('/')); },
    async subir(rel, nombre, cuerpo) {
      llamadas.push('subir ' + nombre);
      if (fallarSubida) throw new Error('GitHub POST: HTTP 502');
      if (rel.archivos.has(nombre)) return { yaEstaba: true };
      rel.archivos.set(nombre, Buffer.from(cuerpo));
      return { yaEstaba: false };
    },
    async reemplazar(rel, { nombre, cuerpo, viejos = [] }) {
      llamadas.push('reemplazar ' + nombre);
      const r = await cliente.subir(rel, nombre, cuerpo);
      if (r.yaEstaba) throw new Error('ya hay un asset con ese nombre');
      for (const v of viejos) if (v.name !== nombre) rel.archivos.delete(v.name);
      return r;
    },
    async leerVarios(rel, filtro) {
      if (!rel) return [];
      return [...rel.archivos.entries()].filter(([n]) => filtro(n)).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, buf]) => ({ asset: { id: rel.tag + '/' + name, name }, buf }));
    },
  };
  return { cliente, rels, llamadas };
}

/** Una base falsa: anota lo que se registra. */
export function baseFalsa({ fallar = false } = {}) {
  const filas = [];
  return { filas, async registrar(proceso, ok, resumen) { if (fallar) throw new Error('registro_procesos: 42501 (sin permiso)'); filas.push({ proceso, ok, resumen: JSON.parse(JSON.stringify(resumen)) }); }, async cerrar() {} };
}
