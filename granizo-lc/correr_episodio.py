# Corre LightningCast sobre un episodio (día convectivo 12-12 UTC) y baja los flashes GLM.
#  - ABI L1b full disk (RadF), canales C02, C05, C13 y C15, cada `paso` minutos: se bajan los archivos
#    enteros de a uno, se corre LightningCast en lotes cortos recortado a la pampa y se borran.
#  - GLM L2 (LCFA, archivos de 20 s): se lee cada archivo en memoria y se guardan sólo los flashes
#    dentro de la caja.
#  - Todo lo que falta queda en faltantes.csv (un faltante NO es cero).
# Satélite: GOES-16 hasta el 6/4/2025, GOES-19 desde el 7/4/2025 (los dos en 75,2° O).
# Uso: python correr_episodio.py --episodio 2026-11-03 --salida out --lc-python venv/bin/python
import argparse
import csv
import glob
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import netCDF4

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import noaa  # noqa: E402

CANALES = ("C02", "C05", "C13", "C15")
W, E, S, N = -66.0, -57.0, -37.0, -29.0          # caja del recorte (la de G3b)
BBOX = "ll_bbox=[%g, %g, %g, %g]" % (W, E, S, N)
CAMBIO_G19 = datetime(2025, 4, 7, tzinfo=timezone.utc)
J2000 = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)
AQUI = os.path.dirname(os.path.abspath(__file__))


def bucket(t):
    return "noaa-goes19" if t >= CAMBIO_G19 else "noaa-goes16"


