"""[312d] EL VIENTO (u y v, sólo en la v2) para el viento animado de MODELOS en SATCHI: la codificación, cada fuente con su nivel (y no
el señuelo de 500 hPa), u arriba y v abajo, el sobre, la idempotencia, los topes y, sobre todo, que EL V1 SALGA SIEMPRE aunque el
viento falle (al bajar, al armar, al publicar, con un error inesperado o cortado a la mitad). Control negativo: test/control_negativo.py."""
import json
import shutil
import tempfile
import unittest
from datetime import timedelta

import numpy as np

import base  # noqa: F401

import sintetico as S
import colector
from lib import fuentes as F, malla, tuberia, valores
from lib.almacen import AlmacenCarpeta
from lib.fuentes import Ecmwf, Gfs, Icon

C = S.CORRIDA0
CC = '2026111612'
AHORA = C + timedelta(hours=8)
SILENCIO = lambda *a: None  # noqa: E731
TODAS = ('ecmwf', 'icon', 'gfs')


def _j(alm, k):
    b = alm.leer(k)
    return json.loads(b.decode()) if b else None


def _uv(alm, f, nivel, h):
    return valores.decodificar_viento(valores.leer_png16(alm.leer('v2/%s/%s/%s/%03d.val.png' % (f, CC, nivel, h))))


def _v1(alm, f):
    """todo lo del v1 de una corrida: cada cuadro (bytes) y el sobre sin lo del viento"""
    out = {k: alm.leer(k) for k in alm.listar('v1/%s/%s/' % (f, CC)) if not k.endswith('corrida.json')}
    s = _j(alm, 'v1/%s/%s/corrida.json' % (f, CC))
    for k in ('viento', 'viento_fallan', 'viento_intentos', 'viento_cerrado', 'pedidos_viento', 'bytes_viento', 'pedidos', 'bytes_bajados'):
        s.pop(k, None)
    out['sobre'] = s
    return out


