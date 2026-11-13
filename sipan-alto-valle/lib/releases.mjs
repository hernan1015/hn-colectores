// HN AGRO · SIPAN Alto Valle · los crudos de 10 min en RELEASES DIARIAS de un repo PRIVADO (hoy: hn-radar).
// Mismo patrón que el colector del radar (colectar.sh): un release por día y los archivos como assets. Acá, en vez de
// `gh`, la API REST de GitHub con fetch (sin dependencias y probable con un fetch falso en los tests).
//   · tag `sipan-AAAA-MM-DD` (el radar usa `dia-AAAA-MM-DD`: no se pisan), un release por día LOCAL (UTC−3);
//   · un asset por estación: `<id>__<sello>.json.gz` (el día ENTERO de esa estación, ya unido y sin duplicados).
//   · Para reemplazar sin perder nada: primero se SUBE el nuevo con otro sello y recién después se borran los viejos
//     de esa estación. Si la subida falla, los viejos quedan. Al leer, si hubiera más de uno, se unen todos.
// Variables (secrets.* del workflow; nunca se imprimen): SIPAN_CRUDOS_TOKEN (permiso Contents: Read and write SÓLO
// sobre ese repo; hoy el RADAR_TOKEN) y SIPAN_CRUDOS_REPO (dueño/repo).
// Interfaz igual que lib/almacen.mjs: leer(clave) → Buffer|null · escribir(clave, cuerpo). Clave:
//   sipan-alto-valle/<id>/<AAAA>/<AAAA-MM-DD>.json.gz
import zlib from 'node:zlib';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

export function partesDeClave(clave) {
  const m = /^sipan-alto-valle\/([0-9A-Za-z_-]{1,20})\/\d{4}\/(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(clave);
  if (!m) throw new Error('clave de crudo inválida');
  return { id: m[1], dia: m[2], tag: 'sipan-' + m[2] };
}

export function almacenReleases({ token, repo, fetchFn = globalThis.fetch, sello = () => new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) } = {}) {
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('faltan SIPAN_CRUDOS_TOKEN o SIPAN_CRUDOS_REPO');
  const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'colector-agrometeorologico' };
  const cache = new Map();   // tag → release (o null)
  async function pedir(metodo, url, { cuerpo, headers = {}, binario = false } = {}) {
    const r = await fetchFn(url, { method: metodo, headers: { ...H, ...headers }, body: cuerpo, signal: AbortSignal.timeout(60000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${metodo}: HTTP ${r.status}`);
    if (binario) return Buffer.from(await r.arrayBuffer());
    const t = await r.text();
    return t ? JSON.parse(t) : {};
  }
  async function release(tag, crear = false) {
    if (cache.has(tag) && (cache.get(tag) || !crear)) return cache.get(tag);
    let rel = await pedir('GET', `${API}/repos/${repo}/releases/tags/${tag}`);
    if (!rel && crear) {
      rel = await pedir('POST', `${API}/repos/${repo}/releases`, { headers: { 'Content-Type': 'application/json' },
        cuerpo: JSON.stringify({ tag_name: tag, name: `SIPAN Alto Valle · ${tag.slice(6)}`, body: 'Registros de 10 min de la red agrometeorológica del INTA EEA Alto Valle. USO INTERNO HN AGRO: no se publica ni se redistribuye.', draft: false, prerelease: false }) });
      if (!rel) throw new Error('GitHub: no se pudo crear el release');
    }
    if (rel && !Array.isArray(rel.assets)) rel.assets = [];
    cache.set(tag, rel || null);
    return rel || null;
  }
  const deLa = (rel, id) => (rel ? rel.assets.filter((a) => a.name.startsWith(id + '__') && a.name.endsWith('.json.gz')) : []);
  return {
    tipo: 'releases',
    async leer(clave) {
      const { id, tag } = partesDeClave(clave);
      const rel = await release(tag);
      const as = deLa(rel, id);
      if (!as.length) return null;
      const registros = new Map(); let base = null;
      for (const a of as.sort((x, y) => (x.name < y.name ? -1 : 1))) {
        const b = await pedir('GET', `${API}/repos/${repo}/releases/assets/${a.id}`, { headers: { Accept: 'application/octet-stream' }, binario: true });
        if (!b) continue;
        const j = JSON.parse(zlib.gunzipSync(b).toString('utf8'));
        base = base || j;
        for (const r of j.registros || []) registros.set(r.local, r);    // el más nuevo (último por nombre) gana
      }
      if (!base) return null;
      return zlib.gzipSync(JSON.stringify({ ...base, registros: [...registros.values()].sort((a, b) => (a.local < b.local ? -1 : 1)) }));
    },
    async escribir(clave, cuerpo) {
      const { id, tag } = partesDeClave(clave);
      const rel = await release(tag, true);
      const viejos = deLa(rel, id);
      const nombre = `${id}__${sello()}.json.gz`;
      const subido = await pedir('POST', `${UPLOADS}/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(nombre)}`,
        { headers: { 'Content-Type': 'application/gzip' }, cuerpo: Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo) });
      if (!subido) throw new Error('GitHub: no se pudo subir el crudo');
      for (const v of viejos) if (v.name !== nombre) await pedir('DELETE', `${API}/repos/${repo}/releases/assets/${v.id}`);
      rel.assets = [...rel.assets.filter((a) => !viejos.includes(a)), { id: subido.id, name: nombre }];
      return true;
    },
  };
}
