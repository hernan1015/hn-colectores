// HN AGRO · RELEASES DE GITHUB COMO ALMACÉN (común a los colectores). API REST con fetch: sin dependencias y probable con
// un fetch falso en los tests.
// ORIGEN: sipan-alto-valle/lib/releases.mjs (feat/sipan-alto-valle @ 8aa7b5d; ya en main desde 9ccb4da). Se sacó acá
// GENERALIZADO (el commit anterior lo trae tal cual, así el diff muestra qué cambió). Lo que se conserva de SIPAN:
//   · un release por día y los archivos como assets (el mismo patrón que colectar.sh del radar);
//   · para REEMPLAZAR sin perder nada: primero se SUBE el nuevo con otro nombre y RECIÉN DESPUÉS se borran los viejos.
//     Si la subida falla, los viejos quedan. Si el borrado falla, quedan los dos: al leer se UNEN (leerVarios).
// Lo que se agrega (lo necesita el archivo de granizo, ~150 assets por día):
//   · el listado de assets PAGINADO (de a 100) y sólo los `uploaded` (una subida cortada deja un asset «starter»
//     que ocupa el nombre: `subir` lo borra y vuelve a probar);
//   · `subir` idempotente: si el nombre ya existe (422 con code already_exists) devuelve { yaEstaba: true }; CUALQUIER
//     otro 422 es error (la corrida sale en rojo y el asset se reintenta en la próxima: nada se da por guardado en verde);
//   · `repoVisible`: GitHub contesta 404 también a un repo privado SIN permiso; esto lo distingue de «no hay release»;
//   · `release` tolera que otra corrida lo haya creado entre el GET y el POST (422 → se vuelve a leer);
//   · el release nuevo NO se marca «Latest» (make_latest: false): no le cambia la portada al repo.
// CUANDO ENTRE SIPAN: su almacenReleases puede apoyarse en clienteReleases (release/assets/reemplazar/leerVarios) y borrar
// su copia. El token (secrets.*) nunca se imprime: los errores dicen método y estado HTTP, nada más.
export const API = 'https://api.github.com';
export const UPLOADS = 'https://uploads.github.com';

/** Sello UTC para nombres: AAAAMMDDTHHMMSS. */
export const selloUTC = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').slice(0, 15);

/** ¿el cuerpo de un 422 dice que el asset ya existe? (errors[].code === 'already_exists') */
export function yaExiste(texto) {
  try { const j = JSON.parse(texto); return Array.isArray(j && j.errors) && j.errors.some((e) => e && e.code === 'already_exists'); } catch { return false; }
}

