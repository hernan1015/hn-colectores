"""HN AGRO · 312 · las 3 fuentes: dónde está cada mensaje y cómo se convierte en un cuadro de la malla de salida.

Medido en el Paso 0 (17/11/2026; ver LEEME.md):
- ECMWF IFS open data 0,25°: .index (JSON por línea, _offset/_length) + rango HTTP. tp en m, acumulada desde el inicio;
  mucape (parcela más inestable, superficie tipo 17). CC BY 4.0.
- NOAA GFS 0,25° (bucket noaa-gfs-bdp-pds): .idx (texto, offset del mensaje siguiente) + rango. APCP «(N−6)-N hour acc»
  directo; CAPE «255-0 mb above ground» (MUCAPE). Dominio público.
- DWD ICON global: un archivo .grib2.bz2 por parámetro y hora = UN mensaje (no hay índice ni rango posible), malla
  icosaédrica R03B07 (no hay versión lat-lon regular del global en el open data). TOT_PREC acumulada desde el inicio;
  CAPE_ML (capa de mezcla). CLAT/CLON (time-invariant) para regrillar. Condiciones del DWD: CC BY 4.0.

Este módulo no importa numpy arriba: el chequeo previo (sin dependencias) usa `candidatos` y `disponible`.
"""
import bz2
import json
from datetime import datetime, timedelta, timezone

H6 = timedelta(hours=6)
LLUVIA_MAX_MM = 500.0       # en 6 h: más que eso es un error de unidades, no un dato
CAPE_MAX = 10000.0
# [312d · 17/11] EL VIENTO (u y v) para el viento animado de MODELOS en SATCHI (el método de `_v795`). Va SÓLO en la v2 (no hay
# cuadro v1 de viento) y se arma APARTE y DESPUÉS de todo el v1 (tuberia.procesar_viento): un error del viento nunca toca el v1.
# u = hacia el ESTE y v = hacia el NORTE, en m/s (GRIB 0/2/2 y 0/2/3), instantáneo a la hora válida. ECMWF y GFS (lat-lon) e ICON
# (sus U y V del open data son geográficas, en el centro de la celda) dan las dos componentes respecto del norte geográfico.
VIENTO_MAX = 150.0          # m/s (540 km/h): más que eso es un error de unidades (el chorro de 250 hPa llega a ~100 m/s)
NIVELES_VIENTO = ('viento10m', 'viento850', 'viento250')
GRIB_VIENTO = {'viento10m': ((103, 10.0), (255, None)),        # 10 m sobre el suelo
               'viento850': ((100, 85000.0), (255, None)),     # isobárica, en Pa (valor FÍSICO, con el factor de escala)
               'viento250': ((100, 25000.0), (255, None))}
PARAM_UV = {'u': (0, 2, 2), 'v': (0, 2, 3)}
HORAS_VIENTO = tuple(range(0, 121, 6))


class ErrorFuente(Exception):
    pass


def ciclo_de(ahora):
    return ahora.replace(minute=0, second=0, microsecond=0, hour=ahora.hour - ahora.hour % 6)


