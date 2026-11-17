"""HN AGRO · 312 · lectura de UN mensaje GRIB2.

La cabecera (secciones 1, 3 y 4: fecha de la corrida, malla, paso, acumulación, parámetro) se lee acá, byte por byte,
y se valida contra lo que se pidió. Los VALORES (sección 7) los decodifica ecCodes (las 3 fuentes empaquetan con CCSDS,
plantilla 5.42, o con el complejo de diferencias espaciales, 5.3).

Sin ecCodes (sólo en los tests de una PC sin la librería, con MODELOS_GRIB_PURO=1) se decodifica en Python puro el
empaquetado simple (plantilla 5.0), que es el que usan los GRIB sintéticos de los tests. En Actions los tests corren
con ecCodes de verdad sobre los mismos sintéticos.
"""
import os
from datetime import datetime, timedelta, timezone

import numpy as np

UNIDAD_MIN = {0: 1, 1: 60, 2: 1440, 10: 180, 11: 360, 12: 720, 13: 1 / 60}  # unidad de tiempo GRIB → minutos


class ErrorGrib(Exception):
    pass


def _s(b):
    """entero con signo al estilo GRIB (bit alto = signo)"""
    v = int.from_bytes(b, 'big')
    n = len(b) * 8
    return -(v & ((1 << (n - 1)) - 1)) if v >> (n - 1) else v


def separar(datos):
    """los mensajes GRIB2 de un bloque de bytes (un archivo o un rango)"""
    out, i = [], 0
    while True:
        j = datos.find(b'GRIB', i)
        if j < 0:
            return out
        if datos[j + 7] != 2:
            raise ErrorGrib('no es GRIB edición 2')
        largo = int.from_bytes(datos[j + 8:j + 16], 'big')
        if j + largo > len(datos) or datos[j + largo - 4:j + largo] != b'7777':
            raise ErrorGrib('mensaje cortado')
        out.append(datos[j:j + largo])
        i = j + largo


def _secciones(m):
    p, out = 16, {}
    while p < len(m) - 4:
        largo = int.from_bytes(m[p:p + 4], 'big')
        n = m[p + 4]
        if largo < 5:
            raise ErrorGrib('sección vacía')
        out.setdefault(n, m[p:p + largo])
        p += largo
    for n in (1, 3, 4, 5, 7):
        if n not in out:
            raise ErrorGrib('falta la sección %d' % n)
    return out


def _nivel(tipo, factor, valor):
    if valor == b'\xff\xff\xff\xff':
        return (tipo, None)
    esc = 0 if factor == 255 else _s(bytes([factor]))
    return (tipo, _s(valor) * 10.0 ** (-esc))


def coincide_nivel(nivel, pedido):
    """pedido: un tipo (int) o (tipo, valor físico); valor None = cualquiera; un 0 pedido acepta también el faltante"""
    if isinstance(pedido, int):
        return nivel[0] == pedido
    tipo, esperado = pedido
    if nivel[0] != tipo:
        return False
    if esperado is None:
        return True
    if nivel[1] is None:
        return esperado == 0
    return abs(nivel[1] - esperado) <= 1e-6 * max(1.0, abs(esperado))


def cabecera(m):
    """lo que importa de un mensaje, sin decodificar los valores"""
    s = _secciones(m)
    s1, s3, s4 = s[1], s[3], s[4]
    r = {'disciplina': m[6], 'centro': int.from_bytes(s1[5:7], 'big')}
    r['corrida'] = datetime(int.from_bytes(s1[12:14], 'big'), s1[14], s1[15], s1[16], s1[17], tzinfo=timezone.utc)
    r['npuntos'] = int.from_bytes(s3[6:10], 'big')
    t3 = int.from_bytes(s3[12:14], 'big')
    if t3 == 0:
        r['malla'] = {
            'tipo': 'latlon', 'Ni': int.from_bytes(s3[30:34], 'big'), 'Nj': int.from_bytes(s3[34:38], 'big'),
            'la1': _s(s3[46:50]) / 1e6, 'lo1': _s(s3[50:54]) / 1e6, 'la2': _s(s3[55:59]) / 1e6, 'lo2': _s(s3[59:63]) / 1e6,
            'di': _s(s3[63:67]) / 1e6, 'dj': _s(s3[67:71]) / 1e6, 'scan': s3[71]}
    elif t3 == 101:
        r['malla'] = {'tipo': 'icosaedrica', 'numero': int.from_bytes(s3[15:18], 'big'), 'uuid': s3[19:35].hex()}
    else:
        raise ErrorGrib('malla no soportada: plantilla 3.%d' % t3)
    t4 = int.from_bytes(s4[7:9], 'big')
    if t4 not in (0, 8):
        raise ErrorGrib('producto no soportado: plantilla 4.%d' % t4)
    r['categoria'], r['numero'] = s4[9], s4[10]
    u = s4[17]
    if u not in UNIDAD_MIN:
        raise ErrorGrib('unidad de tiempo %d' % u)
    t_min = int.from_bytes(s4[18:22], 'big') * UNIDAD_MIN[u]
    # [n3-312a v2] el valor FÍSICO de cada superficie: valor × 10^(−factor de escala) (2550 con factor −1 = 25500 Pa;
    # 25500 con factor 1 = 2550 Pa, otra capa). Valor faltante (todo 1) → None.
    r['nivel1'] = _nivel(s4[22], s4[23], s4[24:28])
    r['nivel2'] = _nivel(s4[28], s4[29], s4[30:34])
    if t4 == 8:
        if s4[48] not in UNIDAD_MIN:
            raise ErrorGrib('unidad del rango %d' % s4[48])
        largo_min = int.from_bytes(s4[49:53], 'big') * UNIDAD_MIN[s4[48]]
        r['proceso'] = s4[46]                       # 1 = acumulación (tabla 4.10); 0 = promedio, 2 = máximo…
        r['n_rangos'] = s4[41]
        r['acum_h'] = (t_min / 60, (t_min + largo_min) / 60)
        r['paso_h'] = (t_min + largo_min) / 60
    else:
        r['proceso'] = None
        r['n_rangos'] = 0
        r['acum_h'] = None
        r['paso_h'] = t_min / 60
    r['plantilla5'] = int.from_bytes(s[5][9:11], 'big')
    return r


