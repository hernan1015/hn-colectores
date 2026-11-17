"""GRIB2 SINTÉTICOS para los tests (sin red): las mismas plantillas, parámetros, niveles y acumulaciones que se midieron
en los archivos reales del Paso 0 (17/11/2026), con empaquetado simple (5.0) para que se puedan leer sin ecCodes.
Y una red de mentira que sirve los índices, los rangos y los .bz2 como las fuentes de verdad.
"""
import bz2
import json
import struct

import numpy as np

UUID_ICON = bytes.fromhex('a27b8de618c411e4820ab5b098c6a5c0')   # el de R03B07 (medido)


def _sm(v, n):
    """entero con signo GRIB (bit alto = signo) en n bytes"""
    v = int(round(v))
    if v < 0:
        return ((1 << (n * 8 - 1)) | -v).to_bytes(n, 'big')
    return v.to_bytes(n, 'big')


def _sec(n, cuerpo):
    return struct.pack('>IB', 5 + len(cuerpo), n) + cuerpo


def mensaje(valores, malla, corrida, cat, num, disciplina=0, centro=98, paso=0, unidad=1, acum=None,
            nivel1=(1, 0), nivel2=(255, None), decimales=3, faltantes=None):
    """un mensaje GRIB2. malla: {'tipo':'latlon', Ni, Nj, la1, lo1, di, dj, scan} o {'tipo':'icosaedrica'}.
    acum = (desde, largo) en `unidad` → plantilla 4.8 (acumulación); si no, 4.0 con `paso`."""
    v = np.asarray(valores, dtype='f8').ravel()
    s1 = struct.pack('>HHBBB', centro, 0, 28, 0, 1) + struct.pack('>HBBBBB', corrida.year, corrida.month, corrida.day,
                                                                   corrida.hour, corrida.minute, 0) + bytes([0, 1])
    n = len(v)
    if malla['tipo'] == 'latlon':
        t = bytes([6, 0]) + b'\x00' * 4 + bytes([0]) + b'\x00' * 4 + bytes([0]) + b'\x00' * 4
        t += struct.pack('>II', malla['Ni'], malla['Nj']) + b'\x00' * 4 + b'\xff' * 4
        la2 = malla['la1'] + (1 if malla['scan'] & 0x40 else -1) * malla['dj'] * (malla['Nj'] - 1)
        lo2 = (malla['lo1'] + malla['di'] * (malla['Ni'] - 1))
        t += _sm(malla['la1'] * 1e6, 4) + _sm(malla['lo1'] * 1e6, 4) + bytes([48]) + _sm(la2 * 1e6, 4) + _sm(lo2 * 1e6, 4)
        t += _sm(malla['di'] * 1e6, 4) + _sm(malla['dj'] * 1e6, 4) + bytes([malla['scan']])
        s3 = bytes([0]) + struct.pack('>I', n) + bytes([0, 0]) + struct.pack('>H', 0) + t
    else:
        t = bytes([6]) + (26).to_bytes(3, 'big') + bytes([1]) + malla.get('uuid', UUID_ICON)
        s3 = bytes([0]) + struct.pack('>I', n) + bytes([0, 0]) + struct.pack('>H', 101) + t

    def nivel(x):
        return bytes([x[0], 0]) + (b'\xff' * 4 if x[1] is None else _sm(x[1], 4))
    cab = bytes([cat, num, 2, 0, 0]) + b'\x00\x00' + bytes([0]) + bytes([unidad])
    if acum is None:
        s4 = struct.pack('>HH', 0, 0) + cab + struct.pack('>I', paso) + nivel(nivel1) + nivel(nivel2)
    else:
        desde, largo = acum
        s4 = struct.pack('>HH', 0, 8) + cab + struct.pack('>I', desde) + nivel(nivel1) + nivel(nivel2)
        s4 += struct.pack('>HBBBBB', corrida.year, corrida.month, corrida.day, corrida.hour, 0, 0)
        s4 += bytes([1]) + b'\x00' * 4 + bytes([1, 2, unidad]) + struct.pack('>I', largo) + bytes([unidad]) + b'\x00' * 4
    mapa = None
    if faltantes is not None:
        mapa = ~np.asarray(faltantes, bool).ravel()
        vv = v[mapa]
    else:
        vv = v
    esc = np.round(vv * 10 ** decimales)
    R = float(np.float32(esc.min())) if len(esc) else 0.0
    x = np.round(esc - R).astype(np.int64)
    if (x < 0).any():
        R -= 1
        x = np.round(esc - R).astype(np.int64)
    nb = max(1, int(x.max()).bit_length()) if len(x) else 0
    bits = ((x[:, None] >> np.arange(nb - 1, -1, -1)) & 1).astype(np.uint8)
    datos = np.packbits(bits.ravel()).tobytes()
    s5 = struct.pack('>IH', len(vv), 0) + struct.pack('>f', R) + _sm(0, 2) + _sm(decimales, 2) + bytes([nb, 0])
    s6 = bytes([255]) if mapa is None else bytes([0]) + np.packbits(mapa.astype(np.uint8)).tobytes()
    cuerpo = _sec(1, s1) + _sec(3, s3) + _sec(4, s4) + _sec(5, s5) + _sec(6, s6) + _sec(7, datos) + b'7777'
    return b'GRIB' + b'\x00\x00' + bytes([disciplina, 2]) + struct.pack('>Q', 16 + len(cuerpo)) + cuerpo


