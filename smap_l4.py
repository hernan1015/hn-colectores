#!/usr/bin/env python3
# HN AGRO · colector de SMAP L4 (humedad del suelo del perfil, NASA) para toda Argentina · 14/10/2026 (uso interno)
# SPL4SMGP v8 (NSIDC, C3480440870-NSIDC_CPRD): modelo GEOS-5 + SMAP, grilla EASE-2 de 9 km, cada 3 h, ~2-3 días
# de atraso, desde 31/03/2015. Se guarda UNA foto por día: la de las 13:30 UTC (promedio 12-15 UTC = 9-12 ART).
# Recorte de Argentina en la grilla EASE-2 9 km: filas 1103..1479, columnas 1135..1354 (377 × 220 = 82.940 celdas;
# lat −21…−55,2 · lon −74…−53,5; ejes medidos del archivo el 14/10/2026). Un pedido OPeNDAP por variable (~2 s);
# pedir varias juntas da 500.
# Variables (m³/m³ salvo indicación):
#   sm_surface (0-5 cm) · sm_rootzone (0-100 cm) · sm_profile (todo el perfil) · sm_rootzone_pctl (percentil, %)
#   land_fraction_saturated (fracción de suelo saturado, 0-1)
#   land_evapotranspiration_flux (kg m⁻² s⁻¹) · soil_temp_layer1 (K, capa superficial)
# Guarda en un release por mes (smap-AAAA-MM): un .npz por día (float32 comprimido) + manifiesto.txt.
# Uso en GitHub: diario (mira los últimos DIAS días). Relleno: DESDE=AAAA-MM-DD HASTA=AAAA-MM-DD FINAL=AAAA-MM-DD:
# al terminar (o al cortar por tiempo) lanza solo el tramo siguiente hasta llegar a FINAL (de a un pedido por vez).
import os, sys, json, time, subprocess, tempfile, io, datetime as dt, urllib.request, urllib.parse
import numpy as np, netCDF4
COL = 'C3480440870-NSIDC_CPRD'
F0, F1, C0, C1 = 1103, 1479, 1135, 1354
VARS = ['sm_surface', 'sm_rootzone', 'sm_profile', 'sm_rootzone_pctl',
        'land_fraction_saturated', 'land_evapotranspiration_flux', 'soil_temp_layer1']
# (depth_to_water_table_from_surface se probó el 14/10: vacía en toda Argentina, sólo existe en turberas)
UA = 'HN-AGRO (contacto: info@hninge.com)'
TK = os.environ.get('EARTHDATA_TOKEN', '').strip()
if not TK: sys.exit('falta EARTHDATA_TOKEN')
H = {'User-Agent': UA, 'Authorization': f'Bearer {TK}'}
hoy = dt.date.today()
desde = dt.date.fromisoformat(os.environ['DESDE']) if os.environ.get('DESDE') else hoy - dt.timedelta(days=int(os.environ.get('DIAS', '10')))
hasta = dt.date.fromisoformat(os.environ['HASTA']) if os.environ.get('HASTA') else hoy
LIMITE_S = int(os.environ.get('LIMITE_S', str(5 * 3600)))   # cortar antes de las 6 h de GitHub
t0 = time.time()

def gh(*a, ok=False):
    r = subprocess.run(['gh', *a], capture_output=True, text=True)
    if r.returncode and not ok: sys.exit(f'gh {a[:2]} falló: {r.stderr[:300]}')
    return r

def get(url, timeout=120, intentos=4):
    for k in range(intentos):
        try: return urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=timeout).read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403): sys.exit('Earthdata rechazó el token: renovar el secreto EARTHDATA_TOKEN.')
            if k == intentos - 1: raise
        except Exception:
            if k == intentos - 1: raise
        time.sleep(5 * (k + 1))

def granulo_del_dia(d):
    q = urllib.parse.urlencode({'collection_concept_id': COL, 'temporal[]': f'{d}T12:00:00Z,{d}T15:00:00Z', 'page_size': 5})
    for it in json.loads(get('https://cmr.earthdata.nasa.gov/search/granules.umm_json?' + q))['items']:
        ur = it['umm']['GranuleUR']
        if f'_{d:%Y%m%d}T133000_' in ur:
            return ur, [r['URL'] for r in it['umm']['RelatedUrls'] if 'opendap' in r['URL']][0]
    return None, None

