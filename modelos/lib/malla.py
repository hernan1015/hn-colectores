"""HN AGRO · 312 · el recorte y la malla de salida (la misma para las 3 fuentes).

La salida: Sudamérica sur (lon −76 a −45, lat −56 a −15), 248 columnas equiespaciadas en longitud (0,125°) y 422 filas
equiespaciadas en Y de Web Mercator (EPSG:3857), de norte a sur. Así un imageOverlay de Leaflet o una fuente `image` de
MapLibre con las esquinas de la caja cae exacta.

Remuestreo: VECINO MÁS CERCANO en las 3 fuentes (equivale a `cdo remapnn`). No inventa valores ni suaviza máximos:
cada píxel tiene el valor de la celda del modelo que le toca. ECMWF y GFS (0,25°) quedan en bloques de 2 × 2 píxeles.
ICON (malla icosaédrica R03B07, ~13 km, 2.949.120 celdas) se lleva a la salida con el centro de celda más cercano sobre
la esfera (árbol KD sobre vectores unitarios 3D, scipy cKDTree), con las coordenadas CLAT/CLON que publica el DWD.
"""
import math

import numpy as np

CAJA = {'oeste': -76.0, 'este': -45.0, 'sur': -56.0, 'norte': -15.0}
PASO_LON = 0.125
R_TIERRA = 6378137.0
ANCHO = int(round((CAJA['este'] - CAJA['oeste']) / PASO_LON))          # 248


def merc_y(lat):
    return R_TIERRA * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def merc_lat(y):
    return np.degrees(2 * np.arctan(np.exp(y / R_TIERRA)) - np.pi / 2)


Y_NORTE, Y_SUR = float(merc_y(CAJA['norte'])), float(merc_y(CAJA['sur']))
X_OESTE, X_ESTE = R_TIERRA * math.radians(CAJA['oeste']), R_TIERRA * math.radians(CAJA['este'])
ALTO = int(round(ANCHO * (Y_NORTE - Y_SUR) / (X_ESTE - X_OESTE)))     # 422: píxel cuadrado en Mercator


def centros_salida():
    """(lat 1D de las filas, lon 1D de las columnas) de los centros de píxel"""
    lon = CAJA['oeste'] + (np.arange(ANCHO) + 0.5) * PASO_LON
    y = Y_NORTE - (np.arange(ALTO) + 0.5) * (Y_NORTE - Y_SUR) / ALTO
    return merc_lat(y), lon


def georref():
    return {
        'ancho': ANCHO, 'alto': ALTO, 'proyeccion': 'EPSG:3857',
        'filas': 'equiespaciadas en Mercator (y), de norte a sur; columnas equiespaciadas en longitud',
        'esquinas': [[CAJA['norte'], CAJA['oeste']], [CAJA['sur'], CAJA['este']]],
        'caja_3857': {'xmin': round(X_OESTE, 1), 'xmax': round(X_ESTE, 1), 'ymin': round(Y_SUR, 1), 'ymax': round(Y_NORTE, 1)},
        'pixel_grados_lon': PASO_LON,
    }


def _lon180(lon):
    return (np.asarray(lon, dtype='f8') + 180.0) % 360.0 - 180.0


def recorte_regular(malla, margen=1.0):
    """índices (filas j, columnas i) de la malla lat-lon de la fuente que caen en la caja (+ margen en grados).
    Soporta lon 0..360 (GFS) y −180..180 (ECMWF), y filas norte→sur (scan 0) o sur→norte (scan 0x40)."""
    if malla['tipo'] != 'latlon':
        raise ValueError('no es lat-lon')
    if malla['scan'] not in (0, 0x40):
        raise ValueError('modo de barrido %d' % malla['scan'])
    Ni, Nj, di, dj = malla['Ni'], malla['Nj'], malla['di'], malla['dj']
    signo = 1 if malla['scan'] & 0x40 else -1
    lats = malla['la1'] + signo * dj * np.arange(Nj)
    lons = _lon180(malla['lo1'] + di * np.arange(Ni))
    j = np.where((lats >= CAJA['sur'] - margen) & (lats <= CAJA['norte'] + margen))[0]
    i = np.where((lons >= CAJA['oeste'] - margen) & (lons <= CAJA['este'] + margen))[0]
    if len(j) == 0 or len(i) == 0:
        raise ValueError('la caja no cae en la malla')
    return j, i, lats[j], lons[i]


def recortar(valores, malla, margen=1.0):
    """el recorte de un campo lat-lon: (matriz [filas, columnas], lats, lons)"""
    j, i, la, lo = recorte_regular(malla, margen)
    m = np.asarray(valores, dtype='f8').reshape(malla['Nj'], malla['Ni'])
    return m[np.ix_(j, i)], la, lo


def regular_a_salida(sub, lats, lons):
    """vecino más cercano de una sub-malla lat-lon (equiespaciada) a la malla de salida"""
    lat_s, lon_s = centros_salida()
    jj = np.abs(lat_s[:, None] - lats[None, :]).argmin(axis=1)
    ii = np.abs(lon_s[:, None] - lons[None, :]).argmin(axis=1)
    paso_la = abs(lats[1] - lats[0]) if len(lats) > 1 else 1.0
    paso_lo = abs(lons[1] - lons[0]) if len(lons) > 1 else 1.0
    if (np.abs(lats[jj] - lat_s).max() > paso_la * 0.51 + 1e-9) or (np.abs(lons[ii] - lon_s).max() > paso_lo * 0.51 + 1e-9):
        raise ValueError('la sub-malla no cubre la caja')
    return sub[np.ix_(jj, ii)]


