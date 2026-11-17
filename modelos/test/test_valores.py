"""[312c] la grilla de valores v2 (contrato R2 v2): la codificación, el PNG de 16 bits, los nodos, el valor de la fuente en cada
nodo, el NaN, el sobre, la retención y que una falla de la v2 no toque el v1. Control negativo: test/control_negativo.py."""
import json
import shutil
import tempfile
import unittest
from datetime import timedelta

import numpy as np

import base  # noqa: F401

import sintetico as S
from lib import malla, paleta, tuberia, valores
from lib.almacen import AlmacenCarpeta
from lib.fuentes import Gfs

C = S.CORRIDA0
AHORA = C + timedelta(hours=8)
SILENCIO = lambda *a: None  # noqa: E731


def _j(alm, k):
    b = alm.leer(k)
    return json.loads(b.decode()) if b else None


class TestCodificacion(unittest.TestCase):
    def test_ida_y_vuelta_con_nan_y_topes(self):
        a = np.array([[0.0, 0.004, 0.006, 12.344], [np.nan, -0.2, 499.99, 900.0]])
        q = valores.codificar(a, 'lluvia6h')
        self.assertEqual(q.dtype, np.uint16)
        self.assertEqual(q.tolist(), [[0, 0, 1, 1234], [65535, 0, 49999, 65534]])
        v = valores.decodificar(q, 'lluvia6h')
        self.assertTrue(np.isnan(v[1, 0]))
        self.assertAlmostEqual(v[0, 3], 12.34)
        self.assertEqual(valores.codificar(np.array([[2345.6]]), 'cape').tolist(), [[2346]])

    def test_png16_ida_y_vuelta(self):
        q = (np.arange(165 * 125, dtype=np.uint32) * 7 % 65536).astype(np.uint16).reshape(165, 125)
        b = valores.png16(q)
        self.assertEqual(b[12:16], b'IHDR')
        self.assertEqual((b[24], b[25]), (16, 0))                     # gris de 16 bits
        self.assertTrue(np.array_equal(valores.leer_png16(b), q))
        self.assertEqual(valores.png16(q), b)                          # mismos datos → mismos bytes

    def test_nodos(self):
        la, lo = malla.nodos_v2()
        self.assertEqual((len(la), len(lo)), (165, 125))
        self.assertEqual((la[0], la[-1], lo[0], lo[-1]), (-15.0, -56.0, -76.0, -45.0))
        g = malla.grilla_v2()
        self.assertEqual((g['lat0'], g['dlat'], g['nlat'], g['lon0'], g['dlon'], g['nlon']), (-15.0, -0.25, 165, -76.0, 0.25, 125))

    def test_una_malla_corrida_no_se_remuestrea_a_escondidas(self):
        la = -13.125 - 0.25 * np.arange(181)
        lo = -78.0 + 0.25 * np.arange(141)
        with self.assertRaises(ValueError):
            malla.regular_a_v2(np.zeros((181, 141)), la, lo)


