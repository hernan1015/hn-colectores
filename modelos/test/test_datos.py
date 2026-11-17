"""el GRIB, el recorte, la lluvia de 6 h por diferencia y el regrillado de ICON (sin red: GRIB sintéticos)."""
import bz2
import unittest
from datetime import timedelta

import base  # noqa: F401
import numpy as np

import sintetico as S
from lib import grib, malla
from lib.fuentes import Ecmwf, ErrorFuente, Gfs, Icon

C = S.CORRIDA0


class TestGrib(unittest.TestCase):
    def test_cabecera_y_valores(self):
        LA, LO = S.coords_regular(S.MALLA_ECMWF)
        v = S.cape(LA, LO, 6)
        c = grib.leer(S.mensaje(v, S.MALLA_ECMWF, C, 7, 6, paso=6, nivel1=(17, None), decimales=1),
                      corrida=C, paso_h=6, parametro=(0, 7, 6))
        self.assertEqual(c['malla']['Ni'], 141)
        self.assertEqual(c['malla']['lo1'], -78.0)
        self.assertEqual(c['nivel1'][0], 17)
        self.assertLess(np.abs(c['valores'] - v.ravel()).max(), 0.06)

    def test_acumulacion_en_minutos(self):
        la, lo = S.celdas_icon(paso=1.0)
        c = grib.leer(S.mensaje(la, {'tipo': 'icosaedrica'}, C, 1, 52, centro=78, unidad=0, acum=(0, 720)))
        self.assertEqual(c['acum_h'], (0, 12))
        self.assertEqual(c['malla']['uuid'], S.UUID_ICON.hex())

    def test_faltantes_por_mapa_de_bits(self):
        LA, LO = S.coords_regular(S.MALLA_GFS)
        f = np.zeros(LA.shape, bool)
        f[5, 7] = True
        c = grib.leer(S.mensaje(S.cape(LA, LO, 0), S.MALLA_GFS, C, 7, 6, centro=7, faltantes=f))
        self.assertTrue(np.isnan(c['valores'].reshape(LA.shape)[5, 7]))
        self.assertEqual(int(np.isnan(c['valores']).sum()), 1)

    def test_control_negativo_validaciones(self):
        LA, LO = S.coords_regular(S.MALLA_ECMWF)
        m = S.mensaje(S.cape(LA, LO, 6), S.MALLA_ECMWF, C, 7, 6, paso=6)
        with self.assertRaises(grib.ErrorGrib):
            grib.leer(m, paso_h=12)                                  # otro paso
        with self.assertRaises(grib.ErrorGrib):
            grib.leer(m, corrida=C - timedelta(hours=6))             # otra corrida
        with self.assertRaises(grib.ErrorGrib):
            grib.leer(m, parametro=(0, 1, 8))                        # otro parámetro
        with self.assertRaises(grib.ErrorGrib):
            grib.leer(m, acum_h=(0, 6))                              # no es una acumulación
        with self.assertRaises(grib.ErrorGrib):
            grib.separar(m[:-10])                                    # mensaje cortado


