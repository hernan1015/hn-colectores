"""la tubería entera con fuentes de mentira: el sobre, el índice, la idempotencia, la llave y la retención."""
import json
import os
import shutil
import tempfile
import unittest
from datetime import timedelta

import base  # noqa: F401

import sintetico as S
from lib import paleta, tuberia
from lib.almacen import AlmacenCarpeta
from lib.fuentes import Ecmwf, Gfs, Icon

C = S.CORRIDA0
AHORA = C + timedelta(hours=8)
SILENCIO = lambda *a: None  # noqa: E731


def _j(alm, k):
    b = alm.leer(k)
    return json.loads(b.decode()) if b else None


class Carpeta(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='modelos-test-')
        self.alm = AlmacenCarpeta(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class TestPuntaAPunta(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix='modelos-e2e-')
        cls.alm = AlmacenCarpeta(cls.dir)
        cls.archivos = S.servidor(C)
        cls.red = S.RedFalsa(cls.archivos)
        cls.r = tuberia.correr(cls.red, cls.alm, ahora=AHORA, llave='si', log=SILENCIO)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_claves_y_sobre(self):
        for f in ('ecmwf', 'icon', 'gfs'):
            s = _j(self.alm, 'v1/%s/2026111612/corrida.json' % f)
            self.assertEqual(s['estado'], 'completa', f)
            self.assertEqual(s['cuadros']['lluvia6h'], list(range(6, 121, 6)))
            self.assertEqual(s['cuadros']['cape'], list(range(0, 121, 6)))
            self.assertEqual(s['faltan'], {'lluvia6h': [], 'cape': []})
            self.assertEqual(len(s['firmas']), 41)
            pngs = [k for k in self.alm.listar('v1/%s/2026111612/' % f) if k.endswith('.png')]
            self.assertEqual(len(pngs), 41)
        self.assertEqual(self.alm.cache['v1/gfs/2026111612/cape/006.png'], tuberia.CACHE_CUADRO)

    def test_metadatos_del_cuadro(self):
        m = _j(self.alm, 'v1/ecmwf/2026111612/lluvia6h/012.json')
        self.assertEqual(m['valida_iso'], '2026-11-17T00:00Z')
        self.assertEqual(m['periodo'], {'desde_iso': '2026-11-16T18:00Z', 'hasta_iso': '2026-11-17T00:00Z'})
        self.assertEqual(m['unidades'], 'mm')
        self.assertEqual(m['paleta'], 'lluvia6h-v1')
        self.assertEqual(m['imagen']['ancho'], 248)
        self.assertEqual(m['imagen']['alto'], 422)
        self.assertEqual(m['caja'], {'oeste': -76.0, 'este': -45.0, 'sur': -56.0, 'norte': -15.0})
        self.assertIn('© 2026 European Centre', m['cita']['texto'])
        self.assertEqual(m['cita']['licencia'], 'CC BY 4.0')
        self.assertTrue(m['aviso'].startswith('PRONÓSTICO del modelo ECMWF IFS, corrida 16/11 12 UTC'))
        png = self.alm.leer('v1/ecmwf/2026111612/lluvia6h/012.png')
        self.assertEqual(m['firma'], paleta.firma(png))
        idx, _, _ = paleta.leer_png_indexado(png)
        self.assertEqual(idx.shape, (422, 248))
        c = _j(self.alm, 'v1/icon/2026111612/cape/006.json')
        self.assertEqual(c['cape_tipo'], 'MLCAPE')
        self.assertIsNone(c['periodo'])
        self.assertEqual(_j(self.alm, 'v1/gfs/2026111612/cape/006.json')['cape_tipo'], 'MUCAPE')

    def test_indice(self):
        i = _j(self.alm, tuberia.K_INDICE)
        self.assertEqual(i['v'], 1)
        for f in ('ecmwf', 'icon', 'gfs'):
            self.assertEqual(i['fuentes'][f]['ultima'], '2026111612')
            self.assertEqual(i['fuentes'][f]['corridas'], ['2026111612'])
        self.assertEqual(i['horas']['cape'][0], 0)
        self.assertIsNotNone(_j(self.alm, tuberia.K_PALETAS))

    def test_pedidos_de_a_uno_y_solo_lo_necesario(self):
        h = self.red.por_host
        # ECMWF: 21 índices + 20 tp + 21 mucape + disponibilidad; GFS igual; ICON: 20 + 21 + CLAT + CLON + 2 de disponibilidad
        self.assertLessEqual(h['data.ecmwf.int'], 63)
        self.assertLessEqual(h['noaa-gfs-bdp-pds.s3.amazonaws.com'], 63)
        self.assertLessEqual(h['opendata.dwd.de'], 45)

    def test_idempotente(self):
        red2 = S.RedFalsa(self.archivos)
        e0 = self.alm.escrituras
        tuberia.correr(red2, self.alm, ahora=AHORA + timedelta(minutes=10), llave='si', log=SILENCIO)
        self.assertEqual(red2.pedidos, 0)                 # una corrida ya hecha no se vuelve a pedir
        self.assertEqual(self.alm.escrituras, e0)         # ni se reescribe nada (tampoco el índice)


class TestLlave(Carpeta):
    def test_apagada_no_hace_nada(self):
        for llave in ('', None, 'no', 'off', '1', 'true', 'sí'):
            red = S.RedFalsa({})
            r = tuberia.correr(red, self.alm, ahora=AHORA, llave=llave, log=SILENCIO)
            self.assertFalse(r['hecho'])
            self.assertEqual(red.pedidos, 0)
            self.assertEqual((self.alm.lecturas, self.alm.escrituras), (0, 0))

    def test_apagada_desde_el_colector(self):
        import colector
        env = {'MODELOS_LLAVE': ''}                        # sin llaves de R2: si intentara armar el almacén, fallaría
        self.assertEqual(colector.main([], env), 0)
        self.assertEqual(colector.main(['--chequeo'], env), 0)

    def test_control_negativo_prendida_si_hace(self):
        red = S.RedFalsa(S.servidor(C, fuentes=('gfs',), horas=()))
        tuberia.correr(red, self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertGreater(red.pedidos, 0)


class TestParcialYReintentos(Carpeta):
    def test_falta_un_cuadro_y_despues_llega(self):
        falta = {('gfs', 'cape', 60)}
        red = S.RedFalsa(S.servidor(C, fuentes=('gfs',), faltar=falta))
        tuberia.correr(red, self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        s = _j(self.alm, 'v1/gfs/2026111612/corrida.json')
        self.assertEqual(s['estado'], 'parcial')
        self.assertEqual(s['faltan'], {'lluvia6h': [], 'cape': [60]})
        i = _j(self.alm, tuberia.K_INDICE)
        self.assertIsNone(i['fuentes']['gfs']['ultima'])          # una parcial nunca es «la última»
        self.assertEqual(i['fuentes']['gfs']['estados'], {'2026111612': 'parcial'})
        red2 = S.RedFalsa(S.servidor(C, fuentes=('gfs',)))
        l0 = self.alm.lecturas
        tuberia.correr(red2, self.alm, ahora=AHORA + timedelta(hours=1), llave='si', fuentes=[Gfs()], log=SILENCIO)
        s = _j(self.alm, 'v1/gfs/2026111612/corrida.json')
        self.assertEqual((s['estado'], s['intentos']), ('completa', 2))
        self.assertLessEqual(red2.pedidos, 3)                      # disponibilidad + .idx + el mensaje que faltaba
        self.assertLessEqual(self.alm.lecturas - l0, 6)            # no relee los 40 cuadros que el sobre ya tiene
        self.assertEqual(_j(self.alm, tuberia.K_INDICE)['fuentes']['gfs']['ultima'], '2026111612')

    def test_tope_de_intentos(self):
        arch = S.servidor(C, fuentes=('gfs',), faltar={('gfs', 'lluvia6h', 120)})
        for n in range(4):
            red = S.RedFalsa(arch)
            tuberia.correr(red, self.alm, ahora=AHORA + timedelta(minutes=n), llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertEqual(red.pedidos, 0)                           # la 4.ª pasada ya no le pide nada a la fuente
        self.assertEqual(_j(self.alm, 'v1/gfs/2026111612/corrida.json')['intentos'], tuberia.MAX_INTENTOS)

    def test_una_fuente_caida_no_frena_a_las_otras(self):
        red = S.RedFalsa(S.servidor(C, fuentes=('gfs',)))
        tuberia.correr(red, self.alm, ahora=AHORA, llave='si', fuentes=[Ecmwf(), Gfs()], log=SILENCIO)
        i = _j(self.alm, tuberia.K_INDICE)
        self.assertIsNone(i['fuentes']['ecmwf']['ultima'])
        self.assertEqual(i['fuentes']['gfs']['ultima'], '2026111612')
        self.assertEqual(self.alm.listar('v1/ecmwf/'), [])

    def test_no_publica_una_corrida_que_la_fuente_no_termino(self):
        arch = S.servidor(C, fuentes=('gfs',), horas=range(0, 115, 6))   # todavía no está la +120
        red = S.RedFalsa(arch)
        tuberia.correr(red, self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertEqual(self.alm.listar('v1/gfs/'), [])
        self.assertLessEqual(red.pedidos, 5)                       # sólo las preguntas de disponibilidad


class AlmacenQueFalla(AlmacenCarpeta):
    """falla al guardar el sobre (como un corte de R2 a mitad de la pasada) y anota cada escritura"""

    def __init__(self, raiz, fallar_sobre=True):
        super().__init__(raiz)
        self.fallar_sobre = fallar_sobre
        self.escritas = []

    def escribir(self, k, datos, tipo='application/json', cache=None, si_no_existe=False):
        if self.fallar_sobre and k.endswith('/corrida.json'):
            raise IOError('R2 escribir: HTTP 500')
        r = super().escribir(k, datos, tipo, cache, si_no_existe)
        if r:
            self.escritas.append(k)
        return r


class TestSinPisar(Carpeta):
    """[n3-312a 2] un cuadro publicado nunca se reescribe, aunque se haya perdido el sobre"""

    def test_falla_el_sobre_y_la_pasada_siguiente_recupera_sin_reescribir(self):
        arch = S.servidor(C, fuentes=('gfs',))
        a1 = AlmacenQueFalla(self.dir)
        with self.assertRaises(IOError):
            tuberia.correr(S.RedFalsa(arch), a1, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertEqual(len([k for k in a1.escritas if k.startswith('v1/') and k.endswith('.png')]), 41)
        self.assertEqual(len([k for k in a1.escritas if k.startswith('v2/') and k.endswith('.val.png')]), 41)   # [312c]
        self.assertIsNone(a1.leer('v1/gfs/2026111612/corrida.json'))
        a2 = AlmacenQueFalla(self.dir, fallar_sobre=False)
        red = S.RedFalsa(arch)
        tuberia.correr(red, a2, ahora=AHORA + timedelta(minutes=5), llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertEqual([k for k in a2.escritas if '/cape/' in k or '/lluvia6h/' in k], [])   # ni un PNG ni un JSON
        s = _j(a2, 'v1/gfs/2026111612/corrida.json')
        self.assertEqual(s['estado'], 'completa')
        self.assertEqual(len(s['firmas']), 41)
        self.assertEqual(sum(len(x) for x in s['valores'].values()), 41)   # [312c] la v2 también se recupera
        self.assertEqual(red.pedidos, 1)                          # sólo la disponibilidad: no se bajó nada
        self.assertEqual(_j(a2, tuberia.K_INDICE)['fuentes']['gfs']['ultima'], '2026111612')

    def test_control_negativo_png_distinto_ya_publicado_no_se_pisa(self):
        k = 'v1/gfs/2026111612/cape/006.png'
        self.alm.escribir(k, b'otro png ya en la cache del borde')
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',))), self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()],
                       log=SILENCIO)
        self.assertEqual(self.alm.leer(k), b'otro png ya en la cache del borde')
        self.assertIsNone(self.alm.leer('v1/gfs/2026111612/cape/006.json'))
        s = _j(self.alm, 'v1/gfs/2026111612/corrida.json')
        self.assertEqual((s['estado'], s['faltan']['cape']), ('parcial', [6]))

    def test_png_igual_ya_publicado_sigue_con_el_json(self):
        a0 = AlmacenCarpeta(tempfile.mkdtemp(prefix='modelos-ref-'))
        try:
            tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',))), a0, ahora=AHORA, llave='si', fuentes=[Gfs()],
                           log=SILENCIO)
            k = 'v1/gfs/2026111612/cape/006.png'
            self.alm.escribir(k, a0.leer(k))                          # quedó el PNG; falló el JSON
        finally:
            shutil.rmtree(a0.raiz, ignore_errors=True)
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',))), self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()],
                       log=SILENCIO)
        self.assertEqual(_j(self.alm, 'v1/gfs/2026111612/corrida.json')['estado'], 'completa')
        self.assertIsNotNone(self.alm.leer('v1/gfs/2026111612/cape/006.json'))


class TestRetencion(Carpeta):
    def test_guarda_las_ultimas_8(self):
        i = tuberia.indice_vacio()
        viejas = [(C - timedelta(hours=6 * k)).strftime('%Y%m%d%H') for k in range(1, 9)]
        for cc in viejas:
            i['fuentes']['gfs']['corridas'].append(cc)
            i['fuentes']['gfs']['estados'][cc] = 'completa'
            self.alm.escribir('v1/gfs/%s/corrida.json' % cc, b'{"estado":"completa"}')
            self.alm.escribir('v1/gfs/%s/cape/000.png' % cc, b'x')
        self.alm.escribir(tuberia.K_INDICE, json.dumps(i).encode())
        red = S.RedFalsa(S.servidor(C, fuentes=('gfs',)))
        r = tuberia.correr(red, self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        n = _j(self.alm, tuberia.K_INDICE)['fuentes']['gfs']
        self.assertEqual(n['corridas'], ['2026111612'] + viejas[:7])
        self.assertEqual(n['ultima'], '2026111612')
        self.assertEqual(self.alm.listar('v1/gfs/%s/' % viejas[7]), [])     # la novena salió de R2
        self.assertEqual(r['borrados'], 2)
        self.assertTrue(self.alm.listar('v1/gfs/%s/' % viejas[6]))

    def test_control_negativo_sin_corrida_nueva_no_borra(self):
        i = tuberia.indice_vacio()
        for k in range(1, 9):
            cc = (C - timedelta(hours=6 * k)).strftime('%Y%m%d%H')
            i['fuentes']['gfs']['corridas'].append(cc)
            i['fuentes']['gfs']['estados'][cc] = 'completa'
        self.alm.escribir(tuberia.K_INDICE, json.dumps(i).encode())
        r = tuberia.correr(S.RedFalsa({}), self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)
        self.assertEqual(r['borrados'], 0)
        self.assertEqual(len(_j(self.alm, tuberia.K_INDICE)['fuentes']['gfs']['corridas']), 8)


class TestChequeo(Carpeta):
    def test_hay_trabajo_y_despues_no(self):
        import colector
        arch = S.servidor(C, fuentes=('icon',))
        env = {'MODELOS_LLAVE': 'si', 'MODELOS_FUENTES': 'icon'}
        self.assertTrue(colector.chequeo(env, S.RedFalsa(arch), self.alm, ahora=AHORA, log=SILENCIO))
        tuberia.correr(S.RedFalsa(arch), self.alm, ahora=AHORA, llave='si', fuentes=[Icon()], log=SILENCIO)
        red = S.RedFalsa(arch)
        self.assertFalse(colector.chequeo(env, red, self.alm, ahora=AHORA, log=SILENCIO))
        self.assertEqual(red.pedidos, 0)


if __name__ == '__main__':
    unittest.main()
