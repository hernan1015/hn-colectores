"""lo común a los tests: de dónde se importa lib/ (MODELOS_RAIZ, para el control negativo) y el lector sin ecCodes."""
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.environ.get('MODELOS_RAIZ') or os.path.dirname(AQUI)
for p in (AQUI, RAIZ):
    if p not in sys.path:
        sys.path.insert(0, p)
sys.path.insert(0, RAIZ)   # lib/ de RAIZ gana siempre (el mutante)

try:
    import eccodes  # noqa: F401
    CON_ECCODES = True
except Exception:
    if os.environ.get('MODELOS_EXIGIR_ECCODES') == '1':      # en Actions: la suite corre con ecCodes de verdad, o no corre
        raise
    CON_ECCODES = False
    os.environ['MODELOS_GRIB_PURO'] = '1'
