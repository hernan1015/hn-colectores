# Envoltorio para llamar a LightningCast (CIMSS, GPL-3.0) como PROGRAMA APARTE, sin tocar su código.
# LightningCast no está en este repositorio: lo instala instalar_lc.sh en tiempo de corrida.
# Este archivo sólo lo arranca. Única maña: pygrib (sólo para radar MRMS de EE. UU., que no se usa)
# no se instala; si falta, se le pasa un módulo vacío para que el import de arriba no falle.
# Uso: <python del entorno LC> correr_lc.py <archivo_C13.nc | lista.txt> --yaml_overrides ...
import runpy
import sys
import types

try:
    import pygrib  # noqa: F401
except ImportError:
    sys.modules["pygrib"] = types.ModuleType("pygrib")

sys.argv = ["lightningcast"] + sys.argv[1:]
runpy.run_module("lightningcast", run_name="__main__", alter_sys=True)
