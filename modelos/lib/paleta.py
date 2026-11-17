"""HN AGRO · 312 · las 2 paletas fijas (iguales para las 3 fuentes) y el PNG indexado.

Índice 0 = transparente (debajo del primer umbral). Índice k = tramo k: desde ≤ v < hasta. Colores opacos: la opacidad
de la capa la pone el front. El PNG se escribe a mano (zlib de la biblioteca estándar): mismos datos → mismos bytes,
y así la firma de un cuadro sólo cambia si cambia el dato.
"""
import hashlib
import struct
import zlib

import numpy as np

PALETAS = {
    'lluvia6h': {
        'id': 'lluvia6h-v1', 'unidades': 'mm', 'nombre': 'Lluvia acumulada en 6 h',
        'tramos': [(1, 2, '#a6d8ff'), (2, 5, '#5fb4f0'), (5, 10, '#2a7fd4'), (10, 15, '#1f9e4a'), (15, 20, '#63c430'),
                   (20, 30, '#f2e33a'), (30, 40, '#f5a623'), (40, 50, '#e8541e'), (50, 75, '#c4161c'),
                   (75, 100, '#a0198f'), (100, None, '#e07ff0')],
    },
    'cape': {
        'id': 'cape-v1', 'unidades': 'J/kg', 'nombre': 'CAPE',
        'tramos': [(100, 250, '#d9f0d3'), (250, 500, '#a6dba0'), (500, 1000, '#5aae61'), (1000, 1500, '#f7f056'),
                   (1500, 2000, '#fdb863'), (2000, 2500, '#f46d43'), (2500, 3000, '#d73027'), (3000, 4000, '#a50026'),
                   (4000, None, '#7b3294')],
    },
}


def leyenda(variable):
    return [{'desde': a, 'hasta': b, 'color': c} for a, b, c in PALETAS[variable]['tramos']]


def paletas_json():
    return {'v': 1, 'paletas': {k: {'id': p['id'], 'unidades': p['unidades'], 'nombre': p['nombre'],
                                    'transparente_debajo_de': p['tramos'][0][0], 'leyenda': leyenda(k)}
                                for k, p in PALETAS.items()}}


def clasificar(campo, variable):
    """valores → índice de tramo (uint8). Un NaN es un error: el cuadro no se publica."""
    campo = np.asarray(campo, dtype='f8')
    if np.isnan(campo).any():
        raise ValueError('valores faltantes en la caja')
    desdes = np.array([t[0] for t in PALETAS[variable]['tramos']], dtype='f8')
    return np.searchsorted(desdes, campo, side='right').astype(np.uint8)


def _trozo(tipo, datos):
    return struct.pack('>I', len(datos)) + tipo + datos + struct.pack('>I', zlib.crc32(tipo + datos) & 0xffffffff)


def png_indexado(indices, variable):
    idx = np.ascontiguousarray(indices, dtype=np.uint8)
    alto, ancho = idx.shape
    colores = [t[2] for t in PALETAS[variable]['tramos']]
    plte = b'\x00\x00\x00' + b''.join(bytes.fromhex(c[1:]) for c in colores)
    trns = b'\x00' + b'\xff' * len(colores)
    crudo = b''.join(b'\x00' + idx[f].tobytes() for f in range(alto))
    return (b'\x89PNG\r\n\x1a\n'
            + _trozo(b'IHDR', struct.pack('>IIBBBBB', ancho, alto, 8, 3, 0, 0, 0))
            + _trozo(b'PLTE', plte) + _trozo(b'tRNS', trns)
            + _trozo(b'IDAT', zlib.compress(crudo, 9)) + _trozo(b'IEND', b''))


def leer_png_indexado(datos):
    """para los tests: PNG indexado → (índices, paleta RGB, tRNS)"""
    assert datos[:8] == b'\x89PNG\r\n\x1a\n'
    p, idat, plte, trns, ancho, alto = 8, b'', b'', b'', 0, 0
    while p < len(datos):
        n = struct.unpack('>I', datos[p:p + 4])[0]
        tipo, cuerpo = datos[p + 4:p + 8], datos[p + 8:p + 8 + n]
        if zlib.crc32(tipo + cuerpo) & 0xffffffff != struct.unpack('>I', datos[p + 8 + n:p + 12 + n])[0]:
            raise ValueError('CRC')
        if tipo == b'IHDR':
            ancho, alto = struct.unpack('>II', cuerpo[:8])
            assert cuerpo[8] == 8 and cuerpo[9] == 3
        elif tipo == b'PLTE':
            plte = cuerpo
        elif tipo == b'tRNS':
            trns = cuerpo
        elif tipo == b'IDAT':
            idat += cuerpo
        p += 12 + n
    crudo = zlib.decompress(idat)
    filas = [crudo[f * (ancho + 1):(f + 1) * (ancho + 1)] for f in range(alto)]
    assert all(r[0] == 0 for r in filas)
    idx = np.frombuffer(b''.join(r[1:] for r in filas), np.uint8).reshape(alto, ancho)
    return idx, plte, trns


def firma(datos):
    return hashlib.sha256(datos).hexdigest()[:16]
