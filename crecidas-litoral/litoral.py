"""HN AGRO · [r79 · 10] TODO EL LITORAL · arma las teselas precocidas de la crecida (una carpeta por fecha) para que subir.mjs las suba.
Ver crecidas-litoral/LEEME.md. Corre en GitHub Actions (el registro es PÚBLICO: sólo cantidades y categorías, nunca un mensaje de error,
una URL firmada ni el token).
Fuentes (sin base de datos: todo público, salvo OPERA que usa EARTHDATA_TOKEN):
  · el calado de cada zona y las cajas de agua vista: los estáticos del sitio ({HN_SITIO}/datos/calado/<zona>.json|.png, /datos/opera/agua-vista.json);
  · las alturas MEDIDAS (30 días, Prefectura vía INA) y el PRONÓSTICO (p50) de cada zona: la function pública del sitio,
    {HN_SITIO}/.netlify/functions/satchi-publico?que=calado&zona=<zona> (la misma que lee SATCHI);
  · el agua vista: OPERA DSWx-S1 (WTR, 30 m) por CMR/Earthdata, con caché en disco (LITORAL_OPERA_CACHE, <GranuleUR>/<archivo>.tif).
Fechas: desde 29 días antes de la última medida hasta el último día en que al menos la mitad de las zonas tiene altura (~44-45 fechas).
SIN CAMBIOS → NO HACE NADA: la firma (alturas y pronósticos de las fechas generadas + gránulos de OPERA + hash de los estáticos + método) se compara con la del índice publicado
({HN_LITORAL_PUBLICO}/indice.json). Igual firma y mismo día → no genera (LITORAL_FORZAR=si lo fuerza). Así se puede disparar seguido barato.
Variables: CRECIDAS_LITORAL_ON (sólo «si»), LITORAL_SALIDA (carpeta de salida), LITORAL_TRABAJO, LITORAL_OPERA_CACHE, EARTHDATA_TOKEN,
HN_SITIO, HN_LITORAL_PUBLICO, LITORAL_FORZAR, LITORAL_ZMAX (11 por defecto).
Uso: python -I litoral.py"""
import datetime, hashlib, json, os, sys, time, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

METODO_V = 'r79c-4'   # sube si cambia el método (marcas, fusión, paleta): obliga a regenerar
ZONAS = ['corrientes', 'bellavista', 'reconquista', 'goya', 'esquina', 'lapaz', 'santotome', 'alvear', 'libres', 'caseros', 'concordia', 'colon', 'cdeluruguay']
CMR = 'https://cmr.earthdata.nasa.gov/search/granules.umm_json?collection_concept_id=C2949811996-POCLOUD&page_size=200'
UA = 'hn-agro-colector-litoral/1'
PAUSA = 1.0


def log(m):
    print('crecidas-litoral: ' + m, flush=True)


def pedir(url, headers=None, timeout=90):
    q = urllib.request.Request(url, headers=dict({'User-Agent': UA}, **(headers or {})))
    with urllib.request.urlopen(q, timeout=timeout) as r:
        return r.read()


def alturas_de(j):
    """la respuesta de satchi-publico?que=calado → {fecha: {h, tipo}} (medido; pronóstico p50 sólo después de la última medida)"""
    out = {}; ult = None
    for x in (j or {}).get('medido') or []:
        f = str(x.get('fecha', ''))[:10]; h = x.get('h')
        if len(f) == 10 and isinstance(h, (int, float)):
            out[f] = {'h': float(h), 'tipo': 'medido'}; ult = f if (ult is None or f > ult) else ult
    for x in (((j or {}).get('pronostico') or {}).get('dias') or []):
        f = str(x.get('fecha', ''))[:10]; h = x.get('p50')
        if len(f) == 10 and isinstance(h, (int, float)) and (ult is None or f > ult):
            out[f] = {'h': float(h), 'tipo': 'pronostico'}
    return out


def fechas_de(alt):
    """desde 29 días antes de la última medida (de cualquier zona) hasta el último día con dato"""
    med = [f for a in alt.values() for f, x in a.items() if x['tipo'] == 'medido']
    todas = sorted({f for a in alt.values() for f in a})
    if not med or not todas: return []
    ult = max(med); d0 = (datetime.date.fromisoformat(ult) - datetime.timedelta(days=29)).isoformat()
    # el final: el último día en que al menos la mitad de las zonas tiene altura (un puerto con 31 días de pronóstico no estira el
    # Litoral a fechas donde casi todo iría rayado «sin dato»)
    n = len(alt); fin = max([f for f in todas if sum(1 for a in alt.values() if f in a) * 2 >= n] or [ult])
    return [f for f in todas if d0 <= f <= fin]


