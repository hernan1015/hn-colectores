"""la paleta fija y el PNG indexado."""
import unittest

import base  # noqa: F401
import numpy as np

from lib import paleta


class TestPaleta(unittest.TestCase):
    def test_tramos_desde_incluido_hasta_excluido(self):
        idx = paleta.clasificar(np.array([[0, 0.99, 1, 1.99, 2, 99.9, 100, 1e3]]), 'lluvia6h')
        self.assertEqual(idx.tolist(), [[0, 0, 1, 1, 2, 10, 11, 11]])
        idx = paleta.clasificar(np.array([[99, 100, 249.9, 250, 3999, 4000]]), 'cape')
        self.assertEqual(idx.tolist(), [[0, 1, 1, 2, 8, 9]])

    def test_png_ida_y_vuelta(self):
        r = np.random.default_rng(1)
        campo = r.uniform(0, 150, (422, 248))
        idx = paleta.clasificar(campo, 'lluvia6h')
        png = paleta.png_indexado(idx, 'lluvia6h')
        idx2, plte, trns = paleta.leer_png_indexado(png)
        np.testing.assert_array_equal(idx, idx2)
        self.assertEqual(plte[:3], b'\x00\x00\x00')
        self.assertEqual(trns[0], 0)                           # índice 0 transparente
        self.assertTrue(all(t == 255 for t in trns[1:]))       # los tramos, opacos
        self.assertEqual(plte[3:6], bytes.fromhex('a6d8ff'))
        self.assertEqual(len(plte), 3 * 12)

    def test_misma_paleta_para_las_3_fuentes(self):
        """la paleta depende sólo de la variable: el mismo campo da los mismos bytes, venga de donde venga"""
        campo = np.linspace(0, 5000, 422 * 248).reshape(422, 248)
        a = paleta.png_indexado(paleta.clasificar(campo, 'cape'), 'cape')
        b = paleta.png_indexado(paleta.clasificar(campo.copy(), 'cape'), 'cape')
        self.assertEqual(a, b)
        self.assertEqual(paleta.firma(a), paleta.firma(b))
        j = paleta.paletas_json()
        self.assertEqual(set(j['paletas']), {'lluvia6h', 'cape'})
        self.assertEqual(j['paletas']['cape']['leyenda'][0], {'desde': 100, 'hasta': 250, 'color': '#d9f0d3'})

    def test_control_negativo(self):
        with self.assertRaises(ValueError):
            paleta.clasificar(np.array([[1.0, np.nan]]), 'lluvia6h')          # un faltante no se pinta como «0»
        campo = np.full((4, 4), 12.0)
        a = paleta.png_indexado(paleta.clasificar(campo, 'lluvia6h'), 'lluvia6h')
        campo[0, 0] = 16.0
        b = paleta.png_indexado(paleta.clasificar(campo, 'lluvia6h'), 'lluvia6h')
        self.assertNotEqual(paleta.firma(a), paleta.firma(b))                # otro dato, otra firma
        roto = bytearray(a)
        roto[40] ^= 0xff
        with self.assertRaises(Exception):
            paleta.leer_png_indexado(bytes(roto))                            # el CRC lo nota


if __name__ == '__main__':
    unittest.main()
