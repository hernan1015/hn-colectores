# Arma la matriz de episodios del workflow a partir del input (lista separada por comas o "todos").
# Sólo acepta episodios de la lista sellada (episodios_lote.csv). Escribe "matriz=[...]" para GITHUB_OUTPUT.
import csv
import json
import os
import re
import sys

entrada = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
aqui = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(aqui, "episodios_lote.csv"), encoding="utf-8") as f:
    validos = sorted({r["episodio"] for r in csv.DictReader(l for l in f if not l.startswith("#"))})
if entrada in ("todos", "*"):
    pedidos = validos
else:
    pedidos = [e.strip() for e in entrada.split(",") if e.strip()]
    malos = [e for e in pedidos if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", e) or e not in validos]
    if malos or not pedidos:
        sys.exit("episodios fuera de la lista sellada o mal escritos: %s" % (malos or "(vacío)"))
print("matriz=" + json.dumps(sorted(set(pedidos))))
