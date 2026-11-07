# -*- coding: utf-8 -*-
"""
SATCHI Granizo · G3 en lote: un episodio (día convectivo 12-12 UTC) por corrida.

    python -P lote.py <AAAA-MM-DD> [--horas HH-HH] [--salida DIR]

1. Baja ABI C13 (disco completo, archivo ENTERO, recortado a la caja) y GLM de 20 s (archivo entero, en memoria)
   del bucket público de NOAA en AWS: noaa-goes16 hasta el 6/4/2025, noaa-goes19 desde el 7/4/2025.
   Como mucho 2 pedidos simultáneos.
2. Corre el seguimiento de la etapa 3 (analisis_g3.py: tobac + paralaje + rayos por celda + salto 2σ).
3. Evalúa contra el catálogo G1 (catalogo_lote.csv) con el contrato G0: celda 25 km × hora UTC, 8 vecinas,
   evento ±1 h, señal acierta en [emisión disponible, vencimiento + 1 h], faltantes ≠ cero, FAR sólo con
   ausencia observada. Sólo CONTEOS: ningún porcentaje ni probabilidad de granizo.

--horas HH-HH recorta la ventana (prueba corta): p. ej. 20-21 corre de 20 a 21 UTC del día del episodio
(horas < 12 caen en el día siguiente, como en el episodio).

Experimental. No es un aviso oficial del SMN.
"""
import os, sys, json, glob, math, shutil, argparse, datetime as dt
import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import analisis_g3 as A  # noqa: E402

UTC = dt.timezone.utc
CAMBIO_G19 = dt.datetime(2025, 4, 7, tzinfo=UTC)
CRS_GRILLA = "+proj=laea +lat_0=-33.5 +lon_0=-61.75 +datum=WGS84 +units=m +no_defs"  # G0/contrato.json
CELDA_M = 25000.0
PILOTO_BOX = (-64.0, -59.5, -35.0, -32.0)  # lon0, lon1, lat0, lat1 (contrato §2)

# Señales PROVISORIAS de la etapa 3 para evaluar (los umbrales se sellan en G2/G4, no acá)
SEN = dict(
    enfr_rc_btmin_max=-0.5,      # °C/min: enfriamiento del tope mínimo ≥ 5 °C en 10 min
    enfr_btmin_max=-55.0,        # °C: y el tope ya está a ≤ −55 °C
    salto_version="linaje",      # versión principal del salto 2σ (saltos.csv); «celda» y «sin_regla» como sensibilidad
    ambas_ventana_s=1800,        # salto y enfriamiento de la MISMA celda a ≤ 30 min
    vencimiento_s=1800,          # etapa 3: 30 min (contrato §6)
    lat_abi_s=120,               # disponible = fin del barrido + 2 min (INVENTARIO §5)
    lat_glm_s=60,                # disponible = fin del período + 1 min
)
# Una hora es «sin datos» si le faltan demasiados archivos (contrato §6: faltante ≠ cero)
MIN_ABI_HORA = 4      # de 6 imágenes
MIN_GLM_HORA = 150    # de 180 archivos de 20 s


def celda_de(lat, lon):
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", CRS_GRILLA, always_xy=True)
    x, y = tr.transform(np.asarray(lon, "f8"), np.asarray(lat, "f8"))
    return np.floor(x / CELDA_M).astype(int), np.floor(y / CELDA_M).astype(int)


def cid(ix, iy):
    return "c%+03d%+03d" % (ix, iy)


def parse_id(c):
    return int(c[1:4]), int(c[4:7])


