# -*- coding: utf-8 -*-
"""
COPIA ADAPTADA PARA EL LOTE (granizo-g3/lote.py la importa). Original: G3/analisis.py del cortex de HN AGRO
(commit c74f276). Cambios respecto del original, todos marcados con «LOTE:»:
  1. ABI: se baja el ARCHIVO ENTERO a disco, se verifica el tamaño contra Content-Length, se recorta y se borra.
     El original leía por rangos HTTP (fsspec blockcache); en este proyecto leer por rangos dio números inventados.
  2. Como mucho 2 pedidos simultáneos a NOAA (el original usaba 3).
  3. BUCKET, DATOS y CASOS los fija lote.py por episodio (GOES-16 o GOES-19 según la fecha).
  4. GLM: se verifica el estado HTTP y el tamaño; sin destellos la matriz vacía tiene 6 columnas (el original, 4).
  5. listar(): si los 4 intentos fallan, corta con error (el original seguía con una variable sin definir).
El resto (tobac, paralaje, rayos por celda, salto 2σ, atributos) es el del original sin tocar.

G3 · Prototipo de la etapa 3 del vigía de granizo («convección intensificándose», 90-0 min).
Seguimiento CELDA por CELDA con GOES-19 ABI banda 13 (cada 10 min) y GLM crudo de 20 s.

Uso (desde cualquier carpeta, Python 3.14, `python -P`):
    python -P analisis.py bajar  <caso>    # ABI C13 recortado + GLM de 20 s (filtrado a la caja)
    python -P analisis.py seguir <caso>    # tobac + paralaje + rayos por celda + salto 2σ
    python -P analisis.py figuras <caso>
    python -P analisis.py todo             # los tres casos, todos los pasos
  <caso> = c3nov26 | c23oct25 | c1nov26

Fuentes (abiertas, sin credenciales): NOAA GOES-19, bucket público noaa-goes19 (AWS, NOAA Open Data
Dissemination). ABI-L2-CMIPF (banda 13, 10,3 µm) y GLM-L2-LCFA (archivos de 20 s).
LOTE: el ABI de disco completo se baja ENTERO a un temporal, se recorta a la caja y se borra (no se leen rangos).
Cada archivo GLM se baja a memoria, se filtra a la caja y se descarta.

Seguimiento: tobac 1.6.4 (BSD-3). Instalado con `pip install --user --ignore-requires-python tobac`
porque tobac todavía declara Python < 3.14; con 3.14 anduvo bien en las pruebas.
"""
import io, os, re, sys, json, math, time, glob, datetime as dt
from concurrent.futures import ThreadPoolExecutor
import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
DATOS = os.path.join(AQUI, "datos")
os.makedirs(DATOS, exist_ok=True)
UTC = dt.timezone.utc
ART = dt.timezone(dt.timedelta(hours=-3))
BUCKET = "https://noaa-goes19.s3.amazonaws.com"
HILOS = max(1, min(2, int(os.environ.get("G3_HILOS", "2"))))  # LOTE: pedidos simultáneos a NOAA (tope 2)
PILOTO = (-64.0, -59.0, -35.0, -31.0)  # lon0, lon1, lat0, lat1 (pedido G3)

# ------------------------------------------------------------------ CASOS
# Coordenadas de pueblos: aproximadas (centro del pueblo). Horas: prensa (ver INFORME.md).
CASOS = {
    "c3nov26": dict(
        titulo="3/11/2026 · granizo en Iriondo y San Lorenzo (Santa Fe)",
        t0=dt.datetime(2026, 11, 3, 15, 0, tzinfo=UTC), t1=dt.datetime(2026, 11, 4, 1, 0, tzinfo=UTC),
        caja=PILOTO,
        granizo=[  # nombre, lat, lon, hora ARG (None = desconocida), tolerancia min
            ("Serodino", -32.60, -60.95, (17, 30), 30),
            ("Salto Grande", -32.65, -61.00, (17, 30), 30),
            ("Corral de Bustos", -33.28, -62.18, None, None),
            ("Monte Buey", -32.92, -62.45, None, None),
        ]),
    "c23oct25": dict(
        titulo="23/10/2025 · granizo en el sur de Córdoba y Unión (San Luis)",
        t0=dt.datetime(2025, 10, 23, 15, 0, tzinfo=UTC), t1=dt.datetime(2025, 10, 24, 0, 0, tzinfo=UTC),
        # el granizo cayó al OESTE de la región piloto: la caja se amplía (se dice en el informe)
        caja=(-66.5, -59.0, -36.0, -31.0),
        granizo=[  # «jueves por la tarde», antes de las 17:29 (nota de Cba24n publicada 17:29)
            ("Vicuña Mackenna", -33.92, -64.39, "tarde", None),
            ("Jovita", -34.52, -63.94, "tarde", None),
            ("Del Campillo", -34.38, -64.50, "tarde", None),
            ("Villa Huidobro (Cañada Verde)", -34.84, -64.59, "tarde", None),
            ("Unión (San Luis)", -35.15, -65.95, "tarde", None),
        ]),
    "c1nov26": dict(
        titulo="1/11/2026 · elegido como «sin granizo»; resultó con granizo en el borde oeste (OHMC)",
        t0=dt.datetime(2026, 11, 1, 15, 0, tzinfo=UTC), t1=dt.datetime(2026, 11, 2, 1, 0, tzinfo=UTC),
        caja=PILOTO,
        # La Voz 1/11/2026: «el Observatorio Hidrometeorológico de Córdoba reportó tormentas fuertes con caída de
        # granizo en Colonia Almada, Villa Ascasubi y Río Tercero». Hora no publicada en el resumen leído.
        granizo=[
            ("Río Tercero", -32.17, -64.11, None, None),
            ("Villa Ascasubi", -32.16, -63.89, None, None),
            ("Colonia Almada", -32.03, -63.86, None, None),
        ]),
}
# ventana «tarde» para el 23/10/2025: 13:00 a 17:30 ARG (la nota sale 17:29; alerta SMN antes de las 16)
TARDE_23OCT = (dt.datetime(2025, 10, 23, 16, 0, tzinfo=UTC), dt.datetime(2025, 10, 23, 20, 30, tzinfo=UTC))

# ------------------------------------------------------------------ utilidades
def listar(prefijo):
    import requests
    keys, token = [], None
    while True:
        p = {"list-type": "2", "prefix": prefijo}
        if token:
            p["continuation-token"] = token
        for i in range(4):
            try:
                r_ = requests.get(BUCKET + "/", params=p, timeout=60)
                r_.raise_for_status()
                t = r_.text
                break
            except Exception as e:
                print("  listar reintento", e); time.sleep(5)
        else:  # LOTE: sin listado no se sigue (antes quedaba `t` sin definir)
            raise RuntimeError("no se pudo listar " + prefijo)
        keys += re.findall(r"<Key>(.*?)</Key>", t)
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", t)
        if not m:
            return keys
        token = m.group(1)


def t_nombre(k, cual="s"):
    m = re.search(r"_%s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)" % cual, k)
    y, j, H, M, S, d = map(int, m.groups())
    return dt.datetime(y, 1, 1, H, M, S, d * 100000, tzinfo=UTC) + dt.timedelta(days=j - 1)


def horas(t0, t1):
    t = t0.replace(minute=0, second=0)
    while t < t1:
        yield t
        t += dt.timedelta(hours=1)


def dist_km(la1, lo1, la2, lo2):
    la1, lo1, la2, lo2 = map(np.radians, (la1, lo1, la2, lo2))
    a = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


