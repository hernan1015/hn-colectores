"""[r79 · CRECIDAS · _v1850] Las DOS marcas del calado que no son una profundidad (hn-cortex docs/satchi-r78-revision/CRECIDAS-verificacion.md).
La MISMA regla que la página (index.html · _v1850 · detectarPico / mesetaDe / bordesDeDatos); el test r79c_crecidas compara los números.
  · PICO de un solo valor: el umbral de CONEXIÓN del barrido (umbral_n.py:99, uc = max(um, h − 0,05)): todos los puntos que se unen al cauce
    en el mismo paso quedan con el mismo umbral → la app les pintaba una profundidad pareja que no mide nada.
    Regla: un valor de cm con ≥ PICO_MIN_PX puntos y ≥ PICO_VECES veces la mediana de sus vecinos (±10 cm, sin él).
  · MESETA del techo: los puntos que las fotos JRC nunca vieron mojados, repartidos POR RANGO (no por cota) en [techo, techo + 1 m]
    (umbral_n.py:85-87), corridos por la corrección del radar → [techo − corr, techo − corr + 1 m).
    Regla: la meseta existe si la zona se extiende por relieve y tiene ≥ MESETA_MIN_PX puntos en la banda, con al menos MESETA_VECES
    veces la densidad (puntos por cm) del metro de arriba (la meseta se corta de golpe).
  · BORDES DE DATOS: un lado de la caja donde lo mojable toca el borde en ≥ BORDE_FRAC de su largo (el cálculo se corta ahí, el agua no).
Sólo numpy. Uso: from marcas import marcas_de_zona"""
import math
import numpy as np

PICO_MIN_PX = 2000
PICO_VECES = 20
PICO_VECINOS = 10
MESETA_MIN_PX = 5000
MESETA_VECES = 3
BORDE_FRAC = 0.15
BORDE_LINEAS = 2


def cuentas(U):
    v = U[(U > 0) & (U < 65535)]
    return np.bincount(v.ravel(), minlength=65536)


def detectar_pico(cnt):
    out = []
    cand = np.where(cnt >= PICO_MIN_PX)[0]
    for c in cand:
        lo, hi = max(1, c - PICO_VECINOS), min(65534, c + PICO_VECINOS)
        vec = np.concatenate([cnt[lo:c], cnt[c + 1:hi + 1]])
        med = float(np.median(vec)) if len(vec) else 0.0
        if cnt[c] >= PICO_VECES * max(med, 1.0):
            out.append({'cm': int(c), 'px': int(cnt[c]), 'mediana_vecinos': med})
    return out


def meseta_de(meta, cnt):
    if not meta.get('extiende_por_relieve'):
        return None
    techo = meta.get('techo_historico_m'); corr = meta.get('correccion_radar_m') or 0
    if not isinstance(techo, (int, float)):
        return None
    d = int(math.floor((techo - corr) * 100 + 0.5 + 1e-9)); h = d + 100   # = la página (_v1850): sin el redondeo bancario de round()
    if d < 1 or h + 100 > 65535:
        return None
    px = int(cnt[d:h].sum()); arriba = int(cnt[h:h + 100].sum())
    ok = px >= MESETA_MIN_PX and px >= MESETA_VECES * max(arriba, 1)
    return {'desde_cm': d, 'hasta_cm': h, 'px': px, 'px_metro_de_arriba': arriba, 'confirmada': bool(ok)}


def bordes_de_datos(U):
    H, W = U.shape
    moj = U < 65535
    lados = {'oeste': moj[:, :BORDE_LINEAS].any(1), 'este': moj[:, -BORDE_LINEAS:].any(1),
             'norte': moj[:BORDE_LINEAS, :].any(0), 'sur': moj[-BORDE_LINEAS:, :].any(0)}
    out = {}
    for k, v in lados.items():
        f = float(v.mean())
        if f >= BORDE_FRAC:
            idx = np.where(v)[0]
            out[k] = {'fraccion': round(f, 3), 'desde': int(idx.min()), 'hasta': int(idx.max())}
    return out


def marcas_de_zona(U, meta):
    """→ (marca: uint8 0 nada · 1 pico · 2 meseta, resumen auditable)"""
    cnt = cuentas(U)
    picos = detectar_pico(cnt)
    mes = meseta_de(meta, cnt)
    marca = np.zeros(U.shape, np.uint8)
    for p in picos:
        marca[U == p['cm']] = 1
    if mes and mes['confirmada']:
        marca[(U >= mes['desde_cm']) & (U < mes['hasta_cm']) & (marca == 0)] = 2
    return marca, {'picos': picos, 'meseta': mes, 'bordes': bordes_de_datos(U),
                   'px_pico': int((marca == 1).sum()), 'px_meseta': int((marca == 2).sum())}