class Carpeta(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='modelos-viento-')
        self.alm = AlmacenCarpeta(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class TestCodificacion(unittest.TestCase):
    def test_ida_y_vuelta_u_arriba_v_abajo_con_nan_y_signos(self):
        u = np.array([[12.34, -7.0], [np.nan, 0.04]])
        v = np.array([[-3.21, 99.9], [0.0, -0.06]])
        q = valores.codificar_viento(u, v)
        self.assertEqual(q.shape, (4, 2))
        self.assertEqual(q.dtype, np.uint16)
        self.assertEqual(q[0].tolist(), [32768 + 123, 32768 - 70])           # u arriba
        self.assertEqual(q[2].tolist(), [32768 - 32, 32768 + 999])           # v abajo
        self.assertEqual(int(q[1, 0]), 65535)                                # NaN → «sin dato»
        u2, v2 = valores.decodificar_viento(q)
        self.assertTrue(np.isnan(u2[1, 0]))
        self.assertAlmostEqual(u2[0, 0], 12.3)
        self.assertAlmostEqual(v2[0, 1], 99.9)
        self.assertAlmostEqual(v2[1, 1], -0.1)                               # el signo se conserva
        b = valores.png16(q)
        self.assertTrue(np.array_equal(valores.leer_png16(b), q))
        self.assertEqual(valores.png16(q), b)                                # mismos datos → mismos bytes


class TestPuntaAPunta(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix='modelos-viento-e2e-')
        cls.alm = AlmacenCarpeta(cls.dir)
        cls.red = S.RedFalsa(S.servidor(C, viento=True))
        cls.r = tuberia.correr(cls.red, cls.alm, ahora=AHORA, llave='si', log=SILENCIO, viento=TODAS)
        cls.dir0 = tempfile.mkdtemp(prefix='modelos-sin-viento-')
        cls.alm0 = AlmacenCarpeta(cls.dir0)
        tuberia.correr(S.RedFalsa(S.servidor(C, viento=True)), cls.alm0, ahora=AHORA, llave='si', log=SILENCIO)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)
        shutil.rmtree(cls.dir0, ignore_errors=True)

    def test_claves_horas_y_sobre(self):
        for f, horas in (('ecmwf', range(0, 121, 6)), ('gfs', range(0, 121, 6)), ('icon', range(0, 121, 12))):
            s = _j(self.alm, 'v1/%s/%s/corrida.json' % (f, CC))
            self.assertEqual(s['estado'], 'completa', f)
            for n in F.NIVELES_VIENTO:
                self.assertEqual(s['viento'][n], list(horas), (f, n))
                self.assertEqual(s['viento_fallan'][n], [], (f, n))
                ks = self.alm.listar('v2/%s/%s/%s/' % (f, CC, n))
                self.assertEqual(len([k for k in ks if k.endswith('.val.png')]), len(horas))
                self.assertEqual(len([k for k in ks if k.endswith('.val.json')]), len(horas))
            self.assertEqual(s['viento_intentos'], 1)
        self.assertEqual(self.alm.cache['v2/gfs/%s/viento850/006.val.png' % CC], tuberia.CACHE_CUADRO)

    def test_el_v1_es_identico_con_y_sin_viento(self):
        for f in TODAS:
            self.assertEqual(_v1(self.alm, f), _v1(self.alm0, f), f)
            self.assertNotIn('viento', _j(self.alm0, 'v1/%s/%s/corrida.json' % (f, CC)))   # sin la fase, nada de viento

    def test_u_y_v_de_la_fuente_en_cada_nodo_y_en_su_nivel(self):
        la, lo = malla.nodos_v2()
        LA, LO = np.meshgrid(la, lo, indexing='ij')
        for f in ('ecmwf', 'gfs'):
            for n in F.NIVELES_VIENTO:
                for h in (0, 54, 120):
                    u, v = _uv(self.alm, f, n, h)
                    self.assertEqual(u.shape, (malla.grilla_v2()['nlat'], malla.grilla_v2()['nlon']))   # la caja de la v2 (CAJA_V2), no un número fijo
                    self.assertLess(np.abs(u - S.viento_u(LA, LO, h, n)).max(), 0.06, (f, n, h))   # 0,1 m/s de paso + las 2 decimales del GRIB
                    self.assertLess(np.abs(v - S.viento_v(LA, LO, h, n)).max(), 0.06, (f, n, h))
        # el señuelo de 500 hPa es −u de 250: si se tomara, el error sería de decenas de m/s
        u, _ = _uv(self.alm, 'gfs', 'viento250', 12)
        self.assertGreater(np.abs(u + S.viento_u(LA, LO, 12, 'viento250')).min(), 1.0)

    def test_icon_el_centro_de_celda_mas_cercano(self):
        cla, clo = S.celdas_icon()
        M = malla.MallaIcon(np.round(cla, 5), np.round(clo, 5), S.UUID_ICON.hex())   # las CLAT/CLON viajan con 5 decimales
        for n in ('viento10m', 'viento250'):
            u, v = _uv(self.alm, 'icon', n, 24)
            esp_u = S.viento_u(cla, clo, 24, n)[M.indice_v2]
            esp_v = S.viento_v(cla, clo, 24, n)[M.indice_v2]
            self.assertLess(np.abs(u - esp_u).max(), 0.06, n)
            self.assertLess(np.abs(v - esp_v).max(), 0.06, n)

    def test_el_json(self):
        m = _j(self.alm, 'v2/ecmwf/%s/viento850/012.val.json' % CC)
        self.assertEqual((m['v'], m['fuente'], m['variable'], m['hora_pronostico'], m['corrida']), (2, 'ecmwf', 'viento850', 12, CC))
        self.assertEqual((m['unidades'], m['paleta'], m['nivel']), ('m/s', 'viento-continua-v2', {'tipo': 'isobárico', 'hPa': 850}))
        self.assertEqual((m['valores']['escala'], m['valores']['cero'], m['valores']['sin_dato'], m['valores']['png']), (0.1, 32768, 65535, '012.val.png'))
        self.assertEqual(m['valores']['componentes'], ['u', 'v'])
        self.assertEqual(m['grilla'], malla.grilla_v2())
        self.assertEqual(m['valida_iso'], '2026-11-17T00:00Z')
        self.assertIsNone(m['periodo'])
        self.assertIsNone(m['cape_tipo'])
        self.assertIn('ECMWF', m['cita']['texto'])
        self.assertEqual(m['aviso'], 'PRONÓSTICO del modelo ECMWF IFS, corrida 16/11 12 UTC: no es observación ni aviso oficial.')
        self.assertEqual(_j(self.alm, 'v2/icon/%s/viento10m/000.val.json' % CC)['nivel'], {'tipo': 'altura sobre el suelo', 'm': 10})

    def test_el_indice_de_ecmwf_y_gfs_no_se_pide_de_nuevo(self):
        s = _j(self.alm, 'v1/ecmwf/%s/corrida.json' % CC)
        self.assertEqual(s['pedidos_viento'], 126)    # 21 horas × 3 niveles × 2 componentes: sólo los rangos
        self.assertEqual(_j(self.alm, 'v1/icon/%s/corrida.json' % CC)['pedidos_viento'], 66)

    def test_idempotente(self):
        red = S.RedFalsa(S.servidor(C, viento=True))
        n0 = self.alm.escrituras
        tuberia.correr(red, self.alm, ahora=AHORA, llave='si', log=SILENCIO, viento=TODAS)
        self.assertEqual(red.pedidos, 0)                 # corridas terminadas y con todo su viento: ni un pedido
        self.assertEqual(self.alm.escrituras, n0)