# ------------------------------------------------------------------ BAJAR ABI
def geos_indices(h, caja):
    from pyproj import Proj
    lon0, lon1, lat0, lat1 = caja
    p = h["goes_imager_projection"].attrs
    H = float(p["perspective_point_height"][0])
    lon_sat = float(p["longitude_of_projection_origin"][0])
    pr = Proj(proj="geos", h=H, lon_0=lon_sat, sweep="x",
              a=float(p["semi_major_axis"][0]), b=float(p["semi_minor_axis"][0]))
    xs, xo = float(h["x"].attrs["scale_factor"][0]), float(h["x"].attrs["add_offset"][0])
    ys, yo = float(h["y"].attrs["scale_factor"][0]), float(h["y"].attrs["add_offset"][0])
    lo, la = np.meshgrid(np.linspace(lon0 - .3, lon1 + .3, 40), np.linspace(lat0 - .3, lat1 + .3, 40))
    X, Y = pr(lo, la)
    c = (X / H - xo) / xs
    r = (Y / H - yo) / ys
    r0, r1, c0, c1 = int(r.min()), int(r.max()) + 1, int(c.min()), int(c.max()) + 1
    cc, rr = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    lon, lat = pr((cc * xs + xo) * H, (rr * ys + yo) * H, inverse=True)
    nfilas = h["y"].shape[0]
    return dict(rc=(r0, r1, c0, c1), lat=np.asarray(lat, "f4"), lon=np.asarray(lon, "f4"),
                nfilas=nfilas, lon_sat=lon_sat, H=H)


def bajar_entero(k, carpeta):
    """LOTE: baja el archivo ENTERO a disco (nunca por rangos) y verifica el tamaño. Devuelve la ruta."""
    import requests
    tmp = os.path.join(carpeta, "_tmp_" + os.path.basename(k))
    with requests.get(BUCKET + "/" + k, stream=True, timeout=120) as r_:
        r_.raise_for_status()
        largo = int(r_.headers.get("Content-Length", -1))
        n = 0
        with open(tmp, "wb") as f:
            for trozo in r_.iter_content(1 << 20):
                f.write(trozo); n += len(trozo)
    if largo >= 0 and n != largo:
        os.remove(tmp)
        raise IOError("archivo incompleto %s: %d de %d bytes" % (k[-40:], n, largo))
    return tmp


def abi_uno(k, geo, carpeta):
    import h5py
    ts, te = t_nombre(k, "s"), t_nombre(k, "e")
    destino = os.path.join(carpeta, ts.strftime("%Y%m%dT%H%M%SZ") + ".npz")
    if os.path.exists(destino):
        return destino
    for intento in range(4):
        tmp = None
        try:
            tmp = bajar_entero(k, carpeta)  # LOTE: archivo entero, no rangos HTTP
            with h5py.File(tmp, "r") as h:
                r0, r1, c0, c1 = geo["rc"]
                c = h["CMI"]
                raw = c[r0:r1, c0:c1].view(np.uint16)
                fill = np.uint16(np.int16(c.attrs["_FillValue"][0]).view(np.uint16))
                bt = raw.astype("f4") * float(c.attrs["scale_factor"][0]) + float(c.attrs["add_offset"][0]) - 273.15
                bt[raw == fill] = np.nan  # faltante = NaN, nunca cero
                dqf = h["DQF"][r0:r1, c0:c1]
            os.remove(tmp); tmp = None
            # hora efectiva del barrido sobre la caja: el disco se barre de norte a sur entre _s y _e
            frac = ((r0 + r1) / 2) / geo["nfilas"]
            tef = ts + (te - ts) * frac
            q = np.where(np.isfinite(bt), np.round(bt * 100), -32768).astype("i2")
            np.savez_compressed(destino, bt100=q, dqf=dqf.astype("u1"), ts=ts.timestamp(), te=te.timestamp(),
                                tef=tef.timestamp())
            return destino
        except Exception as e:
            print("  reintento ABI", k[-50:], e)
            if tmp and os.path.exists(tmp):
                os.remove(tmp)
            time.sleep(4)
    return None