class Fuente:
    id = nombre = modelo = resolucion = cape_tipo = ''
    retraso_h = 0.0
    cita = {}

    def __init__(self):
        self._cache = {}

    def candidatos(self, ahora, n=5):
        """corridas que ya podrían estar, de la más nueva a la más vieja (las últimas 24 h)"""
        c0 = ciclo_de(ahora)
        return [c for c in (c0 - k * H6 for k in range(n)) if ahora >= c + timedelta(hours=self.retraso_h)]

    def disponible(self, red, corrida, h_max):
        raise NotImplementedError

    def nuevo(self, corrida):
        self._cache = {'corrida': corrida}

    # --- lo que necesita numpy ---
    def _chequear(self, arr, variable):
        import numpy as np
        if np.isnan(arr).any():
            raise ErrorFuente('valores faltantes en la caja')
        tope = LLUVIA_MAX_MM if variable == 'lluvia6h' else CAPE_MAX
        if np.nanmax(arr) > tope or np.nanmin(arr) < -1:
            raise ErrorFuente('valores fuera de rango (%.1f..%.1f): ¿unidades?' % (np.nanmin(arr), np.nanmax(arr)))
        return np.clip(arr, 0, None)

    # [312d] el viento: horas, chequeo y las dos componentes (cada fuente define _componente)
    horas_viento = HORAS_VIENTO
    param_viento = {}

    def _chequear_viento(self, u, v):
        import numpy as np
        for n, a in (('u', u), ('v', v)):
            if np.isnan(a).any():
                raise ErrorFuente('viento %s: valores faltantes en un nodo' % n)
            if np.abs(a).max() > VIENTO_MAX:
                raise ErrorFuente('viento %s fuera de rango (%.1f m/s): ¿unidades?' % (n, np.abs(a).max()))
        return u, v

    def viento(self, red, corrida, nivel, h):
        """[312d] (u, v, info): las dos componentes (m/s; u hacia el este, v hacia el norte) en los nodos de la grilla v2"""
        if nivel not in NIVELES_VIENTO:
            raise ErrorFuente('nivel de viento desconocido: %s' % nivel)
        u = self._componente(red, corrida, nivel, 'u', h)
        v = self._componente(red, corrida, nivel, 'v', h)
        u, v = self._chequear_viento(u, v)
        return u, v, {'parametro_fuente': self.param_viento[nivel], 'regrillado': self.regrillado_v2}

    def _v2(self, info, construir, variable):
        """[312c · Codex n3-312c-col 1] la grilla v2 se arma APARTE y DESPUÉS del v1: si no se puede (una malla que no cae en los
        nodos, un faltante en un nodo del borde, otra malla de ICON…), el cuadro v1 sale igual y la v2 queda como fallida."""
        try:
            info['v2'] = self._chequear(construir(), variable)
        except Exception as e:   # cualquier error de la v2 no toca el v1
            info['v2'], info['v2_error'] = None, '%s: %s' % (type(e).__name__, e)
        info['regrillado_v2'] = self.regrillado_v2
        return info


class Regular(Fuente):
    """fuentes en malla lat-lon 0,25° con índice y rango HTTP (ECMWF y GFS)"""
    regrillado = 'vecino más cercano de la malla 0,25° de la fuente a la del PNG (bloques de 2 × 2 píxeles)'
    regrillado_v2 = 'ninguno: los nodos de 0,25° de la grilla v2 son los puntos de la malla de la fuente'   # [312c]

    def _rango(self, red, corrida, h, clave):
        raise NotImplementedError

    def _campo(self, red, corrida, h, clave, **validar):
        from . import grib, malla
        datos = red.get(self._url_grib(corrida, h), rango=self._rango(red, corrida, h, clave))
        if datos is None:
            raise ErrorFuente('el mensaje no está')
        ms = grib.separar(datos)
        if len(ms) != 1:
            raise ErrorFuente('%d mensajes en el rango' % len(ms))
        c = grib.leer(ms[0], corrida=corrida, **validar)
        sub, la, lo = malla.recortar(c['valores'], c['malla'])
        return c, sub, la, lo

    def _componente(self, red, corrida, nivel, comp, h):
        """[312d] una componente del viento en los nodos v2 (los puntos de la fuente, sin remuestreo)"""
        from . import malla
        _, sub, la, lo = self._campo(red, corrida, h, ('viento', nivel, comp), paso_h=h, parametro=PARAM_UV[comp],
                                     niveles=GRIB_VIENTO[nivel])
        return malla.regular_a_v2(sub, la, lo)

    def cuadro(self, red, corrida, variable, h):
        from . import malla
        if variable == 'cape':
            c, sub, la, lo = self._campo(red, corrida, h, 'cape', paso_h=h, parametro=(0, 7, 6), niveles=self.niveles_cape)
            self._validar_cape(c)
            arr = self._chequear(malla.regular_a_salida(sub, la, lo), variable)
            return arr, self._v2({'parametro_fuente': self.param_cape, 'regrillado': self.regrillado},
                                 lambda: malla.regular_a_v2(sub, la, lo), variable)
        sub, la, lo = self._lluvia6(red, corrida, h)
        arr = self._chequear(malla.regular_a_salida(sub, la, lo), variable)
        return arr, self._v2({'parametro_fuente': self.param_lluvia % {'h': h, 'h0': h - 6}, 'regrillado': self.regrillado},
                             lambda: malla.regular_a_v2(sub, la, lo), variable)