def _xyz(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


class MallaIcon:
    """del índice de celda icosaédrica al píxel de salida: vecino más cercano sobre la esfera"""

    DIST_MAX_KM = 25.0      # R03B07: el centro más cercano está a menos de ~8 km; más lejos es una malla equivocada

    def __init__(self, clat, clon, uuid):
        from scipy.spatial import cKDTree
        clat = np.asarray(clat, dtype='f8')
        clon = np.asarray(clon, dtype='f8')
        if np.nanmax(np.abs(clat)) <= math.pi + 1e-6 and np.nanmax(np.abs(clon)) <= 2 * math.pi + 1e-6:
            clat, clon = np.degrees(clat), np.degrees(clon)   # por si vienen en radianes (la malla NetCDF las trae así)
        clon = _lon180(clon)
        self.uuid = uuid
        sel = np.where((clat >= CAJA['sur'] - 1) & (clat <= CAJA['norte'] + 1)
                       & (clon >= CAJA['oeste'] - 1) & (clon <= CAJA['este'] + 1))[0]
        if len(sel) == 0:
            raise ValueError('ninguna celda en la caja')
        arbol = cKDTree(_xyz(clat[sel], clon[sel]))
        lat_s, lon_s = centros_salida()
        LA, LO = np.meshgrid(lat_s, lon_s, indexing='ij')
        d, k = arbol.query(_xyz(LA.ravel(), LO.ravel()), k=1)
        if d.max() * 6371.0 > self.DIST_MAX_KM:
            raise ValueError('celda más cercana a %.0f km: malla equivocada' % (d.max() * 6371.0))
        self.indice = sel[k].reshape(ALTO, ANCHO)
        self.n_celdas_caja = int(len(sel))
        # [312c] los nodos de la grilla de valores v2, con el mismo árbol. La distancia ya la acotó el chequeo de arriba (la misma
        # malla, la misma caja + 1° de margen: un nodo del borde nunca queda más lejos que el tope si los píxeles no quedaron)
        la_n, lo_n = nodos_v2()
        LA, LO = np.meshgrid(la_n, lo_n, indexing='ij')
        d2, k2 = arbol.query(_xyz(LA.ravel(), LO.ravel()), k=1)
        self.dist_max_v2_km = float(d2.max() * 6371.0)
        self.indice_v2 = sel[k2].reshape(NLAT_V2, NLON_V2)

    def a_salida(self, valores, uuid):
        if uuid != self.uuid:
            raise ValueError('el campo es de otra malla (uuid %s, CLAT/CLON %s)' % (uuid, self.uuid))
        return np.asarray(valores, dtype='f8')[self.indice]

    def a_v2(self, valores, uuid):
        """[312c] el campo en los nodos de la grilla de valores v2"""
        if self.uuid != uuid:
            raise ValueError('el campo es de otra malla (uuid %s, CLAT/CLON %s)' % (uuid, self.uuid))
        return np.asarray(valores, dtype='f8')[self.indice_v2]


# ── [312c · 17/11] LA GRILLA DE VALORES (contrato R2 v2) ──────────────────────────────────────────────────────────────────
# Para que el front interpole el VALOR y aplique la paleta continua DESPUÉS (el dibujo suavizado de la 312c, el método de _v795):
# una malla lat-lon regular de 0,25° cuyos NODOS van de −15 a −56 (165 filas, norte → sur) y de −76 a −45 (125 columnas,
# oeste → este). ECMWF y GFS (0,25°) tienen sus puntos EXACTAMENTE en esos nodos: el valor es el de la fuente, sin remuestreo.
# ICON: el centro de celda más cercano a cada nodo (vecino más cercano sobre la esfera, el mismo árbol que el PNG). Nunca se
# promedia ni se inventa: un nodo sin valor es NaN (en el PNG de 16 bits, 65535).
PASO_V2 = 0.25
NLAT_V2 = int(round((CAJA['norte'] - CAJA['sur']) / PASO_V2)) + 1     # 165
NLON_V2 = int(round((CAJA['este'] - CAJA['oeste']) / PASO_V2)) + 1    # 125


def nodos_v2():
    """(lat 1D de las filas, de norte a sur; lon 1D de las columnas, de oeste a este)"""
    return CAJA['norte'] - np.arange(NLAT_V2) * PASO_V2, CAJA['oeste'] + np.arange(NLON_V2) * PASO_V2


def grilla_v2():
    return {'lat0': CAJA['norte'], 'dlat': -PASO_V2, 'nlat': NLAT_V2, 'lon0': CAJA['oeste'], 'dlon': PASO_V2, 'nlon': NLON_V2,
            'orden': 'filas de norte a sur, columnas de oeste a este; cada valor es el del NODO (lat, lon)',
            'proyeccion': 'EPSG:4326 (lat-lon regular)'}


def regular_a_v2(sub, lats, lons):
    """de una sub-malla lat-lon de la fuente a los nodos v2: el punto de la fuente en el nodo (a menos de 1/100 de paso);
    una malla que no tiene sus puntos en los nodos es un error (no se remuestrea a escondidas)"""
    la_n, lo_n = nodos_v2()
    jj = np.abs(la_n[:, None] - lats[None, :]).argmin(axis=1)
    ii = np.abs(lo_n[:, None] - lons[None, :]).argmin(axis=1)
    if np.abs(lats[jj] - la_n).max() > 0.01 * PASO_V2 or np.abs(lons[ii] - lo_n).max() > 0.01 * PASO_V2:
        raise ValueError('la malla de la fuente no tiene sus puntos en los nodos de 0,25°')
    return sub[np.ix_(jj, ii)]

