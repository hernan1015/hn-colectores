// R2 y NOAA falsos, sin red.
//  - R2: VERIFICA la firma SigV4 de cada pedido como R2 (la recalcula con su propio secreto) y el hash del cuerpo.
//    GET/PUT/DELETE de objetos, ListObjectsV2 con páginas, PUT con if-none-match y CopyObject (x-amz-copy-source).
//  - NOAA: el bucket público (sin firma), con el nombre real de los archivos FDCF.
import crypto from 'node:crypto';
import { firmar } from '../../rayos-hora/lib/almacen.mjs';

const resp = (status, cuerpo = '', headers = {}) => new Response(status === 204 ? null : cuerpo, { status, headers });
const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const deAmz = (s) => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null; };

export function r2Falso({ cuenta = 'cuentafalsa', clave = 'CLAVEFALSA', secreto = 'secreto-falso', deposito = 'satchi-mapas', objetos = {}, porPagina = 1000, copiaNoSoportada = false, fallar = {} } = {}) {
  // fallar: { clave: 'put500' | 'get500' | 'del500' | 'copia500' }
  const host = `${cuenta}.r2.cloudflarestorage.com`;
  const obj = new Map(Object.entries(objetos).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
  const st = { pedidos: 0, rechazos: 0, borrados: [], copias: 0, puts: 0, listados: 0 };

  async function fetchFn(url, init = {}) {
    st.pedidos++;
    const u = new URL(url);
    if (u.host !== host) return resp(400, 'host');
    const metodo = init.method || 'GET';
    const ruta = u.pathname.split('/').map(decodeURIComponent).join('/');
    const partes = ruta.split('/').slice(1);
    if (partes[0] !== deposito) return resp(404, 'NoSuchBucket');
    const k = partes.slice(1).join('/');
    const q = Object.fromEntries(u.searchParams.entries());
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([a, b]) => [a.toLowerCase(), String(b)]));
    const cuerpo = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
    // firma
    const fecha = deAmz(h['x-amz-date']);
    if (!fecha) { st.rechazos++; return resp(403, 'AccessDenied'); }
    if (h['x-amz-content-sha256'] !== crypto.createHash('sha256').update(cuerpo).digest('hex')) { st.rechazos++; return resp(400, 'XAmzContentSHA256Mismatch'); }
    const { authorization, 'x-amz-date': _d, 'x-amz-content-sha256': _c, ...resto } = h;
    const esperada = firmar({ metodo, host, ruta, query: q, headers: resto, cuerpo, clave, secreto, fecha });
    if (esperada.authorization !== authorization) { st.rechazos++; return resp(403, 'SignatureDoesNotMatch'); }

    if (!k) {
      if (metodo !== 'GET' || q['list-type'] !== '2') return resp(400, 'sólo ListObjectsV2');
      st.listados++;
      const prefijo = q.prefix || '';
      const todas = [...obj.keys()].filter((x) => x.startsWith(prefijo)).sort();
      const desde = q['continuation-token'] ? Number(q['continuation-token']) : 0;
      const pag = todas.slice(desde, desde + porPagina);
      const truncado = desde + porPagina < todas.length;
      return resp(200, '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>' + deposito + '</Name>'
        + pag.map((x) => `<Contents><Key>${xmlEsc(x)}</Key><Size>${obj.get(x).length}</Size></Contents>`).join('')
        + `<IsTruncated>${truncado}</IsTruncated>` + (truncado ? `<NextContinuationToken>${desde + porPagina}</NextContinuationToken>` : '') + '</ListBucketResult>');
    }
    if (metodo === 'GET') {
      if (fallar[k] === 'get500') return resp(500, 'InternalError');
      const b = obj.get(k);
      return b ? resp(200, b, { 'content-length': String(b.length) }) : resp(404, 'NoSuchKey');
    }
    if (metodo === 'DELETE') {
      if (fallar[k] === 'del500') return resp(500, 'InternalError');
      obj.delete(k); st.borrados.push(k); return resp(204);
    }
    if (metodo === 'PUT') {
      if (h['x-amz-copy-source']) {
        if (copiaNoSoportada) return resp(501, '<Error><Code>NotImplemented</Code></Error>');
        if (fallar[k] === 'copia500') return resp(500, 'InternalError');
        const src = h['x-amz-copy-source'].split('/').map(decodeURIComponent).join('/').replace(/^\//, '');
        if (!src.startsWith(deposito + '/')) return resp(400, 'InvalidArgument');
        const b = obj.get(src.slice(deposito.length + 1));
        if (!b) return resp(404, '<Error><Code>NoSuchKey</Code></Error>');
        obj.set(k, Buffer.from(b)); st.copias++;
        return resp(200, '<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>');
      }
      if (fallar[k] === 'put500') return resp(500, 'InternalError');
      if (h['if-none-match'] === '*' && obj.has(k)) return resp(412, 'PreconditionFailed');
      obj.set(k, cuerpo); st.puts++;
      return resp(200, '');
    }
    return resp(405, 'MethodNotAllowed');
  }
  return { fetchFn, cuenta, clave, secreto, deposito, objetos: obj, stats: st };
}