class Ecmwf(Regular):
    id, nombre = 'ecmwf', 'ECMWF IFS'
    modelo = 'ECMWF IFS (open data, 0,25°)'
    resolucion = '0,25° (~28 km)'
    cape_tipo = 'MUCAPE'
    niveles_cape = ((17, None), (255, None))     # parcela más inestable (sin valor), sin segunda superficie
    retraso_h = 6.0
    BASE = 'https://data.ecmwf.int/forecasts'
    param_cape = 'mucape (J/kg, parcela más inestable)'
    param_lluvia = 'tp (m, acumulada desde el inicio): tp(+%(h)d h) − tp(+%(h0)d h), × 1000'
    param_viento = {'viento10m': '10u y 10v (m/s, a 10 m, instantáneo)', 'viento850': 'u y v (m/s) en 850 hPa (levtype pl, instantáneo)',
                    'viento250': 'u y v (m/s) en 250 hPa (levtype pl, instantáneo)'}
    cita = {
        'texto': ('Basado en datos y productos del Centro Europeo de Pronósticos Meteorológicos a Plazo Medio (ECMWF). '
                  '© %(anio)d European Centre for Medium-Range Weather Forecasts (ECMWF). Licencia CC BY 4.0. '
                  'Datos recortados, diferenciados y coloreados por HN AGRO. ECMWF no acepta responsabilidad por '
                  'errores u omisiones en los datos ni por su disponibilidad.'),
        'licencia': 'CC BY 4.0', 'url': 'https://creativecommons.org/licenses/by/4.0/',
        'fuente_url': 'https://www.ecmwf.int/en/forecasts/datasets/open-data',
    }

    def _url(self, corrida, h, ext):
        return '%s/%s/%02dz/ifs/0p25/oper/%s-%dh-oper-fc.%s' % (
            self.BASE, corrida.strftime('%Y%m%d'), corrida.hour, corrida.strftime('%Y%m%d%H%M%S'), h, ext)

    def _url_grib(self, corrida, h):
        return self._url(corrida, h, 'grib2')

    def disponible(self, red, corrida, h_max):
        return red.existe(self._url(corrida, h_max, 'index'))

    def _indice(self, red, corrida, h):
        k = ('idx', h)
        if k not in self._cache:
            t = red.get(self._url(corrida, h, 'index'))
            if t is None:
                raise ErrorFuente('falta el índice de +%d h' % h)
            self._cache[k] = [json.loads(l) for l in t.decode().splitlines() if l.strip()]
        return self._cache[k]

    def _rango(self, red, corrida, h, clave):
        if isinstance(clave, tuple):     # [312d] ('viento', nivel, 'u'|'v'): 10u/10v en sfc; u/v en pl con su levelist
            _, nivel, comp = clave
            if nivel == 'viento10m':
                param = '10' + comp
                L = [x for x in self._indice(red, corrida, h) if x.get('param') == param and x.get('levtype') == 'sfc']
            else:
                param = '%s %s hPa' % (comp, nivel[6:])
                L = [x for x in self._indice(red, corrida, h) if x.get('param') == comp and x.get('levtype') == 'pl'
                     and str(x.get('levelist')) == nivel[6:]]
            if len(L) != 1:
                raise ErrorFuente('%d entradas de %s en el índice de +%d h' % (len(L), param, h))
            o, n = int(L[0]['_offset']), int(L[0]['_length'])
            return (o, o + n - 1)
        param = 'tp' if clave == 'lluvia' else 'mucape'
        L = [x for x in self._indice(red, corrida, h) if x.get('param') == param and x.get('levtype') == 'sfc']
        if len(L) != 1:
            raise ErrorFuente('%d entradas de %s en el índice de +%d h' % (len(L), param, h))
        o, n = int(L[0]['_offset']), int(L[0]['_length'])
        return (o, o + n - 1)

    def _validar_cape(self, c):
        pass        # [n3-312a 3] la superficie 17 (parcela más inestable) la exige leer() con niveles_cape

    def _tp(self, red, corrida, h):
        from . import grib
        k = ('tp', h)
        if k not in self._cache:
            if h == 0:
                self._cache[k] = None          # tp(0) = 0: no se pide
            else:
                _, sub, la, lo = self._campo(red, corrida, h, 'lluvia', acum_h=(0, h), parametro=(0, 1, 193),
                                             niveles=grib.SUPERFICIE)
                self._cache[k] = (sub, la, lo)
            self._cache.pop(('tp', h - 12), None)
        return self._cache[k]

    def _lluvia6(self, red, corrida, h):
        import numpy as np
        b = self._tp(red, corrida, h)
        a = self._tp(red, corrida, h - 6)
        sub, la, lo = b
        prev = np.zeros_like(sub) if a is None else a[0]
        return (sub - prev) * 1000.0, la, lo


