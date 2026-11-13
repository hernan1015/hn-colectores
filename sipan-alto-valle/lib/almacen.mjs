// HN AGRO · SIPAN Alto Valle · los crudos de 10 min en R2 (depósito PRIVADO; no satchi-mapas, que es público).
// ⚠ COPIA de rayos-hora/lib/almacen.mjs (firma SigV4 propia, sin dependencias), como ya se hizo con el SHN:
//    cuando estén todos en main, unificar en un lib/ común. Variables: SIPAN_R2_CUENTA, SIPAN_R2_ACCESS_KEY_ID,
//    SIPAN_R2_SECRET_ACCESS_KEY, SIPAN_R2_DEPOSITO (secrets.* del workflow; nunca se imprimen).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- carpeta (pruebas locales y tests) ----------
export function almacenCarpeta(raiz) {
  const base = path.resolve(raiz);
  const ruta = (clave) => {
    const p = path.resolve(base, ...clave.split('/'));
    if (!p.startsWith(base)) throw new Error('clave fuera de la carpeta');
    return p;
  };
  return {
    tipo: 'carpeta',
    async leer(clave) { try { return fs.readFileSync(ruta(clave)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
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
    async listar(prefijo = '') {
      const out = [];
      const recorrer = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) recorrer(p);
          else if (!e.name.includes('.tmp')) out.push(path.relative(base, p).split(path.sep).join('/'));
        }
      };
      recorrer(base);
      return out.filter((k) => k.startsWith(prefijo)).sort();
    },
  };
}

// ---------- firma SigV4 (lo mínimo para S3/R2) ----------
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Headers firmados para un pedido S3. Exportada para el test con el ejemplo publicado por AWS. */
export function firmar({ metodo, host, ruta, query = {}, headers = {}, cuerpo = '', clave, secreto, region = 'auto', fecha = new Date() }) {
  const amz = fecha.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dia = amz.slice(0, 8);
  const hc = sha256(cuerpo);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), host, 'x-amz-content-sha256': hc, 'x-amz-date': amz };
  const nombres = Object.keys(h).sort();
  const canonH = nombres.map((n) => `${n}:${h[n].trim()}\n`).join('');
  const firmados = nombres.join(';');
  const canonQ = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonRuta = ruta.split('/').map(enc).join('/');
  const canon = [metodo, canonRuta, canonQ, canonH, firmados, hc].join('\n');
  const alcance = `${dia}/${region}/s3/aws4_request`;
  const aFirmar = ['AWS4-HMAC-SHA256', amz, alcance, sha256(canon)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + secreto, dia), region), 's3'), 'aws4_request');
  const firma = crypto.createHmac('sha256', k).update(aFirmar).digest('hex');
  const { host: _h, ...resto } = h;
  return { ...resto, authorization: `AWS4-HMAC-SHA256 Credential=${clave}/${alcance}, SignedHeaders=${firmados}, Signature=${firma}`, _firma: firma };
}

// ---------- R2 ----------
// Variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET. Nunca se imprimen.
export function almacenR2({ cuenta, clave, secreto, deposito, fetchFn = fetch } = {}) {
  if (!cuenta || !clave || !secreto || !deposito) throw new Error('faltan R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET');
  const host = `${cuenta}.r2.cloudflarestorage.com`;
  async function pedido(metodo, k, { cuerpo = '', query = {}, headers = {} } = {}) {
    const ruta = '/' + deposito + (k ? '/' + k : '');
    const firmados = firmar({ metodo, host, ruta, query, headers, cuerpo, clave, secreto });
    delete firmados._firma;
    const qs = Object.keys(query).length ? '?' + Object.keys(query).sort().map((x) => `${enc(x)}=${enc(query[x])}`).join('&') : '';
    const url = `https://${host}${ruta.split('/').map(enc).join('/')}${qs}`;
    return fetchFn(url, { method: metodo, headers: firmados, body: metodo === 'PUT' ? cuerpo : undefined, signal: AbortSignal.timeout(60000) });
  }
  const falla = async (r, que) => { throw new Error(`R2 ${que}: HTTP ${r.status}`); };
  return {
    tipo: 'r2',
    async leer(k) {
      const r = await pedido('GET', k);
      if (r.status === 404) return null;
      if (!r.ok) return falla(r, 'leer');
      return Buffer.from(await r.arrayBuffer());
    },
    async escribir(k, cuerpo, { soloSiNoExiste = false, tipo = 'application/json' } = {}) {
      const headers = { 'content-type': tipo };
      if (soloSiNoExiste) headers['if-none-match'] = '*';
      const r = await pedido('PUT', k, { cuerpo: Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo), headers });
      if (soloSiNoExiste && (r.status === 412 || r.status === 409)) return false;
      if (!r.ok) return falla(r, 'escribir');
      return true;
    },
    async borrar(k) {
      const r = await pedido('DELETE', k);
      if (!r.ok && r.status !== 404) return falla(r, 'borrar');
    },
    async listar(prefijo = '') {
      const out = [];
      let token = null;
      for (let pag = 0; pag < 100; pag++) {
        const query = { 'list-type': '2', prefix: prefijo };
        if (token) query['continuation-token'] = token;
        const r = await pedido('GET', '', { query });
        if (!r.ok) return falla(r, 'listar');
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(m[1].replace(/&amp;/g, '&'));
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        token = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1];
        if (!token) break;
      }
      return out.sort();
    },
  };
}