export function clienteReleases({ token, repo, fetchFn = globalThis.fetch, userAgent = 'hn-colectores', tiempoMs = 60000 } = {}) {
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('faltan el token o el repo (dueño/repo) del almacén de releases');
  const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent };
  const cache = new Map();   // tag → release (o null)

  /** null si 404; lanza si no es 2xx (salvo los estados de `aceptar`, que vuelven como { _estado }). */
  async function pedir(metodo, url, { cuerpo, headers = {}, binario = false, aceptar = [] } = {}) {
    const r = await fetchFn(url, { method: metodo, headers: { ...H, ...headers }, body: cuerpo, signal: AbortSignal.timeout(tiempoMs) });
    if (r.status === 404) return null;
    if (aceptar.includes(r.status)) return { _estado: r.status, _cuerpo: await r.text().catch(() => '') };
    if (!r.ok) throw new Error(`GitHub ${metodo}: HTTP ${r.status}`);
    if (binario) return Buffer.from(await r.arrayBuffer());
    const t = await r.text();
    return t ? JSON.parse(t) : {};
  }

  async function release(tag, { crear = false, nombre = tag, notas = '' } = {}) {
    if (cache.has(tag) && (cache.get(tag) || !crear)) return cache.get(tag);
    let rel = await pedir('GET', `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (!rel && crear) {
      const c = await pedir('POST', `${API}/repos/${repo}/releases`, { headers: { 'Content-Type': 'application/json' }, aceptar: [422],
        cuerpo: JSON.stringify({ tag_name: tag, name: nombre, body: notas, draft: false, prerelease: false, make_latest: 'false' }) });
      rel = c && c._estado === 422 ? await pedir('GET', `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`) : c;
      if (!rel || rel._estado) throw new Error('GitHub: no se pudo crear el release');
    }
    if (rel) rel._assets = null;   // el listado se pide aparte, paginado (ver assets)
    cache.set(tag, rel || null);
    return rel || null;
  }

  /** Todos los assets del release (paginado). `todos: true` incluye los que no terminaron de subir (state ≠ uploaded). */
  async function assets(rel, { todos = false } = {}) {
    if (!rel) return [];
    if (!rel._assets) {
      const out = [];
      for (let pag = 1; pag <= 20; pag++) {
        const l = await pedir('GET', `${API}/repos/${repo}/releases/${rel.id}/assets?per_page=100&page=${pag}`);
        if (!Array.isArray(l) || !l.length) break;
        out.push(...l.map((a) => ({ id: a.id, name: a.name, state: a.state || 'uploaded', size: a.size, created_at: a.created_at })));
        if (l.length < 100) break;
      }
      rel._assets = out;
    }
    return todos ? rel._assets.slice() : rel._assets.filter((a) => a.state === 'uploaded');
  }

  /** ¿el token ve el repo? (false con 404: no existe o no hay permiso). */
  async function repoVisible() {
    return !!(await pedir('GET', `${API}/repos/${repo}`));
  }

  async function bajar(asset) {
    return pedir('GET', `${API}/repos/${repo}/releases/assets/${asset.id}`, { headers: { Accept: 'application/octet-stream' }, binario: true });
  }

  async function borrar(rel, asset) {
    await pedir('DELETE', `${API}/repos/${repo}/releases/assets/${asset.id}`);
    if (rel && rel._assets) rel._assets = rel._assets.filter((a) => a.id !== asset.id);
  }

  /** Sube un asset. Si ya hay uno `uploaded` con ese nombre → { yaEstaba: true } (no lo pisa). Si hay uno a medio subir
   *  (starter) lo borra primero. Si GitHub dice 422 (otra corrida lo subió recién) → { yaEstaba: true }. */
  async function subir(rel, nombre, cuerpo, tipo = 'application/octet-stream') {
    const hay = (await assets(rel, { todos: true })).filter((a) => a.name === nombre);
    if (hay.some((a) => a.state === 'uploaded')) return { yaEstaba: true };
    for (const a of hay) await borrar(rel, a);
    const s = await pedir('POST', `${UPLOADS}/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(nombre)}`,
      { headers: { 'Content-Type': tipo }, cuerpo: Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo), aceptar: [422] });
    if (!s) throw new Error('GitHub: no se pudo subir el asset');
    if (s._estado === 422) {
      if (yaExiste(s._cuerpo)) return { yaEstaba: true };
      throw new Error('GitHub POST: HTTP 422 (no es already_exists): el asset no se subió');
    }
    const a = { id: s.id, name: nombre, state: 'uploaded', size: s.size, created_at: s.created_at || new Date().toISOString() };
    if (rel._assets) rel._assets.push(a);
    return { asset: a, yaEstaba: false };
  }

  /** EL NUEVO ANTES QUE EL VIEJO: sube `nombre` (tiene que ser un nombre NUEVO, con sello) y recién si salió borra
   *  `viejos` (los que el llamador leyó). Si el nombre ya existía no se subió nada: no se borra nada y se avisa. */
  async function reemplazar(rel, { nombre, cuerpo, tipo, viejos = [] }) {
    const r = await subir(rel, nombre, cuerpo, tipo);
    if (r.yaEstaba) throw new Error('GitHub: ya hay un asset con ese nombre; el reemplazo necesita un nombre nuevo (no se borró nada)');
    let borrados = 0;
    for (const v of viejos) if (v.name !== nombre) { await borrar(rel, v); borrados++; }
    return { ...r, borrados };
  }

  /** Baja todos los assets que cumplen `filtro` (ordenados por nombre): para UNIR los repetidos que dejó un reemplazo cortado. */
  async function leerVarios(rel, filtro) {
    const out = [];
    for (const a of (await assets(rel)).filter((x) => filtro(x.name)).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const buf = await bajar(a);
      if (buf) out.push({ asset: a, buf });
    }
    return out;
  }

  return { release, assets, bajar, borrar, subir, reemplazar, leerVarios, repoVisible };
}