# --- campos de prueba: una función conocida de (lat, lon, hora) para poder verificar píxel por píxel ---
def lluvia_total(lat, lon, h):
    """mm acumulados desde el inicio hasta +h (crece con h; distinta en cada celda)"""
    return h * (2.0 + 0.5 * np.sin(np.radians(lat) * 7) + 0.3 * np.cos(np.radians(lon) * 5) + ((lat + 56) % 3) * 0.4)


def cape(lat, lon, h):
    return np.clip(2500 * np.exp(-((lat + 30) ** 2 + (lon + 60) ** 2) / 60.0) * (1 + 0.1 * np.sin(h)), 0, None) + 50


MALLA_ECMWF = {'tipo': 'latlon', 'Ni': 141, 'Nj': 181, 'la1': -13.0, 'lo1': -78.0, 'di': 0.25, 'dj': 0.25, 'scan': 0}
MALLA_GFS = {'tipo': 'latlon', 'Ni': 141, 'Nj': 181, 'la1': -13.0, 'lo1': 282.0, 'di': 0.25, 'dj': 0.25, 'scan': 0}


def coords_regular(m):
    signo = 1 if m['scan'] & 0x40 else -1
    lats = m['la1'] + signo * m['dj'] * np.arange(m['Nj'])
    lons = ((m['lo1'] + m['di'] * np.arange(m['Ni'])) + 180) % 360 - 180
    return np.meshgrid(lats, lons, indexing='ij')


def celdas_icon(paso=0.11, semilla=7):
    """centros de celda «icosaédricos» de mentira: una grilla con ruido en la caja + 2°, en GRADOS"""
    r = np.random.default_rng(semilla)
    la, lo = np.meshgrid(np.arange(-58, -13, paso), np.arange(-78, -43, paso), indexing='ij')
    la = la.ravel() + r.uniform(-paso / 3, paso / 3, la.size)
    lo = lo.ravel() + r.uniform(-paso / 3, paso / 3, lo.size)
    return la, lo


class RedFalsa:
    """sirve un dict url → bytes; cuenta pedidos; rangos como S3/ECMWF (206)"""

    def __init__(self, archivos):
        self.archivos = archivos
        self.pedidos = 0
        self.bytes = 0
        self.por_host = {}
        self.log = []

    def _contar(self, url):
        self.pedidos += 1
        h = url.split('/')[2]
        self.por_host[h] = self.por_host.get(h, 0) + 1
        self.log.append(url)

    def get(self, url, rango=None):
        self._contar(url)
        d = self.archivos.get(url)
        if d is None:
            return None
        if rango:
            d = d[rango[0]:rango[1] + 1]
        self.bytes += len(d)
        return d

    def existe(self, url):
        self._contar(url)
        return url in self.archivos


def _archivo_con_indice(mensajes):
    """concatena (clave, bytes) y arma el .index de ECMWF y el .idx de GFS"""
    datos, idx_e, idx_g, o = b'', [], [], 0
    for n, (meta, m) in enumerate(mensajes, 1):
        idx_e.append(json.dumps(dict(meta['ecmwf'], _offset=o, _length=len(m))))
        idx_g.append('%d:%d:d=x:%s:' % (n, o, meta['gfs']))
        datos += m
        o += len(m)
    return datos, '\n'.join(idx_e).encode(), '\n'.join(idx_g).encode()


def relleno(m):
    """un mensaje de relleno (otro parámetro) para que los rangos no empiecen en 0"""
    return mensaje(np.zeros(m['Ni'] * m['Nj']), m, CORRIDA0, 0, 0)


from datetime import datetime, timezone  # noqa: E402
CORRIDA0 = datetime(2026, 11, 16, 12, tzinfo=timezone.utc)


