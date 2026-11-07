# Cruza las salidas de LightningCast (probabilidad de RAYO en los próximos 60 min) con los flashes GLM
# y con las horas de granizo del catálogo, para un episodio. Generaliza el análisis de G3b (3/11/2026)
# a cualquier episodio de la lista sellada. Es código propio: lee los netCDF que produce LightningCast,
# no importa nada de LightningCast.
#
# Reglas: un faltante NO es cero (las celdas o barridos sin dato quedan vacíos y se cuentan);
# acá no hay ningún % de granizo: la única probabilidad es la de rayo que da LightningCast.
#
# Uso: python analizar_lote.py --corrida <dir de correr_episodio> --puntos episodios_lote.csv --episodio AAAA-MM-DD
import argparse
import bisect
import csv
import glob
import json
import os
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import xarray as xr
from pyproj import Proj

UMBRALES = [10, 25, 50, 75]
RADIO_KM = 15.0                       # el de G3b
CELDA_M = 25000.0                     # grilla del contrato (G0 §2)
LAEA = Proj("+proj=laea +lat_0=-33.5 +lon_0=-61.75 +datum=WGS84")
CAJA_PILOTO = (-64.0, -59.5, -35.0, -32.0)   # W, E, S, N
HUECO_TORMENTA = pd.Timedelta(minutes=60)    # sin rayos >= 60 min => tormenta nueva (G3b)
BUSCA_ANTES = pd.Timedelta(minutes=90)


def dist_km(la1, lo1, la2, lo2):
    la1, lo1, la2, lo2 = map(np.radians, (la1, lo1, la2, lo2))
    a = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(a))


def id_celda(ix, iy):
    return "c%+03d%+03d" % (ix, iy)


def celdas_piloto():
    out = set()
    for ix in range(-20, 21):
        for iy in range(-20, 21):
            lo, la = LAEA((ix + 0.5) * CELDA_M, (iy + 0.5) * CELDA_M, inverse=True)
            if CAJA_PILOTO[0] <= lo <= CAJA_PILOTO[1] and CAJA_PILOTO[2] <= la <= CAJA_PILOTO[3]:
                out.add((ix, iy))
    return out


def r(x, n=1):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), n)


def hhmm(t):
    return None if t is None else pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ lectura
def leer_lc(ncdir):
    files = sorted(glob.glob(os.path.join(ncdir, "**", "LightningCast_*.nc"), recursive=True))
    tiempos, campos, var_usada = [], [], set()
    lat = lon = forma = None
    for f in files:
        t = datetime.strptime(os.path.basename(f).rsplit("_", 1)[-1][:15], "%Y%m%d-%H%M%S")
        with xr.open_dataset(f) as d:
            var = "PLTG_60min_plax" if "PLTG_60min_plax" in d else "PLTG_60min"
            a = d[var].values.astype("f4")
            if forma is None or a.shape != forma:
                if forma is not None:
                    raise SystemExit("cambió la grilla dentro del episodio: %s" % f)
                pa = d.imager_projection.attrs
                h = pa["perspective_point_height"]
                p = Proj(proj="geos", h=h, lon_0=pa["longitude_of_projection_origin"], sweep="x")
                X, Y = np.meshgrid(d.x.values * h, d.y.values * h)
                lon, lat = p(X, Y, inverse=True)
                lon = np.where(np.isfinite(lon) & (np.abs(lon) <= 180), lon, np.nan)
                lat = np.where(np.isfinite(lat) & (np.abs(lat) <= 90), lat, np.nan)
                forma = a.shape
        var_usada.add(var)
        a = np.where((a < 0) | (a > 100), np.nan, a)    # fuera de rango = sin dato, nunca 0
        tiempos.append(pd.Timestamp(t))
        campos.append(a)
    P = np.stack(campos) if campos else np.zeros((0, 1, 1), "f4")
    return tiempos, P, lat, lon, sorted(var_usada)


def leer_faltantes(ruta):
    if not os.path.exists(ruta):
        return pd.DataFrame(columns=["fuente", "desde_utc", "hasta_utc", "detalle"])
    f = pd.read_csv(ruta)
    for c in ("desde_utc", "hasta_utc"):
        f[c] = pd.to_datetime(f[c]).dt.tz_localize(None)
    return f