class TestElV1SaleSiempre(Carpeta):
    def _indice_ok(self):
        ix = _j(self.alm, 'v1/indice.json')
        for f in ('ecmwf', 'gfs'):
            self.assertEqual(ix['fuentes'][f]['ultima'], CC, f)
            s = _j(self.alm, 'v1/%s/%s/corrida.json' % (f, CC))
            self.assertEqual(s['estado'], 'completa', f)
            self.assertEqual(len(s['firmas']), 41, f)
        return ix

    def test_la_fuente_no_tiene_viento(self):
        log = []
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('ecmwf', 'gfs'))), self.alm, ahora=AHORA, llave='si', log=log.append,
                       fuentes=[Ecmwf(), Gfs()], viento=TODAS)
        self._indice_ok()
        s = _j(self.alm, 'v1/gfs/%s/corrida.json' % CC)
        self.assertEqual(s['viento']['viento10m'], [])
        self.assertEqual(s['viento_fallan']['viento10m'], [0, 6, 12])     # 3 seguidas y se corta
        self.assertTrue(any('cortado' in l for l in log))

    def test_un_error_inesperado_al_armar_el_viento(self):
        class Rota(Gfs):
            def viento(self, *a):
                raise RuntimeError('algo que nadie esperaba')
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('ecmwf', 'gfs'), viento=True)), self.alm, ahora=AHORA, llave='si',
                       log=SILENCIO, fuentes=[Ecmwf(), Rota()], viento=TODAS)
        self._indice_ok()
        self.assertEqual(_j(self.alm, 'v1/ecmwf/%s/corrida.json' % CC)['viento']['viento250'], list(range(0, 121, 6)))

    def test_error_inesperado_fuera_de_cada_cuadro(self):
        """aunque procesar_viento entero lance para una fuente (no sólo un cuadro), el índice del v1 está y la OTRA fuente tiene viento"""
        orig = tuberia.procesar_viento

        def rota(f, *a, **k):
            if f.id == 'gfs':
                raise MemoryError('sin memoria')
            return orig(f, *a, **k)
        tuberia.procesar_viento = rota
        try:
            tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('ecmwf', 'gfs'), viento=True)), self.alm, ahora=AHORA, llave='si',
                           log=SILENCIO, fuentes=[Gfs(), Ecmwf()], viento=TODAS)
        finally:
            tuberia.procesar_viento = orig
        self._indice_ok()
        s = _j(self.alm, 'v1/ecmwf/%s/corrida.json' % CC)
        self.assertEqual(s['viento']['viento250'], list(range(0, 121, 6)))
        self.assertTrue(s['viento_cerrado'])
        self.assertEqual(_j(self.alm, 'v1/indice.json')['fuentes']['ecmwf']['viento'], {CC: 'cerrado'})

    def test_r2_falla_al_publicar_el_viento(self):
        class SinViento(AlmacenCarpeta):
            def escribir(self, k, *a, **kw):
                if '/viento' in k and k.startswith('v2/'):
                    raise IOError('R2 caído para el viento')
                return super().escribir(k, *a, **kw)
        self.alm = SinViento(self.dir)
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('ecmwf', 'gfs'), viento=True)), self.alm, ahora=AHORA, llave='si',
                       log=SILENCIO, fuentes=[Ecmwf(), Gfs()], viento=TODAS)
        self._indice_ok()

    def test_cortado_a_la_mitad_el_sobre_del_v1_ya_estaba(self):
        """una pasada que muere en la mitad del viento (el workflow se corta): el sobre del v1 ya está escrito y la siguiente
        pasada publica el índice"""
        class Muere(Gfs):
            def viento(self, *a):
                raise KeyboardInterrupt('el job se cortó')
        with self.assertRaises(KeyboardInterrupt):
            tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('ecmwf', 'gfs'), viento=True)), self.alm, ahora=AHORA, llave='si',
                           log=SILENCIO, fuentes=[Ecmwf(), Muere()], viento=TODAS)
        s = _j(self.alm, 'v1/gfs/%s/corrida.json' % CC)
        self.assertEqual((s['estado'], len(s['firmas'])), ('completa', 41))   # el v1, entero y anotado ANTES del viento
        self._indice_ok()   # [Codex n3-312d-col] Y EL ÍNDICE: se escribió antes de la fase del viento
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('ecmwf', 'gfs'), viento=True)), self.alm, ahora=AHORA, llave='si',
                       log=SILENCIO, fuentes=[Ecmwf(), Gfs()], viento=TODAS)
        self._indice_ok()

    def test_el_tope_de_tiempo_corta_el_viento_y_no_el_v1(self):
        t = [0.0]

        def reloj():
            t[0] += 7.0
            return t[0]
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('ecmwf', 'gfs'), viento=True)), self.alm, ahora=AHORA, llave='si',
                       log=SILENCIO, fuentes=[Ecmwf(), Gfs()], viento=TODAS, viento_tope_s=60, reloj=reloj)
        self._indice_ok()
        s = _j(self.alm, 'v1/ecmwf/%s/corrida.json' % CC)
        self.assertLess(sum(len(x) for x in s['viento'].values()), 63)

    def test_los_intentos_tienen_tope(self):
        for _ in range(5):
            tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',))), self.alm, ahora=AHORA, llave='si', log=SILENCIO,
                           fuentes=[Gfs()], viento=TODAS)
        s = _j(self.alm, 'v1/gfs/%s/corrida.json' % CC)
        self.assertEqual(s['viento_intentos'], tuberia.VIENTO_MAX_INTENTOS)
        red = S.RedFalsa(S.servidor(C, fuentes=('gfs',)))
        tuberia.correr(red, self.alm, ahora=AHORA, llave='si', log=SILENCIO, fuentes=[Gfs()], viento=TODAS)
        self.assertEqual(red.pedidos, 0)

    def test_otro_nivel_o_unidades_no_pasan(self):
        """un 250 hPa que en la cabecera es 500, o un viento en cm/s: ese cuadro falta (el v1 entero)"""
        A = S.servidor(C, fuentes=('ecmwf',), viento=True)
        E = Ecmwf()
        for h in range(0, 121, 6):
            L = [json.loads(x) for x in A[E._url(C, h, 'index')].decode().splitlines()]
            for x in L:   # el señuelo de 500 hPa pasa a llamarse 250, y el bueno de 250 a 300
                if x.get('levelist') == '250':
                    x['levelist'] = '300'
                elif x.get('levelist') == '500':
                    x['levelist'] = '250'
            A[E._url(C, h, 'index')] = '\n'.join(json.dumps(x) for x in L).encode()
        tuberia.correr(S.RedFalsa(A), self.alm, ahora=AHORA, llave='si', log=SILENCIO, fuentes=[Ecmwf()], viento=('ecmwf',))
        s = _j(self.alm, 'v1/ecmwf/%s/corrida.json' % CC)
        self.assertEqual(s['estado'], 'completa')
        self.assertEqual(s['viento']['viento250'], [])
        self.assertEqual(s['viento']['viento850'], list(range(0, 121, 6)))
        E = Ecmwf()
        with self.assertRaises(F.ErrorFuente):
            E._chequear_viento(np.full((2, 2), 300.0), np.zeros((2, 2)))

    def test_el_nivel_de_la_cabecera_grib_manda(self):
        """el índice dice 250 hPa pero la cabecera de u Y de v dice 500 hPa: ese nivel no sale (el resto, sí; el v1, entero)"""
        orig = S._nv
        S._nv = lambda n: (100, 50000) if n == 'viento250' else orig(n)
        try:
            A = S.servidor(C, fuentes=('ecmwf',), viento=True)
        finally:
            S._nv = orig
        tuberia.correr(S.RedFalsa(A), self.alm, ahora=AHORA, llave='si', log=SILENCIO, fuentes=[Ecmwf()], viento=('ecmwf',))
        s = _j(self.alm, 'v1/ecmwf/%s/corrida.json' % CC)
        self.assertEqual(s['estado'], 'completa')
        self.assertEqual(s['viento']['viento10m'], list(range(0, 121, 6)))
        self.assertEqual(s['viento']['viento850'], list(range(0, 121, 6)))
        self.assertEqual(s['viento']['viento250'], [])

    def test_un_viento_distinto_ya_publicado_no_se_pisa(self):
        k = 'v2/gfs/%s/viento10m/006.val.png' % CC
        g = malla.grilla_v2()
        otro = valores.png16(valores.codificar_viento(np.zeros((g['nlat'], g['nlon'])), np.zeros((g['nlat'], g['nlon']))))
        self.alm.escribir(k, otro, 'image/png')
        tuberia.correr(S.RedFalsa(S.servidor(C, fuentes=('gfs',), viento=True)), self.alm, ahora=AHORA, llave='si', log=SILENCIO,
                       fuentes=[Gfs()], viento=('gfs',))
        self.assertEqual(self.alm.leer(k), otro)
        s = _j(self.alm, 'v1/gfs/%s/corrida.json' % CC)
        self.assertNotIn(6, s['viento']['viento10m'])
        self.assertEqual(s['viento_fallan']['viento10m'], [6])
        self.assertEqual(s['estado'], 'completa')

    def test_el_plazo_es_real_tambien_dentro_de_un_pedido(self):
        """un pedido que se demora (la red «gotea») no estira el plazo: red.hasta corta el siguiente; el índice del v1 ya estaba"""
        t = [0.0]

        class Lenta(S.RedFalsa):
            def get(self, url, rango=None):
                if '/viento' not in url and getattr(self, 'hasta', None) is not None and not url.endswith(('.index', '.idx')):
                    t[0] += 50.0                                   # cada mensaje de viento «tarda» 50 s
                    if t[0] > self.hasta:
                        raise S.ErrorRedFalsa('plazo vencido')
                return super().get(url, rango)
        tuberia.correr(Lenta(S.servidor(C, fuentes=('ecmwf',), viento=True)), self.alm, ahora=AHORA, llave='si', log=SILENCIO,
                       fuentes=[Ecmwf()], viento=('ecmwf',), viento_tope_s=120, reloj=lambda: t[0])
        ix = _j(self.alm, 'v1/indice.json')
        self.assertEqual(ix['fuentes']['ecmwf']['ultima'], CC)
        s = _j(self.alm, 'v1/ecmwf/%s/corrida.json' % CC)
        self.assertLess(sum(len(x) for x in s['viento'].values()), 3)
        self.assertFalse(s['viento_cerrado'])

    def test_red_con_plazo(self):
        from lib.red import Red, ErrorRed
        t = [0.0]

        class Cuerpo:
            status = 200
            headers = None

            def __init__(self):
                self.n = 0

            def read(self, k=-1):
                t[0] += 10.0                                        # cada bloque «tarda» 10 s
                self.n += 1
                return b'x' * 10 if self.n < 100 else b''

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        r = Red(pausa=0, abrir=lambda req, timeout: Cuerpo(), dormir=lambda s: None)
        r.hasta, r.reloj = 35.0, lambda: t[0]
        with self.assertRaises(ErrorRed):
            r.get('https://x.test/a')                               # se corta al vencer, aunque el servidor siga mandando
        self.assertLess(t[0], 60)
        with self.assertRaises(ErrorRed):
            r.get('https://x.test/b')                               # vencido: no empieza
        r.hasta = None
        self.assertEqual(len(r.get('https://x.test/c')), 10)                 # sin plazo, como siempre


