"""el cliente R2 (SigV4 contra el ejemplo publicado por AWS) y la red (UA, rangos, sin bucles)."""
import io
import unittest
import urllib.error
from datetime import datetime, timezone

import base  # noqa: F401

from lib.almacen import AlmacenR2, firmar
from lib.red import UA, ErrorRed, Red


class TestSigV4(unittest.TestCase):
    def test_ejemplo_de_aws_get_object(self):
        """docs de AWS «Signature Calculations for the Authorization Header», ejemplo GET Object"""
        h, firma = firmar('GET', 'examplebucket.s3.amazonaws.com', '/test.txt', {}, {'Range': 'bytes=0-9'}, b'',
                          'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                          datetime(2013, 5, 24, tzinfo=timezone.utc), region='us-east-1')
        self.assertEqual(firma, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
        self.assertIn('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date', h['authorization'])

    def test_control_negativo_otra_clave_otra_firma(self):
        _, f = firmar('GET', 'examplebucket.s3.amazonaws.com', '/test.txt', {}, {'Range': 'bytes=0-9'}, b'',
                      'AKIAIOSFODNN7EXAMPLE', 'otra', datetime(2013, 5, 24, tzinfo=timezone.utc), region='us-east-1')
        self.assertNotEqual(f, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')

    def test_r2_escritura_sin_pisar(self):
        vistos = []

        def abrir(req, timeout=None):
            vistos.append(dict(req.header_items()))
            raise urllib.error.HTTPError(req.full_url, 412, 'Precondition Failed', {}, None)
        a = AlmacenR2('cuenta', 'clave', 'secreto', 'satchi-modelos', abrir=abrir)
        self.assertFalse(a.escribir('v1/x.png', b'x', 'image/png', si_no_existe=True))
        self.assertEqual(vistos[0]['If-none-match'], '*')
        with self.assertRaises(IOError):
            a.escribir('v1/x.png', b'x', 'image/png')                  # sin la condición, un 412 es un error

    def test_sin_llaves_no_arranca(self):
        with self.assertRaises(ValueError):
            AlmacenR2('', 'a', 'b', 'satchi-modelos')

    def test_r2_con_servidor_de_mentira(self):
        vistos = []

        class Resp(io.BytesIO):
            status = 200
            def __enter__(self): return self                  # noqa: E301,E704
            def __exit__(self, *a): return False              # noqa: E301,E704

        def abrir(req, timeout=None):
            vistos.append((req.get_method(), req.full_url, dict(req.header_items())))
            if req.get_method() == 'GET' and 'list-type' not in req.full_url:
                raise urllib.error.HTTPError(req.full_url, 404, 'no', {}, None)
            return Resp(b'<ListBucketResult><Key>v1/a.json</Key><IsTruncated>false</IsTruncated></ListBucketResult>')
        a = AlmacenR2('cuenta', 'clave', 'secreto', 'satchi-modelos', abrir=abrir)
        a.escribir('v1/gfs/2026111612/cape/006.png', b'png', 'image/png', 'public, max-age=86400, immutable')
        self.assertIsNone(a.leer('v1/indice.json'))
        self.assertEqual(a.listar('v1/'), ['v1/a.json'])
        m, url, h = vistos[0]
        self.assertEqual((m, url), ('PUT', 'https://cuenta.r2.cloudflarestorage.com/satchi-modelos/v1/gfs/2026111612/cape/006.png'))
        self.assertEqual(h['Cache-control'], 'public, max-age=86400, immutable')
        self.assertTrue(h['Authorization'].startswith('AWS4-HMAC-SHA256 Credential=clave/'))


class TestRed(unittest.TestCase):
    def _red(self, respuestas):
        vistos = []

        leidos = []

        class Resp(io.BytesIO):
            def __init__(self, b, st, cr=None):
                super().__init__(b)
                self.status = st
                self.headers = {'Content-Range': cr} if cr else {}
            def read(self, n=-1):                              # noqa: E301
                b = super().read(n)
                leidos.append(len(b))
                return b
            def __enter__(self): return self                  # noqa: E301,E704
            def __exit__(self, *a): return False              # noqa: E301,E704

        def abrir(req, timeout=None):
            vistos.append(req)
            r = respuestas.pop(0)
            if isinstance(r, int):
                raise urllib.error.HTTPError(req.full_url, r, 'x', {}, None)
            return Resp(*r)
        self.leidos = leidos
        return Red(pausa=0, espera_reintento=0, abrir=abrir), vistos

    def test_ua_y_rango(self):
        red, v = self._red([(b'0123456789', 206, 'bytes 10-19/1000')])
        self.assertEqual(red.get('https://x/y', rango=(10, 19)), b'0123456789')
        self.assertEqual(v[0].get_header('User-agent'), UA)
        self.assertEqual(v[0].get_header('Range'), 'bytes=10-19')
        self.assertEqual(UA, 'hn-colector/1.0')

    def test_404_es_none_sin_reintento(self):
        red, v = self._red([404])
        self.assertIsNone(red.get('https://x/y'))
        self.assertEqual(len(v), 1)

    def test_un_solo_reintento(self):
        red, v = self._red([503, 503, (b'ok', 200)])
        with self.assertRaises(ErrorRed):
            red.get('https://x/y')
        self.assertEqual(len(v), 2)                              # dos intentos, nunca un bucle

    def test_4xx_sin_reintento(self):
        red, v = self._red([403, (b'ok', 200)])
        with self.assertRaises(ErrorRed):
            red.get('https://x/y')
        self.assertEqual(len(v), 1)

    def test_control_negativo_rango_ignorado(self):
        """[n3-312a 1] un 200 con el archivo entero se corta ANTES de leer: 0 bytes leídos"""
        red, _ = self._red([(b'G' * 1000000, 200)])
        with self.assertRaises(ErrorRed):
            red.get('https://x/y', rango=(0, 3))
        self.assertEqual(sum(self.leidos), 0)
        self.assertEqual(red.bytes, 0)
        red, _ = self._red([(b'GRIB', 200, 'bytes 0-3/4')])     # mismo largo y Content-Range: sólo el 200 lo delata
        with self.assertRaises(ErrorRed):
            red.get('https://x/y', rango=(0, 3))

    def test_control_negativo_content_range_distinto(self):
        red, _ = self._red([(b'GRIB', 206, 'bytes 4-7/1000')])
        with self.assertRaises(ErrorRed):
            red.get('https://x/y', rango=(0, 3))
        self.assertEqual(sum(self.leidos), 0)
        red, _ = self._red([(b'GRIB', 206)])                      # sin Content-Range
        with self.assertRaises(ErrorRed):
            red.get('https://x/y', rango=(0, 3))

    def test_lee_como_mucho_lo_pedido(self):
        red, _ = self._red([(b'G' * 1000000, 206, 'bytes 0-3/1000000')])
        with self.assertRaises(ErrorRed):
            red.get('https://x/y', rango=(0, 3))
        self.assertLessEqual(sum(self.leidos), 5)


if __name__ == '__main__':
    unittest.main()