class TestRecorte(unittest.TestCase):
    def _salida(self, m, f):
        LA, LO = S.coords_regular(m)
        sub, la, lo = malla.recortar(f(LA, LO), m)
        return sub, la, lo, malla.regular_a_salida(sub, la, lo)

    def test_recorte_solo_la_caja(self):
        for m in (S.MALLA_ECMWF, S.MALLA_GFS):
            sub, la, lo, _ = self._salida(m, lambda a, b: a + b)
            self.assertGreaterEqual(la.min(), -57.0)
            self.assertLessEqual(la.max(), -14.0)
            self.assertGreaterEqual(lo.min(), -77.0)
            self.assertLessEqual(lo.max(), -44.0)
            self.assertEqual(sub.shape, (len(la), len(lo)))

    def test_vecino_mas_cercano_pixel_a_pixel(self):
        """cada píxel tiene el valor de la celda 0,25° más cercana; vale igual con lon 0..360 (GFS) y −180..180 (ECMWF)"""
        f = lambda a, b: np.round(a * 1000) + np.round(b * 4)          # noqa: E731  (único por celda)
        lat_s, lon_s = malla.centros_salida()
        esperado = f(np.round(lat_s * 4)[:, None] / 4, np.round(lon_s * 4)[None, :] / 4)
        for m in (S.MALLA_ECMWF, S.MALLA_GFS):
            _, _, _, out = self._salida(m, f)
            self.assertEqual(out.shape, (malla.ALTO, malla.ANCHO))
            np.testing.assert_array_equal(out, esperado)

    def test_malla_de_salida_mercator(self):
        lat_s, lon_s = malla.centros_salida()
        self.assertEqual((malla.ANCHO, malla.ALTO), (248, 422))
        y = malla.merc_y(lat_s)
        self.assertLess(np.ptp(np.diff(y)), 1e-3)                    # filas equiespaciadas en Y de Mercator
        self.assertGreater(np.ptp(np.diff(lat_s)), 0.01)              # y por eso NO en latitud
        self.assertAlmostEqual(lon_s[0], -75.9375)

    def test_sur_a_norte(self):
        m = dict(S.MALLA_ECMWF, la1=-58.0, scan=0x40)
        LA, LO = S.coords_regular(m)
        sub, la, lo = malla.recortar(LA, m)
        out = malla.regular_a_salida(sub, la, lo)
        lat_s, _ = malla.centros_salida()
        self.assertLess(np.abs(out[:, 0] - lat_s).max(), 0.126)

    def test_control_negativo_caja_afuera(self):
        m = dict(S.MALLA_ECMWF, la1=60.0)
        with self.assertRaises(ValueError):
            malla.recortar(np.zeros(m['Ni'] * m['Nj']), m)
        m2 = dict(S.MALLA_ECMWF, Ni=60)                               # no llega al este de la caja
        LA, LO = S.coords_regular(m2)
        sub, la, lo = malla.recortar(LA, m2)
        with self.assertRaises(ValueError):
            malla.regular_a_salida(sub, la, lo)


class TestLluvia6h(unittest.TestCase):
    def _esperado(self, h):
        lat_s, lon_s = malla.centros_salida()
        LA = np.round(lat_s * 4)[:, None] / 4 + 0 * lon_s[None, :]
        LO = np.round(lon_s * 4)[None, :] / 4 + 0 * lat_s[:, None]
        return S.lluvia_total(LA, LO, h) - S.lluvia_total(LA, LO, h - 6)

    def test_ecmwf_por_diferencia(self):
        red = S.RedFalsa(S.servidor(C, fuentes=('ecmwf',), horas=(0, 6, 12)))
        E = Ecmwf()
        E.nuevo(C)
        a6, _ = E.cuadro(red, C, 'lluvia6h', 6)
        a12, info = E.cuadro(red, C, 'lluvia6h', 12)
        self.assertLess(np.abs(a6 - self._esperado(6)).max(), 0.01)
        self.assertLess(np.abs(a12 - self._esperado(12)).max(), 0.01)
        self.assertIn('tp(+12 h) − tp(+6 h)', info['parametro_fuente'])
        # control negativo: la acumulada total NO es la de 6 h
        self.assertGreater(np.abs(a12 - (self._esperado(12) + self._esperado(6))).max(), 1.0)

    def test_gfs_balde_directo(self):
        red = S.RedFalsa(S.servidor(C, fuentes=('gfs',), horas=(6, 12)))
        G = Gfs()
        G.nuevo(C)
        a12, _ = G.cuadro(red, C, 'lluvia6h', 12)
        self.assertLess(np.abs(a12 - self._esperado(12)).max(), 0.01)

    def test_icon_por_diferencia_en_la_malla_nativa(self):
        red = S.RedFalsa(S.servidor(C, fuentes=('icon',), horas=(6, 12)))
        I = Icon()
        I.nuevo(C)
        a12, info = I.cuadro(red, C, 'lluvia6h', 12)
        la, lo = S.celdas_icon()
        M = I._cache['malla']
        esperado = (S.lluvia_total(la, lo, 12) - S.lluvia_total(la, lo, 6))[M.indice]
        self.assertLess(np.abs(a12 - esperado).max(), 0.01)
        self.assertIn('vecino más cercano', info['regrillado'])

    def test_control_negativo_acumulacion_equivocada(self):
        """si la fuente pone otra acumulación en el lugar pedido, el cuadro no sale"""
        A = S.servidor(C, fuentes=('icon',), horas=(6, 12))
        I = Icon()
        la, lo = S.celdas_icon()
        A[I._url(C, 12, 'TOT_PREC')] = bz2.compress(S.mensaje(S.lluvia_total(la, lo, 12), {'tipo': 'icosaedrica'}, C,
                                                              1, 52, centro=78, unidad=0, acum=(360, 360)))
        I.nuevo(C)
        with self.assertRaises(grib.ErrorGrib):
            I.cuadro(S.RedFalsa(A), C, 'lluvia6h', 12)

    def test_control_negativo_unidades(self):
        """tp en mm en vez de m daría 1000 veces más: se rechaza"""
        A = S.servidor(C, fuentes=('ecmwf',), horas=(6,))
        E = Ecmwf()
        LA, LO = S.coords_regular(S.MALLA_ECMWF)
        A[E._url(C, 6, 'grib2')] = S.mensaje(S.lluvia_total(LA, LO, 6) * 10, S.MALLA_ECMWF, C, 1, 193, acum=(0, 6))
        A[E._url(C, 6, 'index')] = b'{"param":"tp","levtype":"sfc","_offset":0,"_length":%d}' % len(A[E._url(C, 6, 'grib2')])
        E.nuevo(C)
        with self.assertRaises(ErrorFuente):
            E.cuadro(S.RedFalsa(A), C, 'lluvia6h', 6)


