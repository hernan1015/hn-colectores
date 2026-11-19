"""[r79 · Codex n3-r79c] Prueba de componer() (precocer.py): donde se pisan dos zonas, el color fijo del modelo (pico/meseta con OPERA) MANDA y
nunca se promedia con un color de profundidad; donde no hay fijo, el color es el de profundidad y el agua vista sin modelo no lo tiñe.
Control negativo: PRUEBA_CONTROL=<carpeta> importa precocer.py de esa carpeta (git show e35e91d6:…) → falla en 1).  Uso: python -I prueba_componer.py"""
import os, sys
import numpy as np
sys.path.insert(0, os.environ.get('PRUEBA_CONTROL') or os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(1, os.path.dirname(os.path.abspath(__file__)))
import precocer as P  # noqa: E402

def fuente(o, e, rgb, fijo, peso=None):
    H = W = 64; meta = {'oeste': o, 'este': e, 'sur': -30.6, 'norte': -30.4}
    a = np.ones((H, W), np.float32)
    return {'meta': meta, 'rgb': np.tile(np.array(rgb, np.uint8), (H, W, 1)), 'a': a, 'w': None if peso else np.ones((H, W), np.float32) * 0.5,
            'peso': peso, 'fijo': (np.ones((H, W), bool) if fijo else np.zeros((H, W), bool)) if fijo is not None else None}

ROJO = (232, 0, 0)
z, x, y = 9, None, None
n = 2 ** z; lon = -59.7; lat = -30.5
import math
x = int((lon + 180) / 360 * n); r = math.radians(lat); y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
A = fuente(-60.5, -59.0, ROJO, False)            # zona con profundidad (rojo)
B = fuente(-60.5, -59.0, P.FIJO, True)           # zona vecina: pico/meseta con OPERA (fijo)
C = fuente(-60.5, -59.0, P.FIJO, None, peso=P.PESO_AGUA_VISTA)   # agua vista sin modelo
out = P.componer([A, B], z, x, y); px = out[128, 128, :3].tolist()
assert px == list(P.FIJO), ('1) el fijo del modelo manda sobre la profundidad', px)
out = P.componer([A, C], z, x, y); px = out[128, 128, :3].tolist()
assert px == list(ROJO), ('2) la profundidad no se tiñe con el agua vista sin modelo', px)
out = P.componer([C], z, x, y); px = out[128, 128, :3].tolist()
assert px == list(P.FIJO), ('3) sin modelo: el agua vista en el color fijo', px)
R = fuente(-60.5, -59.0, P.RAYADO, None); R['rayado'] = True; R['a'] = R['a'] * P.RAYADO_ALFA; R['fijo'] = None
out = P.componer([R], z, x, y); px = out[128, 128].tolist()
assert px[:3] == list(P.RAYADO) and px[3] > 0, ('4) zona sin dato: rayada, nunca vacía', px)
solo = P.componer([A], z, x, y)[128, 128].tolist(); con = P.componer([A, R], z, x, y)[128, 128].tolist()
assert con == solo, ('5) el rayado de una zona sin dato no tiñe ni apaga la mancha de la vecina', con, solo)
print('prueba_componer: 5/5 ok')
