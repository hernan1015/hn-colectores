"""HN AGRO · 312c · LA GRILLA DE VALORES (contrato R2 v2): el valor del modelo, no el color.

Para que el front dibuje el campo SUAVE como Windy/TRP (el método de `_v795` de HN AGRO: interpolar el VALOR bilineal y aplicar
la paleta continua DESPUÉS), la tubería publica, JUNTO al cuadro v1 (que no cambia), la grilla en los nodos de 0,25° de la caja:
  v2/{fuente}/{corrida}/{variable}/{fff}.val.png   PNG gris de 16 bits (tipo de color 0), 125 × 165, filas de norte a sur
  v2/{fuente}/{corrida}/{variable}/{fff}.val.json  la escala, la grilla, el «sin dato», la caja y la cita (los mismos del v1)
valor = q × escala (q = 0…65534); q = 65535 es «sin dato» (NaN): el front no lo interpola con los vecinos.
lluvia6h: escala 0,01 mm (tope 655,34 mm; la tubería corta en 500); cape: escala 1 J/kg (tope 65534; corta en 10000).
El PNG se escribe a mano (zlib de la biblioteca estándar, filtro 0): mismos datos → mismos bytes → misma firma.
"""
import struct
import zlib

import numpy as np

from . import malla
from .paleta import _trozo, firma

V2 = 'v2'
ESCALA = {'lluvia6h': 0.01, 'cape': 1.0}
SIN_DATO = 65535
TOPE_Q = 65534
PALETA_V2 = {'lluvia6h': 'lluvia6h-continua-v2', 'cape': 'cape-continua-v2'}


def codificar(campo, variable):
    """valores físicos → q uint16 (redondeo al más cercano; NaN → SIN_DATO; negativo → 0; más del tope → TOPE_Q)"""
    a = np.asarray(campo, dtype='f8')
    nan = np.isnan(a)
    q = np.rint(np.where(nan, 0.0, a) / ESCALA[variable])
    q = np.clip(q, 0, TOPE_Q).astype(np.uint16)
    q[nan] = SIN_DATO
    return q


def decodificar(q, variable):
    q = np.asarray(q, dtype=np.uint16)
    v = q.astype('f8') * ESCALA[variable]
    v[q == SIN_DATO] = np.nan
    return v


def png16(q):
    q = np.ascontiguousarray(q, dtype='>u2')
    alto, ancho = q.shape
    crudo = b''.join(b'\x00' + q[f].tobytes() for f in range(alto))
    return (b'\x89PNG\r\n\x1a\n'
            + _trozo(b'IHDR', struct.pack('>IIBBBBB', ancho, alto, 16, 0, 0, 0, 0))
            + _trozo(b'IDAT', zlib.compress(crudo, 9)) + _trozo(b'IEND', b''))


def leer_png16(datos):
    """para los tests (y para el chequeo antes de publicar): PNG gris de 16 bits sin filtro → q uint16"""
    assert datos[:8] == b'\x89PNG\r\n\x1a\n'
    p, idat, ancho, alto = 8, b'', 0, 0
    while p < len(datos):
        n = struct.unpack('>I', datos[p:p + 4])[0]
        tipo, cuerpo = datos[p + 4:p + 8], datos[p + 8:p + 8 + n]
        if zlib.crc32(tipo + cuerpo) & 0xffffffff != struct.unpack('>I', datos[p + 8 + n:p + 12 + n])[0]:
            raise ValueError('CRC')
        if tipo == b'IHDR':
            ancho, alto = struct.unpack('>II', cuerpo[:8])
            if cuerpo[8] != 16 or cuerpo[9] != 0:
                raise ValueError('no es gris de 16 bits')
        elif tipo == b'IDAT':
            idat += cuerpo
        p += 12 + n
    crudo = zlib.decompress(idat)
    fila = 1 + 2 * ancho
    if len(crudo) != alto * fila or any(crudo[f * fila] != 0 for f in range(alto)):
        raise ValueError('IDAT de otro largo o con filtro')
    return np.frombuffer(b''.join(crudo[f * fila + 1:(f + 1) * fila] for f in range(alto)), '>u2').reshape(alto, ancho).astype(np.uint16)


def meta_valores(meta_v1, campo, variable, png, regrillado_v2):
    """el JSON del cuadro v2: lo del v1 (fuente, corrida, horas, período, cita, aviso) + la codificación y la grilla"""
    a = np.asarray(campo, dtype='f8')
    m = {k: meta_v1[k] for k in ('fuente', 'modelo', 'corrida', 'corrida_iso', 'hora_pronostico', 'valida_iso', 'variable',
                                  'nombre', 'unidades', 'periodo', 'parametro_fuente', 'cape_tipo', 'caja', 'resolucion_fuente',
                                  'cita', 'aviso')}
    m.update({
        'v': 2, 'paleta': PALETA_V2[variable],
        'valores': {'png': '%03d.val.png' % meta_v1['hora_pronostico'], 'tipo': 'PNG gris 16 bits (big-endian), sin filtro',
                    'escala': ESCALA[variable], 'sin_dato': SIN_DATO, 'formula': 'valor = q × escala; q = sin_dato → NaN'},
        'grilla': malla.grilla_v2(), 'regrillado': regrillado_v2,
        'estadisticas': {'min': round(float(np.nanmin(a)), 2), 'max': round(float(np.nanmax(a)), 2),
                         'media': round(float(np.nanmean(a)), 3), 'sin_dato': int(np.isnan(a).sum())},
        'firma': firma(png), 'firma_v1': meta_v1['firma'],
    })
    return m
