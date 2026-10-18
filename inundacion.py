#!/usr/bin/env python3
# HN AGRO · colector del MAPA DE INUNDACIÓN diario de la NASA (uso interno) · 14/10/2026
# Productos LANCE casi en tiempo real, 250 m, mosaicos de 10° (GeoTIFF de 40-500 KB):
#   MCDWD_L3_F{1,1C,2,3}_NRT (MODIS Terra+Aqua) y VCDWD_L3_F{1,1C,2,3}_NRT (VIIRS NOAA-20/21).
#   F1 = 1 día, F1C = 1 día sin sombras de nubes, F2 = 2 días, F3 = 3 días.
#   Valores: 0 seco · 1 agua de siempre (lagunas, ríos) · 2 anegamiento recurrente · 3 INUNDACIÓN · 255 sin dato.
# ⚠ La NASA guarda sólo ~7 días: lo que no se guarda se pierde. Corre 2 veces por día; cada corrida mira
#   los últimos 8 días y baja lo que falta (una corrida caída se recupera en la siguiente).
# Guarda en un release por MES (inund-AAAA-MM): un .tar por corrida con los .tif nuevos + manifiesto.txt
# con todo lo ya guardado. Necesita el secreto EARTHDATA_TOKEN (cuenta del maker, vence 08/12/2026).
import os, sys, json, time, subprocess, tarfile, tempfile, datetime as dt, urllib.request, urllib.parse
PRODUCTOS = ['MCDWD_L3_F1_NRT', 'MCDWD_L3_F1C_NRT', 'MCDWD_L3_F2_NRT', 'MCDWD_L3_F3_NRT',
             'VCDWD_L3_F1_NRT', 'VCDWD_L3_F1C_NRT', 'VCDWD_L3_F2_NRT', 'VCDWD_L3_F3_NRT']
CAJA = os.environ.get('CAJA', '-74,-56,-53,-21')          # Argentina continental
DIAS = int(os.environ.get('DIAS', '8'))
UA = 'HN-AGRO (contacto: info@hninge.com)'
TK = os.environ.get('EARTHDATA_TOKEN', '').strip()
if not TK: sys.exit('falta EARTHDATA_TOKEN')

def gh(*a, ok=False):
    r = subprocess.run(['gh', *a], capture_output=True, text=True)
    if r.returncode and not ok: sys.exit(f'gh {a[:2]} falló: {r.stderr[:300]}')
    return r

def cmr(prod, desde):
    out, page = [], 1
    while True:
        q = urllib.parse.urlencode({'short_name': prod, 'bounding_box': CAJA, 'temporal[]': desde + 'T00:00:00Z,',
                                    'page_size': 200, 'page_num': page})
        req = urllib.request.Request('https://cmr.earthdata.nasa.gov/search/granules.umm_json?' + q, headers={'User-Agent': UA})
        items = json.load(urllib.request.urlopen(req, timeout=60))['items']
        for it in items:
            u = it['umm']
            url = [r['URL'] for r in u.get('RelatedUrls', []) if r.get('Type') == 'GET DATA' and r['URL'].endswith('.tif')]
            if url: out.append((u['TemporalExtent']['RangeDateTime']['BeginningDateTime'][:10], url[0]))
        if len(items) < 200: return out
        page += 1

hoy = dt.date.today(); desde = (hoy - dt.timedelta(days=DIAS)).isoformat()
trabajo = tempfile.mkdtemp(); os.chdir(trabajo)
granulos = []
for p in PRODUCTOS:
    try: granulos += cmr(p, desde)
    except Exception as e: print(f'⚠ catálogo {p}: {e}')
    time.sleep(0.5)

# manifiestos de los meses tocados
meses = sorted({f[:7] for f, _ in granulos}); ya = {}
for m in meses:
    os.makedirs(f'man/{m}', exist_ok=True); p = f'man/{m}/manifiesto.txt'
    if gh('release', 'download', f'inund-{m}', '-p', 'manifiesto.txt', '-D', f'man/{m}', '--clobber', ok=True).returncode: open(p, 'w').close()
    ya[m] = set(open(p).read().split())

nuevos, fallas = {}, 0
for fecha, url in granulos:
    m = fecha[:7]; nombre = url.rsplit('/', 1)[1]
    if nombre in ya[m]: continue
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Authorization': f'Bearer {TK}'})
        datos = urllib.request.urlopen(req, timeout=120).read()
        if len(datos) < 1000: raise ValueError(f'{len(datos)} bytes')
        open(nombre, 'wb').write(datos); nuevos.setdefault(m, []).append(nombre)
    except Exception as e:
        fallas += 1; print(f'⚠ {nombre}: {e}')
        if '401' in str(e) or '403' in str(e): sys.exit('Earthdata rechazó el token: renovarlo (secreto EARTHDATA_TOKEN).')
    time.sleep(0.4)

for m, lista in nuevos.items():
    tag = f'inund-{m}'
    if gh('release', 'view', tag, ok=True).returncode:
        gh('release', 'create', tag, '--title', f'Inundación NASA (MODIS+VIIRS 250 m) · {m}', '--notes',
           'Mapas diarios de inundación LANCE NRT (MCDWD/VCDWD F1, F1C, F2, F3) sobre Argentina. 0 seco · 1 agua de siempre · 2 recurrente · 3 inundación · 255 sin dato. Uso interno HN AGRO.')
    lote = f'lote_{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M}Z_{os.environ.get("GITHUB_RUN_ID", "local")}.tar'
    with tarfile.open(lote, 'w') as t:
        for n in lista: t.add(n)
    with open(f'man/{m}/manifiesto.txt', 'w') as f: f.write('\n'.join(sorted(ya[m] | set(lista))) + '\n')
    gh('release', 'upload', tag, lote); gh('release', 'upload', tag, f'man/{m}/manifiesto.txt', '--clobber')
    print(f'subido {tag}: {lote} ({len(lista)} archivos; el mes lleva {len(ya[m]) + len(lista)})')

res = [f'### Inundación NASA · {dt.datetime.now(dt.timezone.utc):%d/%m %H:%M} UTC',
       f'- en el catálogo (últimos {DIAS} días): **{len(granulos)}** · nuevos guardados: **{sum(map(len, nuevos.values()))}** · fallas: {fallas}']
print('\n'.join(res))
if os.environ.get('GITHUB_STEP_SUMMARY'): open(os.environ['GITHUB_STEP_SUMMARY'], 'a').write('\n'.join(res) + '\n')
if fallas and not nuevos: sys.exit(1)   # todo falló: que GitHub lo marque en rojo
