"""[r79 · 10 · _v1850] TODO EL LITORAL: las teselas PRECOCIDAS de la crecida, una carpeta por fecha, para el depósito público de SATCHI.
Pedido del maker (LISTA-del-maker.md, punto 10) y su decisión (c) del 19/11 (canal 2026-11-19_1125).
  {salida}/<AAAA-MM-DD>/<z>/<x>/<y>.png     (Web Mercator, 256 px, z6-z11 por defecto)
  {salida}/indice.json                      ({v:1, z_min, z_max, generado, fechas:[{fecha, tipo, sin_dato, zonas}], marcas, mb})
  En el depósito (hn-colectores, crecidas-litoral/subir.mjs) las fechas van debajo de una VERSIÓN: crecidas-litoral/<version>/<fecha>/…,
  y el índice en crecidas-litoral/indice.json (la página arma la ruta con base + version).
La página (_v1850, «Todo el Litoral») lee el índice y pide las teselas de la fecha del cursor.
[r79 · local 19/11] corre también en GitHub Actions (hn-colectores, crecidas-litoral/): --calado-dir y --agua-vista apuntan a lo bajado
  del sitio; la función precocer(...) se llama desde allá. Esta copia y la de hn-colectores tienen que ser IGUALES (el test de allá lo mira).
CADA ZONA PASA EL MISMO CONTROL ANTES DE PINTARSE (marcas.py, las mismas reglas que la página):
  · el PICO de un solo valor → color fijo «agua vista (sin profundidad)»;
  · la MESETA del techo → sólo el agua que vio OPERA (la última pasada con ≥ 50 % de la caja, hasta 12 días antes de la fecha), color fijo;
  · los BORDES DE DATOS → degradado de ~1 km.
LA FUSIÓN (sin cortes rectos): donde dos cajas se pisan, cada zona pesa por su distancia al borde de SU caja (0 en el borde, 1 desde los
  2 km hacia adentro) y el color se promedia con esos pesos (premultiplicado por el alfa). Las cajas de AGUA VISTA sin modelo
  (datos/opera/agua-vista.json) entran con el color fijo y un peso chico (0,05): mandan sólo donde no hay modelo.
UNA ZONA SIN ALTURA ESE DÍA no se pinta como seca: va en «sin_dato» de esa fecha (la página lo dice).
NO SUBE NADA. Subir es otro paso (como tools/satchi/cog/subir-r2.mjs), con las llaves del entorno, y lo hace local o el trabajo nocturno.
Uso (en seco):
  python -I precocer.py --alturas alturas.json --opera-indice indice-cache.json --fechas 2026-11-12,2026-11-18 --salida <carpeta>
  alturas.json = {zona: {"AAAA-MM-DD": {"h": 6.24, "tipo": "medido"|"pronostico"}}}
  indice-cache.json = {granulo: {fecha:"AAAAMMDD", archivo, bbox:[o,s,e,n]}} (los WTR de OPERA DSWx-S1 ya bajados)
Requiere numpy, pillow, rasterio y scipy."""
import argparse, json, math, os, sys, time, datetime
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from marcas import marcas_de_zona  # noqa: E402

RAIZ = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
CORTES = [0.01, 0.26, 0.51, 0.76, 1, 1.3, 1.5, 1.8, 2, 2.3, 2.5, 2.8]          # = _v865 CORTES_M
COLORES = ['#800000', '#e80000', '#ff5500', '#ffab00', '#ebff0c', '#a0ff56', '#56ffa0', '#0cf4eb', '#0094ff', '#0038ff', '#0000e8', '#000080']
FIJO = (150, 205, 255)
RAYADO = (127, 150, 158)   # [r79 · maker, punto 6] una zona SIN DATO ese día va rayada (nunca seca): el gris de «sin pasada» de SATCHI
RAYADO_ALFA = 0.55                                                           # = _v1850 FIJO
DEGRADE_M = 1000
FUSION_M = 2000
PESO_AGUA_VISTA = 0.05
OPERA_DIAS = 12
OPERA_COB = 0.5