# manifiestos de los meses del rango
meses = sorted({(desde + dt.timedelta(days=k)).strftime('%Y-%m') for k in range((hasta - desde).days + 1)})
trabajo = tempfile.mkdtemp(); os.chdir(trabajo); ya = {}
for m in meses:
    os.makedirs(f'man/{m}', exist_ok=True); p = f'man/{m}/manifiesto.txt'
    if gh('release', 'download', f'smap-{m}', '-p', 'manifiesto.txt', '-D', f'man/{m}', '--clobber', ok=True).returncode: open(p, 'w').close()
    ya[m] = set(open(p).read().split())

nuevos, sin_dato, fallas, d, cortado = {}, 0, 0, desde, False
while d <= hasta:
    if time.time() - t0 > LIMITE_S: print(f'⏱ corte por tiempo en {d}: sigue el tramo siguiente'); cortado = True; break
    m = d.strftime('%Y-%m'); nombre = f'smap_l4_{d:%Y%m%d}.npz'
    if nombre in ya[m]: d += dt.timedelta(days=1); continue
    try:
        ur, url = granulo_del_dia(d)
        if not url: sin_dato += 1; d += dt.timedelta(days=1); continue
        out = {}
        for v in VARS:
            ce = urllib.parse.quote(f'/Geophysical_Data/{v}[{F0}:1:{F1}][{C0}:1:{C1}]', safe='/:')
            ds = netCDF4.Dataset('x', memory=get(f'{url}.dap.nc4?dap4.ce={ce}'))
            a = ds[f'Geophysical_Data/{v}'][:]; out[v] = np.ma.filled(a.astype(np.float32), np.nan); ds.close()
            time.sleep(0.5)
        np.savez_compressed(nombre, granulo=ur, filas=[F0, F1], columnas=[C0, C1], **out)
        nuevos.setdefault(m, []).append(nombre)
    except SystemExit: raise
    except Exception as e:
        fallas += 1; print(f'⚠ {d}: {e}')
    d += dt.timedelta(days=1)

for m, lista in nuevos.items():
    tag = f'smap-{m}'
    if gh('release', 'view', tag, ok=True).returncode:
        gh('release', 'create', tag, '--title', f'SMAP L4 humedad del suelo · Argentina · {m}', '--notes',
           'SPL4SMGP v8 (NASA), EASE-2 9 km, foto diaria 13:30 UTC, recorte filas 1103-1479 / columnas 1135-1354. '
           'Variables: ' + ', '.join(VARS) + '. Uso interno HN AGRO.')
    for n in lista: gh('release', 'upload', tag, n, '--clobber')
    with open(f'man/{m}/manifiesto.txt', 'w') as f: f.write('\n'.join(sorted(ya[m] | set(lista))) + '\n')
    gh('release', 'upload', tag, f'man/{m}/manifiesto.txt', '--clobber')
    print(f'subido {tag}: {len(lista)} días (el mes lleva {len(ya[m]) + len(lista)})')

res = [f'### SMAP L4 · {dt.datetime.now(dt.timezone.utc):%d/%m %H:%M} UTC · {desde} → {hasta}',
       f'- días nuevos: **{sum(map(len, nuevos.values()))}** · todavía sin publicar: {sin_dato} · fallas: {fallas} · {time.time() - t0:.0f} s']
print('\n'.join(res))
if os.environ.get('GITHUB_STEP_SUMMARY'): open(os.environ['GITHUB_STEP_SUMMARY'], 'a').write('\n'.join(res) + '\n')
FINAL = os.environ.get('FINAL', '').strip()
if FINAL:
    sig = d if cortado else hasta + dt.timedelta(days=1)
    fin = dt.date.fromisoformat(FINAL)
    if sig <= fin:
        h2 = min(sig + dt.timedelta(days=700), fin)
        # el tramo siguiente corre en ESTE repo (público, hn-colectores) con su propio permiso, no en hn-radar (privado: sólo guarda)
        env2 = {**os.environ, 'GH_TOKEN': os.environ.get('COLECTOR_TOKEN') or os.environ.get('GH_TOKEN', ''), 'GH_REPO': os.environ.get('COLECTOR_REPO') or os.environ.get('GH_REPO', '')}
        r2 = subprocess.run(['gh', 'workflow', 'run', 'colector-smap', '-f', f'desde={sig}', '-f', f'hasta={h2}', '-f', f'final={fin}'], capture_output=True, text=True, env=env2)
        if r2.returncode: sys.exit(f'no pude lanzar el tramo siguiente: {r2.stderr[:300]}')
        print(f'➡ lanzado el tramo siguiente: {sig} → {h2} (final {fin})')
    else: print('✅ relleno completo hasta', fin)
if fallas and not nuevos: sys.exit(1)
