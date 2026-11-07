// HN AGRO · almacenamiento del colector del SHN: R2 (API S3, firma SigV4 propia, sin dependencias) o carpeta local.
// Interfaz común (claves con "/" y SIN el prefijo, que lo agrega el almacén):
//   leer(clave) -> Buffer | null       escribir(clave, cuerpo, { soloSiNoExiste }) -> true | false (false = ya existía)
//   existe(clave) -> bool              borrar(clave)                 listar(subprefijo) -> [claves]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- carpeta (pruebas locales y tests) ----------
export function almacenCarpeta(raiz) {
  const ruta = (clave) => {
    const p = path.resolve(raiz, ...clave.split('/'));
    if (!p.startsWith(path.resolve(raiz))) throw new Error('clave fuera de la carpeta: ' + clave);
    return p;
  };
  return {
    tipo: 'carpeta',
    async leer(clave) { try { return fs.readFileSync(ruta(clave)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async existe(clave) { return fs.existsSync(ruta(clave)); },
    async escribir(clave, cuerpo, { soloSiNoExiste = false } = {}) {
      const p = ruta(clave);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (soloSiNoExiste) {
        try { fs.writeFileSync(p, cuerpo, { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
      }
      const tmp = p + '.tmp' + process.pid;
      fs.writeFileSync(tmp, cuerpo);
      fs.renameSync(tmp, p);
      return true;
    },
    async borrar(clave) { try { fs.unlinkSync(ruta(clave)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
    async listar(sub = '') {
      const base = path.resolve(raiz);
      const out = [];
      const recorrer = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) recorrer(p); else out.push(path.relative(base, p).split(path.sep).join('/'));
        }
      };
      recorrer(base);
      return out.filter((k) => k.startsWith(sub)).sort();
    },
  };
}

// ---------- firma SigV4 (lo mínimo para S3/R2) ----------
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();
// RFC 3986: encodeURIComponent deja sin codificar !'()* y S3 los quiere codificados
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Devuelve los headers firmados (Authorization, x-amz-date, x-amz-content-sha256 y los que se pasaron).
// `firmar`: nombres (minúscula) de headers extra a incluir en la firma; host siempre va.
export function firmarSigV4({ metodo, host, ruta, query = {}, headers = {}, cuerpo = '', clave, secreto, region = 'auto', servicio = 's3', fecha = new Date(), hashCuerpo }) {
  const amzDate = fecha.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // AAAAMMDDThhmmssZ
  const dia = amzDate.slice(0, 8);
  const hc = hashCuerpo || sha256(cuerpo);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), host, 'x-amz-content-sha256': hc, 'x-amz-date': amzDate };
  const nombres = Object.keys(h).sort();
  const canonHeaders = nombres.map((n) => `${n}:${h[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const firmados = nombres.join(';');
  const canonQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonRuta = ruta.split('/').map(enc).join('/');
  const canonica = [metodo, canonRuta, canonQuery, canonHeaders, firmados, hc].join('\n');
  const alcance = `${dia}/${region}/${servicio}/aws4_request`;
  const aFirmar = ['AWS4-HMAC-SHA256', amzDate, alcance, sha256(canonica)].join('\n');
  const kFirma = hmac(hmac(hmac(hmac('AWS4' + secreto, dia), region), servicio), 'aws4_request');
  const firma = crypto.createHmac('sha256', kFirma).update(aFirmar).digest('hex');
  const { host: _h, ...resto } = h;
  return { ...resto, authorization: `AWS4-HMAC-SHA256 Credential=${clave}/${alcance}, SignedHeaders=${firmados}, Signature=${firma}`, _canonica: canonica, _firma: firma };
}

// ---------- R2 ----------
// env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET. Los valores no se imprimen nunca.
export function almacenR2({ cuenta, clave, secreto, deposito, prefijo = 'shn/', fetchFn = fetch } = {}) {
  if (!cuenta || !clave || !secreto || !deposito) throw new Error('faltan las variables R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET');
  const host = `${cuenta}.r2.cloudflarestorage.com`;
  async function pedido(metodo, clave2, { cuerpo, query = {}, headers = {} } = {}) {
    const ruta = `/${deposito}${clave2 != null ? '/' + clave2 : ''}`;
    const datos = cuerpo == null ? '' : cuerpo;
    const fh = firmarSigV4({ metodo, host, ruta, query, headers, cuerpo: datos, clave, secreto });
    delete fh._canonica; delete fh._firma;
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const url = `https://${host}${ruta.split('/').map(enc).join('/')}${qs ? '?' + qs : ''}`;
    for (let intento = 0; intento < 2; intento++) {
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 60000);
        const r = await fetchFn(url, { method: metodo, headers: fh, body: cuerpo == null ? undefined : datos, signal: ctl.signal });
        clearTimeout(to);
        if (r.status >= 500 && intento === 0) { await new Promise((s) => setTimeout(s, 3000)); continue; }
        return r;
      } catch (e) {
        if (intento === 0) { await new Promise((s) => setTimeout(s, 3000)); continue; }
        throw new Error(`R2 ${metodo}: ${e.message}`);
      }
    }
  }
  const k = (c) => prefijo + c;
  return {
    tipo: 'r2',
    async leer(c) {
      const r = await pedido('GET', k(c));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`R2 GET ${c}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async existe(c) {
      const r = await pedido('HEAD', k(c));
      if (r.status === 404) return false;
      if (!r.ok) throw new Error(`R2 HEAD ${c}: HTTP ${r.status}`);
      return true;
    },
    async escribir(c, cuerpo, { soloSiNoExiste = false } = {}) {
      const buf = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(String(cuerpo));
      const headers = { 'content-type': tipoContenido(c) };
      if (soloSiNoExiste) headers['if-none-match'] = '*';
      const r = await pedido('PUT', k(c), { cuerpo: buf, headers });
      if (soloSiNoExiste && r.status === 412) return false;
      if (!r.ok) throw new Error(`R2 PUT ${c}: HTTP ${r.status}`);
      return true;
    },
    async borrar(c) {
      const r = await pedido('DELETE', k(c));
      if (!r.ok && r.status !== 404) throw new Error(`R2 DELETE ${c}: HTTP ${r.status}`);
    },
    async listar(sub = '') {
      const out = [];
      let token;
      do {
        const query = { 'list-type': '2', prefix: k(sub), 'max-keys': '1000' };
        if (token) query['continuation-token'] = token;
        const r = await pedido('GET', null, { query });
        if (!r.ok) throw new Error(`R2 LIST: HTTP ${r.status}`);
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) out.push(desXml(m[1]).slice(prefijo.length));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? desXml((xml.match(/<NextContinuationToken>([^<]*)</) || [])[1] || '') : null;
      } while (token);
      return out.sort();
    },
  };
}
const desXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function tipoContenido(c) {
  const e = c.split('.').pop().toLowerCase();
  return { csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', json: 'application/json', jsonl: 'application/x-ndjson', svg: 'image/svg+xml', html: 'text/html' }[e] || 'application/octet-stream';
}

// Elige el almacén: --carpeta DIR (o SHN_CARPETA) = carpeta local; si no, R2 con las variables de entorno.
export function almacenDesdeEntorno({ carpeta, env = process.env } = {}) {
  const dir = carpeta || env.SHN_CARPETA;
  if (dir) return almacenCarpeta(dir);
  return almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET, prefijo: env.SHN_PREFIJO || 'shn/' });
}