def bajar_abi(caso):
    import h5py
    C = CASOS[caso]
    carpeta = os.path.join(DATOS, caso, "abi")
    os.makedirs(carpeta, exist_ok=True)
    keys = []
    for t in horas(C["t0"], C["t1"]):
        keys += [k for k in listar("ABI-L2-CMIPF/%d/%03d/%02d/" % (t.year, t.timetuple().tm_yday, t.hour)) if "M6C13_" in k]
    keys = sorted(k for k in keys if C["t0"] <= t_nombre(k) < C["t1"])
    esperados = int((C["t1"] - C["t0"]).total_seconds() // 600)
    print(caso, "ABI C13:", len(keys), "archivos de", esperados, "esperados")
    geof = os.path.join(DATOS, caso, "geo.npz")
    if not os.path.exists(geof):
        if not keys:
            raise RuntimeError("sin archivos ABI C13 en " + BUCKET)
        tmp = bajar_entero(keys[0], carpeta)  # LOTE: archivo entero
        with h5py.File(tmp, "r") as h:
            g = geos_indices(h, C["caja"])
        os.remove(tmp)
        np.savez_compressed(geof, lat=g["lat"], lon=g["lon"], rc=np.array(g["rc"]), nfilas=g["nfilas"],
                            lon_sat=g["lon_sat"], H=g["H"])
    z = np.load(geof)
    geo = dict(rc=tuple(int(v) for v in z["rc"]), nfilas=int(z["nfilas"]))
    with ThreadPoolExecutor(HILOS) as ex:  # LOTE: máximo 2 pedidos simultáneos a NOAA
        res = list(ex.map(lambda k: abi_uno(k, geo, carpeta), keys))
    malos = [k for k, r in zip(keys, res) if r is None]
    json.dump(dict(archivos=len(keys), esperados=esperados, fallidos=malos), open(os.path.join(DATOS, caso, "abi_log.json"), "w"))
    print(caso, "ABI listo; fallidos:", len(malos))


# ------------------------------------------------------------------ BAJAR GLM
def glm_uno(k, caja):
    import requests, h5py
    lon0, lon1, lat0, lat1 = caja
    for intento in range(4):
        try:
            r_ = requests.get(BUCKET + "/" + k, timeout=60)  # archivo entero, en memoria
            r_.raise_for_status()
            b = r_.content
            largo = int(r_.headers.get("Content-Length", -1))
            if largo >= 0 and len(b) != largo:  # LOTE: archivo cortado = reintento, nunca «sin rayos»
                raise IOError("GLM incompleto: %d de %d bytes" % (len(b), largo))
            h = h5py.File(io.BytesIO(b), "r")
            la, lo = h["flash_lat"][:], h["flash_lon"][:]
            o = h["flash_time_offset_of_first_event"]
            off = o[:].view(np.uint16).astype("f8") * float(o.attrs["scale_factor"][0]) + float(o.attrs["add_offset"][0])
            base = re.search(r"seconds since (\S+ \S+)", o.attrs["units"].decode()).group(1)
            t0 = dt.datetime.strptime(base[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC).timestamp()
            q = h["flash_quality_flag"][:]
            def esc(v):  # entero sin signo empaquetado -> valor físico
                x = h[v]
                return x[:].view(np.uint16).astype("f8") * float(x.attrs["scale_factor"][0]) + float(x.attrs["add_offset"][0])
            ar = esc("flash_area") / 1e6      # m² -> km²
            en = esc("flash_energy") * 1e15   # J -> fJ
            sel = (lo >= lon0 - .3) & (lo <= lon1 + .3) & (la >= lat0 - .3) & (la <= lat1 + .3)
            h.close()
            # columnas: tiempo, lat, lon, calidad, área (km²), energía óptica (fJ)
            return np.c_[t0 + off[sel], la[sel], lo[sel], q[sel], ar[sel], en[sel]].astype("f8")
        except Exception as e:
            print("  reintento GLM", k[-50:], e)
            time.sleep(4)
    return None


def bajar_glm(caso):
    C = CASOS[caso]
    destino = os.path.join(DATOS, caso, "glm.npz")
    if os.path.exists(destino):
        print(caso, "GLM ya está"); return
    keys = []
    for t in horas(C["t0"], C["t1"]):
        keys += listar("GLM-L2-LCFA/%d/%03d/%02d/" % (t.year, t.timetuple().tm_yday, t.hour))
    keys = sorted(k for k in keys if C["t0"] <= t_nombre(k) < C["t1"])
    esperados = int((C["t1"] - C["t0"]).total_seconds() // 20)
    print(caso, "GLM:", len(keys), "archivos de", esperados, "esperados")
    filas, faltan, ok_t = [], [], []
    with ThreadPoolExecutor(HILOS) as ex:  # LOTE: máximo 2 pedidos simultáneos a NOAA
        for i, (k, r) in enumerate(zip(keys, ex.map(lambda k: glm_uno(k, C["caja"]), keys))):
            if r is None:
                faltan.append(k)
            else:
                filas.append(r); ok_t.append(t_nombre(k).timestamp())
            if i % 300 == 0:
                print(" ", i, k[-55:])
    a = np.vstack(filas) if filas else np.zeros((0, 6))  # LOTE: 6 columnas, como las filas
    np.savez_compressed(destino, f=a.astype("f8"), archivos=np.array(ok_t), faltan=np.array(faltan),
                        esperados=esperados)
    print(caso, "destellos:", len(a), "archivos bajados:", len(ok_t), "fallidos:", len(faltan))


def bajar(caso):
    bajar_abi(caso)
    bajar_glm(caso)


# ------------------------------------------------------------------ PARALAJE
def paralaje(lat, lon, h_km, lon_sat=-75.2, r_geo=42164.16, R=6371.0):
    """Devuelve lat/lon corregidos: dónde está de verdad (en el suelo, debajo) un tope a h_km
    que el ABI ubicó en (lat, lon) suponiéndolo a nivel del suelo. Tierra esférica (aproximado)."""
    la, lo = np.radians(lat), np.radians(lon)
    P = np.stack([R * np.cos(la) * np.cos(lo), R * np.cos(la) * np.sin(lo), R * np.sin(la)], -1)
    S = np.array([r_geo * math.cos(math.radians(lon_sat)), r_geo * math.sin(math.radians(lon_sat)), 0.0])
    D = S - P
    # |P + t D| = R + h  ->  t² |D|² + 2 t P·D + |P|² - (R+h)² = 0, raíz chica positiva
    a = np.sum(D * D, -1); b = 2 * np.sum(P * D, -1); c = np.sum(P * P, -1) - (R + h_km) ** 2
    t = (-b - np.sqrt(b * b - 4 * a * c)) / (2 * a)
    t = np.where(t < 0, (-b + np.sqrt(b * b - 4 * a * c)) / (2 * a), t)
    Q = P + t[..., None] * D
    rq = np.linalg.norm(Q, axis=-1)
    return np.degrees(np.arcsin(Q[..., 2] / rq)).astype("f4"), np.degrees(np.arctan2(Q[..., 1], Q[..., 0])).astype("f4")


# ------------------------------------------------------------------ SEGUIR
H_TOPE = 12.0          # km: altura supuesta del tope para corregir el paralaje del ABI
UMBRALES = [-50, -55, -60, -65]   # °C, detección multiumbral (tobac)
UMBRAL_SEG = -50       # °C, área de la celda (segmentación)
V_MAX = 35             # m/s, velocidad máxima de una celda para el enlace
D_MEST = 20000         # m: distancia máxima para que tobac una celdas en una familia
FRAC_EV = 0.25        # fracción del área propia que define una fusión o división significativa
R_GLM = 5.0            # km: un destello va a la celda si cae a ≤ 5 km de un píxel de esa celda
SALTO_TASA_MIN = 10.0  # destellos/min (Schultz y otros 2009)


def cargar_abi(caso):
    z = np.load(os.path.join(DATOS, caso, "geo.npz"))
    lat, lon = z["lat"], z["lon"]
    fs = sorted(glob.glob(os.path.join(DATOS, caso, "abi", "*.npz")))
    T, TE, B = [], [], []
    for f in fs:
        q = np.load(f)
        b = q["bt100"].astype("f4") / 100.0
        b[q["bt100"] == -32768] = np.nan
        T.append(dt.datetime.fromtimestamp(float(q["ts"]), UTC))
        TE.append(float(q["tef"]))
        B.append(b)
    return T, np.array(TE), np.array(B), lat, lon, float(z["lon_sat"])


def area_pixel(lat, lon):
    dy = np.abs(np.gradient(lat, axis=0)) * 111.2
    dxl = np.gradient(lon, axis=1) * 111.2 * np.cos(np.radians(lat))
    dyl = np.gradient(lat, axis=1) * 111.2
    dxr = np.gradient(lon, axis=0) * 111.2 * np.cos(np.radians(lat))
    # área = |det| del jacobiano (km² por píxel)
    return np.abs(dxl * np.gradient(lat, axis=0) * 111.2 - dyl * dxr)


def seguir(caso):
    import pandas as pd, xarray as xr, tobac, trackpy
    import logging
    trackpy.quiet(); logging.getLogger("trackpy").setLevel(logging.WARNING)
    C = CASOS[caso]
    T, TE, B, lat, lon, lon_sat = cargar_abi(caso)
    nt, ny, nx = B.shape
    apx = area_pixel(lat, lon)
    dxy = float(np.sqrt(np.nanmedian(apx))) * 1000.0  # m (tobac pide un solo paso)
    print(caso, "frames", nt, "grilla", ny, nx, "píxel medio %.2f km" % (dxy / 1000))
    # paralaje
    latc, lonc = paralaje(lat, lon, H_TOPE, lon_sat)
    latc15, lonc15 = paralaje(lat, lon, 15.0, lon_sat)
    corr = dict(d12=float(np.median(dist_km(lat, lon, latc, lonc))), d15=float(np.median(dist_km(lat, lon, latc15, lonc15))),
                dlat12=float(np.median(latc - lat)), dlon12=float(np.median(lonc - lon)))
    # huecos: frames faltantes -> se dejan como huecos en la serie (tobac los ve como salto de tiempo)
    da = xr.DataArray(np.where(np.isfinite(B), B, 30.0), dims=("time", "y", "x"),
                      coords={"time": pd.to_datetime([t.replace(tzinfo=None) for t in T]), "y": np.arange(ny), "x": np.arange(nx)})
    feats = tobac.feature_detection_multithreshold(da, dxy=dxy, threshold=UMBRALES, target="minimum",
                                                   n_min_threshold=4, position_threshold="weighted_diff",
                                                   sigma_threshold=0.5, min_distance=10000)
    print(" features:", len(feats))
    mask, feats = tobac.segmentation_2D(feats, da, dxy=dxy, threshold=UMBRAL_SEG, target="minimum")
    track = tobac.linking_trackpy(feats, da, dt=600, dxy=dxy, v_max=V_MAX, stubs=2, method_linking="predict",
                                  adaptive_stop=0.2, adaptive_step=0.95, subnetwork_size=100, memory=0)
    track = track[track["cell"] >= 0].copy()
    # familias de celdas que se fusionan o dividen: tobac.merge_split_MEST (árbol de expansión mínima)
    from tobac import merge_split
    try:
        ms = merge_split.merge_split_MEST(track, dxy, distance=D_MEST, frame_len=2)
        cel2fam = dict(zip(ms["cell"].values.astype(int), ms["cell_parent_track_id"].values.astype(int)))
    except Exception as e:
        print("  merge_split_MEST falló:", e); cel2fam = {}
    M = mask.values.astype("i4")
    f2c = dict(zip(track["feature"].astype(int), track["cell"].astype(int)))
    # máscara por CELDA (0 = sin celda)
    MC = np.zeros_like(M)
    for f, c in f2c.items():
        MC[M == f] = c
    # ---------- métricas por celda y frame
    filas = []
    for i in range(nt):
        for c in np.unique(MC[i]):
            if c == 0:
                continue
            m = MC[i] == c
            b = B[i][m]
            j = np.nanargmin(b)
            filas.append(dict(cell=int(c), frame=i, t=T[i].timestamp(), tef=TE[i], btmin=float(np.nanmin(b)),
                              a50=float(apx[m & (B[i] < -50)].sum()), a55=float(apx[m & (B[i] < -55)].sum()),
                              a60=float(apx[m & (B[i] < -60)].sum()), a65=float(apx[m & (B[i] < -65)].sum()),
                              lat_min=float(latc[m][j]), lon_min=float(lonc[m][j]),
                              lat=float(np.average(latc[m], weights=apx[m])), lon=float(np.average(lonc[m], weights=apx[m])),
                              npx=int(m.sum())))
    df = pd.DataFrame(filas).sort_values(["cell", "frame"])
    # posición del «feature» de tobac (núcleo frío), corregida por paralaje: más estable que el centro del área
    from scipy.ndimage import map_coordinates
    tk = track[["frame", "cell", "hdim_1", "hdim_2"]].copy()
    tk["lat_f"] = map_coordinates(latc, [tk.hdim_1.values, tk.hdim_2.values], order=1)
    tk["lon_f"] = map_coordinates(lonc, [tk.hdim_1.values, tk.hdim_2.values], order=1)
    tk = tk.groupby(["cell", "frame"])[["lat_f", "lon_f"]].mean().reset_index()
    df = df.merge(tk, on=["cell", "frame"], how="left")
    # ---------- fusiones, divisiones y «padre» de cada celda, por superposición entre frames consecutivos
    # Un evento es SIGNIFICATIVO si cambia al menos FRAC_EV del área de la propia celda:
    #  fusión en c: ≥ FRAC_EV de los píxeles de c (frame i) eran de OTRA celda en i−1;
    #  división de c: ≥ FRAC_EV de los píxeles de c (frame i−1) pasan a OTRA celda en i.
    ev, padre = [], {}
    primera = df.groupby("cell").frame.min().to_dict()
    for i in range(1, nt):
        if (T[i] - T[i - 1]).total_seconds() > 660:
            continue
        a, b_ = MC[i - 1], MC[i]
        par = (a.astype("i8") << 20) | b_.astype("i8")
        u, n = np.unique(par[(a > 0) & (b_ > 0)], return_counts=True)
        pa, pb = (u >> 20).astype(int), (u & 0xFFFFF).astype(int)
        npa = {int(c): int(k) for c, k in zip(*np.unique(a[a > 0], return_counts=True))}
        npb = {int(c): int(k) for c, k in zip(*np.unique(b_[b_ > 0], return_counts=True))}
        for c in npb:
            otras = [int(x) for x, y, k in zip(pa, pb, n) if y == c and x != c and k >= FRAC_EV * npb[c]]
            if otras and primera[c] < i:
                ev.append((i, "fusión", c, otras))
            if primera[c] == i:   # celda nueva: su padre es la celda previa que más le aporta
                cand = [(k, int(x)) for x, y, k in zip(pa, pb, n) if y == c]
                if cand and max(cand)[0] >= FRAC_EV * npb[c]:
                    padre[c] = (max(cand)[1], i)
        for c in npa:
            otras = [int(y) for x, y, k in zip(pa, pb, n) if x == c and y != c and k >= FRAC_EV * npa[c]]
            if otras:
                ev.append((i, "división", c, otras))
    # ---------- GLM -> celdas
    g = np.load(os.path.join(DATOS, caso, "glm.npz"))
    F, tarch = g["f"], g["archivos"]
    # movimiento medio de las celdas en cada frame (para trasladar el destello a la hora del barrido)
    vel = np.zeros((nt, 2))
    for i in range(1, nt):
        a = df[df.frame == i - 1].set_index("cell"); b_ = df[df.frame == i].set_index("cell")
        com = a.index.intersection(b_.index)
        if len(com) and TE[i] > TE[i - 1]:
            vel[i] = [np.median((b_.loc[com, "lat"] - a.loc[com, "lat"]) / (TE[i] - TE[i - 1])),
                      np.median((b_.loc[com, "lon"] - a.loc[com, "lon"]) / (TE[i] - TE[i - 1]))]
    vel[0] = vel[1]
    from scipy.spatial import cKDTree
    k_frame = np.searchsorted((TE[1:] + TE[:-1]) / 2, F[:, 0])  # frame ABI más cercano en el tiempo
    cel_f = np.zeros(len(F), "i4")
    ok_t = np.abs(F[:, 0] - TE[k_frame]) <= 330
    coslat = math.cos(math.radians(np.mean(lat)))
    for i in range(nt):
        sel = np.where((k_frame == i) & ok_t)[0]
        m = MC[i] > 0
        if not len(sel) or not m.any():
            continue
        dtf = F[sel, 0] - TE[i]
        fla = F[sel, 1] - vel[i, 0] * dtf; flo = F[sel, 2] - vel[i, 1] * dtf
        tree = cKDTree(np.c_[latc[m] * 111.2, lonc[m] * 111.2 * coslat])
        d, j = tree.query(np.c_[fla * 111.2, flo * 111.2 * coslat], distance_upper_bound=R_GLM)
        hit = np.isfinite(d)
        cel_f[sel[hit]] = MC[i][m][j[hit]]
    # cobertura GLM por minuto (3 archivos de 20 s = minuto completo)
    m0 = math.floor(C["t0"].timestamp() / 60) * 60
    nmin = int((C["t1"].timestamp() - m0) // 60)
    cub = np.zeros(nmin, int)
    ia = ((tarch - m0) // 60).astype(int)
    np.add.at(cub, ia[(ia >= 0) & (ia < nmin)], 1)
    minutos = m0 + 60 * np.arange(nmin)
    # ---------- series por celda y salto 2σ
    imin = ((F[:, 0] - m0) // 60).astype(int)
    n2 = nmin // 2
    t2 = minutos[:n2 * 2].reshape(n2, 2)[:, 1] + 60      # fin de cada período de 2 min

    def salto_2s(fr_min, bloq):
        """Salto de rayos 2σ (Schultz, Petersen y Carey 2009), definición completa en INFORME.md."""
        tr2 = fr_min[:n2 * 2].reshape(n2, 2).mean(1)          # tasa media de cada período de 2 min (NaN si falta)
        bl2 = bloq[:n2 * 2].reshape(n2, 2).any(1)
        dfr = np.r_[np.nan, np.diff(tr2)] / 2.0               # DFRDT, destellos/min²
        sig = np.full(n2, np.nan); salto = np.zeros(n2, bool); bloqueado = np.zeros(n2, bool)
        for k in range(6, n2):
            ven = dfr[k - 5:k]                                # los 5 períodos previos (10 min), sin el actual
            if np.isnan(ven).any() or np.isnan(dfr[k]):
                continue
            if bl2[k - 5:k + 1].any():
                bloqueado[k] = True; continue
            sig[k] = np.std(ven)
            if tr2[k] >= SALTO_TASA_MIN and sig[k] > 0 and dfr[k] > 2 * sig[k]:
                salto[k] = True
        # episodios: el salto termina cuando DFRDT ≤ 0, salvo que otro salto llegue a ≤ 6 min del anterior
        ep, ult, dentro = [], None, False
        for k in range(n2):
            if salto[k]:
                if not dentro and (ult is None or t2[k] - ult > 360):
                    ep.append(k)
                dentro, ult = True, t2[k]
            elif not (dfr[k] > 0):
                dentro = False
        return dict(tr2=tr2, dfr=dfr, sig=sig, salto=salto, bloq=bloqueado, ep=ep)

    def bloqueo(c):
        bloq = np.zeros(nmin, bool)
        for (i, tipo, cc, otras) in ev:
            if cc == c or c in otras:   # desde 5 min antes hasta 12 min después del barrido
                a0 = int((TE[i] - 300 - m0) // 60); a1 = int((TE[i] + 720 - m0) // 60)
                bloq[max(a0, 0):min(a1, nmin)] = True
        return bloq

    series, saltos, resumen, lin = {}, [], [], {}
    orden = df.groupby("cell").frame.min().sort_values().index
    for c in orden:
        d_ = df[df.cell == c]
        fr = d_.frame.values
        vivo = np.zeros(nmin, bool)   # minutos en que la celda existe: ±5 min alrededor de cada barrido
        for i in fr:
            a0 = int((TE[i] - 300 - m0) // 60); a1 = int((TE[i] + 300 - m0) // 60)
            vivo[max(a0, 0):min(a1, nmin)] = True
        cnt = np.zeros(nmin)
        s = (cel_f == c) & (imin >= 0) & (imin < nmin)
        np.add.at(cnt, imin[s], 1)
        fr_min = np.where(vivo & (cub >= 3), cnt, np.nan)   # sin celda o sin GLM = hueco, no cero
        bloq = bloqueo(c)
        S1 = salto_2s(fr_min, bloq)
        S0 = salto_2s(fr_min, np.zeros(nmin, bool))         # sensibilidad: sin la regla de fusiones/divisiones
        # LINAJE: antes de nacer, la celda hereda la serie de su padre (y éste la del suyo)
        fl, bl = fr_min.copy(), bloq.copy()
        if c in padre and padre[c][0] in lin:
            pf, pb_ = lin[padre[c][0]]
            ini = int((TE[fr[0]] - 300 - m0) // 60)
            fl[:max(ini, 0)] = pf[:max(ini, 0)]; bl[:max(ini, 0)] = pb_[:max(ini, 0)]
            # el nacimiento por división es un cambio de área: se bloquea igual que una división
            a0 = int((TE[fr[0]] - 300 - m0) // 60); a1 = int((TE[fr[0]] + 720 - m0) // 60)
            bl[max(a0, 0):min(a1, nmin)] = True
        lin[int(c)] = (fl, bl)
        SL = salto_2s(fl, bl)
        for nombre, SS in (("celda", S1), ("sin_regla", S0), ("linaje", SL)):
            for k in SS["ep"]:
                saltos.append(dict(cell=int(c), version=nombre, t=float(t2[k]), tasa=float(SS["tr2"][k]),
                                   dfr=float(SS["dfr"][k]), sig=float(SS["sig"][k])))
        series[int(c)] = dict(fr_min=fr_min, tr2=S1["tr2"], t2=t2, dfr=S1["dfr"], sig=S1["sig"], bloq=S1["bloq"],
                              fr_lin=fl, tr2_lin=SL["tr2"], dfr_lin=SL["dfr"], sig_lin=SL["sig"], bloq_lin=SL["bloq"])
        ep = S1["ep"]
        btm = d_.btmin.values; tt = d_.t.values
        enf = [btm[n] - btm[n - 1] for n in range(1, len(btm)) if fr[n] - fr[n - 1] == 1]
        a50v = d_.a50.values
        crec = [a50v[n] - a50v[n - 1] for n in range(1, len(a50v)) if fr[n] - fr[n - 1] == 1]
        # versión «limpia»: sin los pasos en que la celda tuvo una fusión o división significativa
        f_ev = {i for (i, tp, cc, otras) in ev if cc == c or c in otras}
        enf_l = [btm[n] - btm[n - 1] for n in range(1, len(btm)) if fr[n] - fr[n - 1] == 1 and fr[n] not in f_ev]
        crec_l = [a50v[n] - a50v[n - 1] for n in range(1, len(a50v)) if fr[n] - fr[n - 1] == 1 and fr[n] not in f_ev]
        resumen.append(dict(cell=int(c), t_ini=float(tt[0]), t_fin=float(tt[-1]), dur_min=float((tt[-1] - tt[0]) / 60 + 10),
                            btmin=float(btm.min()), t_btmin=float(tt[np.argmin(btm)]), enf_max=float(min(enf)) if enf else np.nan,
                            a60max=float(d_.a60.max()), a50max=float(d_.a50.max()),
                            crec_a50_max=float(max(crec)) if crec else np.nan,
                            enf_max_limpio=float(min(enf_l)) if enf_l else np.nan,
                            crec_a50_max_limpio=float(max(crec_l)) if crec_l else np.nan,
                            frmax=float(np.nanmax(fr_min)) if np.isfinite(fr_min).any() else np.nan,
                            destellos=int(np.nansum(fr_min)), n_saltos=len(ep), n_saltos_linaje=len(SL["ep"]),
                            n_saltos_sin_regla=len(S0["ep"]), periodos_evaluados=int(np.isfinite(S1["sig"]).sum()),
                            periodos_bloqueados=int(S1["bloq"].sum()), padre=int(padre[c][0]) if c in padre else 0,
                            n_fus=sum(1 for e in ev if e[2] == c and e[1] == "fusión"),
                            n_div=sum(1 for e in ev if e[2] == c and e[1] == "división"),
                            lat0=float(d_.lat.values[0]), lon0=float(d_.lon.values[0]),
                            lat1=float(d_.lat.values[-1]), lon1=float(d_.lon.values[-1])))
    # ---------- salto 2σ por FAMILIA (tobac MEST): la suma de destellos de todas las celdas de la familia.
    # Dentro de la familia una fusión no suma destellos «de afuera», así que no hace falta bloquear.
    fam_series = {}
    for c, s_ in series.items():
        f_ = cel2fam.get(c, -c)
        x = s_["fr_min"]
        if f_ not in fam_series:
            fam_series[f_] = np.full(nmin, np.nan)
        y = fam_series[f_]
        fam_series[f_] = np.where(np.isnan(y), x, np.where(np.isnan(x), y, y + x))
    fam_saltos = {}
    for f_, x in fam_series.items():
        SF = salto_2s(x, np.zeros(nmin, bool))
        fam_saltos[f_] = SF
        for k in SF["ep"]:
            saltos.append(dict(cell=-int(f_), version="familia", t=float(t2[k]), tasa=float(SF["tr2"][k]),
                               dfr=float(SF["dfr"][k]), sig=float(SF["sig"][k])))
    # ---------- salto 2σ por SISTEMA: celdas unidas por fusiones/divisiones significativas (unión-búsqueda)
    raiz = {}
    def buscar(x):
        raiz.setdefault(x, x)
        while raiz[x] != x:
            raiz[x] = raiz[raiz[x]]; x = raiz[x]
        return x
    for (i, tp, c, otras) in ev:
        for u in otras:
            raiz[buscar(c)] = buscar(u)
    for c in padre:
        raiz[buscar(c)] = buscar(padre[c][0])
    sis_series = {}
    for c, s_ in series.items():
        f_ = buscar(c); x = s_["fr_min"]
        y = sis_series.get(f_, np.full(nmin, np.nan))
        sis_series[f_] = np.where(np.isnan(y), x, np.where(np.isnan(x), y, y + x))
    sis_saltos = {}
    for f_, x in sis_series.items():
        SF = salto_2s(x, np.zeros(nmin, bool)); sis_saltos[f_] = SF
        for k in SF["ep"]:
            saltos.append(dict(cell=-int(f_), version="sistema", t=float(t2[k]), tasa=float(SF["tr2"][k]),
                               dfr=float(SF["dfr"][k]), sig=float(SF["sig"][k])))
    for r_ in resumen:
        s_ = buscar(r_["cell"])
        r_["sistema"] = int(s_)
        r_["n_celdas_sistema"] = sum(1 for c in series if buscar(c) == s_)
        f_ = cel2fam.get(r_["cell"], -r_["cell"])
        r_["familia"] = int(f_)
        r_["n_celdas_familia"] = sum(1 for v in cel2fam.values() if v == f_) or 1
        # episodios de la familia mientras vive esta celda
        r_["n_saltos_familia"] = sum(1 for k in fam_saltos[f_]["ep"] if r_["t_ini"] - 300 <= t2[k] <= r_["t_fin"] + 600)
    R = pd.DataFrame(resumen)
    S = pd.DataFrame(saltos)
    out = os.path.join(DATOS, caso)
    # ---------- atributos por celda y frame con los NOMBRES de ProbSevere v3 (jlc248/ProbSevere_v3_paper_2024)
    # Equivalencias aproximadas (ver INFORME.md): no son el mismo cálculo que en ProbSevere.
    atr = []
    pix_cel = {}
    for i in range(nt):
        for c in np.unique(MC[i]):
            if c:
                m = MC[i] == c
                pix_cel[(i, int(c))] = (np.c_[latc[m] * 111.2, lonc[m] * 111.2 * coslat], m)
    for (i, c), (xy, m) in pix_cel.items():
        sel = np.where((cel_f == c) & (F[:, 0] >= TE[i] - 300) & (F[:, 0] < TE[i]))[0]  # 5 min previos
        fila = dict(cell=c, frame=i, dts=dt.datetime.fromtimestamp(TE[i], UTC).strftime("%Y-%m-%d %H:%M:%S"),
                    size=int(m.sum()), area_km2=float(apx[m].sum()))
        if not len(sel):
            k5 = cub[max(int((TE[i] - 300 - m0) // 60), 0):max(int((TE[i] - m0) // 60), 0)]
            vacio = 0.0 if len(k5) and (k5 >= 3).all() else np.nan  # sin rayos con GLM completo = 0; sin GLM = hueco
            fila.update(max_fcd=vacio, max_fed=vacio, accum_fcd=vacio, avg_flash_area=np.nan, accum_total_energy=vacio)
        else:
            dtf = F[sel, 0] - TE[i]
            q = np.c_[(F[sel, 1] - vel[i, 0] * dtf) * 111.2, (F[sel, 2] - vel[i, 1] * dtf) * 111.2 * coslat]
            tr_ = cKDTree(xy)
            _, j = tr_.query(q)
            fcd = np.bincount(j, minlength=len(xy))
            fed = np.zeros(len(xy))
            for p, a_ in zip(q, F[sel, 4]):   # disco del área del destello alrededor del centroide (aprox. FED)
                fed[tr_.query_ball_point(p, max(math.sqrt(a_ / math.pi), 1.2))] += 1
            fila.update(max_fcd=float(fcd.max()), max_fed=float(fed.max()), accum_fcd=float(len(sel)),
                        avg_flash_area=float(F[sel, 4].mean()), accum_total_energy=float(F[sel, 5].sum()))
        atr.append(fila)
    A = pd.DataFrame(atr).sort_values(["cell", "frame"])
    A = A.merge(df[["cell", "frame", "btmin", "a50", "a60", "lat", "lon"]], on=["cell", "frame"], how="left")
    A = A.rename(columns={"lat": "mean_lat", "lon": "mean_lon"})
    # tasas satelitales por minuto respecto del frame anterior de la MISMA celda (sólo si son consecutivos)
    A["rc_btmin"] = np.nan; A["rc_frac60"] = np.nan
    for c, d_ in A.groupby("cell"):
        ix = d_.index.values
        for n in range(1, len(ix)):
            i0, i1 = d_.frame.values[n - 1], d_.frame.values[n]
            if i1 - i0 == 1:
                dtm = (TE[i1] - TE[i0]) / 60
                A.loc[ix[n], "rc_btmin"] = (d_.btmin.values[n] - d_.btmin.values[n - 1]) / dtm
                f1 = d_.a60.values[n] / d_.area_km2.values[n]; f0 = d_.a60.values[n - 1] / d_.area_km2.values[n - 1]
                A.loc[ix[n], "rc_frac60"] = (f1 - f0) / dtm
    # rayos: flash_rate (suma de 2 min), dfrdt y lja_std del período de 2 min que termina antes del barrido
    A["flash_rate"] = np.nan; A["dfrdt"] = np.nan; A["lja_std"] = np.nan
    for ix_, r_ in A.iterrows():
        s_ = series.get(int(r_.cell))
        if s_ is None:
            continue
        k = int(np.searchsorted(s_["t2"], TE[int(r_.frame)], side="right")) - 1
        if 0 <= k < len(s_["t2"]):
            A.loc[ix_, ["flash_rate", "dfrdt", "lja_std"]] = [s_["tr2"][k] * 2, s_["dfr"][k], s_["sig"][k]]
    A.to_csv(os.path.join(out, "atributos_probsevere.csv"), index=False, float_format="%.4f")
    df.to_csv(os.path.join(out, "celdas_frames.csv"), index=False, float_format="%.4f")
    R.to_csv(os.path.join(out, "celdas_resumen.csv"), index=False, float_format="%.3f")
    S.to_csv(os.path.join(out, "saltos.csv"), index=False, float_format="%.3f")
    json.dump(dict(eventos=[(int(i), tp, int(c), o) for i, tp, c, o in ev]), open(os.path.join(out, "fusiones_divisiones.json"), "w"))
    np.savez_compressed(os.path.join(out, "series.npz"), cells=np.array(list(series)), minutos=minutos, cub=cub,
                        **{"fr_%d" % c: v["fr_min"] for c, v in series.items()},
                        **{"tr2_%d" % c: v["tr2"] for c, v in series.items()},
                        **{"dfr_%d" % c: v["dfr"] for c, v in series.items()},
                        **{"sig_%d" % c: v["sig"] for c, v in series.items()},
                        **{"bl_%d" % c: v["bloq"] for c, v in series.items()},
                        **{"frL_%d" % c: v["fr_lin"] for c, v in series.items()},
                        **{"dfrL_%d" % c: v["dfr_lin"] for c, v in series.items()},
                        **{"sigL_%d" % c: v["sig_lin"] for c, v in series.items()},
                        **{"blL_%d" % c: v["bloq_lin"] for c, v in series.items()},
                        **{"sisfr_%d" % f_: x for f_, x in sis_series.items()},
                        **{"sisdfr_%d" % f_: v["dfr"] for f_, v in sis_saltos.items()},
                        **{"sissig_%d" % f_: v["sig"] for f_, v in sis_saltos.items()},
                        **{"famfr_%d" % abs(f_): x for f_, x in fam_series.items() if f_ > 0},
                        **{"famdfr_%d" % abs(f_): v["dfr"] for f_, v in fam_saltos.items() if f_ > 0},
                        **{"famsig_%d" % abs(f_): v["sig"] for f_, v in fam_saltos.items() if f_ > 0},
                        t2=list(series.values())[0]["t2"] if series else np.array([]))
    np.savez_compressed(os.path.join(out, "mascara_celdas.npz"), mc=MC.astype("i4"))
    meta = dict(frames=nt, grilla=[ny, nx], pixel_km=dxy / 1000, paralaje=corr, n_features=int(len(feats)),
                n_celdas=int(df.cell.nunique()), destellos_caja=int(len(F)), destellos_asignados=int((cel_f > 0).sum()),
                destellos_fuera_tiempo=int((~ok_t).sum()), calidad_flags={str(int(k)): int(v) for k, v in zip(*np.unique(F[:, 3], return_counts=True))},
                glm_archivos=int(len(tarch)), glm_esperados=int(g["esperados"]), glm_fallidos=int(len(g["faltan"])),
                minutos_glm_incompletos=int((cub < 3).sum()), n_fusiones=sum(1 for e in ev if e[1] == "fusión"),
                n_divisiones=sum(1 for e in ev if e[1] == "división"))
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=1)
    print(json.dumps(meta, indent=1))


# ------------------------------------------------------------------ EVALUAR + FIGURAS
R_NUCLEO = 20.0   # km: la celda «pasó por» el pueblo si su núcleo frío (feature tobac, corregido) está a ≤ 20 km
R_REPORTE = 10.0  # km: la celda «pasó por» el pueblo si algún píxel suyo (corregido) está a ≤ 10 km
DUR_MIN, BT_MIN = 40, -55  # celdas comparables: viven ≥ 40 min y llegan a ≤ −55 °C


def fuente(ax, txt, y=-0.13):
    import textwrap
    ax.text(0.0, y, "\n".join(textwrap.wrap(txt, 150)), transform=ax.transAxes, fontsize=7, color="#444", va="top")


def ventana_reporte(caso, hora, tol):
    C = CASOS[caso]
    if hora is None:
        return C["t0"], C["t1"], "hora desconocida: todo el período"
    if hora == "tarde":
        return TARDE_23OCT[0], TARDE_23OCT[1], "«por la tarde», antes de las 17:29 ARG"
    t = C["t0"].astimezone(ART).replace(hour=hora[0], minute=hora[1], second=0)
    return (t - dt.timedelta(minutes=tol)).astimezone(UTC), (t + dt.timedelta(minutes=tol)).astimezone(UTC), "%02d:%02d ±%d min ARG" % (hora[0], hora[1], tol)


def figuras(caso):
    import pandas as pd
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib.colors import ListedColormap, BoundaryNorm
    C = CASOS[caso]
    out = os.path.join(DATOS, caso)
    T, TE, B, lat, lon, lon_sat = cargar_abi(caso)
    latc, lonc = paralaje(lat, lon, H_TOPE, lon_sat)
    MC = np.load(os.path.join(out, "mascara_celdas.npz"))["mc"]
    df = pd.read_csv(os.path.join(out, "celdas_frames.csv"))
    R = pd.read_csv(os.path.join(out, "celdas_resumen.csv"))
    SA = pd.read_csv(os.path.join(out, "saltos.csv")) if os.path.getsize(os.path.join(out, "saltos.csv")) > 5 else pd.DataFrame(columns=["cell", "version", "t", "tasa", "dfr", "sig"])
    S, SL, S0 = SA[SA.version == "celda"], SA[SA.version == "linaje"], SA[SA.version == "sin_regla"]
    Z = np.load(os.path.join(out, "series.npz"))
    minutos, t2 = Z["minutos"], Z["t2"]
    lon0, lon1, lat0, lat1 = C["caja"]
    # ---------- ¿qué celda pasó por cada pueblo con granizo?
    rep = []
    for (nom, la, lo, hora, tol) in C["granizo"]:
        w0, w1, txt = ventana_reporte(caso, hora, tol)
        dd = dist_km(latc, lonc, la, lo)
        cerca = dd <= R_REPORTE
        pasos, yunque = {}, {}
        dv = df[(df.tef >= w0.timestamp() - 300) & (df.tef <= w1.timestamp() + 300)].copy()
        dv["d"] = dist_km(dv.lat_f.values, dv.lon_f.values, la, lo)
        for r_ in dv[dv.d <= R_NUCLEO].itertuples():   # el NÚCLEO frío pasa a ≤ R_NUCLEO km
            pasos.setdefault(int(r_.cell), []).append(dt.datetime.fromtimestamp(r_.t, UTC).astimezone(ART).strftime("%H:%M"))
        for i, t in enumerate(T):                       # sólo el yunque (algún píxel de la celda) encima
            if not (w0.timestamp() - 300 <= TE[i] <= w1.timestamp() + 300):
                continue
            for c in np.unique(MC[i][cerca]):
                if c > 0 and int(c) not in pasos:
                    yunque.setdefault(int(c), []).append(T[i].astimezone(ART).strftime("%H:%M"))
        rep.append(dict(lugar=nom, lat=la, lon=lo, ventana=txt, celdas={str(c): v for c, v in pasos.items()},
                        solo_yunque={str(c): v for c, v in yunque.items()}))
    A = pd.read_csv(os.path.join(out, "atributos_probsevere.csv"))
    R = R.merge(A.groupby("cell").max_fed.max().rename("fedmax").reset_index(), on="cell", how="left")
    comp = R[(R.dur_min >= DUR_MIN) & (R.btmin <= BT_MIN)].copy()
    # celdas granizeras = las comparables que pasaron por algún pueblo con granizo en su ventana
    gran = sorted({int(c) for r in rep for c in r["celdas"] if int(c) in set(comp.cell)})
    señales = [("btmin", "tope mínimo (°C)", True), ("enf_max_limpio", "enfriamiento máx. en 10 min (°C)\nsin pasos con fusión/división", True),
               ("a60max", "área máx. < −60 °C (km²)", False), ("crec_a50_max_limpio", "crecimiento máx. del área < −50 °C\nen 10 min (km²), sin fusión/división", False),
               ("frmax", "destellos máx. por minuto", False), ("fedmax", "FED máx. aprox.\n(destellos/5 min/píxel)", False),
               ("n_saltos_linaje", "saltos de rayos 2σ\n(episodios, linaje)", False)]
    puestos = {}
    for c in gran:
        puestos[c] = {}
        for col, _, menor in señales:
            v = comp[col].values
            x = float(comp.loc[comp.cell == c, col].iloc[0])
            orden = (np.sum(v < x) + 1 if menor else np.sum(v > x) + 1) if np.isfinite(x) else -1  # -1 = sin dato
            puestos[c][col] = dict(valor=x, puesto=int(orden), de=int(np.isfinite(v).sum()))
    # saltos de las granizeras y minutos antes del granizo con hora conocida
    anticip = {}
    horas_rep = {n_: (h, t_) for (n_, a_, b_, h, t_) in C["granizo"]}
    for r in rep:
        w0, w1, _ = ventana_reporte(caso, *horas_rep[r["lugar"]])
        for c in r["celdas"]:
            ss = SA[SA.cell == int(c)]
            anticip.setdefault(r["lugar"], {})[c] = [
                dict(version=v_, hora=dt.datetime.fromtimestamp(t, UTC).astimezone(ART).strftime("%H:%M"),
                     min_antes_del_inicio_de_ventana=round((w0.timestamp() - t) / 60), tasa=round(float(q), 1))
                for v_, t, q in zip(ss.version, ss.t, ss.tasa)]
    ev = dict(reportes=rep, comparables=int(len(comp)), granizeras=gran, puestos=puestos, saltos_por_reporte=anticip,
              umbral_comparables="dur ≥ %d min y tope ≤ %d °C" % (DUR_MIN, BT_MIN))
    json.dump(ev, open(os.path.join(out, "evaluacion.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    # ---------- FIGURA 1: mapa con trayectorias
    niveles = [-90, -70, -65, -60, -55, -50, -40, -20, 0, 40]
    cols = ["#ffffff", "#ff00ff", "#d00000", "#ff8c00", "#ffd700", "#2ca02c", "#7fa7d9", "#bdbdbd", "#eeeeee"]
    cm, nm = ListedColormap(cols), BoundaryNorm(niveles, len(cols))
    # momento de referencia: el frame con el tope más frío de la primera granizera (o de toda la caja)
    if gran:
        cref = int(comp[comp.cell.isin(gran)].sort_values("btmin").cell.iloc[0])
        tref = float(R.loc[R.cell == cref, "t_btmin"].iloc[0])
    else:
        cref = None; tref = df.loc[df.btmin.idxmin(), "t"]
    iref = int(np.argmin([abs(t.timestamp() - tref) for t in T]))
    fig, ax = plt.subplots(figsize=(11, 8.5))
    m = ax.pcolormesh(lonc, latc, B[iref], cmap=cm, norm=nm, shading="auto")
    for _, r in comp.iterrows():
        d_ = df[df.cell == r.cell]
        es = int(r.cell) in gran
        ax.plot(d_.lon_f, d_.lat_f, "-", color="#00e5ff" if es else "#333", lw=2.4 if es else 0.9, zorder=3)
        ax.plot(d_.lon_f.values[-1], d_.lat_f.values[-1], ">" if es else ".", color="#00e5ff" if es else "#333", ms=6 if es else 3, zorder=3)
        ax.text(d_.lon_f.values[0], d_.lat_f.values[0], str(int(r.cell)), fontsize=7, color="#006064" if es else "#222",
                zorder=4, clip_on=True, fontweight="bold" if es else "normal")
    for (nom, la, lo, hora, tol) in C["granizo"]:
        ax.plot(lo, la, "*", color="#1a1a1a", mec="w", ms=13, zorder=5); ax.text(lo + .05, la + .05, nom, fontsize=7.5, zorder=5)
    p0, p1, q0, q1 = PILOTO
    ax.plot([p0, p1, p1, p0, p0], [q0, q0, q1, q1, q0], "--", color="#555", lw=1)
    ax.set_xlim(lon0, lon1); ax.set_ylim(lat0, lat1); ax.set_aspect(1 / math.cos(math.radians((lat0 + lat1) / 2)))
    ax.set_xlabel("longitud"); ax.set_ylabel("latitud")
    cb = fig.colorbar(m, ax=ax, shrink=.75, ticks=niveles)
    cb.set_label("Temperatura del tope de nube (°C), %s ARG" % T[iref].astimezone(ART).strftime("%d/%m %H:%M"))
    ax.set_title("%s\nTrayectorias de celdas (núcleo frío de tobac, corregido por paralaje a %d km). "
                 "Celeste grueso = pasó por un pueblo con granizo; negro = otras celdas comparables (≥ %d min, ≤ %d °C). "
                 "★ = granizo (prensa). Línea de trazos = región piloto." % (C["titulo"], H_TOPE, DUR_MIN, BT_MIN), fontsize=8.5, wrap=True)
    fuente(ax, "Fuente: NOAA GOES-19 ABI L2 CMIPF banda 13 (bucket público noaa-goes19, AWS). Seguimiento: tobac 1.6.4. "
               "Número = id de la celda en su punto de partida; ▸ = punto final. Píxel blanco/gris claro = nube baja o cielo despejado.", y=-0.08)
    fig.savefig(os.path.join(AQUI, "%s_mapa.png" % caso), dpi=105, bbox_inches="tight"); plt.close(fig)
    # ---------- FIGURA 2: series de las celdas granizeras (o de las 3 con más rayos si no hay)
    # primero las celdas sobre pueblos con hora conocida, después las de mayor tope frío
    con_hora = [int(c) for r, g_ in zip(rep, C["granizo"]) if g_[3] is not None for c in r["celdas"] if int(c) in gran]
    resto = list(comp[comp.cell.isin(gran) & ~comp.cell.isin(con_hora)].sort_values("btmin").cell.astype(int))
    sel = list(dict.fromkeys(con_hora + resto)) if gran else list(comp.sort_values("destellos", ascending=False).cell.astype(int)[:3])
    sel = sel[:4]
    if sel:
        fig, axs = plt.subplots(4, 1, figsize=(11, 12), sharex=True)
        pal = ["#00838f", "#d81b60", "#7b1fa2", "#ef6c00"]
        for col, c in zip(pal, sel):
            d_ = df[df.cell == c]
            tt = [dt.datetime.fromtimestamp(x, UTC) for x in d_.tef]
            axs[0].plot(tt, d_.btmin, "-o", ms=3, color=col, label="celda %d" % c)
            axs[1].plot(tt, d_.a60, "-o", ms=3, color=col)
            TT = [dt.datetime.fromtimestamp(x, UTC) for x in minutos]
            axs[2].plot(TT, Z["frL_%d" % c], color=col, lw=.7, ls=":")
            axs[2].plot(TT, Z["fr_%d" % c], color=col, lw=1.2)
            T2 = [dt.datetime.fromtimestamp(x, UTC) for x in t2]
            axs[3].plot(T2, Z["dfrL_%d" % c], color=col, lw=1)
            axs[3].plot(T2, 2 * Z["sigL_%d" % c], color=col, lw=1, ls="--")
            for marca, SS in (("*", SL), ("o", S0)):
                ss = SS[SS.cell == c]
                for t, q in zip(ss.t, ss.tasa):
                    k = int(np.argmin(np.abs(t2 - t)))
                    if marca == "*":
                        axs[3].plot(T2[k], Z["dfrL_%d" % c][k], "*", color=col, mec="k", ms=13, zorder=4)
                        axs[2].axvline(T2[k], color=col, lw=.8, ls="--")
                    else:
                        axs[3].plot(T2[k], Z["dfr_%d" % c][k], "o", mfc="none", mec=col, ms=9, mew=1.3, zorder=4)
            bl = Z["blL_%d" % c]
            for k in np.where(bl)[0]:
                axs[3].axvspan(T2[k] - dt.timedelta(minutes=2), T2[k], color=col, alpha=.12, lw=0)
        axs[0].invert_yaxis(); axs[0].set_ylabel("Tope mínimo (°C)")
        for v, cc in [(-60, "#ff8c00"), (-65, "#d00000")]:
            axs[0].axhline(v, color=cc, lw=.8, ls="--")
        axs[0].legend(fontsize=8, title="Color = celda", loc="lower left")
        axs[1].set_ylabel("Área < −60 °C (km²)")
        axs[2].set_ylabel("Destellos GLM por minuto\n(llena = la celda;\npunteada = linaje)")
        axs[3].set_ylabel("DFRDT (destellos/min²)")
        axs[3].plot([], [], "k-", lw=1, label="DFRDT: cambio de la tasa de 2 min"); axs[3].plot([], [], "k--", lw=1, label="2σ de los 10 min previos")
        axs[3].plot([], [], "k*", ms=10, label="salto 2σ sobre el linaje (celda + antecesoras), con la regla de fusiones/divisiones")
        axs[3].plot([], [], "ko", mfc="none", ms=8, label="salto 2σ de la celda sola SIN la regla (sensibilidad)")
        axs[3].fill_between([], [], color="#888", alpha=.3, label="no evaluable (linaje): fusión o división significativa")
        axs[3].legend(fontsize=7.5, loc="upper left")
        ventanas = {ventana_reporte(caso, hora, tol)[:2] for (nom, la, lo, hora, tol) in C["granizo"] if hora is not None}
        for w0, w1 in ventanas:
            for ax in axs:
                ax.axvspan(w0, w1, color="#999", alpha=.18, lw=0)
        for ax in axs:
            ax.grid(alpha=.3)
        axs[0].set_title("%s\nceldas %s · hora UTC (ARG = UTC−3) · banda gris = ventana del granizo según prensa" % (
            C["titulo"], "que pasaron por pueblos con granizo" if gran else "con más destellos (no hay granizo reportado)"), fontsize=9)
        axs[3].xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
        fuente(axs[3], "Fuente: NOAA GOES-19 ABI banda 13 y GLM L2 LCFA de 20 s (noaa-goes19, AWS). Salto 2σ según Schultz, Petersen y Carey 2009 "
                       "(definición completa en INFORME.md). Huecos en las curvas = sin celda o sin archivo GLM (no son cero). "
                       "Hora ABI = barrido efectivo sobre la caja.", y=-0.25)
        fig.tight_layout(); fig.savefig(os.path.join(AQUI, "%s_series.png" % caso), dpi=105); plt.close(fig)
    # ---------- FIGURA 3: ¿se distingue la granizera de las demás del mismo día?
    fig, axs = plt.subplots(1, len(señales), figsize=(18, 5))
    rng = np.random.default_rng(0)
    for ax, (col, nom, menor) in zip(axs, señales):
        v = comp[col].values
        x = rng.uniform(-.25, .25, len(v))
        es = comp.cell.isin(gran).values
        eh = comp.cell.isin(con_hora).values
        ax.scatter(x[~es], v[~es], s=14, color="#555", label="otras celdas comparables")
        ax.scatter(x[es & ~eh], v[es & ~eh], s=55, color="#b2ebf2", edgecolor="#00838f", zorder=3,
                   label="pasó por pueblo con granizo (hora del granizo desconocida o imprecisa)")
        ax.scatter(x[eh], v[eh], s=90, color="#00bcd4", edgecolor="k", zorder=4,
                   label="pasó por pueblo con granizo en la ventana horaria de la prensa")
        ax.set_xticks([]); ax.set_title(nom, fontsize=8.5); ax.grid(alpha=.3)
        if menor:
            ax.invert_yaxis()
    h_, l_ = axs[0].get_legend_handles_labels()
    fig.legend(h_, l_, loc="lower center", ncol=3, fontsize=8, title="Color = tipo de celda", bbox_to_anchor=(0.5, 0.03))
    fig.suptitle("%s · %d celdas comparables (viven ≥ %d min y llegan a ≤ %d °C). En las dos primeras, arriba = más extremo." % (
        C["titulo"], len(comp), DUR_MIN, BT_MIN), fontsize=9)
    fig.text(0.01, 0.005, "Fuente: NOAA GOES-19 ABI banda 13 y GLM (noaa-goes19, AWS); seguimiento tobac. Cada punto = una celda. "
             "Celdas sin minutos GLM válidos no aparecen en los paneles de rayos.", fontsize=7, color="#444")
    fig.tight_layout(rect=(0, .16, 1, .95)); fig.savefig(os.path.join(AQUI, "%s_comparacion.png" % caso), dpi=105); plt.close(fig)
    print(caso, "figuras listas; granizeras:", gran, "comparables:", len(comp))


if __name__ == "__main__":
    paso = sys.argv[1] if len(sys.argv) > 1 else "todo"
    casos = [sys.argv[2]] if len(sys.argv) > 2 else list(CASOS)
    pasos = {"bajar": bajar, "seguir": seguir}
    if paso == "todo":
        for c in casos:
            bajar(c); seguir(c)
            if "figuras" in globals():
                figuras(c)
    else:
        f = globals()[paso]
        for c in casos:
            f(c)
