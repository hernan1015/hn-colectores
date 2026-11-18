"""HN AGRO · 312 · los pedidos a las fuentes: de a uno, con pausa, UA hn-colector/1.0 y a lo sumo UN reintento.

Sólo biblioteca estándar (lo usa también el chequeo previo, antes de instalar nada). Cuenta pedidos y bytes.
Un 404 es «todavía no está» (None) y no se reintenta. El registro de Actions es público: no se imprimen URL firmadas.
"""
import time
import urllib.error
import urllib.request

UA = 'hn-colector/1.0'


class ErrorRed(Exception):
    pass


class Red:
    def __init__(self, pausa=0.5, espera_reintento=2.0, timeout=60, abrir=None, dormir=time.sleep):
        self.pausa, self.espera, self.timeout = pausa, espera_reintento, timeout
        self._abrir = abrir or urllib.request.urlopen
        self._dormir = dormir
        self.pedidos = 0
        self.bytes = 0
        self.por_host = {}
        # [312d] plazo TOTAL opcional (reloj monotónico): ningún pedido empieza después, el socket espera a lo sumo lo que queda y
        # el cuerpo se lee por bloques mirando el plazo (un servidor que gotea no lo estira)
        self.hasta, self.reloj = None, time.monotonic

    def _resta(self):
        if self.hasta is None:
            return self.timeout
        r = self.hasta - self.reloj()
        if r <= 0:
            raise ErrorRed('plazo vencido')
        return min(self.timeout, max(1.0, r))

    def _leer(self, r, n):
        """el cuerpo por bloques de 1 MB, mirando el plazo; n = tope de bytes (None: todo)"""
        partes, total = [], 0
        while n is None or total < n:
            self._resta()
            b = r.read(1 << 20 if n is None else min(1 << 20, n - total))
            if not b:
                break
            partes.append(b)
            total += len(b)
        return b''.join(partes)

    def _uno(self, metodo, url, rango):
        h = {'User-Agent': UA}
        if rango:
            h['Range'] = 'bytes=%d-%d' % rango
        req = urllib.request.Request(url, headers=h, method=metodo)
        for intento in range(2):
            if self.pedidos:
                self._dormir(self.pausa)
            plazo = self._resta()
            self.pedidos += 1
            host = url.split('/')[2]
            self.por_host[host] = self.por_host.get(host, 0) + 1
            try:
                with self._abrir(req, timeout=plazo) as r:
                    if rango:
                        # [n3-312a 1] ANTES de leer: un 200 (rango ignorado) sería el archivo entero (~100–540 MB)
                        n = rango[1] - rango[0] + 1
                        if r.status != 206:
                            raise ErrorRed('se pidió un rango y no vino 206 (%d): no se lee' % r.status)
                        cr = (r.headers.get('Content-Range') or '').strip() if r.headers is not None else ''
                        if not cr.startswith('bytes %d-%d/' % rango):
                            raise ErrorRed('Content-Range distinto del pedido: no se lee')
                        cuerpo = r.read(n + 1) if self.hasta is None else self._leer(r, n + 1)   # nunca más que lo pedido (+1 para notar si sobra)
                        if len(cuerpo) != n:
                            raise ErrorRed('rango de %d bytes, vinieron %s' % (n, len(cuerpo) if len(cuerpo) <= n else 'más'))
                    else:
                        cuerpo = (r.read() if self.hasta is None else self._leer(r, None)) if metodo == 'GET' else b''
                    self.bytes += len(cuerpo)
                    return cuerpo
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if intento == 0 and e.code >= 500:
                    self._dormir(self.espera)
                    continue
                raise ErrorRed('HTTP %d' % e.code)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if intento == 0:
                    self._dormir(self.espera)
                    continue
                raise ErrorRed('sin conexión: %s' % type(e).__name__)
        raise ErrorRed('sin respuesta')

    def get(self, url, rango=None):
        """bytes, o None si no está (404)"""
        return self._uno('GET', url, rango)

    def existe(self, url):
        return self._uno('HEAD', url, None) is not None