class TestPuntaAPuntaV2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix='modelos-v2-')
        cls.alm = AlmacenCarpeta(cls.dir)
        cls.r = tuberia.correr(S.RedFalsa(S.servidor(C)), cls.alm, ahora=AHORA, llave='si', log=SILENCIO)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_claves_junto_al_v1_y_el_sobre(self):
        for f in ('ecmwf', 'icon', 'gfs'):
            s = _j(self.alm, 'v1/%s/2026111612/corrida.json' % f)
            self.assertEqual(s['valores'], s['cuadros'], f)
            ks = self.alm.listar('v2/%s/2026111612/' % f)
            self.assertEqual(len([k for k in ks if k.endswith('.val.png')]), 41, f)
            self.assertEqual(len([k for k in ks if k.endswith('.val.json')]), 41, f)
            self.assertEqual(len([k for k in self.alm.listar('v1/%s/2026111612/' % f) if k.endswith('.png')]), 41, f)
        self.assertEqual(self.alm.cache['v2/gfs/2026111612/cape/006.val.png'], tuberia.CACHE_CUADRO)

    def test_el_json_v2(self):
        m = _j(self.alm, 'v2/ecmwf/2026111612/lluvia6h/012.val.json')
        v1 = _j(self.alm, 'v1/ecmwf/2026111612/lluvia6h/012.json')
        self.assertEqual(m['v'], 2)
        for k in ('fuente', 'corrida', 'valida_iso', 'periodo', 'unidades', 'caja', 'cita', 'aviso'):
            self.assertEqual(m[k], v1[k], k)
        self.assertEqual(m['valores']['escala'], 0.01)
        self.assertEqual(m['valores']['sin_dato'], 65535)
        self.assertEqual(m['valores']['png'], '012.val.png')
        self.assertEqual(m['grilla']['nlat'], 165)
        self.assertEqual(m['paleta'], 'lluvia6h-continua-v2')
        self.assertEqual(m['firma'], paleta.firma(self.alm.leer('v2/ecmwf/2026111612/lluvia6h/012.val.png')))
        self.assertEqual(m['firma_v1'], v1['firma'])
        self.assertEqual(m['estadisticas']['sin_dato'], 0)
        self.assertNotIn('grilla', v1)                                  # el v1 no cambia

    def _val(self, f, var, h):
        q = valores.leer_png16(self.alm.leer('v2/%s/2026111612/%s/%03d.val.png' % (f, var, h)))
        return valores.decodificar(q, var)

    def test_el_valor_de_la_fuente_en_cada_nodo(self):
        la, lo = malla.nodos_v2()
        LA, LO = np.meshgrid(la, lo, indexing='ij')
        for f in ('ecmwf', 'gfs'):
            esp = S.lluvia_total(LA, LO, 12) - S.lluvia_total(LA, LO, 6)
            self.assertLess(np.abs(self._val(f, 'lluvia6h', 12) - esp).max(), 0.006, f)
            self.assertLess(np.abs(self._val(f, 'cape', 6) - S.cape(LA, LO, 6)).max(), 0.6, f)
        # ICON: el centro de celda más cercano a cada nodo (las celdas de mentira están corridas hasta 0,04° de su lugar)
        ci = self._val('icon', 'cape', 6)
        self.assertLess(np.abs(ci - S.cape(LA, LO, 6)).max(), 60)
        self.assertGreater(np.abs(ci - S.cape(LA, LO, 6)).max(), 0.6)   # no es la función en el nodo: es la celda
        # la fila 0 es la del NORTE y la columna 0 la del OESTE
        v = self._val('gfs', 'cape', 6)
        self.assertLess(abs(v[0, 0] - S.cape(-15.0, -76.0, 6)), 0.6)
        self.assertLess(abs(v[164, 124] - S.cape(-56.0, -45.0, 6)), 0.6)


class AlmacenSinV2(AlmacenCarpeta):
    def escribir(self, k, datos, tipo='application/json', cache=None, si_no_existe=False):
        if k.startswith('v2/'):
            raise IOError('R2 escribir v2: HTTP 500')
        return super().escribir(k, datos, tipo, cache, si_no_existe)


class TestFallaV2(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='modelos-v2f-')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_si_falla_la_v2_el_v1_queda_entero(self):
        a = AlmacenSinV2(self.dir)
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',))), a, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        s = _j(a, 'v1/gfs/2026111612/corrida.json')
        self.assertEqual(s['estado'], 'completa')
        self.assertEqual(s['valores'], {'lluvia6h': [], 'cape': []})
        self.assertEqual(_j(a, tuberia.K_INDICE)['fuentes']['gfs']['ultima'], '2026111612')

    def test_v2_distinta_ya_publicada_no_se_pisa(self):
        a = AlmacenCarpeta(self.dir)
        k = 'v2/gfs/2026111612/cape/006.val.png'
        a.escribir(k, b'otra grilla')
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',))), a, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertEqual(a.leer(k), b'otra grilla')
        self.assertIsNone(a.leer('v2/gfs/2026111612/cape/006.val.json'))
        s = _j(a, 'v1/gfs/2026111612/corrida.json')
        self.assertEqual(s['estado'], 'completa')                       # el v1 sí
        self.assertNotIn(6, s['valores']['cape'])

    def test_la_retencion_borra_tambien_la_v2(self):
        a = AlmacenCarpeta(self.dir)
        i = tuberia.indice_vacio()
        viejas = [(C - timedelta(hours=6 * k)).strftime('%Y%m%d%H') for k in range(1, 9)]
        for cc in viejas:
            i['fuentes']['gfs']['corridas'].append(cc)
            i['fuentes']['gfs']['estados'][cc] = 'completa'
            a.escribir('v1/gfs/%s/cape/000.png' % cc, b'x')
            a.escribir('v2/gfs/%s/cape/000.val.png' % cc, b'x')
        a.escribir(tuberia.K_INDICE, json.dumps(i).encode())
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',))), a, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertEqual(a.listar('v2/gfs/%s/' % viejas[7]), [])
        self.assertTrue(a.listar('v2/gfs/%s/' % viejas[6]))


class TestIconV2(unittest.TestCase):
    def test_otra_malla_no(self):
        la, lo = S.celdas_icon()
        M = malla.MallaIcon(la, lo, 'u1')
        with self.assertRaises(ValueError):
            M.a_v2(np.zeros(len(la)), 'u2')
        self.assertEqual(M.indice_v2.shape, (165, 125))
        self.assertLess(M.dist_max_v2_km, M.DIST_MAX_KM)   # los nodos del borde también tienen su celda cerca


if __name__ == '__main__':
    unittest.main()
