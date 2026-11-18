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
                                  'nombre', 'unidades', 'periodo', 'parametro_fuente', 'cape_tipo', 'resolucion_fuente',
                                  'cita', 'aviso')}
    m['caja'] = dict(malla.CAJA_V2)   # [312c] la caja de la GRILLA v2 (no la del PNG v1)
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


# ── [312d · 17/11] EL VIENTO (u y v) en la v2 ──────────────────────────────────────────────────────────────────────────────
# Para el viento animado de MODELOS en SATCHI (el método de `_v795`: el campo de color por velocidad y los trazos advectados sobre
# u/v interpolados). SÓLO hay v2 (no hay cuadro v1 de viento). Las claves son las de la v2 con la variable = el nivel:
#   v2/{fuente}/{corrida}/viento10m|viento850|viento250/{fff}.val.png   PNG gris de 16 bits de 125 × 330: las filas 0-164 son u
#                                                                       y las 165-329 son v (los mismos nodos, de norte a sur)
#   …/{fff}.val.json                                                    la codificación, la grilla, el nivel, la cita y el aviso
# valor (m/s) = (q − 32768) × 0,1 (de −3276,8 a +3276,6); q = 65535 es «sin dato». u = hacia el ESTE, v = hacia el NORTE.
NIVELES_VIENTO = {
    'viento10m': {'nombre': 'Viento a 10 m', 'nivel': {'tipo': 'altura sobre el suelo', 'm': 10}},
    'viento850': {'nombre': 'Viento en 850 hPa (~1500 m)', 'nivel': {'tipo': 'isobárico', 'hPa': 850}},
    'viento250': {'nombre': 'Viento en 250 hPa (~10 km, la corriente en chorro)', 'nivel': {'tipo': 'isobárico', 'hPa': 250}},
}
ESCALA_VIENTO = 0.1
CERO_VIENTO = 32768
PALETA_VIENTO = 'viento-continua-v2'


def codificar_viento(u, v):
    """u y v (m/s, nlat × nlon) → q uint16 de (2·nlat) × nlon: u arriba, v abajo (NaN → SIN_DATO; fuera del rango → el tope)"""
    out = []
    for c in (u, v):
        a = np.asarray(c, dtype='f8')
        nan = np.isnan(a)
        q = np.rint(np.where(nan, 0.0, a) / ESCALA_VIENTO) + CERO_VIENTO
        q = np.clip(q, 0, TOPE_Q).astype(np.uint16)
        out.append(np.where(nan, SIN_DATO, q).astype(np.uint16))
    return np.vstack(out)


def decodificar_viento(q):
    """q de (2·nlat) × nlon → (u, v) en m/s, con NaN donde hay «sin dato»"""
    q = np.asarray(q, dtype=np.uint16)
    x = (q.astype('f8') - CERO_VIENTO) * ESCALA_VIENTO
    x[q == SIN_DATO] = np.nan
    n = q.shape[0] // 2
    return x[:n], x[n:]


def anuncio():
    """[312c] lo que el índice anuncia de la grilla de valores (la MISMA caja la usa el viento de la 312d): si la grilla cambia, sube
    `v` y cambian las claves (v3/…); el v1 no se toca."""
    return {'v': 2, 'claves': V2 + '/{fuente}/{corrida}/{variable}/{fff}.val.png|json', 'grilla': malla.grilla_v2(),
            'escala': dict(ESCALA), 'sin_dato': SIN_DATO, 'paletas': dict(PALETA_V2)}
