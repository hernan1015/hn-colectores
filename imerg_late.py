#!/usr/bin/env python3
"""
HN AGRO · colector diario de IMERG-Late (lluvia satelital de NASA, toda Argentina) · 21/10/2026
──────────────────────────────────────────────────────────────────────────────
Movido desde el repo privado de la app (tools/imerg/diario_late.py) para que la BAJADA corra acá, sin gastar minutos.
Este colector NO toca la base ni lee nada de clientes: baja la grilla de TODO el país (celdas de 0,1°, ~67.000) y la
guarda en el repo privado (release por mes «imerg-late-AAAA-MM»: un .csv.gz por día + manifiesto.txt).
La carga en la base (sólo las celdas que la app necesita) la hace la app desde ese release.
Los registros muestran sólo cantidades del país (celdas, cuántas con lluvia, máximo).

env: EARTHDATA_TOKEN · GH_TOKEN (permiso sólo para escribir en el repo privado) · GH_REPO · DESDE / HASTA (opcionales)
"""
import os, re, gzip, subprocess, datetime as dt
import requests

CID = 'C2723754859-GES_DISC'                       # IMERG-Late diario v07
CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json'
I0, I1, J0, J1 = 1063, 1264, 349, 682              # caja de Argentina en índices de la grilla IMERG (0,1°)


class Sesion(requests.Session):
    """Conserva el token sólo entre servidores de NASA (OPeNDAP redirige dentro de earthdata.nasa.gov)."""
    def rebuild_auth(self, prep, resp):
        host = requests.utils.urlparse(prep.url).hostname or ''
        if not (host.endswith('earthdata.nasa.gov') or host.endswith('eosdis.nasa.gov')):
            prep.headers.pop('Authorization', None)


def url_opendap(dia):
    r = requests.get(CMR, params={'collection_concept_id': CID, 'page_size': 5,
                                  'temporal': f'{dia}T00:00:00Z,{dia}T23:59:59Z'}, timeout=60)
    r.raise_for_status()
    for g in r.json()['feed']['entry']:
        if g.get('time_start', '')[:10] != dia:
            continue
        for l in g.get('links', []):
            if 'opendap.earthdata.nasa.gov' in l.get('href', ''):
                return l['href'].replace('.html', '')
    return None


def parsear(txt):
    m = re.search(r'^precipitation\.lat, (.*)$', txt, re.M)
    if not m:
        raise RuntimeError('respuesta OPeNDAP sin latitudes')
    lats = [round(float(x), 2) for x in m.group(1).split(', ')]
    out = {}
    for fila in re.finditer(r'\[precipitation\.lon=(-?[\d.]+)\], (.*)$', txt, re.M):
        lon = round(float(fila.group(1)), 2)
        for lat, v in zip(lats, fila.group(2).split(', ')):
            mm = float(v)
            if mm >= 0:                                 # relleno (−9999,9) y negativos: sin dato, NO 0
                out[(lat, lon)] = round(mm, 3)
    return out


def gh(*args, ok=False):
    r = subprocess.run(['gh', *args], capture_output=True, text=True)
    if r.returncode and not ok:
        raise SystemExit('gh falló: ' + ' '.join(args[:2]))
    return r


def main():
    tk = os.environ.get('EARTHDATA_TOKEN', '').strip()
    if not tk:
        raise SystemExit('falta EARTHDATA_TOKEN')
    ayer = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).date()
    d = dt.date.fromisoformat(os.environ.get('DESDE') or str(ayer - dt.timedelta(days=4)))
    fin = dt.date.fromisoformat(os.environ.get('HASTA') or str(ayer))
    s = Sesion()
    s.headers['Authorization'] = 'Bearer ' + tk
    ya = {}
    while d <= fin:
        dia, mes = str(d), str(d)[:7]
        tag = f'imerg-late-{mes}'
        if mes not in ya:
            os.makedirs(f'man/{mes}', exist_ok=True)
            if gh('release', 'download', tag, '-p', 'manifiesto.txt', '-D', f'man/{mes}', '--clobber', ok=True).returncode:
                open(f'man/{mes}/manifiesto.txt', 'w').close()
            ya[mes] = set(open(f'man/{mes}/manifiesto.txt').read().split())
        nombre = f'imerg_late_AR_{dia.replace("-", "")}.csv.gz'
        if nombre in ya[mes]:
            print(f'{dia}: ya guardado')
            d += dt.timedelta(days=1)
            continue
        base = url_opendap(dia)
        if not base:
            print(f'{dia}: todavía no publicado')
            d += dt.timedelta(days=1)
            continue
        r = s.get(f'{base}.ascii?precipitation[0][{I0}:{I1}][{J0}:{J1}]', timeout=180)
        if r.status_code == 401 or 'Earthdata Login' in r.text[:2000]:
            raise SystemExit('Earthdata rechazó el token (¿vencido?): renovarlo y actualizar el secreto EARTHDATA_TOKEN.')
        r.raise_for_status()
        grilla = parsear(r.text)
        with gzip.open(nombre, 'wt', encoding='utf-8') as f:
            f.write('lat,lon,mm\n')
            for (lat, lon), mm in sorted(grilla.items()):
                f.write(f'{lat},{lon},{mm}\n')
        if gh('release', 'view', tag, ok=True).returncode:
            gh('release', 'create', tag, '--latest=false', '--title', f'IMERG-Late · Argentina · {mes}',
               '--notes', 'Lluvia satelital diaria (mm/día) de IMERG-Late v07, caja de Argentina, celdas de 0,1°. '
                          'Un .csv.gz por día (lat,lon,mm). Sin dato = celda ausente, nunca 0.')
        gh('release', 'upload', tag, nombre, '--clobber')
        ya[mes].add(nombre)
        with open(f'man/{mes}/manifiesto.txt', 'w') as f:
            f.write('\n'.join(sorted(ya[mes])) + '\n')
        gh('release', 'upload', tag, f'man/{mes}/manifiesto.txt', '--clobber')
        llovio = sum(1 for v in grilla.values() if v >= 1)
        print(f'{dia}: {len(grilla)} celdas del país · {llovio} con ≥1 mm · máx {max(grilla.values()):.1f} mm')
        d += dt.timedelta(days=1)


if __name__ == '__main__':
    main()