class Gfs(Regular):
    id, nombre = 'gfs', 'NOAA GFS'
    modelo = 'NOAA GFS (0,25°)'
    resolucion = '0,25° (~28 km)'
    cape_tipo = 'MUCAPE'
    niveles_cape = ((108, 25500.0), (108, 0.0))  # [n3-312a v2] de 255 hPa (25500 Pa, FÍSICO, con la escala) al suelo
    retraso_h = 3.5
    BASE = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com'
    param_cape = 'CAPE 255-0 mb above ground (J/kg, parcela más inestable de los 255 hPa de abajo)'
    param_lluvia = 'APCP (kg/m², «%(h0)d-%(h)d hour acc»): el balde de 6 h directo'
    param_viento = {'viento10m': 'UGRD y VGRD «10 m above ground» (m/s)', 'viento850': 'UGRD y VGRD «850 mb» (m/s)',
                    'viento250': 'UGRD y VGRD «250 mb» (m/s)'}
    cita = {
        'texto': ('NOAA/NCEP Global Forecast System (GFS), dominio público. Fuente: NOAA Open Data Dissemination '
                  '(bucket noaa-gfs-bdp-pds). Datos recortados y coloreados por HN AGRO; NOAA no los avala.'),
        'licencia': 'Dominio público (EE. UU.)', 'url': 'https://www.noaa.gov/information-technology/open-data-dissemination',
        'fuente_url': 'https://registry.opendata.aws/noaa-gfs-bdp-pds/',
    }

    def _url(self, corrida, h, ext=''):
        return '%s/gfs.%s/%02d/atmos/gfs.t%02dz.pgrb2.0p25.f%03d%s' % (
            self.BASE, corrida.strftime('%Y%m%d'), corrida.hour, corrida.hour, h, ext)

    def _url_grib(self, corrida, h):
        return self._url(corrida, h)

    def disponible(self, red, corrida, h_max):
        return red.existe(self._url(corrida, h_max, '.idx'))

    def _indice(self, red, corrida, h):
        k = ('idx', h)
        if k not in self._cache:
            t = red.get(self._url(corrida, h, '.idx'))
            if t is None:
                raise ErrorFuente('falta el .idx de f%03d' % h)
            self._cache[k] = [l.split(':') for l in t.decode().splitlines() if l.strip()]
        return self._cache[k]

    def _rango(self, red, corrida, h, clave):
        L = self._indice(red, corrida, h)
        if isinstance(clave, tuple):     # [312d] ('viento', nivel, 'u'|'v')
            _, nivel, comp = clave
            quiero = ({'u': 'UGRD', 'v': 'VGRD'}[comp], '10 m above ground' if nivel == 'viento10m' else '%s mb' % nivel[6:],
                      'anl' if h == 0 else '%d hour fcst' % h)
        elif clave == 'lluvia':
            quiero = ('APCP', 'surface', '%d-%d hour acc fcst' % (h - 6, h))
        else:
            quiero = ('CAPE', '255-0 mb above ground', 'anl' if h == 0 else '%d hour fcst' % h)
        for n, linea in enumerate(L):
            if tuple(linea[3:6]) == quiero:
                if n + 1 >= len(L):
                    raise ErrorFuente('el mensaje es el último del archivo')
                return (int(linea[1]), int(L[n + 1][1]) - 1)
        raise ErrorFuente('no está %s en el .idx de f%03d' % (':'.join(quiero), h))

    def _validar_cape(self, c):
        pass        # [n3-312a v2] los dos niveles (con su escala) los exige leer() con niveles_cape

    def _lluvia6(self, red, corrida, h):
        from . import grib
        _, sub, la, lo = self._campo(red, corrida, h, 'lluvia', acum_h=(h - 6, h), parametro=(0, 1, 8),
                                     niveles=grib.SUPERFICIE)
        return sub, la, lo