class GLMCompleto:
    def __init__(self, falt):
        g = falt[falt.fuente == "glm"]
        self.iv = list(zip(g.desde_utc, g.hasta_utc))

    def __call__(self, a, b):
        return not any(x < b and y > a for x, y in self.iv)


# ------------------------------------------------------------------ anticipos
def nanmax_mask(P, m):
    if not m.any():
        return np.full(len(P), np.nan)
    sub = P[:, m]
    with np.errstate(all="ignore"):
        out = np.nanmax(np.where(np.isnan(sub), -1, sub), axis=1)
    return np.where(out < 0, np.nan, out)


def anticipo_continuo(serie, tiempos, T, u, paso):
    """Desde que la prob. pasó u y se quedó arriba (sin cortes ni barridos faltantes) hasta T."""
    prev = [i for i, t in enumerate(tiempos) if t <= T]
    res = {}
    if not prev:
        res["nota"] = "sin barridos antes"
        return None, res
    i = prev[-1]
    if (T - tiempos[i]) > pd.Timedelta(minutes=paso + 2):
        res["nota"] = "falta el barrido previo"
    if np.isnan(serie[i]) or serie[i] < u:
        post = [t for t, s in zip(tiempos, serie) if not np.isnan(s) and s >= u and t > T - pd.Timedelta(minutes=10)]
        res["recien_despues_utc"] = hhmm(post[0]) if post else None
        return None, res
    while i - 1 >= 0 and not np.isnan(serie[i - 1]) and serie[i - 1] >= u:
        if tiempos[i] - tiempos[i - 1] > pd.Timedelta(minutes=paso + 2):
            res["cortado_por_barrido_faltante"] = True
            break
        i -= 1
    res["desde_utc"] = hhmm(tiempos[i])
    res["ya_estaba_al_inicio"] = (i == 0)
    return tiempos[i], res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corrida", required=True)
    ap.add_argument("--puntos", required=True)
    ap.add_argument("--episodio", required=True)
    ap.add_argument("--paso", type=int, default=10)
    ap.add_argument("--latencia", type=float, default=10.0,
                    help="min entre el inicio del barrido y el dato en la mano (G3b: ~10)")
    ap.add_argument("--sin-png", action="store_true")
    a = ap.parse_args()
    C = a.corrida
    out = os.path.join(C, "analisis")
    os.makedirs(out, exist_ok=True)

    tiempos, P, lat, lon, var = leer_lc(os.path.join(C, "netcdf"))
    falt = leer_faltantes(os.path.join(C, "faltantes.csv"))
    glm_ok = GLMCompleto(falt)
    g = pd.read_csv(os.path.join(C, "glm_flashes.csv.gz"), parse_dates=["utc"])
    g = g.sort_values("utc").reset_index(drop=True)
    corrida = json.load(open(os.path.join(C, "corrida.json")))
    v0 = pd.Timestamp(corrida["ventana_utc"][0]).tz_localize(None)
    v1 = pd.Timestamp(corrida["ventana_utc"][1]).tz_localize(None)
    pts = pd.read_csv(a.puntos, comment="#", dtype=str)
    pts = pts[pts.episodio == a.episodio]
    res = {"episodio": a.episodio, "variable_lightningcast": var, "radio_km": RADIO_KM, "umbrales_pct": UMBRALES,
           "latencia_min": a.latencia, "barridos_con_prob": len(tiempos),
           "aviso": "Probabilidad de RAYO en 60 min (LightningCast). No es probabilidad de granizo.",
           "faltantes_por_fuente": falt.fuente.value_counts().to_dict(), "puntos": []}
    if not len(tiempos):
        res["nota"] = "sin ninguna salida de LightningCast: nada que analizar"
        json.dump(res, open(os.path.join(out, "resumen.json"), "w"), ensure_ascii=False, indent=1)
        return

    # ---------------- probabilidad por celda de 25 km (sólo celdas del piloto)
    piloto = celdas_piloto()
    X, Y = LAEA(np.nan_to_num(lon, nan=0.0), np.nan_to_num(lat, nan=0.0))
    IX = np.floor(X / CELDA_M).astype(int)
    IY = np.floor(Y / CELDA_M).astype(int)
    valido = np.isfinite(lat) & np.isfinite(lon)
    mascaras = {}
    for (ix, iy) in sorted(piloto):
        m = valido & (IX == ix) & (IY == iy)
        if m.any():
            mascaras[(ix, iy)] = m
    gx, gy = LAEA(g.lon.values, g.lat.values)
    g["ix"] = np.floor(gx / CELDA_M).astype(int)
    g["iy"] = np.floor(gy / CELDA_M).astype(int)
    gt = g.utc.values
    filas = []
    serie_celda = {}
    for (ix, iy), m in mascaras.items():
        sub = P[:, m]
        with np.errstate(all="ignore"):
            pmax = np.nanmax(np.where(np.isnan(sub), -1, sub), axis=1)
            pmed = np.nanmean(sub, axis=1)
        pmax = np.where(pmax < 0, np.nan, pmax)
        nval = np.isfinite(sub).sum(axis=1)
        serie_celda[(ix, iy)] = pmax
        fl = g[(g.ix == ix) & (g.iy == iy)].utc.values
        for k, t in enumerate(tiempos):
            n60 = int(np.searchsorted(fl, np.datetime64(t + pd.Timedelta(minutes=60))) - np.searchsorted(fl, np.datetime64(t)))
            comp = glm_ok(t, t + pd.Timedelta(minutes=60)) and (t + pd.Timedelta(minutes=60) <= v1)
            filas.append([hhmm(t), id_celda(ix, iy), r(pmax[k]), r(pmed[k]), int(m.sum()), int(nval[k]),
                          n60 if comp else "", "si" if comp else "no"])
    with open(os.path.join(out, "prob_celdas.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["barrido_utc", "celda", "prob_rayo_max_pct", "prob_rayo_media_pct", "n_pix", "n_pix_con_dato",
                    "flashes_glm_celda_60min", "glm_completo_60min"])
        w.writerows(filas)

    # ---------------- iniciaciones por celda: primer rayo tras >= 60 min sin rayos en la celda y sus 8 vecinas
    ini = []
    por_celda = {k: np.sort(v.utc.values) for k, v in g.groupby(["ix", "iy"])}
    for (ix, iy), m in mascaras.items():
        propios = por_celda.get((ix, iy))
        if propios is None:
            continue
        bloque = np.sort(np.concatenate([por_celda.get((ix + dx, iy + dy), np.array([], "datetime64[ns]"))
                                         for dx in (-1, 0, 1) for dy in (-1, 0, 1)]))
        for t1 in propios:
            j = bisect.bisect_left(bloque, t1)
            t1p = pd.Timestamp(t1)
            if j > 0 and (t1p - pd.Timestamp(bloque[j - 1])) < HUECO_TORMENTA:
                continue
            if t1p - HUECO_TORMENTA < v0 or not glm_ok(t1p - HUECO_TORMENTA, t1p):
                continue  # no se puede asegurar que sea el primer rayo
            s = serie_celda[(ix, iy)]
            idx = [k for k, t in enumerate(tiempos) if t1p - BUSCA_ANTES <= t <= t1p]
            ev = {"celda": id_celda(ix, iy), "primer_flash_utc": hhmm(t1p), "barridos_en_90min": len(idx),
                  "barridos_esperados_90min": int(BUSCA_ANTES / pd.Timedelta(minutes=a.paso)),
                  "prob_rayo_ultimo_barrido_pct": r(s[idx[-1]]) if idx else None}
            for u in UMBRALES:
                cand = [tiempos[k] for k in idx if not np.isnan(s[k]) and s[k] >= u]
                ant = (t1p - cand[0]).total_seconds() / 60 if cand else None
                ev["anticipo_%d_min" % u] = r(ant)
                ev["anticipo_%d_entregado_min" % u] = r(ant - a.latencia) if ant is not None else None
            ini.append(ev)
    ini = pd.DataFrame(ini)
    ini.to_csv(os.path.join(out, "iniciaciones_celdas.csv"), index=False)
    resumen_ini = {"n_iniciaciones": int(len(ini))}
    for u in UMBRALES:
        s = ini["anticipo_%d_min" % u].dropna() if len(ini) else pd.Series(dtype=float)
        resumen_ini["prob%d" % u] = {
            "con_aviso_antes_del_primer_rayo": int(len(s)), "de": int(len(ini)),
            "anticipo_mediana_min": r(s.median()) if len(s) else None,
            "anticipo_p10_min": r(s.quantile(.1)) if len(s) else None,
            "anticipo_p90_min": r(s.quantile(.9)) if len(s) else None}
    res["iniciaciones_celdas"] = resumen_ini

    # ---------------- celdas-barrido con prob alta: ¿hubo rayo en el bloque 3x3 en la hora siguiente?
    acierto = {}
    for u in (50, 75):
        tot = hit = 0
        for (ix, iy), s in serie_celda.items():
            bloque = np.sort(np.concatenate([por_celda.get((ix + dx, iy + dy), np.array([], "datetime64[ns]"))
                                             for dx in (-1, 0, 1) for dy in (-1, 0, 1)]))
            for k, t in enumerate(tiempos):
                if np.isnan(s[k]) or s[k] < u:
                    continue
                t2 = t + pd.Timedelta(minutes=60)
                if t2 > v1 or not glm_ok(t, t2):
                    continue
                tot += 1
                n = np.searchsorted(bloque, np.datetime64(t2)) - np.searchsorted(bloque, np.datetime64(t))
                hit += int(n > 0)
        acierto["prob%d" % u] = {"celdas_barrido": tot, "con_rayo_en_bloque_60min": hit,
                                 "pct": r(100 * hit / tot) if tot else None}
    res["celdas_con_prob_alta"] = acierto

    # ---------------- puntos del catálogo (granizo y ausencias)
    series_png = []
    for _, p in pts.iterrows():
        la, lo = float(p["lat"]), float(p["lon"])
        m = valido & (dist_km(lat, lon, la, lo) <= RADIO_KM)
        serie = nanmax_mask(P, m)
        gd = g[dist_km(g.lat.values, g.lon.values, la, lo) <= RADIO_KM]
        d = {k: p[k] for k in ("id", "tipo", "de_la_lista", "region", "nivel", "celda", "usa_hora")}
        d.update({"lat": la, "lon": lo, "flashes_glm_radio_ventana": int(len(gd)),
                  "prob_rayo_max_ventana_pct": r(np.nanmax(serie)) if np.isfinite(serie).any() else None,
                  "barridos_sin_dato_en_radio": int(np.isnan(serie).sum())})
        if p["tipo"] == "granizo":
            tgr = pd.Timestamp(p["hora_utc"]).tz_localize(None)
            d["granizo_utc"] = hhmm(tgr)
            d["incertidumbre_h"] = float(p["incertidumbre_h"])
            if p["usa_hora"] == "si":
                antes = gd[gd.utc <= tgr + pd.Timedelta(minutes=30)].utc.reset_index(drop=True)
                primer = None
                if len(antes):
                    idx = np.where((antes.diff() >= HUECO_TORMENTA).values)[0]
                    primer = antes.iloc[idx[-1]] if len(idx) else antes.iloc[0]
                    if not len(idx) and antes.iloc[0] - HUECO_TORMENTA < v0:
                        d["nota_primer_flash"] = "puede haber rayos antes de la ventana"
                    if not glm_ok(primer - HUECO_TORMENTA, primer):
                        d["nota_primer_flash"] = "faltan archivos GLM en la hora previa al primer flash"
                d["primer_flash_tormenta_utc"] = hhmm(primer)
                for u in UMBRALES:
                    if primer is not None:
                        t_u, info = anticipo_continuo(serie, tiempos, primer, u, a.paso)
                        if t_u is not None:
                            ant = (primer - t_u).total_seconds() / 60
                            info["anticipo_vs_primer_flash_min"] = r(ant)
                            info["anticipo_vs_primer_flash_entregado_min"] = r(ant - a.latencia)
                    else:
                        info = {"nota": "sin rayos GLM en el radio antes del granizo"}
                    t_g, info_g = anticipo_continuo(serie, tiempos, tgr, u, a.paso)
                    if t_g is not None:
                        ant = (tgr - t_g).total_seconds() / 60
                        info["anticipo_vs_granizo_min"] = r(ant)
                        info["anticipo_vs_granizo_entregado_min"] = r(ant - a.latencia)
                        info["vs_granizo_desde_utc"] = info_g.get("desde_utc")
                        info["vs_granizo_cortado_por_barrido_faltante"] = info_g.get("cortado_por_barrido_faltante", False)
                        info["vs_granizo_ya_estaba_al_inicio"] = info_g.get("ya_estaba_al_inicio")
                    else:
                        info["vs_granizo"] = info_g
                    d["prob%d" % u] = info
                series_png.append((p["id"], serie, gd, tgr, primer))
            else:
                d["nota"] = ("hora inferida del GOES: sólo nivel episodio (circular para la etapa 3)"
                             if p["nivel"] == "celda-hora" else "hora incierta (±%s h): sin anticipo contra el granizo" % p["incertidumbre_h"])
                d["primer_flash_radio_ventana_utc"] = hhmm(gd.utc.iloc[0]) if len(gd) else None
        else:  # ausencia observada de confianza alta (había tormenta en la estación, sin granizo)
            horas = []
            for h in str(p["horas_ausencia"]).split():
                h0 = pd.Timestamp(h).tz_localize(None)
                pre = [s for t, s in zip(tiempos, serie) if h0 - pd.Timedelta(minutes=60) <= t < h0 and not np.isnan(s)]
                dur = [s for t, s in zip(tiempos, serie) if h0 <= t < h0 + pd.Timedelta(hours=1) and not np.isnan(s)]
                comp = glm_ok(h0, h0 + pd.Timedelta(hours=1))
                horas.append({"hora_utc": hhmm(h0), "prob_rayo_max_hora_previa_pct": r(max(pre)) if pre else None,
                              "prob_rayo_max_en_la_hora_pct": r(max(dur)) if dur else None,
                              "flashes_glm_radio_en_la_hora": int(((gd.utc >= h0) & (gd.utc < h0 + pd.Timedelta(hours=1))).sum()) if comp else None,
                              "glm_completo": comp})
            d["horas_ausencia"] = horas
        res["puntos"].append(d)

    # tabla plana de puntos para juntar el lote
    plano = []
    for d in res["puntos"]:
        f = {k: v for k, v in d.items() if not isinstance(v, (dict, list))}
        for u in UMBRALES:
            for k, v in (d.get("prob%d" % u) or {}).items():
                if not isinstance(v, dict):
                    f["p%d_%s" % (u, k)] = v
        f["episodio"] = a.episodio
        plano.append(f)
    pd.DataFrame(plano).to_csv(os.path.join(out, "puntos.csv"), index=False)
    json.dump(res, open(os.path.join(out, "resumen.json"), "w"), ensure_ascii=False, indent=1, default=str)

    if series_png and not a.sin_png:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, axs = plt.subplots(len(series_png), 1, figsize=(10, 3.2 * len(series_png)), sharex=True, squeeze=False)
        for ax, (pid, serie, gd, tgr, primer) in zip(axs[:, 0], series_png):
            ax.plot(tiempos, serie, "-o", ms=2.5, color="#1f5fbf", label="LightningCast: prob. máx. de RAYO en 60 min (radio %d km)" % RADIO_KM)
            for u in (25, 50, 75):
                ax.axhline(u, color="#999", lw=0.6, ls=":")
            ax2 = ax.twinx()
            if len(gd):
                cnt = gd.set_index("utc").resample("5min").size()
                ax2.bar(cnt.index, cnt.values, width=timedelta(minutes=4.5), align="edge", color="#888", alpha=0.45)
            ax2.set_ylabel("flashes GLM / 5 min", fontsize=8)
            ax.axvline(tgr, color="#c0392b", lw=2, label="granizo informado %s UTC" % tgr.strftime("%H:%M"))
            if primer is not None:
                ax.axvline(primer, color="#222", lw=1, ls="--", label="primer flash GLM %s UTC" % primer.strftime("%H:%M"))
            ax.set_ylim(0, 102)
            ax.set_ylabel("prob. de rayo (%)")
            ax.set_title(pid, loc="left", fontsize=10)
            ax.legend(fontsize=7, loc="upper left")
            ax.set_zorder(ax2.get_zorder() + 1)
            ax.patch.set_visible(False)
        fig.text(0.01, 0.003, "Fuente: NOAA/CIMSS ProbSevere LightningCast v1.4.4 (GPL-3.0), corrido aparte sobre GOES ABI full disk (NOAA, AWS); "
                 "rayos GOES GLM L2. Probabilidad de RAYO, no de granizo. Barridos faltantes = sin dato.", fontsize=6)
        fig.tight_layout(rect=(0, 0.02, 1, 1))
        fig.savefig(os.path.join(out, "series_puntos.png"), dpi=110)
        plt.close(fig)
    print(json.dumps({k: v for k, v in res.items() if k != "puntos"}, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main()
