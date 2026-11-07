# Junta los resultados de todos los episodios bajados (un directorio por episodio) en tablas del lote.
# Uso: python juntar.py <dir con lc-AAAA-MM-DD/> <salida>
import glob
import json
import os
import sys

import pandas as pd

BASE, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
puntos, ini, res = [], [], []
for d in sorted(glob.glob(os.path.join(BASE, "lc-*"))):
    ep = os.path.basename(d)[3:]
    a = os.path.join(d, "analisis")
    if os.path.exists(os.path.join(a, "puntos.csv")):
        puntos.append(pd.read_csv(os.path.join(a, "puntos.csv")))
    if os.path.exists(os.path.join(a, "iniciaciones_celdas.csv")) and os.path.getsize(os.path.join(a, "iniciaciones_celdas.csv")) > 1:
        x = pd.read_csv(os.path.join(a, "iniciaciones_celdas.csv"))
        x.insert(0, "episodio", ep)
        ini.append(x)
    fila = {"episodio": ep}
    for nombre in ("corrida.json", os.path.join("analisis", "resumen.json")):
        p = os.path.join(d, nombre)
        if os.path.exists(p):
            j = json.load(open(p))
            for k in ("satelite", "paso_min", "barridos_con_prob", "faltantes", "faltantes_por_fuente",
                      "abi_resumen", "glm_resumen", "celdas_con_prob_alta"):
                if k in j:
                    fila[k] = json.dumps(j[k], ensure_ascii=False)
    res.append(fila)
if puntos:
    pd.concat(puntos).to_csv(os.path.join(OUT, "lote_puntos.csv"), index=False)
if ini:
    t = pd.concat(ini)
    t.to_csv(os.path.join(OUT, "lote_iniciaciones_celdas.csv"), index=False)
    filas = []
    for u in (10, 25, 50, 75):
        s = t["anticipo_%d_min" % u].dropna()
        filas.append({"umbral_prob_rayo_pct": u, "iniciaciones": len(t), "con_aviso_antes": len(s),
                      "mediana_min": s.median() if len(s) else None, "p10_min": s.quantile(.1) if len(s) else None,
                      "p90_min": s.quantile(.9) if len(s) else None})
    pd.DataFrame(filas).to_csv(os.path.join(OUT, "lote_iniciaciones_resumen.csv"), index=False)
pd.DataFrame(res).to_csv(os.path.join(OUT, "lote_corridas.csv"), index=False)
print(len(res), "episodios juntados")