def firma_de(alt, fechas, granulos=(), estaticos=''):
    """[Codex n3-litoral-colector] la firma: el método, las fechas, las alturas SÓLO de esas fechas, los gránulos de OPERA de la ventana y el
    hash de los estáticos (calado + cajas de agua vista). Cualquiera que cambie obliga a regenerar; nada más."""
    fs_ = set(fechas)
    a = {z: {f: x for f, x in alt[z].items() if f in fs_} for z in sorted(alt)}
    b = json.dumps({'m': METODO_V, 'f': fechas, 'a': a, 'o': sorted(granulos), 'e': estaticos}, sort_keys=True).encode()
    return hashlib.sha256(b).hexdigest()


def cmr_granulos(caja, desde, hasta, pedir_=pedir):
    w, s, e, n = caja
    u = CMR + f'&bounding_box={w},{s},{e},{n}&temporal={desde}T00:00:00Z,{hasta}T23:59:59Z'
    out = {}
    for g in json.loads(pedir_(u))['items']:
        ur = g['umm'].get('GranuleUR')
        urls = [x['URL'] for x in g['umm'].get('RelatedUrls', []) if str(x.get('URL', '')).startswith('https') and x['URL'].endswith('_B01_WTR.tif')]
        if ur and urls: out[ur] = urls[0]
    return out


class _SinRedireccion(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


def bajar_wtr(url, destino, token):
    q = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'User-Agent': UA})
    loc = None
    try:
        urllib.request.build_opener(_SinRedireccion).open(q, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307): loc = e.headers['Location']
        else: raise
    with urllib.request.urlopen(loc if loc else q, timeout=180) as r:
        b = r.read()
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    with open(destino + '.part', 'wb') as o: o.write(b)
    os.replace(destino + '.part', destino)


def listar_opera(cajas, desde, hasta, pedir_=pedir):
    """sólo la lista de gránulos (CMR): barata, entra en la firma antes de bajar nada → ({granulo: url}, fallas)"""
    gr = {}; fallas = 0
    for c in cajas:
        try: gr.update(cmr_granulos(c, desde, hasta, pedir_))
        except Exception: fallas += 1
        time.sleep(PAUSA)
    return gr, fallas


def indice_opera(gr, cache, token, fallas=0, bajar=bajar_wtr):
    """los WTR de la lista, bajados a la caché (lo que ya está no se baja) → {granulo: {fecha, archivo, bbox}}"""
    import rasterio
    from rasterio.warp import transform_bounds
    nuevos = 0; ind = {}
    for ur, url in sorted(gr.items()):
        f = os.path.join(cache, ur, os.path.basename(url))
        if not os.path.exists(f):
            try: bajar(url, f, token); nuevos += 1; time.sleep(PAUSA)
            except Exception: fallas += 1; continue
        try:
            with rasterio.open(f) as r: bb = [round(v, 4) for v in transform_bounds(r.crs, 'EPSG:4326', *r.bounds)]
        except Exception: fallas += 1; continue
        p = ur.split('_')
        ind[ur] = {'fecha': p[4][:8], 'archivo': f, 'bbox': bb}
    log(f'opera: {len(gr)} gránulos en la ventana · {nuevos} bajados · {len(ind)} usables · {fallas} fallas')
    return ind