def horas_ventana(ep, horas):
    """Lista de horas UTC (datetime) de la ventana. Por defecto 12Z del episodio a 12Z del día siguiente."""
    t0 = datetime.strptime(ep, "%Y-%m-%d").replace(hour=12, tzinfo=timezone.utc)
    if not horas:
        return [t0 + timedelta(hours=i) for i in range(24)]
    m = re.fullmatch(r"(\d{1,2})-(\d{1,2})", horas.strip())
    if not m:
        raise SystemExit("horas mal escritas (ej.: 15-23 o 18-06): %r" % horas)
    h0, h1 = int(m.group(1)), int(m.group(2))
    ini = t0.replace(hour=h0) if h0 >= 12 else t0.replace(hour=h0) + timedelta(days=1)
    fin = t0.replace(hour=h1) if h1 >= 12 else t0.replace(hour=h1) + timedelta(days=1)
    if fin < ini:
        raise SystemExit("la ventana tiene que quedar dentro de 12Z-12Z del episodio")
    return [ini + timedelta(hours=i) for i in range(int((fin - ini).total_seconds() // 3600) + 1)]


def t_de_nombre(nombre, campo="s"):
    m = re.search(r"_%s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)" % campo, nombre)
    y, j, hh, mm, ss, _ = (int(x) for x in m.groups())
    return datetime(y, 1, 1, hh, mm, ss, tzinfo=timezone.utc) + timedelta(days=j - 1)


def prefijo(producto, h):
    return "%s/%04d/%03d/%02d/" % (producto, h.year, h.timetuple().tm_yday, h.hour)


class Faltantes:
    def __init__(self, ruta):
        self.f = open(ruta, "w", newline="")
        self.w = csv.writer(self.f)
        self.w.writerow(["fuente", "desde_utc", "hasta_utc", "detalle"])
        self.n = {}

    def add(self, fuente, desde, hasta, detalle):
        self.w.writerow([fuente, desde.strftime("%Y-%m-%dT%H:%M:%SZ"), hasta.strftime("%Y-%m-%dT%H:%M:%SZ"), detalle])
        self.f.flush()
        self.n[fuente] = self.n.get(fuente, 0) + 1


# ---------------------------------------------------------------- GLM
def glm(horas, salida, falt):
    ruta = os.path.join(salida, "glm_flashes.csv.gz")
    n_arch = n_fl = 0
    with gzip.open(ruta, "wt", newline="") as fo:
        w = csv.writer(fo)
        w.writerow(["utc", "lat", "lon", "energia_J", "area_m2"])
        # una hora más al final para poder mirar "los 60 min siguientes" del último barrido
        for h in horas + [horas[-1] + timedelta(hours=1)]:
            b = bucket(h)
            claves = sorted(k for k, _ in noaa.listar(b, prefijo("GLM-L2-LCFA", h)) if k.endswith(".nc"))
            if not claves:
                falt.add("glm", h, h + timedelta(hours=1), "hora sin archivos en %s" % b)
                continue
            # huecos: los archivos son de 20 s; más de 30 s entre inicios es un faltante (falta al menos un archivo)
            inicios = [t_de_nombre(k) for k in claves]
            if (inicios[0] - h).total_seconds() > 10:   # el primero arranca en HH:00:00
                falt.add("glm", h, inicios[0], "hueco al inicio de la hora")
            for a, c in zip(inicios[:-1], inicios[1:]):
                if (c - a).total_seconds() > 30:   # 20 s entre inicios; 40 s = un archivo menos
                    falt.add("glm", a + timedelta(seconds=20), c, "hueco entre archivos de 20 s")
            if (h + timedelta(hours=1) - inicios[-1]).total_seconds() > 30:
                falt.add("glm", inicios[-1] + timedelta(seconds=20), h + timedelta(hours=1), "hueco al final de la hora")
            for k in claves:
                try:
                    datos = noaa.bajar(b, k)
                    d = netCDF4.Dataset("glm", memory=datos)
                except Exception as e:  # noqa: BLE001
                    t = t_de_nombre(k)
                    falt.add("glm", t, t + timedelta(seconds=20), "archivo ilegible: %s" % str(e)[:80])
                    continue
                n_arch += 1
                if "flash_lat" not in d.variables or d.variables["flash_lat"].shape[0] == 0:
                    d.close()
                    continue
                lat = np.ma.filled(d.variables["flash_lat"][:].astype("f8"), np.nan)
                lon = np.ma.filled(d.variables["flash_lon"][:].astype("f8"), np.nan)
                v = d.variables["flash_time_offset_of_first_event"]
                base = datetime.strptime(v.units.split("since ")[1][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                off = np.ma.filled(v[:].astype("f8"), np.nan)
                en = np.ma.filled(d.variables["flash_energy"][:].astype("f8"), np.nan)
                ar = np.ma.filled(d.variables["flash_area"][:].astype("f8"), np.nan)
                d.close()
                m = (lat >= S) & (lat <= N) & (lon >= W) & (lon <= E)
                for i in np.where(m)[0]:
                    t = base + timedelta(seconds=float(off[i]))
                    w.writerow([t.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3], round(lat[i], 4), round(lon[i], 4),
                                "%.4g" % en[i], "%.4g" % ar[i]])
                    n_fl += 1
            print(h.strftime("%Y-%m-%d %HZ"), "GLM:", len(claves), "archivos", flush=True)
    return {"archivos_glm_leidos": n_arch, "flashes_en_caja": n_fl}


# ---------------------------------------------------------------- ABI + LightningCast
def barridos(horas, paso, falt):
    """Devuelve [(t_inicio, bucket, {canal: clave})] con los 4 canales; anota lo que falta."""
    lista = []
    for h in horas:
        b = bucket(h)
        claves = [k for k, _ in noaa.listar(b, prefijo("ABI-L1b-RadF", h))]
        por_t = {}
        for k in claves:
            nombre = k.rsplit("/", 1)[-1]
            for c in CANALES:
                if re.search(r"-M\d%s_" % c, nombre):
                    t = t_de_nombre(nombre)
                    por_t.setdefault(t.replace(second=0), {})[c] = k
        # ranuras esperadas: el full disk sale cada 10 min
        for mm in range(0, 60, paso):
            ranura = h.replace(minute=mm)
            cand = [t for t in por_t if ranura <= t < ranura + timedelta(minutes=min(paso, 10))]
            if not cand:
                falt.add("abi", ranura, ranura + timedelta(minutes=10), "sin barrido full disk")
                continue
            t = min(cand)
            if len(por_t[t]) < 4:
                falt.add("abi", t, t + timedelta(minutes=10),
                         "faltan canales: %s" % ",".join(c for c in CANALES if c not in por_t[t]))
                continue
            lista.append((t, b, por_t[t]))
    return lista


def correr_lc(lc_python, entradas, out):
    lst = os.path.join(out, "_lista.txt")
    with open(lst, "w") as f:
        f.write("\n".join(entradas) + "\n")
    cmd = [lc_python, os.path.join(AQUI, "correr_lc.py"), lst if len(entradas) > 1 else entradas[0],
           "--yaml_overrides", BBOX, "netcdf=3", "plax_hgt=9000", "make_json=false", "awips_nc=0",
           "make_img=0", 'outdir="%s"' % out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, (r.stdout[-4000:] + "\n" + r.stderr[-4000:])


def salida_de(out_lc, t):
    patron = os.path.join(out_lc, "**", "LightningCast_*_%s*.nc" % t.strftime("%Y%m%d-%H%M"))
    return glob.glob(patron, recursive=True)


def abi_lc(horas, paso, lote, lc_python, salida, falt):
    datos = os.path.join(salida, "_l1b")
    out_lc = os.path.join(salida, "netcdf")
    os.makedirs(datos, exist_ok=True)
    os.makedirs(out_lc, exist_ok=True)
    log = open(os.path.join(salida, "lightningcast.log"), "w")
    lista = barridos(horas, paso, falt)
    hechos = 0
    for i in range(0, len(lista), lote):
        grupo = lista[i:i + lote]
        t0 = time.time()
        c13 = {}
        for t, b, canales in grupo:
            try:
                for c, k in canales.items():
                    dst = os.path.join(datos, k.rsplit("/", 1)[-1])
                    noaa.bajar(b, k, dst)
                    if c == "C13":
                        c13[t] = dst
            except IOError as e:
                c13.pop(t, None)
                falt.add("abi", t, t + timedelta(minutes=10), "descarga fallida: %s" % str(e)[:80])
        grupo = [g for g in grupo if g[0] in c13]
        if not grupo:
            shutil.rmtree(datos)
            os.makedirs(datos)
            continue
        t1 = time.time()
        rc, txt = correr_lc(lc_python, [c13[t] for t, _, _ in grupo], out_lc)
        log.write("=== lote %s (rc=%d)\n%s\n" % (grupo[0][0].isoformat(), rc, txt))
        # lo que no salió en lote se reintenta solo, una vez
        for t, _, _ in grupo:
            if not salida_de(out_lc, t):
                rc2, txt2 = correr_lc(lc_python, [c13[t]], out_lc)
                log.write("=== reintento %s (rc=%d)\n%s\n" % (t.isoformat(), rc2, txt2))
            if salida_de(out_lc, t):
                hechos += 1
            else:
                falt.add("lightningcast", t, t + timedelta(minutes=10), "el modelo no dio salida (ver lightningcast.log)")
        log.flush()
        print(grupo[0][0].strftime("%Y-%m-%d %H:%M"), "x%d" % len(grupo), "bajada %.0fs" % (t1 - t0),
              "modelo %.0fs" % (time.time() - t1), flush=True)
        shutil.rmtree(datos)
        os.makedirs(datos)
        for f in glob.glob(os.path.join(out_lc, "**", "OR_ABI*.nc"), recursive=True):
            os.remove(f)
    shutil.rmtree(datos, ignore_errors=True)
    log.close()
    return {"barridos_completos": len(lista), "barridos_con_salida_lc": hechos}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodio", required=True)
    ap.add_argument("--salida", required=True)
    ap.add_argument("--lc-python", required=True)
    ap.add_argument("--paso", type=int, default=10, choices=[10, 20, 30, 60])
    ap.add_argument("--horas", default="")
    ap.add_argument("--lote", type=int, default=6)
    ap.add_argument("--sin-abi", action="store_true", help="sólo GLM (prueba)")
    a = ap.parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.episodio):
        raise SystemExit("episodio mal escrito")
    os.makedirs(a.salida, exist_ok=True)
    horas = horas_ventana(a.episodio, a.horas)
    falt = Faltantes(os.path.join(a.salida, "faltantes.csv"))
    man = {"episodio": a.episodio, "ventana_utc": [horas[0].isoformat(), (horas[-1] + timedelta(hours=1)).isoformat()],
           "paso_min": a.paso, "satelite": sorted({bucket(h).replace("noaa-", "").upper() for h in horas}),
           "caja": [W, E, S, N], "abi": "ABI-L1b-RadF C02 C05 C13 C15", "glm": "GLM-L2-LCFA",
           "lightningcast_overrides": [BBOX, "netcdf=3", "plax_hgt=9000"], "inicio": datetime.now(timezone.utc).isoformat()}
    man["glm_resumen"] = glm(horas, a.salida, falt)
    if not a.sin_abi:
        man["abi_resumen"] = abi_lc(horas, a.paso, a.lote, a.lc_python, a.salida, falt)
    man["faltantes"] = falt.n
    man["fin"] = datetime.now(timezone.utc).isoformat()
    json.dump(man, open(os.path.join(a.salida, "corrida.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(man, ensure_ascii=False))


if __name__ == "__main__":
    main()
