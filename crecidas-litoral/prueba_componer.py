"""[r79 · Codex n3-r79c y n3-litoral-colector] Prueba de componer() (precocer.py), caso por caso (cuenta las fallas):
  1) el color fijo del modelo (pico/meseta con OPERA) manda sobre la profundidad;  2) la profundidad no se tiñe con el agua vista sin modelo;
  3) sin modelo, el agua vista en el color fijo;  4) una zona sin dato va rayada, nunca vacía;  5) sin dato GANA en su planicie (sobre la
  profundidad de la vecina, el agua vista y el fijo de la vecina);  6) nunca un color de profundidad promediado: una sola zona pone el color
  (la de más peso · alfa);  7) en el pico/meseta de una zona (sin OPERA), la vecina no pone profundidad.
Control negativo: PRUEBA_CONTROL=<carpeta> importa precocer.py de esa carpeta (git show <sha>:…). Uso: python -I prueba_componer.py"""
import math, os, sys
import numpy as np
sys.path.insert(0, os.environ.get('PRUEBA_CONTROL') or os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(1, os.path.dirname(os.path.abspath(__file__)))
import precocer as P  # noqa: E402

MAL = []


def chk(nombre, f):
    try:
        ok = f()
    except Exception as e:
        ok = False; nombre += ' (' + type(e).__name__ + ')'
    if not ok: MAL.append(nombre); print('MAL:', nombre)


def fuente(o, e, rgb, fijo, peso=None):
    H = W = 64; meta = {'oeste': o, 'este': e, 'sur': -30.6, 'norte': -30.4}
    a = np.ones((H, W), np.float32)
    return {'meta': meta, 'rgb': np.tile(np.array(rgb, np.uint8), (H, W, 1)), 'a': a, 'w': None if peso else np.ones((H, W), np.float32) * 0.5,
            'peso': peso, 'fijo': (np.ones((H, W), bool) if fijo else np.zeros((H, W), bool)) if fijo is not None else None}


def rayada():
    R = fuente(-60.5, -59.0, P.RAYADO, None); R['rayado'] = True; R['a'] = R['a'] * P.RAYADO_ALFA; R['sd'] = np.ones(R['a'].shape, bool); return R


def px(fs, todo=False):
    out = P.componer(fs, z, x, y)
    if out is None: return None
    return out[128, 128].tolist() if todo else out[128, 128, :3].tolist()


ROJO, VERDE = (232, 0, 0), (86, 255, 160)
z = 9; n = 2 ** z; lon = -59.7; lat = -30.5
x = int((lon + 180) / 360 * n); r = math.radians(lat); y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
A = fuente(-60.5, -59.0, ROJO, False)            # zona con profundidad (rojo)
B = fuente(-60.5, -59.0, P.FIJO, True)           # zona vecina: pico/meseta con OPERA (fijo)
C = fuente(-60.5, -59.0, P.FIJO, None, peso=P.PESO_AGUA_VISTA)   # agua vista sin modelo
D2 = fuente(-60.5, -59.0, VERDE, False); D2['w'] = D2['w'] * 0.3  # otra zona, otra profundidad, menos peso
V = fuente(-60.5, -59.0, ROJO, False); V['a'] = V['a'] * 0; V['veto'] = np.ones(V['a'].shape, bool)   # meseta de una zona sin OPERA (vacía)

chk('1) el fijo del modelo manda sobre la profundidad', lambda: px([A, B]) == list(P.FIJO))
chk('2) la profundidad no se tiñe con el agua vista sin modelo', lambda: px([A, C]) == list(ROJO))
chk('3) sin modelo: el agua vista en el color fijo', lambda: px([C]) == list(P.FIJO))
chk('4) zona sin dato: rayada, nunca vacía', lambda: (lambda p: p is not None and p[:3] == list(P.RAYADO) and p[3] > 0)(px([rayada()], True)))
for nom, otra in (('la profundidad de la vecina', A), ('el agua vista', C), ('el fijo de la vecina', B)):
    chk('5) sin dato gana en su planicie sobre ' + nom, lambda otra=otra: (px([otra, rayada()]) or [])[:3] == list(P.RAYADO))
chk('6) nunca un color de profundidad promediado: gana la zona de más peso · alfa', lambda: px([A, D2]) == list(ROJO))
chk('7) en el pico/meseta de una zona, la vecina no pone profundidad', lambda: (lambda o: o is None or o[128, 128, 3] == 0)(P.componer([V, D2], z, x, y)))
print('prueba_componer: ' + str(9 - len(MAL)) + '/9 ok')
sys.exit(1 if MAL else 0)