class TestProcesoYNivel(unittest.TestCase):
    """[n3-312a 3] la lluvia tiene que ser una ACUMULACIÓN en SUPERFICIE; el CAPE, en su nivel"""

    def _gfs_con(self, **kw):
        A = S.servidor(C, fuentes=('gfs',), horas=(12,))
        G = Gfs()
        LA, LO = S.coords_regular(S.MALLA_GFS)
        m = S.mensaje(S.lluvia_total(LA, LO, 12) - S.lluvia_total(LA, LO, 6), S.MALLA_GFS, C, 1, 8, centro=7,
                      acum=(6, 6), **kw)
        A[G._url(C, 12)] = m + S.relleno(S.MALLA_GFS)
        A[G._url(C, 12, '.idx')] = b'1:0:d=x:APCP:surface:6-12 hour acc fcst:\n2:%d:d=x:CIN:x:x:' % len(m)
        G.nuevo(C)
        return G, S.RedFalsa(A)

    def test_la_buena_pasa(self):
        G, red = self._gfs_con()
        a, _ = G.cuadro(red, C, 'lluvia6h', 12)
        self.assertGreater(a.max(), 0)

    def test_control_negativo_promedio_no_es_acumulacion(self):
        G, red = self._gfs_con(proceso=0)                     # mismo intervalo 6-12, pero PROMEDIO
        with self.assertRaises(grib.ErrorGrib):
            G.cuadro(red, C, 'lluvia6h', 12)

    def test_control_negativo_otro_nivel(self):
        for n1, n2 in (((100, 85000), (255, None)), ((1, 0), (1, 0))):   # isobárico; o con segunda superficie
            G, red = self._gfs_con(nivel1=n1, nivel2=n2)
            with self.assertRaises(grib.ErrorGrib):
                G.cuadro(red, C, 'lluvia6h', 12)

    def test_control_negativo_icon_y_ecmwf(self):
        la, lo = S.celdas_icon()
        A = S.servidor(C, fuentes=('icon',), horas=(6,))
        I = Icon()
        A[I._url(C, 6, 'TOT_PREC')] = bz2.compress(S.mensaje(S.lluvia_total(la, lo, 6), {'tipo': 'icosaedrica'}, C, 1, 52,
                                                             centro=78, unidad=0, acum=(0, 360), proceso=0))
        I.nuevo(C)
        with self.assertRaises(grib.ErrorGrib):
            I.cuadro(S.RedFalsa(A), C, 'lluvia6h', 6)
        A[I._url(C, 6, 'CAPE_ML')] = bz2.compress(S.mensaje(S.cape(la, lo, 6), {'tipo': 'icosaedrica'}, C, 7, 6, centro=78,
                                                            unidad=0, paso=360, nivel1=(192, 0), nivel2=(1, 0)))
        I.nuevo(C)
        with self.assertRaises(grib.ErrorGrib):
            I.cuadro(S.RedFalsa(A), C, 'cape', 6)
        A = S.servidor(C, fuentes=('ecmwf',), horas=(6,))
        E = Ecmwf()
        LA, LO = S.coords_regular(S.MALLA_ECMWF)
        m = S.mensaje(S.lluvia_total(LA, LO, 6) / 1000.0, S.MALLA_ECMWF, C, 1, 193, acum=(0, 6), decimales=6,
                      nivel1=(103, 2))
        A[E._url(C, 6, 'grib2')] = m
        A[E._url(C, 6, 'index')] = b'{"param":"tp","levtype":"sfc","_offset":0,"_length":%d}' % len(m)
        E.nuevo(C)
        with self.assertRaises(grib.ErrorGrib):
            E.cuadro(S.RedFalsa(A), C, 'lluvia6h', 6)