def main(env=os.environ):
    if env.get('CRECIDAS_LITORAL_ON') != 'si':
        log('llave apagada, nada que hacer'); return 0
    import precocer as P
    sitio = env.get('HN_SITIO', 'https://app.hnagroapp.com').rstrip('/')
    publico = env.get('HN_LITORAL_PUBLICO', 'https://pub-2c436586c4cc4b728b64d0f6c5337b0b.r2.dev/crecidas-litoral').rstrip('/')
    trabajo = env.get('LITORAL_TRABAJO') or os.path.join(os.getcwd(), '_trabajo_litoral'); salida = env.get('LITORAL_SALIDA')
    cache = env.get('LITORAL_OPERA_CACHE') or os.path.join(trabajo, 'opera')
    if not salida: log('falló (error:interno) · falta LITORAL_SALIDA'); return 1
    t0 = time.time()
    try:
        cal = os.path.join(trabajo, 'calado'); os.makedirs(cal, exist_ok=True)
        for z in ZONAS:
            for ext in ('json', 'png'):
                with open(os.path.join(cal, z + '.' + ext), 'wb') as o: o.write(pedir(f'{sitio}/datos/calado/{z}.{ext}'))
        av = os.path.join(trabajo, 'agua-vista.json')
        with open(av, 'wb') as o: o.write(pedir(f'{sitio}/datos/opera/agua-vista.json'))
        alt = {}; sin = 0
        for z in ZONAS:
            try: alt[z] = alturas_de(json.loads(pedir(f'{sitio}/.netlify/functions/satchi-publico?que=calado&zona={z}')))
            except Exception: alt[z] = {}; sin += 1
            time.sleep(PAUSA)
        fechas = fechas_de(alt)
        if not fechas: log('falló (error:fuente) · sin alturas'); return 1
        h = hashlib.sha256()
        for z in ZONAS:
            for ext in ('json', 'png'):
                with open(os.path.join(cal, z + '.' + ext), 'rb') as fh: h.update(fh.read())
        with open(av, 'rb') as fh: h.update(fh.read())
        estaticos = h.hexdigest()
        log(f'alturas: {len(ZONAS) - sin} zonas · {len(fechas)} fechas ({sum(1 for f in fechas if any((alt[z].get(f) or {}).get("tipo") == "pronostico" for z in alt))} con pronóstico)')
        hoy = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        # las cajas: zonas, cajas de agua vista (ampliadas) y tramos del río entre zonas, como precocer.py
        Zm = {z: {'meta': json.load(open(os.path.join(cal, z + '.json'), encoding='utf-8'))} for z in ZONAS}
        cajas = [(m['meta']['oeste'], m['meta']['sur'], m['meta']['este'], m['meta']['norte']) for m in Zm.values()]
        cajas += [P.ampliar(c['caja']) for c in json.load(open(av, encoding='utf-8'))['zonas'].values()]
        cajas += list(P.corredores(Zm).values())
        desde = (datetime.date.fromisoformat(fechas[0]) - datetime.timedelta(days=P.OPERA_DIAS)).isoformat()
        token = env.get('EARTHDATA_TOKEN', '')
        ind = None; gr = {}; fallas = 0
        if env.get('LITORAL_OPERA_INDICE'):   # pruebas en seco: un índice de una caché ya bajada (no pide nada a NASA)
            ind = json.load(open(env['LITORAL_OPERA_INDICE'], encoding='utf-8')); granulos = list(ind)
        elif token:
            gr, fallas = listar_opera(cajas, desde, hoy); granulos = list(gr)
        else:
            ind = {}; granulos = []; log('opera: sin EARTHDATA_TOKEN: la meseta y el pico no se pintan (regla c)')
        firma = firma_de(alt, fechas, granulos, estaticos)
        if env.get('LITORAL_FORZAR') != 'si':
            try:
                pub = json.loads(pedir(publico + '/indice.json', timeout=30))
                if pub.get('firma') == firma and str(pub.get('generado', ''))[:10] == hoy:
                    log('sin cambios (misma firma hoy): no se genera'); return 0
            except Exception:
                pass   # sin índice publicado (primera vez) o no se pudo leer: se genera
        if ind is None:
            ind = indice_opera(gr, cache, token, fallas)
        os.makedirs(salida, exist_ok=True)
        P.precocer(alt, ind, fechas, salida, zmin=6, zmax=int(env.get('LITORAL_ZMAX', '11')), zonas=ZONAS, calado_dir=cal, agua_vista=av,
                   log=log, extra={'firma': firma, 'metodo': METODO_V})
        log(f'listo en {time.time() - t0:.0f} s')
        return 0
    except urllib.error.HTTPError as e:
        log(f'falló (error:fuente http {int(e.code)})'); return 1
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        log('falló (error:red)'); return 1
    except Exception:
        log('falló (error:interno)'); return 1


if __name__ == '__main__':
    sys.exit(main())