def servidor(corrida, fuentes=('ecmwf', 'gfs', 'icon'), horas=range(0, 121, 6), faltar=()):
    """todos los archivos de una corrida de las 3 fuentes. `faltar`: (fuente, variable, h) que no se publican."""
    from lib.fuentes import Ecmwf, Gfs, Icon
    A = {}
    if 'ecmwf' in fuentes:
        E = Ecmwf()
        LA, LO = coords_regular(MALLA_ECMWF)
        for h in horas:
            ms = [({'ecmwf': {'param': '2t', 'levtype': 'sfc'}, 'gfs': ''}, relleno(MALLA_ECMWF))]
            if h > 0 and ('ecmwf', 'lluvia6h', h) not in faltar:
                ms.append(({'ecmwf': {'param': 'tp', 'levtype': 'sfc'}, 'gfs': ''},
                           mensaje(lluvia_total(LA, LO, h) / 1000.0, MALLA_ECMWF, corrida, 1, 193, acum=(0, h), decimales=6)))
            if ('ecmwf', 'cape', h) not in faltar:
                ms.append(({'ecmwf': {'param': 'mucape', 'levtype': 'sfc'}, 'gfs': ''},
                           mensaje(cape(LA, LO, h), MALLA_ECMWF, corrida, 7, 6, paso=h, nivel1=(17, None), decimales=1)))
            d, ie, _ = _archivo_con_indice(ms)
            A[E._url(corrida, h, 'grib2')] = d
            A[E._url(corrida, h, 'index')] = ie
    if 'gfs' in fuentes:
        G = Gfs()
        LA, LO = coords_regular(MALLA_GFS)
        for h in horas:
            ms = [({'ecmwf': {}, 'gfs': 'PRMSL:mean sea level:x'}, relleno(MALLA_GFS))]
            if h > 0 and ('gfs', 'lluvia6h', h) not in faltar:
                b6 = lluvia_total(LA, LO, h) - lluvia_total(LA, LO, h - 6)
                ms.append(({'ecmwf': {}, 'gfs': 'APCP:surface:%d-%d hour acc fcst' % (h - 6, h)},
                           mensaje(b6, MALLA_GFS, corrida, 1, 8, centro=7, acum=(h - 6, 6))))
                ms.append(({'ecmwf': {}, 'gfs': 'APCP:surface:0-%d hour acc fcst' % h},
                           mensaje(lluvia_total(LA, LO, h), MALLA_GFS, corrida, 1, 8, centro=7, acum=(0, h))))
            ms.append(({'ecmwf': {}, 'gfs': 'CAPE:surface:%s' % ('anl' if h == 0 else '%d hour fcst' % h)},
                       mensaje(cape(LA, LO, h) * 3, MALLA_GFS, corrida, 7, 6, centro=7, paso=h, decimales=1)))
            if ('gfs', 'cape', h) not in faltar:
                ms.append(({'ecmwf': {}, 'gfs': 'CAPE:255-0 mb above ground:%s' % ('anl' if h == 0 else '%d hour fcst' % h)},
                           mensaje(cape(LA, LO, h), MALLA_GFS, corrida, 7, 6, centro=7, paso=h, nivel1=(108, 25500),
                                   nivel2=(108, 0), decimales=1)))
            ms.append(({'ecmwf': {}, 'gfs': 'CIN:255-0 mb above ground:x'}, relleno(MALLA_GFS)))
            d, _, ig = _archivo_con_indice(ms)
            A[G._url(corrida, h)] = d
            A[G._url(corrida, h, '.idx')] = ig
    if 'icon' in fuentes:
        I = Icon()
        la, lo = celdas_icon()
        mi = {'tipo': 'icosaedrica'}
        A[I._url_fija(corrida, 'CLAT')] = bz2.compress(mensaje(la, mi, corrida, 191, 1, centro=78, decimales=5))
        A[I._url_fija(corrida, 'CLON')] = bz2.compress(mensaje(lo, mi, corrida, 191, 2, centro=78, decimales=5))
        for h in horas:
            if h > 0 and ('icon', 'lluvia6h', h) not in faltar:
                A[I._url(corrida, h, 'TOT_PREC')] = bz2.compress(
                    mensaje(lluvia_total(la, lo, h), mi, corrida, 1, 52, centro=78, unidad=0, acum=(0, h * 60)))
            if ('icon', 'cape', h) not in faltar:
                A[I._url(corrida, h, 'CAPE_ML')] = bz2.compress(
                    mensaje(cape(la, lo, h), mi, corrida, 7, 6, centro=78, unidad=0, paso=h * 60, nivel1=(192, 0), decimales=1))
    return A