class TestChequeoViento(Carpeta):
    def test_terminada_sin_indice_es_trabajo(self):
        arch = S.servidor(C, fuentes=('gfs',), viento=True)
        env = {'MODELOS_LLAVE': 'si', 'MODELOS_FUENTES': 'gfs'}
        tuberia.correr(S.RedFalsa(arch), self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO, viento=('gfs',))
        self.assertFalse(colector.chequeo(env, S.RedFalsa(arch), self.alm, ahora=AHORA, log=SILENCIO))   # todo hecho: nada
        self.alm.borrar('v1/indice.json')                                                                   # una pasada cortada
        self.assertTrue(colector.chequeo(env, S.RedFalsa(arch), self.alm, ahora=AHORA, log=SILENCIO))

    def test_viento_pendiente_es_trabajo(self):
        arch = S.servidor(C, fuentes=('gfs',), viento=True)
        env = {'MODELOS_LLAVE': 'si', 'MODELOS_FUENTES': 'gfs'}
        tuberia.correr(S.RedFalsa(arch), self.alm, ahora=AHORA, llave='si', fuentes=[Gfs()], log=SILENCIO)   # sin la fase del viento
        self.assertTrue(colector.chequeo(env, S.RedFalsa(arch), self.alm, ahora=AHORA, log=SILENCIO))
        self.assertFalse(colector.chequeo(dict(env, MODELOS_VIENTO='no'), S.RedFalsa(arch), self.alm, ahora=AHORA, log=SILENCIO))