class Icon(Fuente):
    id, nombre = 'icon', 'DWD ICON'
    modelo = 'DWD ICON global (R03B07, ~13 km)'
    resolucion = '~13 km (malla icosaédrica R03B07)'
    cape_tipo = 'MLCAPE'
    retraso_h = 2.5
    BASE = 'https://opendata.dwd.de/weather/nwp/icon/grib'
    param_cape = 'CAPE_ML (J/kg, parcela de la capa de mezcla)'
    param_lluvia = 'TOT_PREC (kg/m², acumulada desde el inicio): TOT_PREC(+%(h)d h) − TOT_PREC(+%(h0)d h)'
    param_viento = {'viento10m': 'U_10M y V_10M (m/s, single-level)', 'viento850': 'U y V (m/s) pressure-level 850 hPa',
                    'viento250': 'U y V (m/s) pressure-level 250 hPa'}
    # [312d] EL PESO: ICON no tiene índice ni rango; es un .bz2 por componente, nivel y hora (~3,4-3,9 MB cada uno, medido el 17/11
    # con HEAD). Cada 6 h serían 126 archivos ≈ 460 MB por corrida; cada 12 h son 66 ≈ 240 MB. ECMWF y GFS van por rango
    # (~0,5-1 MB por mensaje), cada 6 h: ~78 y ~88 MB por corrida.
    horas_viento = tuple(range(0, 121, 12))
    regrillado = ('malla icosaédrica R03B07 → vecino más cercano sobre la esfera (centros de celda CLAT/CLON del DWD, '
                  'árbol KD), equivalente a cdo remapnn')
    regrillado_v2 = ('[312c] a cada nodo de 0,25° de la grilla v2, el valor del centro de celda R03B07 más cercano sobre la esfera '
                     '(el mismo árbol KD; ICON tiene ~13 km: es un muestreo, no un promedio)')
    cita = {
        'texto': ('Fuente: Deutscher Wetterdienst (DWD), modelo ICON global, opendata.dwd.de. Licencia CC BY 4.0. '
                  'Datos regrillados de la malla icosaédrica, recortados, diferenciados y coloreados por HN AGRO.'),
        'licencia': 'CC BY 4.0', 'url': 'https://creativecommons.org/licenses/by/4.0/',
        'fuente_url': 'https://www.dwd.de/opendata',
    }

    def _url(self, corrida, h, var):
        return '%s/%02d/%s/icon_global_icosahedral_single-level_%s_%03d_%s.grib2.bz2' % (
            self.BASE, corrida.hour, var.lower(), corrida.strftime('%Y%m%d%H'), h, var)

    def _url_fija(self, corrida, var):
        return '%s/%02d/%s/icon_global_icosahedral_time-invariant_%s_%s.grib2.bz2' % (
            self.BASE, corrida.hour, var.lower(), corrida.strftime('%Y%m%d%H'), var)

    def disponible(self, red, corrida, h_max):
        return red.existe(self._url(corrida, h_max, 'CAPE_ML')) and red.existe(self._url(corrida, h_max, 'TOT_PREC'))

    def _url_pl(self, corrida, h, hpa, var):
        """[312d] los niveles de presión: un archivo por variable, hora y nivel (en hPa)"""
        return '%s/%02d/%s/icon_global_icosahedral_pressure-level_%s_%03d_%d_%s.grib2.bz2' % (
            self.BASE, corrida.hour, var.lower(), corrida.strftime('%Y%m%d%H'), h, hpa, var)

    def _componente(self, red, corrida, nivel, comp, h):
        """[312d] una componente del viento: el centro de celda más cercano a cada nodo v2 (el mismo árbol KD)"""
        from . import grib
        M = self._malla(red, corrida)
        var = comp.upper()
        url = self._url(corrida, h, var + '_10M') if nivel == 'viento10m' else self._url_pl(corrida, h, int(nivel[6:]), var)
        c = grib.leer(self._bajar(red, url), corrida=corrida, paso_h=h, parametro=PARAM_UV[comp], niveles=GRIB_VIENTO[nivel])
        return M.a_v2(c['valores'], c['malla']['uuid'])

    def _bajar(self, red, url):
        from . import grib
        d = red.get(url)
        if d is None:
            raise ErrorFuente('el archivo no está')
        try:
            d = bz2.decompress(d)
        except (OSError, ValueError):
            raise ErrorFuente('bz2 roto')
        ms = grib.separar(d)
        if len(ms) != 1:
            raise ErrorFuente('%d mensajes en el archivo' % len(ms))
        return ms[0]

    def _malla(self, red, corrida):
        from . import grib, malla
        if 'malla' not in self._cache:
            la = grib.leer(self._bajar(red, self._url_fija(corrida, 'CLAT')), parametro=(0, 191, 1))
            lo = grib.leer(self._bajar(red, self._url_fija(corrida, 'CLON')), parametro=(0, 191, 2))
            if la['malla']['uuid'] != lo['malla']['uuid']:
                raise ErrorFuente('CLAT y CLON de mallas distintas')
            self._cache['malla'] = malla.MallaIcon(la['valores'], lo['valores'], la['malla']['uuid'])
        return self._cache['malla']

    def _acum(self, red, corrida, h):
        from . import grib
        k = ('tp', h)
        if k not in self._cache:
            if h == 0:
                self._cache[k] = None
            else:
                c = grib.leer(self._bajar(red, self._url(corrida, h, 'TOT_PREC')), corrida=corrida, acum_h=(0, h),
                              parametro=(0, 1, 52), niveles=grib.SUPERFICIE)
                self._cache[k] = (c['valores'], c['malla']['uuid'])
            self._cache.pop(('tp', h - 12), None)
        return self._cache[k]

    def cuadro(self, red, corrida, variable, h):
        from . import grib
        import numpy as np
        M = self._malla(red, corrida)
        if variable == 'cape':
            c = grib.leer(self._bajar(red, self._url(corrida, h, 'CAPE_ML')), corrida=corrida, paso_h=h, parametro=(0, 7, 6),
                          niveles=((192, None), (255, None)))
            if c['nivel1'][0] != 192:
                raise ErrorFuente('el CAPE no es el de capa de mezcla (superficie %d)' % c['nivel1'][0])
            arr = self._chequear(M.a_salida(c['valores'], c['malla']['uuid']), variable)
            return arr, self._v2({'parametro_fuente': self.param_cape, 'regrillado': self.regrillado},
                                 lambda: M.a_v2(c['valores'], c['malla']['uuid']), variable)
        b = self._acum(red, corrida, h)
        a = self._acum(red, corrida, h - 6)
        dif = b[0] - (0 if a is None else a[0])          # la diferencia en la malla nativa, después se regrilla
        if a is not None and a[1] != b[1]:
            raise ErrorFuente('las dos acumuladas son de mallas distintas')
        arr = self._chequear(M.a_salida(dif, b[1]), variable)
        return arr, self._v2({'parametro_fuente': self.param_lluvia % {'h': h, 'h0': h - 6}, 'regrillado': self.regrillado},
                             lambda: M.a_v2(dif, b[1]), variable)


FUENTES = {'ecmwf': Ecmwf, 'icon': Icon, 'gfs': Gfs}
