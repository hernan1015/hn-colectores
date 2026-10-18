#!/usr/bin/env python3
# HN AGRO · nivel de lagunas del Salado y del noroeste bonaerense medido por SWOT (NASA/CNES) · 14/10/2026 (uso interno)
# SWOT existe desde 2023 (no hay nada antes). Hydrocron (PO.DAAC) devuelve la serie ENTERA de cada laguna en un
# pedido chico, sin token: no hace falta bajar los LakeSP de ~30 MB por pasada.
# Códigos de la base de lagunas de SWOT (PLD), encontrados el 14/10/2026 bajando las pasadas 354, 326 y 061.
# Se queda sólo quality_f = 0 (buena); el área casi no cambia en lagunas llenas: la señal útil es el NIVEL (wse, m).
# Guarda la tabla completa en el release fijo «swot-lagunas» (lagunas_swot.csv, se reemplaza cada semana).
import os, sys, io, csv, json, time, subprocess, tempfile, urllib.request, urllib.parse, datetime as dt
LAGUNAS = {
    '6510003382': 'Epecuén', '6510021122': 'del Venado', '6510021112': 'del Monte', '6510021102': 'Cochicó',
    '6510008722': 'Alsina', '6510185012': 'de Gómez (Junín)', '6510228822': 'Mar Chiquita (Junín)',
    '6510091032': 'La Picasa',
}
UA = 'HN-AGRO (contacto: info@hninge.com)'
CAMPOS = 'lake_id,time_str,wse,wse_u,area_total,quality_f,partial_f,dark_frac'
hasta = (dt.date.today() + dt.timedelta(days=1)).isoformat()
filas, resumen, fallas = [], [], 0
for lid, nombre in LAGUNAS.items():
    q = urllib.parse.urlencode({'feature': 'PriorLake', 'feature_id': lid, 'start_time': '2023-01-01T00:00:00Z',
                                'end_time': hasta + 'T00:00:00Z', 'output': 'csv', 'fields': CAMPOS})
    try:
        j = json.load(urllib.request.urlopen(urllib.request.Request(
            'https://soto.podaac.earthdatacloud.nasa.gov/hydrocron/v1/timeseries?' + q, headers={'User-Agent': UA}), timeout=300))
        vistos, buenas = set(), []
        for r in csv.DictReader(io.StringIO(j['results']['csv'])):
            if r['time_str'] in vistos or r['time_str'] in ('', 'no_data'): continue
            vistos.add(r['time_str'])
            try: wse = float(r['wse'])
            except ValueError: continue
            if wse < -1e9: continue
            r['laguna'] = nombre; filas.append(r)
            if r['quality_f'] == '0': buenas.append((r['time_str'], wse))
        buenas.sort()
        if buenas:
            ult = buenas[-1]; hace = [w for t, w in buenas if t <= (dt.datetime.fromisoformat(ult[0][:19]) - dt.timedelta(days=60)).isoformat()]
            dif = f'{ult[1] - hace[-1]:+.2f} m en 60 días' if hace else ''
            resumen.append(f'- {nombre}: {len(buenas)} pasadas buenas (los niveles van sólo al repo privado)')   # el registro de un repo público no muestra datos
    except Exception as e:
        fallas += 1; resumen.append(f'- ⚠ {nombre}: {e}')
    time.sleep(2)

os.chdir(tempfile.mkdtemp())
with open('lagunas_swot.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=['laguna'] + CAMPOS.split(','), extrasaction='ignore'); w.writeheader(); w.writerows(filas)
gh = lambda *a: subprocess.run(['gh', *a], capture_output=True, text=True)
if gh('release', 'view', 'swot-lagunas').returncode:
    gh('release', 'create', 'swot-lagunas', '--title', 'SWOT · nivel de lagunas (Salado y NO bonaerense)', '--notes',
       'Serie completa desde 2023 por Hydrocron (PO.DAAC). Usar quality_f = 0. wse = nivel del agua en metros. Uso interno HN AGRO.')
r = gh('release', 'upload', 'swot-lagunas', 'lagunas_swot.csv', '--clobber')
txt = [f'### SWOT lagunas · {dt.datetime.now(dt.timezone.utc):%d/%m %H:%M} UTC · {len(filas)} pasadas guardadas'] + resumen
print('\n'.join(txt))
if os.environ.get('GITHUB_STEP_SUMMARY'): open(os.environ['GITHUB_STEP_SUMMARY'], 'a').write('\n'.join(txt) + '\n')
if r.returncode or fallas == len(LAGUNAS): sys.exit(1)