def _valores_puro(m):
    s = _secciones(m)
    s5 = s[5]
    if int.from_bytes(s5[9:11], 'big') != 0:
        raise ErrorGrib('sin ecCodes sólo se lee el empaquetado simple (5.0)')
    n = int.from_bytes(s5[5:9], 'big')
    R = np.frombuffer(s5[11:15], '>f4')[0].astype('f8')
    E, D, nb = _s(s5[15:17]), _s(s5[17:19]), s5[19]
    crudo = s[7][5:]
    if nb == 0:
        x = np.zeros(n)
    else:
        bits = np.unpackbits(np.frombuffer(crudo, np.uint8))[:n * nb].reshape(n, nb)
        x = bits.astype(np.int64) @ (1 << np.arange(nb - 1, -1, -1, dtype=np.int64))
    v = (R + x * 2.0 ** E) / 10.0 ** D
    total = int.from_bytes(s[3][6:10], 'big')
    s6 = s.get(6)
    if s6 is not None and s6[5] == 0:
        mapa = np.unpackbits(np.frombuffer(s6[6:], np.uint8))[:total].astype(bool)
        out = np.full(total, np.nan)
        out[mapa] = v
        return out
    if n != total:
        raise ErrorGrib('cantidad de valores')
    return v


def valores(m):
    """los valores en el orden del mensaje; NaN donde falta"""
    try:
        import eccodes
    except ImportError:
        if os.environ.get('MODELOS_GRIB_PURO') == '1':
            return _valores_puro(m)
        raise
    h = eccodes.codes_new_from_message(bytes(m))
    try:
        eccodes.codes_set(h, 'missingValue', 9.999e20)
        v = np.asarray(eccodes.codes_get_values(h), dtype='f8')
    finally:
        eccodes.codes_release(h)
    v[v >= 9.99e20] = np.nan
    return v


SUPERFICIE = ((1, 0), (255, None))   # la lluvia: superficie tipo 1 (suelo o agua) a 0, sin segunda superficie


def leer(m, corrida=None, paso_h=None, acum_h=None, parametro=None, niveles=None):
    """cabecera + valores, validando que es lo pedido (corrida, paso, acumulación y parámetro).
    [n3-312a 3] Con acum_h, además: plantilla 4.8 con UN rango de tiempo y proceso 1 (ACUMULACIÓN; un promedio o un
    máximo con el mismo intervalo no pasa). Con niveles=(n1, n2): cada uno un tipo, o (tipo, valor FÍSICO) con la escala aplicada [n3-312a v2]."""
    c = cabecera(m)
    if corrida is not None and c['corrida'] != corrida:
        raise ErrorGrib('corrida %s, se pidió %s' % (c['corrida'].isoformat(), corrida.isoformat()))
    if paso_h is not None and abs(c['paso_h'] - paso_h) > 1e-6:
        raise ErrorGrib('paso %s h, se pidió %s h' % (c['paso_h'], paso_h))
    if acum_h is not None and (c['acum_h'] is None or abs(c['acum_h'][0] - acum_h[0]) > 1e-6
                               or abs(c['acum_h'][1] - acum_h[1]) > 1e-6):
        raise ErrorGrib('acumulación %s, se pidió %s' % (c['acum_h'], acum_h))
    if acum_h is not None and (c['proceso'] != 1 or c['n_rangos'] != 1):
        raise ErrorGrib('no es una acumulación (proceso %s, %s rangos)' % (c['proceso'], c['n_rangos']))
    if niveles is not None and not (coincide_nivel(c['nivel1'], niveles[0]) and coincide_nivel(c['nivel2'], niveles[1])):
        raise ErrorGrib('superficies %s/%s, se pidió %s/%s' % (c['nivel1'], c['nivel2'], niveles[0], niveles[1]))
    if parametro is not None and (c['disciplina'], c['categoria'], c['numero']) != parametro:
        raise ErrorGrib('parámetro %s' % ((c['disciplina'], c['categoria'], c['numero']),))
    v = valores(m)
    if len(v) != c['npuntos']:
        raise ErrorGrib('%d valores para %d puntos' % (len(v), c['npuntos']))
    c['valores'] = v
    return c


def valida(corrida, paso_h):
    return corrida + timedelta(hours=paso_h)
