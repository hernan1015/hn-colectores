"""[r79 · 10] Tests de litoral.py sin red: las alturas, las fechas, la firma y la llave. Correr: python -I -m unittest discover -s test -p "test_*.py"
(dentro de crecidas-litoral/). La composición de las teselas la prueba prueba_componer.py."""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import litoral as L  # noqa: E402

J = {'medido': [{'fecha': '2026-11-17', 'h': 6.24}, {'fecha': '2026-11-18', 'h': 6.25}, {'fecha': 'mal', 'h': 1}],
     'pronostico': {'dias': [{'fecha': '2026-11-18', 'p50': 9.9}, {'fecha': '2026-11-19', 'p50': 6.3}, {'fecha': '2026-11-20', 'p50': None}]}}


class Litoral(unittest.TestCase):
    def test_alturas(self):
        a = L.alturas_de(J)
        self.assertEqual(a['2026-11-18'], {'h': 6.25, 'tipo': 'medido'}, 'lo medido manda sobre el pronóstico del mismo día')
        self.assertEqual(a['2026-11-19'], {'h': 6.3, 'tipo': 'pronostico'})
        self.assertNotIn('2026-11-20', a); self.assertNotIn('mal', a)

    def test_fechas_y_firma(self):
        alt = {'lapaz': L.alturas_de(J), 'goya': {'2026-10-01': {'h': 5, 'tipo': 'medido'}}}
        f = L.fechas_de(alt)
        self.assertEqual(f[0] >= '2026-10-20', True, 'desde 29 días antes de la última medida')
        self.assertEqual(f[-1], '2026-11-19')
        f1 = L.firma_de(alt, f); alt['lapaz']['2026-11-19']['h'] = 6.31
        self.assertNotEqual(f1, L.firma_de(alt, f), 'un pronóstico que cambia cambia la firma')

    def test_fin_con_la_mitad(self):
        alt = {'a': {'2026-11-18': {'h': 1, 'tipo': 'medido'}, '2026-11-19': {'h': 1, 'tipo': 'pronostico'}, '2026-12-19': {'h': 1, 'tipo': 'pronostico'}},
               'b': {'2026-11-18': {'h': 1, 'tipo': 'medido'}, '2026-11-19': {'h': 1, 'tipo': 'pronostico'}}, 'c': {'2026-11-18': {'h': 1, 'tipo': 'medido'}}}
        self.assertEqual(L.fechas_de(alt)[-1], '2026-11-19', 'un solo puerto con pronóstico largo no estira el Litoral')

    def test_llave_apagada(self):
        self.assertEqual(L.main({'CRECIDAS_LITORAL_ON': 'no'}), 0)


class Firma(unittest.TestCase):
    def test_firma_justa(self):
        alt = {'a': {'2026-11-18': {'h': 1.0, 'tipo': 'medido'}, '2026-09-01': {'h': 2.0, 'tipo': 'medido'}}}
        f = ['2026-11-18']
        base = L.firma_de(alt, f, ['G1'], 'e1')
        alt['a']['2026-09-01']['h'] = 3.0
        self.assertEqual(base, L.firma_de(alt, f, ['G1'], 'e1'), 'una altura fuera de las fechas generadas no cambia la firma')
        self.assertNotEqual(base, L.firma_de(alt, f, ['G1', 'G2'], 'e1'), 'una pasada nueva de OPERA sí')
        self.assertNotEqual(base, L.firma_de(alt, f, ['G1'], 'e2'), 'un estático nuevo (calado, cajas) sí')
        self.assertEqual(base, L.firma_de(alt, f, ['G1'], 'e1'))


if __name__ == '__main__':
    unittest.main()
