"""HN AGRO · 312 · colector de MODELOS (ECMWF · ICON · GFS) → R2 satchi-modelos. Ver modelos/LEEME.md.

  python modelos/colector.py              una pasada (lo corre el workflow colector-modelos)
  python modelos/colector.py --chequeo    sólo dice si hay algo nuevo (sin numpy ni ecCodes; escribe hay=si|no en
                                          $GITHUB_OUTPUT), para no instalar nada en las pasadas que no tienen trabajo

Entorno: MODELOS_LLAVE (la variable del repo MODELOS_ON; sin «si» no hace nada), MODELOS_FUENTES (ecmwf,icon,gfs),
R2_OPERA_CUENTA / R2_OPERA_ACCESS_KEY_ID / R2_OPERA_SECRET_ACCESS_KEY, MODELOS_DEPOSITO (satchi-modelos) o
ALMACEN_CARPETA (seco: escribe en una carpeta, no en R2).
El registro de Actions es PÚBLICO: se imprimen claves, corridas y cantidades; nunca llaves ni URL firmadas.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import almacen as alm  # noqa: E402
from lib.fuentes import FUENTES  # noqa: E402
from lib.red import Red  # noqa: E402


def fuentes_de(env):
    ids = [x.strip() for x in (env.get('MODELOS_FUENTES') or 'ecmwf,icon,gfs').split(',') if x.strip()]
    malas = [x for x in ids if x not in FUENTES]
    if malas:
        raise SystemExit('fuentes desconocidas: %s' % ','.join(malas))
    return [FUENTES[x]() for x in ids]


def chequeo(env, red, almacen, ahora=None, log=print):
    """¿alguna fuente tiene una corrida entera que todavía no está terminada en R2?"""
    import json
    from datetime import datetime, timezone
    if (env.get('MODELOS_LLAVE') or '').strip().lower() != 'si':
        log('llave apagada (MODELOS_ON != «si»): no se hace nada')
        return False
    ahora = ahora or datetime.now(timezone.utc)
    for f in fuentes_de(env):
        for c in f.candidatos(ahora):
            b = almacen.leer('v1/%s/%s/corrida.json' % (f.id, c.strftime('%Y%m%d%H')))
            s = json.loads(b.decode()) if b else None
            if s and (s.get('estado') == 'completa' or s.get('intentos', 0) >= 3):
                break
            if f.disponible(red, c, 120):
                log('%s %s: hay trabajo' % (f.id, c.strftime('%Y%m%d%H')))
                return True
    log('nada nuevo (%d pedidos)' % red.pedidos)
    return False


def main(argv, env=os.environ):
    llave = env.get('MODELOS_LLAVE', '')
    if (llave or '').strip().lower() != 'si':
        print('llave apagada (MODELOS_ON != «si»): no se hace nada')
        if '--chequeo' in argv and env.get('GITHUB_OUTPUT'):
            with open(env['GITHUB_OUTPUT'], 'a') as f:
                f.write('hay=no\n')
        return 0
    red, almacen = Red(), alm.desde_entorno(env)
    if '--chequeo' in argv:
        hay = chequeo(env, red, almacen)
        if env.get('GITHUB_OUTPUT'):
            with open(env['GITHUB_OUTPUT'], 'a') as f:
                f.write('hay=%s\n' % ('si' if hay else 'no'))
        return 0
    from lib import tuberia
    tuberia.correr(red, almacen, llave=llave, fuentes=fuentes_de(env))
    print('R2: %d lecturas, %d escrituras, %d borrados' % (almacen.lecturas, almacen.escrituras, almacen.borrados))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