def lut():
    t = np.zeros((300, 3), np.uint8)
    for d in range(1, 300):
        m = d / 100; b = -1
        for k in range(len(CORTES) - 1, -1, -1):
            if m >= CORTES[k] - 1e-9: b = k; break
        if b >= 0: t[d] = [int(COLORES[b][i:i + 2], 16) for i in (1, 3, 5)]
    return t
LUT = lut()


def leer_zona(z, calado_dir=None):
    d = calado_dir or os.path.join(RAIZ, 'datos', 'calado')
    meta = json.load(open(os.path.join(d, z + '.json'), encoding='utf-8'))
    a = np.array(Image.open(os.path.join(d, z + '.png')).convert('RGB')).astype(np.int32)
    return meta, (a[..., 0] * 256 + a[..., 1]).astype(np.int32)


def obs_opera(meta, shape, fecha, indice):
    """el agua abierta (clase 1) de la última pasada con ≥ 50 % de la caja, hasta OPERA_DIAS antes de la fecha → (uint8 0/1, fecha, cob, False).
    [r79 · maker 19/11, (b)] si no hay ninguna en esos días (las fechas de pronóstico lejanas), LA ÚLTIMA PASADA DISPONIBLE anterior, con su
    fecha (el cuarto valor es True: «última pasada dd/mm» en la página). Nunca un tramo vacío que parezca seco por falta de una pasada nueva."""
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    H, W = shape; tr = from_bounds(meta['oeste'], meta['sur'], meta['este'], meta['norte'], W, H)
    f1 = fecha.replace('-', ''); f0 = (datetime.date.fromisoformat(fecha) - datetime.timedelta(days=OPERA_DIAS)).strftime('%Y%m%d')
    por = {}
    for g in indice.values():
        b = g['bbox']
        if g['fecha'] <= f1 and not (b[2] < meta['oeste'] or b[0] > meta['este'] or b[3] < meta['sur'] or b[1] > meta['norte']):
            por.setdefault(g['fecha'], []).append(g['archivo'])
    for f in sorted(por, reverse=True):   # primero las de la ventana (de la más nueva); si ninguna sirve, las anteriores (la última disponible)
        mos = np.full((H, W), 255, np.uint8)
        for t in por[f]:
            with rasterio.open(t) as s:
                tmp = np.full((H, W), 255, np.uint8)
                reproject(rasterio.band(s, 1), tmp, dst_transform=tr, dst_crs='EPSG:4326', resampling=Resampling.nearest, dst_nodata=255)
            tmp = np.where(np.isin(tmp, (0, 1, 3)), tmp, 255); ll = (mos == 255) | ((tmp == 1) & (mos != 1)); ll &= tmp != 255; mos[ll] = tmp[ll]
        cob = float((mos != 255).mean())
        if cob >= OPERA_COB:
            return (mos == 1).astype(np.uint8), f[:4] + '-' + f[4:6] + '-' + f[6:], round(100 * cob, 1), f < f0
    return None, None, None, False


def factor_borde(meta, U, bordes):
    H, W = U.shape; px, py = meta['pixel_m']
    fx, fy = max(1, round(DEGRADE_M / px)), max(1, round(DEGRADE_M / py))
    f = np.ones((H, W), np.float32)
    x = np.arange(W)[None, :]; y = np.arange(H)[:, None]
    if 'oeste' in bordes: f = np.minimum(f, np.clip(x / fx, 0, 1))
    if 'este' in bordes: f = np.minimum(f, np.clip((W - 1 - x) / fx, 0, 1))
    if 'norte' in bordes: f = np.minimum(f, np.clip(y / fy, 0, 1))
    if 'sur' in bordes: f = np.minimum(f, np.clip((H - 1 - y) / fy, 0, 1))
    return f


