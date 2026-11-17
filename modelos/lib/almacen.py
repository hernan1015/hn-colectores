"""HN AGRO · 312 · dónde se guarda: R2 (SigV4 a mano, biblioteca estándar) o una carpeta (seco y tests).

R2: depósito `satchi-modelos` (público, sólo modelos), llaves R2_OPERA_CUENTA / R2_OPERA_ACCESS_KEY_ID /
R2_OPERA_SECRET_ACCESS_KEY (las de opera-mosaico-diario y del derivado público de rayos). Nunca se imprimen.
"""
import datetime as _dt
import hashlib
import hmac
import os
import re
import urllib.error
import urllib.parse
import urllib.request


def _enc(s):
    return urllib.parse.quote(str(s), safe='-_.~')


def _h(b):
    return hashlib.sha256(b).hexdigest()


def _hm(k, s):
    return hmac.new(k, s.encode(), hashlib.sha256).digest()


def firmar(metodo, host, ruta, query, headers, cuerpo, clave, secreto, ahora, region='auto'):
    """cabeceras firmadas (AWS SigV4, servicio s3). `ruta` ya viene sin codificar."""
    amz = ahora.strftime('%Y%m%dT%H%M%SZ')
    dia = amz[:8]
    hc = _h(cuerpo)
    h = {k.lower(): str(v) for k, v in headers.items()}
    h.update({'host': host, 'x-amz-content-sha256': hc, 'x-amz-date': amz})
    nombres = sorted(h)
    canon_h = ''.join('%s:%s\n' % (n, h[n].strip()) for n in nombres)
    firmados = ';'.join(nombres)
    canon_q = '&'.join('%s=%s' % (_enc(k), _enc(query[k])) for k in sorted(query))
    canon_ruta = '/'.join(_enc(p) for p in ruta.split('/'))
    canon = '\n'.join([metodo, canon_ruta, canon_q, canon_h, firmados, hc])
    alcance = '%s/%s/s3/aws4_request' % (dia, region)
    a_firmar = '\n'.join(['AWS4-HMAC-SHA256', amz, alcance, _h(canon.encode())])
    k = _hm(_hm(_hm(_hm(('AWS4' + secreto).encode(), dia), region), 's3'), 'aws4_request')
    firma = hmac.new(k, a_firmar.encode(), hashlib.sha256).hexdigest()
    h.pop('host')
    h['authorization'] = 'AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s' % (clave, alcance, firmados, firma)
    return h, firma


class AlmacenR2:
    tipo = 'r2'

    def __init__(self, cuenta, clave, secreto, deposito, abrir=None):
        if not (cuenta and clave and secreto and deposito):
            raise ValueError('faltan R2_OPERA_CUENTA / R2_OPERA_ACCESS_KEY_ID / R2_OPERA_SECRET_ACCESS_KEY')
        self.host = '%s.r2.cloudflarestorage.com' % cuenta
        self.clave, self.secreto, self.deposito = clave, secreto, deposito
        self._abrir = abrir or urllib.request.urlopen
        self.lecturas = self.escrituras = self.borrados = 0

    def _pedido(self, metodo, k, cuerpo=b'', query=None, headers=None):
        query = query or {}
        ruta = '/' + self.deposito + ('/' + k if k else '')
        h, _ = firmar(metodo, self.host, ruta, query, headers or {}, cuerpo, self.clave, self.secreto,
                      _dt.datetime.now(_dt.timezone.utc))
        qs = ('?' + '&'.join('%s=%s' % (_enc(x), _enc(query[x])) for x in sorted(query))) if query else ''
        url = 'https://%s%s%s' % (self.host, '/'.join(_enc(p) for p in ruta.split('/')), qs)
        req = urllib.request.Request(url, data=cuerpo if metodo == 'PUT' else None, headers=h, method=metodo)
        try:
            with self._abrir(req, timeout=60) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, b''

    def leer(self, k):
        self.lecturas += 1
        st, b = self._pedido('GET', k)
        if st == 404:
            return None
        if st != 200:
            raise IOError('R2 leer: HTTP %d' % st)
        return b

    def escribir(self, k, datos, tipo='application/json', cache=None, si_no_existe=False):
        """True si escribió; False si si_no_existe y la clave ya estaba (If-None-Match: *, R2 responde 412)"""
        self.escrituras += 1
        h = {'content-type': tipo}
        if cache:
            h['cache-control'] = cache
        if si_no_existe:
            h['if-none-match'] = '*'
        st, _ = self._pedido('PUT', k, cuerpo=datos, headers=h)
        if si_no_existe and st in (409, 412):
            return False
        if st not in (200, 201):
            raise IOError('R2 escribir: HTTP %d' % st)
        return True

    def borrar(self, k):
        self.borrados += 1
        st, _ = self._pedido('DELETE', k)
        if st not in (200, 204, 404):
            raise IOError('R2 borrar: HTTP %d' % st)

    def listar(self, prefijo):
        out, token = [], None
        for _ in range(100):
            q = {'list-type': '2', 'prefix': prefijo}
            if token:
                q['continuation-token'] = token
            self.lecturas += 1
            st, b = self._pedido('GET', '', query=q)
            if st != 200:
                raise IOError('R2 listar: HTTP %d' % st)
            xml = b.decode()
            out += [m.replace('&amp;', '&') for m in re.findall(r'<Key>([^<]+)</Key>', xml)]
            if '<IsTruncated>true</IsTruncated>' not in xml:
                break
            m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
            if not m:
                break
            token = m.group(1)
        return sorted(out)


class AlmacenCarpeta:
    tipo = 'carpeta'

    def __init__(self, raiz):
        self.raiz = raiz
        self.lecturas = self.escrituras = self.borrados = 0
        self.cache = {}

    def _p(self, k):
        if '..' in k.split('/'):
            raise ValueError('clave')
        return os.path.join(self.raiz, *k.split('/'))

    def leer(self, k):
        self.lecturas += 1
        try:
            with open(self._p(k), 'rb') as f:
                return f.read()
        except FileNotFoundError:
            return None

    def escribir(self, k, datos, tipo='application/json', cache=None, si_no_existe=False):
        self.escrituras += 1
        p = self._p(k)
        if si_no_existe and os.path.exists(p):
            return False
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p + '.parte', 'wb') as f:
            f.write(datos)
        os.replace(p + '.parte', p)
        self.cache[k] = cache
        return True

    def borrar(self, k):
        self.borrados += 1
        try:
            os.remove(self._p(k))
        except FileNotFoundError:
            pass

    def listar(self, prefijo):
        out = []
        for base, _, archivos in os.walk(self.raiz):
            for a in archivos:
                k = os.path.relpath(os.path.join(base, a), self.raiz).replace(os.sep, '/')
                if k.startswith(prefijo) and not k.endswith('.parte'):
                    out.append(k)
        return sorted(out)


def desde_entorno(env=os.environ):
    if env.get('ALMACEN_CARPETA'):
        return AlmacenCarpeta(env['ALMACEN_CARPETA'])
    return AlmacenR2(env.get('R2_OPERA_CUENTA'), env.get('R2_OPERA_ACCESS_KEY_ID'), env.get('R2_OPERA_SECRET_ACCESS_KEY'),
                     env.get('MODELOS_DEPOSITO') or 'satchi-modelos')