class TestColector(unittest.TestCase):
    def test_el_viento_va_por_defecto_y_se_puede_apagar(self):
        fs = [Ecmwf(), Icon(), Gfs()]
        self.assertEqual(colector.viento_de({}, fs), TODAS)
        self.assertEqual(colector.viento_de({'MODELOS_VIENTO': 'no'}, fs), ())
        self.assertEqual(colector.viento_de({'MODELOS_VIENTO': 'gfs,ecmwf'}, fs), ('ecmwf', 'gfs'))
        self.assertEqual(colector.viento_de({'MODELOS_VIENTO': 'icon'}, [Gfs()]), ())
        with self.assertRaises(SystemExit):
            colector.viento_de({'MODELOS_VIENTO': 'gfz'}, fs)

    def test_el_colector_le_pasa_el_viento_a_la_tuberia(self):
        visto = {}
        orig = tuberia.correr
        tuberia.correr = lambda *a, **k: visto.update(k)
        try:
            env = {'MODELOS_LLAVE': 'si', 'ALMACEN_CARPETA': tempfile.mkdtemp(prefix='modelos-col-'), 'MODELOS_FUENTES': 'gfs,icon'}
            colector.main([], env)
        finally:
            tuberia.correr = orig
            shutil.rmtree(env['ALMACEN_CARPETA'], ignore_errors=True)
        self.assertEqual([f.id for f in visto['fuentes']], ['gfs', 'icon'])
        self.assertEqual(visto['viento'], ('gfs', 'icon'))


if __name__ == '__main__':
    unittest.main()