def peso_fusion(meta, H, W):
    px, py = meta['pixel_m']
    x = np.arange(W)[None, :] * px; y = np.arange(H)[:, None] * py
    d = np.minimum(np.minimum(x, (W - 1) * px - x), np.minimum(y, (H - 1) * py - y))
    return np.clip(d / FUSION_M, 0.02, 1).astype(np.float32)


RIOS = {'parana': ['corrientes', 'bellavista', 'reconquista', 'goya', 'esquina', 'lapaz'],
        'uruguay': ['santotome', 'alvear', 'libres', 'caseros', 'concordia', 'colon', 'cdeluruguay']}


SOLAPE_G = 0.02      # ~2 km: el tramo se mete en las zonas vecinas y la fusión hace la costura (sin hueco ni corte)
AMPLIAR_AV_G = 0.15  # las cajas de agua vista se amplían: el borde lo da el agua unida al río, no el rectángulo


def ampliar(c):
    return (c[0] - AMPLIAR_AV_G, c[1] - AMPLIAR_AV_G, c[2] + AMPLIAR_AV_G, c[3] + AMPLIAR_AV_G)


def corredores(Z):
    """los tramos del río ENTRE dos zonas con modelo (de norte a sur): una caja que cubre el hueco, para el agua vista en color fijo"""
    out = {}
    for rio, lista in RIOS.items():
        zs = [z for z in lista if z in Z]
        for a, b in zip(zs, zs[1:]):
            A, B = Z[a]['meta'], Z[b]['meta']
            if A['sur'] > B['norte'] + 1e-6:
                out['tramo:' + a + '-' + b] = (min(A['oeste'], B['oeste']), B['norte'] - SOLAPE_G, max(A['este'], B['este']), A['sur'] + SOLAPE_G)
    return out


MIN_CUERPO_PX = 1000   # ~2,7 km² con el píxel de 0,00054° (~52 m)


def unida_al_rio(obs):
    from scipy import ndimage
    lab, n = ndimage.label(ndimage.binary_dilation(obs == 1, iterations=1), structure=np.ones((3, 3)))
    if n == 0: return obs
    tam = np.bincount(lab.ravel()); tam[0] = 0
    grandes = np.where(tam >= MIN_CUERPO_PX)[0]   # los cuerpos de agua grandes (el río y su planicie); los charcos sueltos, afuera
    return (np.isin(lab, grandes) & (obs == 1)).astype(np.uint8)


def pintar_zona(U, marca, hcm, obs, fb):
    """RGBA float (0-1 alfa) + máscara del color fijo de una zona a una altura: paleta de La Paz; pico y meseta SÓLO con agua de OPERA, en el
    color fijo (como la página: sin OPERA, vacío); degradado del borde"""
    H, W = U.shape
    rgb = np.zeros((H, W, 3), np.uint8); a = np.zeros((H, W), np.float32)
    moj = (U < 65535) & (U <= hcm)
    d = np.clip(hcm - U, 0, 299)
    m0 = moj & (marca == 0)
    rgb[m0] = LUT[d[m0]]; rgb[moj & (U == 0)] = LUT[299]; a[m0] = 1
    fijo = np.zeros((H, W), bool)
    if obs is not None:
        fijo = moj & (marca > 0) & (obs == 1); rgb[fijo] = FIJO; a[fijo] = 1
    a *= fb
    return rgb, a, fijo


def pintar_sin_dato(U, meta):
    """la planicie de la zona (lo que se moja hasta el techo de las fotos + 1 m), rayada en diagonal: «sin dato ese día», nunca seca"""
    H, W = U.shape
    tope = int(math.floor(((meta.get('techo_historico_m') or 18) - (meta.get('correccion_radar_m') or 0) + 1) * 100 + 0.5))
    y, x = np.mgrid[0:H, 0:W]
    raya = ((x + y) // 8) % 3 == 0
    sd = (U < 65535) & (U <= tope)          # la planicie entera de la zona: ahí MANDA el «sin dato» (nadie pinta encima)
    m = sd & raya
    rgb = np.zeros((H, W, 3), np.uint8); rgb[m] = RAYADO
    return rgb, m.astype(np.float32) * RAYADO_ALFA, sd


def tesela_lonlat(z, x, y):
    n = 2 ** z; px = (np.arange(256) + 0.5) / 256
    lon = (x + px) / n * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + px) / n))))
    return lon, lat