// ---------- NOAA ----------
const dd = (n, k = 2) => String(n).padStart(k, '0');
const jul = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
export function nombreFdcf(turnoMs) {
  const s = new Date(turnoMs + 20500), e = new Date(turnoMs + 9 * 60e3 + 52300), c = new Date(turnoMs + 9 * 60e3 + 59900);
  const f = (d) => `${d.getUTCFullYear()}${dd(jul(d), 3)}${dd(d.getUTCHours())}${dd(d.getUTCMinutes())}${dd(d.getUTCSeconds())}${Math.floor(d.getUTCMilliseconds() / 100)}`;
  return `OR_ABI-L2-FDCF-M6_G19_s${f(s)}_e${f(e)}_c${f(c)}.nc`;
}
export const HDF5 = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
export function cuerpoFdcf(turnoMs, bytes = 1900) {
  const b = Buffer.alloc(bytes);
  HDF5.copy(b, 0);
  for (let i = 8; i < bytes; i++) b[i] = (turnoMs / 60e3 + i * 31) & 0xff;
  return b;
}
/** turnos: [ms] publicados. fallar: { ms: 'http500' | 'corto' | 'no_hdf5' | 'red' }. listarFalla: [msHora] */
export function noaaFalso({ turnos = [], fallar = {}, listarFalla = [] } = {}) {
  const arch = new Map();
  for (const t of turnos) {
    const d = new Date(t);
    const ruta = `ABI-L2-FDCF/${d.getUTCFullYear()}/${dd(jul(d), 3)}/${dd(d.getUTCHours())}/${nombreFdcf(t)}`;
    arch.set(ruta, { t, cuerpo: cuerpoFdcf(t) });
  }
  const st = { listados: 0, bajadas: 0, maxSimultaneas: 0, ahora: 0 };
  async function fetchFn(url) {
    const u = new URL(url);
    if (u.host !== 'noaa-goes19.s3.amazonaws.com') return resp(400, 'host');
    if (u.pathname === '/' && u.searchParams.get('list-type') === '2') {
      st.listados++;
      const p = u.searchParams.get('prefix');
      for (const hf of listarFalla) { const d = new Date(hf); if (p === `ABI-L2-FDCF/${d.getUTCFullYear()}/${dd(jul(d), 3)}/${dd(d.getUTCHours())}/`) return resp(503, 'SlowDown'); }
      const ks = [...arch.keys()].filter((k) => k.startsWith(p)).sort();
      return resp(200, '<ListBucketResult>' + ks.map((k) => `<Contents><Key>${k}</Key><Size>${arch.get(k).cuerpo.length}</Size></Contents>`).join('') + '<IsTruncated>false</IsTruncated></ListBucketResult>');
    }
    const a = arch.get(decodeURIComponent(u.pathname.slice(1)));
    if (!a) return resp(404, 'NoSuchKey');
    st.bajadas++; st.ahora++; st.maxSimultaneas = Math.max(st.maxSimultaneas, st.ahora);
    await new Promise((r) => setTimeout(r, 2));
    st.ahora--;
    const modo = fallar[a.t];
    if (modo === 'http500') return resp(500, 'x');
    if (modo === 'red') throw new TypeError('fetch failed');
    if (modo === 'corto') return resp(200, a.cuerpo.subarray(0, a.cuerpo.length - 100));
    if (modo === 'no_hdf5') { const b = Buffer.from(a.cuerpo); b[1] = 0; return resp(200, b, { 'content-length': String(b.length) }); }
    return resp(200, a.cuerpo, { 'content-length': String(a.cuerpo.length) });
  }
  return { fetchFn, stats: st, archivos: arch };
}