class TestCape(unittest.TestCase):
    def test_cada_fuente_su_cape(self):
        red = S.RedFalsa(S.servidor(C, horas=(0, 6)))
        for F in (Ecmwf, Gfs, Icon):
            f = F()
            f.nuevo(C)
            a, info = f.cuadro(red, C, 'cape', 6)
            self.assertLess(a.max(), 2900)
            self.assertGreater(a.max(), 2000)
        self.assertEqual((Ecmwf.cape_tipo, Gfs.cape_tipo, Icon.cape_tipo), ('MUCAPE', 'MUCAPE', 'MLCAPE'))

    def test_control_negativo_ecmwf_cape_de_otro_nivel(self):
        A = S.servidor(C, fuentes=('ecmwf',), horas=(6,))
        E = Ecmwf()
        LA, LO = S.coords_regular(S.MALLA_ECMWF)
        m = S.mensaje(S.cape(LA, LO, 6), S.MALLA_ECMWF, C, 7, 6, paso=6, nivel1=(1, 0), decimales=1)   # CAPE de superficie
        A[E._url(C, 6, 'grib2')] = m
        A[E._url(C, 6, 'index')] = b'{"param":"mucape","levtype":"sfc","_offset":0,"_length":%d}' % len(m)
        E.nuevo(C)
        with self.assertRaises((ErrorFuente, grib.ErrorGrib)):
            E.cuadro(S.RedFalsa(A), C, 'cape', 6)

    def test_control_negativo_gfs_no_toma_el_cape_de_superficie(self):
        """en el .idx el CAPE de superficie (×3 en el sintético) viene antes; tiene que tomar el de 255-0 hPa"""
        red = S.RedFalsa(S.servidor(C, fuentes=('gfs',), horas=(6,)))
        G = Gfs()
        G.nuevo(C)
        a, _ = G.cuadro(red, C, 'cape', 6)
        self.assertLess(a.max(), 3000)
        red2 = S.RedFalsa(S.servidor(C, fuentes=('gfs',), horas=(6,), faltar={('gfs', 'cape', 6)}))
        G.nuevo(C)
        with self.assertRaises(ErrorFuente):
            G.cuadro(red2, C, 'cape', 6)


class TestRegrilladoIcon(unittest.TestCase):
    def test_vecino_mas_cercano_sobre_la_esfera(self):
        la, lo = S.celdas_icon()
        M = malla.MallaIcon(la, lo, 'u')
        lat_s, lon_s = malla.centros_salida()
        r = np.random.default_rng(3)
        for _ in range(300):                       # fuerza bruta en píxeles al azar
            j, i = r.integers(malla.ALTO), r.integers(malla.ANCHO)
            a, b = np.radians(lat_s[j]), np.radians(lon_s[i])
            d = np.arccos(np.clip(np.sin(a) * np.sin(np.radians(la)) + np.cos(a) * np.cos(np.radians(la)) * np.cos(np.radians(lo) - b), -1, 1))
            self.assertEqual(M.indice[j, i], int(np.argmin(d)))
        v = np.arange(len(la), dtype='f8')
        np.testing.assert_array_equal(M.a_salida(v, 'u'), M.indice.astype('f8'))

    def test_radianes_y_lon_0_360(self):
        la, lo = S.celdas_icon()
        M1 = malla.MallaIcon(la, lo, 'u')
        M2 = malla.MallaIcon(np.radians(la), np.radians(lo % 360), 'u')
        np.testing.assert_array_equal(M1.indice, M2.indice)

    def test_control_negativo(self):
        la, lo = S.celdas_icon()
        M = malla.MallaIcon(la, lo, 'u')
        with self.assertRaises(ValueError):
            M.a_salida(np.zeros(len(la)), 'otra')                    # el campo es de otra malla
        with self.assertRaises(ValueError):
            malla.MallaIcon(la[::400], lo[::400], 'u')               # celdas demasiado lejos: malla equivocada
        with self.assertRaises(ValueError):
            malla.MallaIcon(la + 80, lo, 'u')                        # ninguna celda en la caja


if __name__ == '__main__':
    unittest.main()