def teselas_de(caja, z):
    o, s, e, nn = caja; n = 2 ** z
    def tx(lon): return int(math.floor((lon + 180) / 360 * n))
    def ty(lat): r = math.radians(lat); return int(math.floor((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n))
    return [(x, y) for x in range(tx(o), tx(e) + 1) for y in range(ty(nn), ty(s) + 1)]


def componer(fuentes, z, x, y):
    """Una tesela de 256 px con todas las fuentes. [Codex n3-litoral-colector] Las reglas, por punto:
      1) SIN DATO GANA EN SU PLANICIE: si una zona no tiene altura ese día, su planicie va rayada y NADIE pinta encima (ni la profundidad de
         una vecina ni el agua vista): otro color ahí se leería como un dato de esa zona, que no lo hay. El rayado y el «sin dato» de la barra
         dicen lo mismo.
      2) EL PICO Y LA MESETA NO TIENEN PROFUNDIDAD EN NINGÚN LADO: el territorio marcado de cualquier zona veta la profundidad de TODAS (también
         de una vecina solapada); ahí va el color fijo si OPERA vio agua, si no nada.
      3) UNA SOLA FUENTE DE COLOR POR PUNTO: la profundidad sale de UNA zona (la de más peso · alfa en ese punto), nunca de un promedio de
         colores (un promedio no es la profundidad de nadie). La costura se suaviza en el ALFA (peso por distancia al borde de cada caja).
      4) El color fijo del modelo (pico/meseta con OPERA) manda sobre la profundidad; el agua vista sin modelo, sólo donde no hay ninguna de las dos."""
    lon, lat = tesela_lonlat(z, x, y)
    LON, LAT = np.meshgrid(lon, lat)
    N = (256, 256)
    aD = np.zeros(N, np.float32); mejor = np.zeros(N, np.float32); col = np.zeros(N + (3,), np.uint8)
    aZF = np.zeros(N, np.float32); aAV = np.zeros(N, np.float32); ww = np.zeros(N, np.float32)
    aR = np.zeros(N, np.float32); wR = np.zeros(N, np.float32); sd = np.zeros(N, bool); veto = np.zeros(N, bool)
    for F in fuentes:
        m = F['meta']; H, W = F['a'].shape
        c = ((LON - m['oeste']) / (m['este'] - m['oeste']) * W).astype(np.int64); r = ((m['norte'] - LAT) / (m['norte'] - m['sur']) * H).astype(np.int64)
        dentro = (c >= 0) & (c < W) & (r >= 0) & (r < H)
        if not dentro.any(): continue
        cc, rr = c[dentro], r[dentro]
        al = F['a'][rr, cc]; w = F['w'][rr, cc] if F['w'] is not None else np.full(al.shape, F['peso'], np.float32)
        wa = w * al
        if F.get('rayado'):
            aR[dentro] += wa; wR[dentro] += w; sd[dentro] |= F['sd'][rr, cc]; continue
        ww[dentro] += w
        if F['fijo'] is None:                                   # agua vista sin modelo
            aAV[dentro] += wa; continue
        if F.get('veto') is not None: veto[dentro] |= F['veto'][rr, cc]
        fj = F['fijo'][rr, cc]
        aZF[dentro] += np.where(fj, wa, 0)
        prof = np.where(fj, 0, wa)
        aD[dentro] += prof
        gana = prof > mejor[dentro]                             # la zona de más peso · alfa en este punto pone el color
        sub = mejor[dentro]; sub[gana] = prof[gana]; mejor[dentro] = sub
        cs = col[dentro]; cs[gana] = F['rgb'][rr, cc][gana]; col[dentro] = cs
    aD = np.where(veto, 0, aD)
    out = np.zeros(N + (4,), np.uint8)
    aa = aD + aZF + aAV
    hay = (aa > 1e-6) & ~sd
    ray = sd & (aR > 1e-6)
    if not (hay.any() or ray.any()): return None
    profu = hay & (aZF <= 1e-6) & (aD > 1e-6)
    out[hay, :3] = FIJO
    out[profu, :3] = col[profu]
    out[hay, 3] = np.clip(255 * aa[hay] / np.maximum(ww[hay], 1e-6), 0, 255).astype(np.uint8)
    out[ray, :3] = RAYADO
    out[ray, 3] = np.clip(255 * aR[ray] / np.maximum(wR[ray], 1e-6), 0, 255).astype(np.uint8)
    if not (out[..., 3] > 0).any(): return None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--alturas', required=True); ap.add_argument('--opera-indice', required=True)
    ap.add_argument('--fechas', required=True); ap.add_argument('--salida', required=True)
    ap.add_argument('--zmin', type=int, default=6); ap.add_argument('--zmax', type=int, default=11)
    ap.add_argument('--zonas', default=None); ap.add_argument('--calado-dir', default=None); ap.add_argument('--agua-vista', default=None)
    A = ap.parse_args()
    precocer(json.load(open(A.alturas, encoding='utf-8')), json.load(open(A.opera_indice, encoding='utf-8')), A.fechas.split(','), A.salida,
             zmin=A.zmin, zmax=A.zmax, zonas=A.zonas.split(',') if A.zonas else None, calado_dir=A.calado_dir, agua_vista=A.agua_vista)


def precocer(alt, ind, fechas, salida, zmin=6, zmax=11, zonas=None, calado_dir=None, agua_vista=None, log=print, extra=None):
    class _A: pass
    A = _A(); A.zmin = zmin; A.zmax = zmax
    cd = calado_dir or os.path.join(RAIZ, 'datos', 'calado')
    zonas = zonas or sorted(f[:-5] for f in os.listdir(cd) if f.endswith('.json'))
    av = json.load(open(agua_vista or os.path.join(RAIZ, 'datos', 'opera', 'agua-vista.json'), encoding='utf-8'))['zonas']
    base = salida; os.makedirs(base, exist_ok=True)
    Z = {}
    for z in zonas:
        meta, U = leer_zona(z, cd); marca, R = marcas_de_zona(U, meta)
        Z[z] = {'meta': meta, 'U': U, 'marca': marca, 'R': R, 'fb': factor_borde(meta, U, R['bordes']), 'w': peso_fusion(meta, *U.shape)}
        log(f"{z}: pico {R['px_pico']} px · meseta {R['px_meseta']} px · bordes {len(R['bordes'])}")
    indice = {'v': 1, 'z_min': A.zmin, 'z_max': A.zmax, 'generado': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'fechas': [], 'marcas': {}, 'mb': {}}
    for z in zonas:
        R = Z[z]['R']; indice['marcas'][z] = {'pico_px': R['px_pico'], 'meseta_px': R['px_meseta'], 'picos': [p['cm'] for p in R['picos']],
                                             'meseta': R['meseta'], 'bordes': list(R['bordes'])}
    for fecha in fechas:
        t0 = time.time(); fuentes = []; sin = []; tipo = 'medido'; det = {}
        for z in zonas:
            a = (alt.get(z) or {}).get(fecha)
            if not a or not isinstance(a.get('h'), (int, float)):
                sin.append(z)
                rgb, al, sdm = pintar_sin_dato(Z[z]['U'], Z[z]['meta'])
                fuentes.append({'meta': Z[z]['meta'], 'rgb': rgb, 'a': al, 'w': Z[z]['w'], 'peso': None, 'fijo': None, 'rayado': True, 'sd': sdm})
                continue
            if a.get('tipo') == 'pronostico': tipo = 'pronostico'
            obs, fo, cob, ult = (None, None, None, False)
            if Z[z]['R']['px_meseta'] or Z[z]['R']['px_pico']: obs, fo, cob, ult = obs_opera(Z[z]['meta'], Z[z]['U'].shape, fecha, ind)
            rgb, al, fj = pintar_zona(Z[z]['U'], Z[z]['marca'], int(math.floor(a['h'] * 100 + 0.5)), obs, Z[z]['fb'])
            fuentes.append({'meta': Z[z]['meta'], 'rgb': rgb, 'a': al, 'w': Z[z]['w'], 'peso': None, 'fijo': fj, 'veto': Z[z]['marca'] > 0})
            det[z] = {'h': a['h'], 'opera': fo, 'opera_cob': cob, 'opera_ultima': bool(ult)}
        sueltas = dict(('av:' + k, ampliar(c['caja'])) for k, c in av.items()); sueltas.update(corredores(Z))
        for k, caja in sueltas.items():   # el agua vista sin modelo (cajas de agua vista y los tramos del río entre zonas), en el color fijo
            o, s, e, n = caja; px = 0.00054; W = int(round((e - o) / px)); H = int(round((n - s) / px))
            meta = {'oeste': o, 'sur': s, 'este': e, 'norte': n, 'pixel_m': [px * 111320 * math.cos(math.radians((s + n) / 2)), px * 110950]}
            obs, fo, cob, ult = obs_opera(meta, (H, W), fecha, ind)
            if obs is None: det[k] = {'opera': None}; continue
            obs = unida_al_rio(obs)   # sólo los cuerpos de agua grandes (el río y su planicie): fuera los charcos sueltos
            rgb = np.zeros((H, W, 3), np.uint8); rgb[obs == 1] = FIJO
            al = obs.astype(np.float32) * factor_borde(meta, obs, ('oeste', 'este', 'norte', 'sur'))   # sin cortes rectos: se esfuma en ~1 km
            fuentes.append({'meta': meta, 'rgb': rgb, 'a': al, 'w': None, 'peso': PESO_AGUA_VISTA, 'fijo': None})
            det[k] = {'opera': fo, 'opera_cob': cob, 'opera_ultima': bool(ult)}
        cajas = [(F['meta']['oeste'], F['meta']['sur'], F['meta']['este'], F['meta']['norte']) for F in fuentes]
        n = 0; bytes_ = 0
        for zz in range(A.zmin, A.zmax + 1):
            hechas = set()
            for c in cajas:
                for (x, y) in teselas_de(c, zz):
                    if (x, y) in hechas: continue
                    hechas.add((x, y)); im = componer(fuentes, zz, x, y)
                    if im is None: continue
                    d = os.path.join(base, fecha, str(zz), str(x)); os.makedirs(d, exist_ok=True)
                    f = os.path.join(d, f'{y}.png'); Image.fromarray(im, 'RGBA').save(f, optimize=True); n += 1; bytes_ += os.path.getsize(f)
        ultimas = sorted({d['opera'] for d in det.values() if d.get('opera_ultima') and d.get('opera')})
        indice['fechas'].append({'fecha': fecha, 'tipo': tipo, 'sin_dato': sin, 'zonas': det, 'opera_ultima': ultimas})   # [b] las pasadas viejas usadas ese día
        indice['mb'][fecha] = {'teselas': n, 'mb': round(bytes_ / 1e6, 3)}
        log(f'{fecha}: {n} teselas · {bytes_ / 1e6:.2f} MB · sin dato {len(sin)} · {time.time() - t0:.0f} s')
    if extra: indice.update(extra)
    json.dump(indice, open(os.path.join(base, 'indice.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    log('listo: indice.json')
    return indice


if __name__ == '__main__':
    main()
