// R2 falso, sin red: un fetch que VERIFICA las firmas como R2 (recalcula SigV4 con su propio secreto).
//  - ListObjectsV2 firmado con cabeceras (firmar() de rayos-hora/lib/almacen.mjs), con páginas de `porPagina` claves;
//  - GET por enlace firmado por query (presign.mjs): firma, X-Amz-Expires ≤ 604800 y vencimiento contra `ahora()`;
//    Range bytes=a-b → 206.
import { firmar } from '../../rayos-hora/lib/almacen.mjs';
import { presignGet, deAmzFecha, MAX_EXPIRA } from '../lib/presign.mjs';

export function r2Falso({ cuenta = 'cuentafalsa', clave = 'CLAVEFALSA', secreto = 'secreto-falso', deposito = 'satchi-mapas', objetos = {}, porPagina = 1000, ahora = () => Date.now() } = {}) {
  const host = `${cuenta}.r2.cloudflarestorage.com`;
  const obj = new Map(Object.entries(objetos).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
  const cuenta_ = { listados: 0, gets: 0, rechazos: 0 };
  const resp = (status, cuerpo = '', headers = {}) => new Response(status === 204 ? null : cuerpo, { status, headers });
  const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function fetchFn(url, init = {}) {
    const u = new URL(url);
    if (u.host !== host) return resp(400, 'host');
    const partes = u.pathname.split('/').slice(1).map(decodeURIComponent);
    if (partes[0] !== deposito) return resp(404, 'NoSuchBucket');
    const k = partes.slice(1).join('/');
    const q = Object.fromEntries(u.searchParams.entries());
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([a, b]) => [a.toLowerCase(), b]));

    if (q['X-Amz-Signature']) {
      // GET por enlace firmado
      cuenta_.gets++;
      const fecha = deAmzFecha(q['X-Amz-Date']);
      const exp = Number(q['X-Amz-Expires']);
      if (!fecha || !Number.isInteger(exp) || exp < 1 || exp > MAX_EXPIRA) { cuenta_.rechazos++; return resp(400, 'AuthorizationQueryParametersError'); }
      if (q['X-Amz-Credential'] !== `${clave}/${q['X-Amz-Date'].slice(0, 8)}/auto/s3/aws4_request`) { cuenta_.rechazos++; return resp(403, 'InvalidAccessKeyId'); }
      const esperada = presignGet({ host, ruta: '/' + deposito + '/' + k, clave, secreto, fecha, expira: exp }).firma;
      if (esperada !== q['X-Amz-Signature']) { cuenta_.rechazos++; return resp(403, 'SignatureDoesNotMatch'); }
      if (ahora() > fecha.getTime() + exp * 1000) { cuenta_.rechazos++; return resp(403, 'Request has expired'); }
      if (ahora() < fecha.getTime() - 15 * 60e3) { cuenta_.rechazos++; return resp(403, 'Request is not valid yet'); }
      const b = obj.get(k);
      if (!b) return resp(404, 'NoSuchKey');
      const m = /^bytes=(\d+)-(\d+)$/.exec(headers.range || '');
      if (m) return resp(206, b.subarray(+m[1], +m[2] + 1));
      return resp(200, b);
    }

    // pedido firmado con cabeceras: sólo ListObjectsV2
    const fecha = deAmzFecha(headers['x-amz-date']);
    if (!fecha) { cuenta_.rechazos++; return resp(403, 'AccessDenied'); }
    const h = firmar({ metodo: init.method || 'GET', host, ruta: u.pathname.split('/').map(decodeURIComponent).join('/'), query: q, clave, secreto, fecha });
    if (h.authorization !== headers.authorization) { cuenta_.rechazos++; return resp(403, 'SignatureDoesNotMatch'); }
    if (k || q['list-type'] !== '2') return resp(400, 'sólo ListObjectsV2');
    cuenta_.listados++;
    const prefijo = q.prefix || '';
    const todas = [...obj.keys()].filter((x) => x.startsWith(prefijo)).sort();
    const desde = q['continuation-token'] ? Number(q['continuation-token']) : 0;
    const pag = todas.slice(desde, desde + porPagina);
    const truncado = desde + porPagina < todas.length;
    const xml = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>' + deposito + '</Name><Prefix>' + xmlEsc(prefijo) + '</Prefix>'
      + pag.map((x) => `<Contents><Key>${xmlEsc(x)}</Key><Size>${obj.get(x).length}</Size><ETag>"e"</ETag></Contents>`).join('')
      + `<IsTruncated>${truncado}</IsTruncated>` + (truncado ? `<NextContinuationToken>${desde + porPagina}</NextContinuationToken>` : '') + '</ListBucketResult>';
    return resp(200, xml, { 'content-type': 'application/xml' });
  }
  return { fetchFn, host, cuenta, clave, secreto, deposito, objetos: obj, stats: cuenta_ };
}

/** El depósito de prueba: lo que hoy hay en producción según local (1 + 4 + 92) + horas de rayos + basura que no se firma */
export function depositoTipico(ahoraMs, { horasRayos = 72, quitar = [] } = {}) {
  const o = {};
  o['tormentas/proyeccion_tormentas.json'] = JSON.stringify({ emitido: '2026-11-06', escenarios: {} });
  o['tormentas/viejo/otra.json'] = '{}';
  o['escenarios/indice.json'] = JSON.stringify([{ cuenca: 'brasil', archivo: 'brasil.json', emitido: '2026-11-05' }, { cuenca: 'parana', archivo: 'parana.json', emitido: '2026-11-06' }, { cuenca: 'paraguay', archivo: 'paraguay.json', emitido: '2026-11-04' }]);
  for (const z of ['brasil', 'parana', 'paraguay']) o[`escenarios/${z}.json`] = JSON.stringify({ emitido: '2026-11-06', escenarios: { a: { nombre: 'x', zonas: {} } } });
  o['escenarios/paquete-escenarios.zip'] = 'zip';
  o['opera/cog/pasadas.json'] = JSON.stringify({ desde: '2026-07-27', hasta: '2026-10-25', zonas: {} });
  for (let t = Date.parse('2026-07-27T00:00:00Z'); t <= Date.parse('2026-10-25T00:00:00Z'); t += 864e5) o[`opera/cog/cuenca-del-plata/${new Date(t).toISOString().slice(0, 10)}.tif`] = Buffer.alloc(40, 7);
  o['opera/cog/_subida/lista-subida.txt'] = 'x';
  o['opera/crudo/lista-0-2278.txt'] = 'x';
  const fin = Math.floor(ahoraMs / 3600e3) * 3600e3;
  for (let i = 1; i <= horasRayos; i++) {
    const d = new Date(fin - i * 3600e3);
    const p = (n) => String(n).padStart(2, '0');
    o[`rayos-hora/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCHours())}.json`] = JSON.stringify({ v: 1, flashes: [] });
  }
  o['rayos-hora/candado.json'] = '{}';
  o['rayos-hora/alertas.txt'] = '';
  for (const k of quitar) delete o[k];
  return o;
}
