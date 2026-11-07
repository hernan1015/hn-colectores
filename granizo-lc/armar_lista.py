# Arma episodios_lote.csv (los puntos a evaluar por episodio) a partir de la lista sellada de
# episodios y del catálogo de granizo. Se corre UNA vez fuera de Actions; el CSV queda en el repo.
# Uso: python armar_lista.py <episodios.csv sellado> <CATALOGO.csv> <salida.csv>
# Sólo copia lo necesario: id, tipo, lugar (lat/lon), hora UTC, incertidumbre y celda.
# Sin nombres de personas ni de fuentes.
import csv, sys, hashlib

EPIS, CATA, OUT = sys.argv[1:4]
CIRCULARES = {"C-20261103-02", "C-20261103-03"}   # horas inferidas del GOES: sólo nivel episodio
BBOX = (-66.0, -57.0, -37.0, -29.0)               # W, E, S, N (la misma caja del recorte)

def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()

eps = list(csv.DictReader(open(EPIS, encoding="utf-8-sig")))
cat = list(csv.DictReader(open(CATA, encoding="utf-8-sig")))
filas = []
for e in eps:
    ep, tipo = e["episodio"], e["tipo"]
    if tipo == "confirmado":
        listados = set(e["eventos_o_horas"].split())
        for r in cat:
            if r["etiqueta"] != "confirmado" or r["episodio"] != ep or r["nivel"] == "semana":
                continue
            lat, lon = float(r["lat"]), float(r["lon"])
            if not (BBOX[0] <= lon <= BBOX[1] and BBOX[2] <= lat <= BBOX[3]):
                continue
            inc = float(r["incertidumbre_h"] or 99)
            usa_hora = (r["nivel"] in ("celda-hora", "difuso") and inc <= 1.0 and r["id_evento"] not in CIRCULARES)
            filas.append(dict(episodio=ep, tipo="granizo", id=r["id_evento"],
                              de_la_lista="si" if r["id_evento"] in listados else "no",
                              region=r["region"], nivel=r["nivel"], lat=lat, lon=lon,
                              hora_utc=r["fecha_hora_utc"], incertidumbre_h=inc,
                              usa_hora="si" if usa_hora else "no", celda=r["celda"], horas_ausencia=""))
    else:
        # control: estaciones con ausencia observada de confianza alta y tormenta en la estación
        por_est = {}
        for r in cat:
            if (r["etiqueta"] == "ausencia observada" and r["episodio"] == ep and r["uso_far"] == "alta"
                    and "tormenta en la estaci" in r["evidencia"]):
                k = r["localidad"]
                d = por_est.setdefault(k, dict(lat=float(r["lat"]), lon=float(r["lon"]), celda=r["celda"], region=r["region"], horas=[]))
                d["horas"].append(r["hora_ini_utc"])
        for k, d in sorted(por_est.items()):
            filas.append(dict(episodio=ep, tipo="ausencia", id="A-%s-%s" % (ep.replace("-", ""), d["celda"]),
                              de_la_lista="si", region=d["region"], nivel="celda-hora", lat=d["lat"], lon=d["lon"],
                              hora_utc="", incertidumbre_h="", usa_hora="no", celda=d["celda"],
                              horas_ausencia=" ".join(sorted(d["horas"]))))
cols = ["episodio", "tipo", "id", "de_la_lista", "region", "nivel", "lat", "lon", "hora_utc",
        "incertidumbre_h", "usa_hora", "celda", "horas_ausencia"]
with open(OUT, "w", newline="", encoding="utf-8") as f:
    f.write("# lista sellada sha256=%s ; catalogo sha256=%s\n" % (sha(EPIS), sha(CATA)))
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(filas)
print(len(filas), "puntos en", len(eps), "episodios")
