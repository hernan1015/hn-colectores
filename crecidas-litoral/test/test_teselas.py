"""[_v1860] la lista de teselas que EXISTEN por fecha (para que la página no pida las que faltan: el r2.dev las contesta con un
404 de 27 KB en HTML). Correr: python -I -m unittest discover -s test -p "test_*.py" (dentro de crecidas-litoral/)."""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import precocer as P  # noqa: E402


class Teselas(unittest.TestCase):
    def test_rangos(self):
        self.assertEqual(P.rangos([3, 4, 5, 9, 11, 12]), '3-5,9,11-12')
        self.assertEqual(P.rangos([7]), '7')
        self.assertEqual(P.rangos([5, 3, 4, 4]), '3-5')   # desordenadas y repetidas

    def test_compactas(self):
        T = P.teselas_compactas({(6, 20, 37), (6, 20, 38), (6, 21, 37), (7, 41, 75), (7, 41, 77)})
        self.assertEqual(T, {'6': {'20': '37-38', '21': '37'}, '7': {'41': '75,77'}})

    def test_ida_y_vuelta(self):
        """lo que se compacta se reconstruye igual (la misma regla que lee la página)"""
        orig = {(9, 160, 300), (9, 160, 301), (9, 160, 305), (10, 321, 600), (11, 642, 1200), (11, 642, 1201), (11, 643, 1200)}
        T = P.teselas_compactas(orig)
        vuelta = set()
        for z, xs in T.items():
            for x, s in xs.items():
                for tramo in s.split(','):
                    a, _, b = tramo.partition('-')
                    for y in range(int(a), int(b or a) + 1):
                        vuelta.add((int(z), int(x), y))
        self.assertEqual(vuelta, orig)

    def test_control_negativo(self):
        """CONTROL: una tesela de más o de menos cambia la lista"""
        a = P.teselas_compactas({(6, 20, 37), (6, 20, 38)})
        self.assertNotEqual(a, P.teselas_compactas({(6, 20, 37)}))
        self.assertNotEqual(a, P.teselas_compactas({(6, 20, 37), (6, 20, 38), (6, 20, 40)}))


if __name__ == '__main__':
    unittest.main()