def hora_floor(ts):
    return int(ts // 3600) * 3600


def iso(ts):
    return dt.datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%MZ")


def t_iso(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC).timestamp() if s else None


# ------------------------------------------------------------------ catálogo
def cargar_catalogo(ep):
    import pandas as pd
    c = pd.read_csv(os.path.join(AQUI, "catalogo_lote.csv"), dtype=str).fillna("")
    c = c[c.episodio == ep].copy()
    ini, fin = [], []
    for r in c.itertuples():
        a, b = t_iso(r.hora_ini_utc), t_iso(r.hora_fin_utc)
        if a is None:
            m = t_iso(r.fecha_hora_utc); u = float(r.incertidumbre_h or 0) * 3600
            a, b = m - u, m + u
        ini.append(a); fin.append(b)
    c["ini"], c["fin"] = ini, fin
    return c


# ------------------------------------------------------------------ cobertura
def cobertura(out, t0, t1):
    fs = sorted(glob.glob(os.path.join(out, "abi", "*.npz")))
    te = np.array([float(np.load(f)["te"]) for f in fs])
    ts = np.array([float(np.load(f)["ts"]) for f in fs])
    g = np.load(os.path.join(out, "glm.npz"))
    ga = g["archivos"]
    hs = list(range(hora_floor(t0), int(t1), 3600))
    cob = {}
    for h in hs:
        na = int(((ts >= h) & (ts < h + 3600)).sum())
        ng = int(((ga >= h) & (ga < h + 3600)).sum())
        cob[h] = dict(abi=na, glm=ng, sin_datos=bool(na < MIN_ABI_HORA or ng < MIN_GLM_HORA))
    return te, cob


# ------------------------------------------------------------------ señales
def instancias(out, te):
    """Cada instancia: tipo, celda tobac, hora disponible (emisión), vencimiento, celda de grilla."""
    import pandas as pd
    A_ = pd.read_csv(os.path.join(out, "atributos_probsevere.csv"))
    F = pd.read_csv(os.path.join(out, "celdas_frames.csv"))
    sp = os.path.join(out, "saltos.csv")
    S = pd.read_csv(sp) if os.path.getsize(sp) > 5 else pd.DataFrame(columns=["cell", "version", "t", "tasa", "dfr", "sig"])
    ev = json.load(open(os.path.join(out, "fusiones_divisiones.json")))["eventos"]
    con_ev = {(int(i), int(c)) for i, tp, c, o in ev} | {(int(i), int(u)) for i, tp, c, o in ev for u in o}
    F = F.merge(A_[["cell", "frame", "rc_btmin"]], on=["cell", "frame"], how="left")
    F["la"] = F.lat_f.fillna(F.lat); F["lo"] = F.lon_f.fillna(F.lon)
    ix, iy = celda_de(F.la.values, F.lo.values)
    F["ix"], F["iy"] = ix, iy
    F["te"] = [te[int(i)] for i in F.frame]
    ins = []
    # ABI: enfriamiento sin fusión/división en ese paso
    m = (F.rc_btmin <= SEN["enfr_rc_btmin_max"]) & (F.btmin <= SEN["enfr_btmin_max"])
    for r in F[m].itertuples():
        if (int(r.frame), int(r.cell)) in con_ev:
            continue
        t = r.te + SEN["lat_abi_s"]
        ins.append(dict(tipo="abi_enfriamiento", cell=int(r.cell), t=t, v=t + SEN["vencimiento_s"], ix=int(r.ix), iy=int(r.iy),
                        valor=float(r.rc_btmin)))
    # GLM: saltos 2σ (sólo versiones por celda: familia/sistema no tienen una posición única)
    pos = {c: d.sort_values("tef") for c, d in F.groupby("cell")}
    for r in S[S.version.isin(["linaje", "celda", "sin_regla"])].itertuples():
        d = pos.get(int(r.cell))
        if d is None or not len(d):
            continue
        k = int(np.argmin(np.abs(d.tef.values - r.t)))
        t = float(r.t) + SEN["lat_glm_s"]
        ins.append(dict(tipo="glm_salto_" + r.version, cell=int(r.cell), t=t, v=t + SEN["vencimiento_s"],
                        ix=int(d.ix.values[k]), iy=int(d.iy.values[k]), valor=float(r.tasa)))
    # ambas: salto (versión principal) y enfriamiento de la misma celda a ≤ 30 min
    sal = [x for x in ins if x["tipo"] == "glm_salto_" + SEN["salto_version"]]
    enf = [x for x in ins if x["tipo"] == "abi_enfriamiento"]
    for s in sal:
        for e in enf:
            if e["cell"] == s["cell"] and abs(e["t"] - s["t"]) <= SEN["ambas_ventana_s"]:
                x = s if s["t"] >= e["t"] else e
                ins.append(dict(tipo="ambas", cell=s["cell"], t=x["t"], v=x["t"] + SEN["vencimiento_s"], ix=x["ix"], iy=x["iy"], valor=None))
                break
    return ins


def componentes(ins):
    """Señal = componente conexa de celdas-hora (8 vecinas × 1 h), contrato §3."""
    ch = {}
    for n, x in enumerate(ins):
        for h in range(hora_floor(x["t"]), hora_floor(x["v"]) + 1, 3600):
            ch.setdefault((x["ix"], x["iy"], h), []).append(n)
    claves = list(ch)
    idx = {k: i for i, k in enumerate(claves)}
    padre = list(range(len(claves)))

    def raiz(a):
        while padre[a] != a:
            padre[a] = padre[padre[a]]; a = padre[a]
        return a
    for (ix, iy, h) in claves:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dh in (-3600, 0, 3600):
                    k = (ix + dx, iy + dy, h + dh)
                    if k in idx:
                        padre[raiz(idx[(ix, iy, h)])] = raiz(idx[k])
    grupos = {}
    for k in claves:
        grupos.setdefault(raiz(idx[k]), set()).add(k)
    out = []
    for g in grupos.values():
        miembros = sorted({n for k in g for n in ch[k]})
        out.append(dict(celdas_horas=sorted(g), inst=miembros))
    return out


def vecina(ix, iy, celda):
    a, b = parse_id(celda)
    return abs(a - ix) <= 1 and abs(b - iy) <= 1


def evaluar_tipo(tipo, ins, cat, cob):
    I = [x for x in ins if x["tipo"] == tipo]
    comps = componentes(I)
    conf = cat[cat.etiqueta == "confirmado"]
    horarios = conf[(conf.nivel.isin(["celda-hora", "difuso"])) & (conf.hora_inferida != "si")]
    de_episodio = conf[~conf.index.isin(horarios.index) & (conf.nivel != "semana")]
    aus = cat[(cat.etiqueta == "ausencia observada")]
    señales, ev_match = [], {}
    for n, c in enumerate(comps):
        inst = [I[i] for i in c["inst"]]
        hits = []
        for e in horarios.itertuples():
            a, b = e.ini - 3600, e.fin + 3600  # evento ±1 h
            for x in inst:
                if vecina(x["ix"], x["iy"], e.celda) and x["t"] <= b and a <= x["v"] + 3600:
                    hits.append(e.id_evento); break
        set_ch = {(cid(ix, iy), h) for ix, iy, h in c["celdas_horas"]}
        def toca(df):
            return sorted({r.id_evento for r in df.itertuples()
                           if any((r.celda, h) in set_ch for h in range(hora_floor(r.ini), hora_floor(max(r.fin - 1, r.ini)) + 1, 3600))})
        aus_alta = toca(aus[aus.uso_far == "alta"])
        aus_media = toca(aus[aus.uso_far == "media"])
        cerca_ep = sorted({e.id_evento for e in de_episodio.itertuples() if any(vecina(x["ix"], x["iy"], e.celda) for x in inst)})
        if hits:
            clase = "acierto"
        elif aus_alta:
            clase = "falsa_alta"
        elif aus_media:
            clase = "falsa_media"   # sensibilidad: sólo SYNOP
        else:
            clase = "sin_verificar"
        piloto = any(PILOTO_BOX[0] <= lon <= PILOTO_BOX[1] and PILOTO_BOX[2] <= lat <= PILOTO_BOX[3]
                     for lat, lon in [centro(ix, iy) for ix, iy, h in c["celdas_horas"]])
        t_e = min(x["t"] for x in inst)
        señales.append(dict(n=n, clase=clase, piloto=piloto, emision=iso(t_e), vence=iso(max(x["v"] for x in inst)),
                            celdas=sorted({cid(ix, iy) for ix, iy, h in c["celdas_horas"]}),
                            n_celdas_hora=len(c["celdas_horas"]), celdas_tobac=sorted({x["cell"] for x in inst}),
                            eventos=hits, ausencias_alta=aus_alta, ausencias_media=aus_media,
                            cerca_de_confirmado_sin_hora=cerca_ep,
                            horas_sin_datos=sum(1 for h in {h for _, _, h in c["celdas_horas"]} if cob.get(h, {}).get("sin_datos", True))))
        for e in hits:
            ev_match.setdefault(e, []).append((t_e, n))
    eventos = []
    for e in horarios.itertuples():
        hs = [h for h in range(hora_floor(e.ini - 3600), hora_floor(e.fin + 3600) + 1, 3600)]
        sd = all(cob.get(h, {}).get("sin_datos", True) for h in hs)
        if e.id_evento in ev_match:
            t_e, n = min(ev_match[e.id_evento])
            eventos.append(dict(id=e.id_evento, nivel=e.nivel, celda=e.celda, region=e.region, ge_2cm=e.ge_2cm,
                                resultado="acierto", señal=n, adelanto_min=round((e.ini - t_e) / 60, 1)))
        else:
            eventos.append(dict(id=e.id_evento, nivel=e.nivel, celda=e.celda, region=e.region, ge_2cm=e.ge_2cm,
                                resultado="sin_datos" if sd else "perdido"))
    ep_ev = []
    for e in de_episodio.itertuples():
        cerca = [x for x in I if vecina(x["ix"], x["iy"], e.celda)]
        ep_ev.append(dict(id=e.id_evento, nivel=e.nivel, celda=e.celda, region=e.region, hora_inferida=e.hora_inferida == "si",
                          señal_en_vecinas_en_el_episodio=bool(cerca),
                          primera=iso(min(x["t"] for x in cerca)) if cerca else None))
    cnt = lambda k, p=None: sum(1 for s in señales if s["clase"] == k and (p is None or s["piloto"] == p))
    conteos = dict(H_eventos=sum(1 for e in eventos if e["resultado"] == "acierto"),
                   M_eventos=sum(1 for e in eventos if e["resultado"] == "perdido"),
                   eventos_sin_datos=sum(1 for e in eventos if e["resultado"] == "sin_datos"),
                   señales=len(señales), señales_acierto=cnt("acierto"), F_alta=cnt("falsa_alta"),
                   F_media_sensibilidad=cnt("falsa_media"), sin_verificar=cnt("sin_verificar"),
                   señales_piloto=sum(1 for s in señales if s["piloto"]), F_alta_piloto=cnt("falsa_alta", True),
                   sin_verificar_piloto=cnt("sin_verificar", True))
    return dict(conteos=conteos, eventos_hora=eventos, eventos_sin_hora=ep_ev, señales=señales)


def centro(ix, iy):
    from pyproj import Transformer
    tr = Transformer.from_crs(CRS_GRILLA, "EPSG:4326", always_xy=True)
    lon, lat = tr.transform((ix + .5) * CELDA_M, (iy + .5) * CELDA_M)
    return lat, lon


def evaluar(ep, out, t0, t1, tipo_ep, ventana_recortada):
    import pandas as pd
    te, cob = cobertura(out, t0, t1)
    cat = cargar_catalogo(ep)
    cat = cat[(cat.fin >= t0 - 3600) & (cat.ini <= t1 + 3600)]  # sólo lo que toca la ventana corrida
    ins = instancias(out, te)
    tipos = ["glm_salto_linaje", "abi_enfriamiento", "ambas", "glm_salto_celda", "glm_salto_sin_regla"]
    res = {t: evaluar_tipo(t, ins, cat, cob) for t in tipos}
    meta = json.load(open(os.path.join(out, "meta.json")))
    return dict(
        episodio=ep, tipo=tipo_ep, ventana_utc=[iso(t0), iso(t1)], ventana_recortada=ventana_recortada,
        satelite=A.BUCKET.split("//")[1].split(".")[0],
        aviso="Experimental. No es un aviso oficial del SMN. Sólo conteos: ningún % ni probabilidad de granizo.",
        contrato="G0 (borrador sin sellar): celda 25 km LAEA × hora UTC; 8 vecinas; evento ±1 h; señal acierta en "
                 "[emisión disponible, vencimiento + 1 h]; FAR sólo si toca ausencia observada (alta; media = sensibilidad); "
                 "lo desconocido se cuenta aparte; eventos de nivel episodio o con hora inferida del GOES van sólo por episodio.",
        señales_provisorias=SEN, regla_sin_datos=dict(min_abi_por_hora=MIN_ABI_HORA, min_glm_por_hora=MIN_GLM_HORA),
        cobertura=dict(horas=len(cob), horas_sin_datos=sum(v["sin_datos"] for v in cob.values()),
                       por_hora={iso(h): v for h, v in cob.items()}),
        catalogo=dict(confirmados=int((cat.etiqueta == "confirmado").sum()),
                      desconocidos=int((cat.etiqueta == "desconocido").sum()),
                      ausencias_hora_alta=int(((cat.etiqueta == "ausencia observada") & (cat.uso_far == "alta")).sum()),
                      ausencias_hora_media=int(((cat.etiqueta == "ausencia observada") & (cat.uso_far == "media")).sum())),
        seguimiento=dict(n_celdas=meta.get("n_celdas"), frames=meta.get("frames"), glm_fallidos=meta.get("glm_fallidos"),
                         minutos_glm_incompletos=meta.get("minutos_glm_incompletos"), paralaje=meta.get("paralaje")),
        por_señal=res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("episodio")
    ap.add_argument("--horas", default="")
    ap.add_argument("--salida", default=os.path.join(AQUI, "salida"))
    ap.add_argument("--tipo", default="")
    a = ap.parse_args()
    ep = a.episodio
    d0 = dt.datetime.strptime(ep, "%Y-%m-%d").replace(tzinfo=UTC)
    t0, t1 = d0 + dt.timedelta(hours=12), d0 + dt.timedelta(hours=36)
    if a.horas:
        h0, h1 = [int(x) for x in a.horas.split("-")]
        f = lambda h: d0 + dt.timedelta(hours=h if h >= 12 else h + 24)
        t0, t1 = f(h0), f(h1)
        if t1 <= t0:
            sys.exit("--horas: el fin tiene que ser posterior al inicio")
    A.BUCKET = "https://noaa-goes16.s3.amazonaws.com" if t0 < CAMBIO_G19 else "https://noaa-goes19.s3.amazonaws.com"
    A.DATOS = os.path.join(a.salida, "_trabajo")
    os.makedirs(A.DATOS, exist_ok=True)
    A.CASOS[ep] = dict(titulo="episodio %s" % ep, t0=t0, t1=t1, caja=A.PILOTO, granizo=[])
    print("episodio", ep, A.BUCKET, t0.isoformat(), "->", t1.isoformat(), flush=True)
    A.bajar(ep)
    out = os.path.join(A.DATOS, ep)
    dest = os.path.join(a.salida, ep)
    os.makedirs(dest, exist_ok=True)
    try:
        A.seguir(ep)
        ev = evaluar(ep, out, t0.timestamp(), t1.timestamp(), a.tipo, bool(a.horas))
    except Exception as e:  # sin celdas, etc.: queda escrito, nunca como «sin señal»
        import traceback; traceback.print_exc()
        ev = dict(episodio=ep, estado="error", error=repr(e), nota="sin evaluación: NO equivale a «sin señal»")
    json.dump(ev, open(os.path.join(dest, "evaluacion.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    for f in ("atributos_probsevere.csv", "saltos.csv", "celdas_resumen.csv", "celdas_frames.csv", "meta.json",
              "abi_log.json", "fusiones_divisiones.json"):
        p = os.path.join(out, f)
        if os.path.exists(p):
            shutil.copy(p, dest)
    if ev.get("estado") == "error":
        sys.exit(1)
    for t, r in ev["por_señal"].items():
        print(t, json.dumps(r["conteos"], ensure_ascii=False))


if __name__ == "__main__":
    main()
