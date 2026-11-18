"""HN AGRO · 312 · una pasada de la tubería: por cada fuente, la corrida más nueva que ya está completa en la fuente.

- LLAVE: si no vale «si», no se hace NADA (ni un pedido a una fuente ni una lectura de R2).
- [n3-312a 2] UN CUADRO PUBLICADO NO SE PISA NUNCA: antes de bajar nada se mira si su JSON ya está (y se recupera); el PNG y
  el JSON se escriben con If-None-Match: * (si la clave existe, R2 no la toca).
- IDEMPOTENTE: una corrida con su sobre `completa` (o `parcial` con los intentos agotados) no se toca más; en una `parcial`
  sólo se hacen los cuadros que faltan. Un cuadro publicado no se reescribe nunca (la caché del borde es larga).
- Orden de escritura: PNG → JSON del cuadro → sobre de la corrida → índice → (retención) borrado de lo viejo.
  Quien lee el índice nunca encuentra una corrida a medias.
- Una fuente que falla no frena a las otras. Si fallan 3 pedidos seguidos a una fuente, esa fuente se corta por esta vez.
- [312d] EL VIENTO (u y v, sólo v2) va en una SEGUNDA FASE, cuando el v1 de TODAS las fuentes ya está publicado, su sobre escrito
  Y EL ÍNDICE ESCRITO (Codex n3-312d-col: el viento nunca deja un v1 sin índice). Cualquier error del viento (bajar, armar,
  publicar, hasta uno inesperado) queda adentro de su propio try y sólo lo anota (`viento_fallan`). Tiene un plazo TOTAL real
  (cada pedido y cada lectura lo miran: red.hasta) y un tope de intentos por corrida. Al terminar, el sobre dice `viento_cerrado`
  y el índice anota el estado del viento de cada corrida (`viento`).
"""
import json
import time
from datetime import datetime, timezone

from . import paleta, valores
from .fuentes import FUENTES, NIVELES_VIENTO, VIENTO_MAX_INTENTOS, ErrorFuente, viento_pendiente  # noqa: F401
from .red import ErrorRed

V = 'v1'
HORAS = {'lluvia6h': list(range(6, 121, 6)), 'cape': list(range(0, 121, 6))}
H_MAX = 120
RETENER = 8
MAX_INTENTOS = 3
CORTE_FALLAS_SEGUIDAS = 3
CACHE_CUADRO = 'public, max-age=86400, immutable'
CACHE_SOBRE_COMPLETA = 'public, max-age=3600'
CACHE_CORTA = 'public, max-age=300'
VIENTO_TOPE_S = 20 * 60          # [312d] tope de la fase del viento por pasada (el workflow tiene 60 min)
CORTE_FALLAS_VIENTO = 3          # [312d] cuadros de viento fallidos seguidos → se corta el viento de esa fuente por esta vez


def iso(d):
    return d.strftime('%Y-%m-%dT%H:%MZ')


def clave_corrida(c):
    return c.strftime('%Y%m%d%H')


def k_sobre(f, cc):
    return '%s/%s/%s/corrida.json' % (V, f, cc)


def k_cuadro(f, cc, var, h, ext):
    return '%s/%s/%s/%s/%03d.%s' % (V, f, cc, var, h, ext)


def k_valores(f, cc, var, h, ext):
    """[312c] la grilla de valores v2, junto al cuadro v1: v2/{fuente}/{corrida}/{variable}/{fff}.val.png|json"""
    return '%s/%s/%s/%s/%03d.val.%s' % (valores.V2, f, cc, var, h, ext)


K_INDICE = V + '/indice.json'
K_PALETAS = V + '/paletas.json'


def _json(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def _leer_json(almacen, k):
    b = almacen.leer(k)
    if b is None:
        return None
    try:
        return json.loads(b.decode())
    except ValueError:
        return None


def indice_vacio():
    return {'v': 1, 'actualizado': None, 'horas': HORAS,
            'fuentes': {f: {'nombre': FUENTES[f].nombre, 'ultima': None, 'corridas': [], 'estados': {}} for f in FUENTES}}


def meta_cuadro(fuente, corrida, variable, h, arr, info, png):
    import numpy as np
    from . import malla
    from .grib import valida
    p = paleta.PALETAS[variable]
    cc = clave_corrida(corrida)
    m = {
        'v': 1, 'fuente': fuente.id, 'modelo': fuente.modelo, 'corrida': cc, 'corrida_iso': iso(corrida),
        'hora_pronostico': h, 'valida_iso': iso(valida(corrida, h)), 'variable': variable, 'nombre': p['nombre'],
        'unidades': p['unidades'], 'periodo': None, 'parametro_fuente': info['parametro_fuente'],
        'cape_tipo': fuente.cape_tipo if variable == 'cape' else None, 'paleta': p['id'], 'leyenda': paleta.leyenda(variable),
        'caja': dict(malla.CAJA), 'imagen': dict(malla.georref(), png='%03d.png' % h),
        'resolucion_fuente': fuente.resolucion, 'regrillado': info.get('regrillado'),
        'estadisticas': {'min': round(float(np.min(arr)), 2), 'max': round(float(np.max(arr)), 2),
                         'media': round(float(np.mean(arr)), 3)},
        'cita': dict(fuente.cita, texto=fuente.cita['texto'].replace('%(anio)d', str(corrida.year))),
        'aviso': 'PRONÓSTICO del modelo %s, corrida %s %02d UTC: no es observación ni aviso oficial.' % (
            fuente.nombre, corrida.strftime('%d/%m'), corrida.hour),
        'firma': paleta.firma(png),
    }
    if variable == 'lluvia6h':
        m['periodo'] = {'desde_iso': iso(valida(corrida, h - 6)), 'hasta_iso': iso(valida(corrida, h))}
    return m


def _firma_publicada(almacen, kj):
    m = _leer_json(almacen, kj)
    return m.get('firma') if isinstance(m, dict) and isinstance(m.get('firma'), str) and m.get('firma') else None


def publicar_valores(almacen, fuente, cc, variable, h, meta, info):
    """[312c] la grilla de valores v2 del cuadro, DESPUÉS del v1 (que ya está publicado y no cambia). Las mismas reglas: nunca se
    pisa una clave publicada (If-None-Match: *); si ya estaba, sólo se sigue si es la MISMA. Devuelve True si quedó publicada."""
    if info.get('v2') is None:
        raise ValueError(info.get('v2_error') or 'la fuente no armó la grilla v2')
    vpng = valores.png16(valores.codificar(info['v2'], variable))
    m = valores.meta_valores(meta, info['v2'], variable, vpng, info.get('regrillado_v2'))
    kvp, kvj = k_valores(fuente.id, cc, variable, h, 'png'), k_valores(fuente.id, cc, variable, h, 'json')
    if not almacen.escribir(kvp, vpng, 'image/png', CACHE_CUADRO, si_no_existe=True):
        viejo = almacen.leer(kvp)
        if viejo is None or paleta.firma(viejo) != m['firma']:
            raise ValueError('ya hay otra grilla v2 publicada en %s: no se pisa' % kvp)
    if not almacen.escribir(kvj, _json(m), 'application/json', CACHE_CUADRO, si_no_existe=True):
        if _firma_publicada(almacen, kvj) != m['firma']:
            raise ValueError('ya hay otro JSON v2 publicado en %s: no se pisa' % kvj)
    return True


# ── [312d] EL VIENTO: la segunda fase ───────────────────────────────────────────────────────────────────────────────────────
def meta_viento(fuente, corrida, nivel, h, u, v, png, info):
    """el JSON del cuadro de viento (v2): lo común del cuadro (fuente, corrida, horas, caja, cita, aviso) + la codificación"""
    import numpy as np
    from . import malla
    from .grib import valida
    vel = np.hypot(np.asarray(u, dtype='f8'), np.asarray(v, dtype='f8'))
    N = valores.NIVELES_VIENTO[nivel]
    return {
        'v': 2, 'fuente': fuente.id, 'modelo': fuente.modelo, 'corrida': clave_corrida(corrida), 'corrida_iso': iso(corrida),
        'hora_pronostico': h, 'valida_iso': iso(valida(corrida, h)), 'variable': nivel, 'nombre': N['nombre'], 'nivel': dict(N['nivel']),
        'unidades': 'm/s', 'componentes': 'u = hacia el este, v = hacia el norte (m/s); el rumbo «de dónde viene» es atan2(−u, −v)',
        'periodo': None, 'cape_tipo': None, 'parametro_fuente': info['parametro_fuente'], 'caja': dict(malla.CAJA_V2),
        'resolucion_fuente': fuente.resolucion, 'paleta': valores.PALETA_VIENTO,
        'valores': {'png': '%03d.val.png' % h, 'tipo': 'PNG gris 16 bits (big-endian), sin filtro; filas 0-164 = u, 165-329 = v',
                    'escala': valores.ESCALA_VIENTO, 'cero': valores.CERO_VIENTO, 'sin_dato': valores.SIN_DATO,
                    'componentes': ['u', 'v'], 'formula': 'valor = (q − cero) × escala; q = sin_dato → NaN'},
        'grilla': malla.grilla_v2(), 'regrillado': info.get('regrillado'),
        'estadisticas': {'vel_max': round(float(np.nanmax(vel)), 2), 'vel_media': round(float(np.nanmean(vel)), 3),
                         'sin_dato': int(np.isnan(vel).sum())},
        'cita': dict(fuente.cita, texto=fuente.cita['texto'].replace('%(anio)d', str(corrida.year))),
        'aviso': 'PRONÓSTICO del modelo %s, corrida %s %02d UTC: no es observación ni aviso oficial.' % (
            fuente.nombre, corrida.strftime('%d/%m'), corrida.hour),
        'firma': paleta.firma(png),
    }


def publicar_viento(almacen, fuente, corrida, nivel, h, u, v, info):
    """el cuadro de viento: PNG y después JSON, con If-None-Match: * (nunca se pisa; si ya estaba, sólo sigue si es el MISMO)"""
    cc = clave_corrida(corrida)
    png = valores.png16(valores.codificar_viento(u, v))
    m = meta_viento(fuente, corrida, nivel, h, u, v, png, info)
    kwp, kwj = k_valores(fuente.id, cc, nivel, h, 'png'), k_valores(fuente.id, cc, nivel, h, 'json')
    if not almacen.escribir(kwp, png, 'image/png', CACHE_CUADRO, si_no_existe=True):
        viejo = almacen.leer(kwp)
        if viejo is None or paleta.firma(viejo) != m['firma']:
            raise ValueError('ya hay otro viento publicado en %s: no se pisa' % kwp)
    if not almacen.escribir(kwj, _json(m), 'application/json', CACHE_CUADRO, si_no_existe=True):
        if _firma_publicada(almacen, kwj) != m['firma']:
            raise ValueError('ya hay otro JSON de viento publicado en %s: no se pisa' % kwj)
    return m


def procesar_viento(fuente, corrida, sobre, red, almacen, log, hasta=None, reloj=time.monotonic):
    """el viento de una corrida cuyo v1 ya está publicado. Anota en el sobre `viento` (lo publicado) y `viento_fallan`. TODO error
    queda acá adentro: el que llama sólo vuelve a escribir el sobre (el del v1 ya estaba escrito antes de empezar)."""
    cc = clave_corrida(corrida)
    sobre['viento_intentos'] = sobre.get('viento_intentos', 0) + 1
    hechos = sobre.setdefault('viento', {})
    fallan = sobre.setdefault('viento_fallan', {})
    for n in NIVELES_VIENTO:
        hechos.setdefault(n, [])
        fallan.setdefault(n, [])
    seguidas, nuevos, cortado = 0, 0, ''
    for nivel in NIVELES_VIENTO:
        for h in fuente.horas_viento:
            if h in hechos[nivel]:
                continue
            if hasta is not None and reloj() > hasta:
                cortado = 'tope de tiempo'
                break
            try:
                if _firma_publicada(almacen, k_valores(fuente.id, cc, nivel, h, 'json')):   # ya estaba (una pasada sin sobre)
                    hechos[nivel].append(h)
                    continue
                u, v, info = fuente.viento(red, corrida, nivel, h)
                publicar_viento(almacen, fuente, corrida, nivel, h, u, v, info)
                hechos[nivel].append(h)
                seguidas, nuevos = 0, nuevos + 1
            except Exception as e:       # cualquier cosa: el viento NUNCA tumba nada
                fallan[nivel].append(h)
                seguidas += 1
                log('  %s %s %s +%d h: sin viento (%s: %s)' % (fuente.id, cc, nivel, h, type(e).__name__, e))
                if seguidas >= CORTE_FALLAS_VIENTO:
                    cortado = '%d fallas seguidas' % seguidas
                    break
        if cortado:
            break
    for n in NIVELES_VIENTO:
        hechos[n] = sorted(set(hechos[n]))
        fallan[n] = sorted(set(fallan[n]) - set(hechos[n]))
    log('  %s %s: viento, %d cuadros nuevos%s' % (fuente.id, cc, nuevos, (' (cortado: %s)' % cortado) if cortado else ''))
    return sobre


def fase_viento(hechas, viento, indice, red, almacen, ahora, log, tope_s, reloj=time.monotonic):
    """[312d] LA SEGUNDA FASE: el v1 de todas las fuentes ya está publicado, con sus sobres y el ÍNDICE escritos. Con un plazo TOTAL
    real (red.hasta: ningún pedido empieza después y ninguna lectura lo estira). Al terminar cada corrida, su sobre dice si el viento
    quedó cerrado (`viento_cerrado`: la function cachea largo sólo entonces) y el índice anota el estado del viento de esa corrida.
    Nada de acá adentro sale: un error sólo se anota."""
    try:
        hasta = reloj() + tope_s
        red.hasta, red.reloj = hasta, reloj
        cambio = False
        for f, c, sobre in hechas:
            if f.id not in (viento or ()) or c is None or sobre is None or not viento_pendiente(f, sobre):
                continue
            cc = clave_corrida(c)
            try:
                p0, b0 = red.pedidos, red.bytes
                procesar_viento(f, c, sobre, red, almacen, log, hasta=hasta, reloj=reloj)
                sobre['pedidos_viento'] = sobre.get('pedidos_viento', 0) + red.pedidos - p0
                sobre['bytes_viento'] = sobre.get('bytes_viento', 0) + red.bytes - b0
                sobre['viento_cerrado'] = not viento_pendiente(f, sobre)
                escribir_sobre(almacen, f, cc, sobre)
                e = indice['fuentes'].get(f.id) or {}
                if cc in (e.get('estados') or {}):
                    e.setdefault('viento', {})[cc] = 'cerrado' if sobre['viento_cerrado'] else 'abierto'
                    e['viento'] = {k: x for k, x in e['viento'].items() if k in e['estados']}
                    cambio = True
            except Exception as e:       # ni siquiera un error inesperado del viento toca el v1 (ni su índice, ya escrito)
                log('  %s: el viento no se pudo guardar (%s: %s); el v1 queda' % (f.id, type(e).__name__, e))
        if cambio:
            indice['actualizado'] = iso(ahora)
            almacen.escribir(K_INDICE, _json(indice), 'application/json', CACHE_CORTA)
    except Exception as e:
        log('  el viento no se pudo anotar en el índice (%s: %s); el índice del v1 ya estaba' % (type(e).__name__, e))
    finally:
        red.hasta = None


def escribir_sobre(almacen, fuente, cc, sobre):
    almacen.escribir(k_sobre(fuente.id, cc), _json(sobre), 'application/json',
                     CACHE_SOBRE_COMPLETA if sobre['estado'] == 'completa' else CACHE_CORTA)


def procesar_corrida(fuente, corrida, sobre, red, almacen, ahora, log):
    cc = clave_corrida(corrida)
    if sobre is None:
        sobre = {'v': 1, 'fuente': fuente.id, 'corrida': cc, 'corrida_iso': iso(corrida), 'intentos': 0,
                 'cuadros': {v: [] for v in HORAS}, 'firmas': {}, 'pedidos': 0, 'bytes_bajados': 0}
    sobre['intentos'] = sobre.get('intentos', 0) + 1
    sobre.setdefault('valores', {v: [] for v in HORAS})   # [312c] los cuadros que además tienen su grilla v2
    sobre.setdefault('valores_fallan', {v: [] for v in HORAS})   # [312c] los que la tienen fallida (el v1 sí está)
    fuente.nuevo(corrida)
    p0, b0 = red.pedidos, red.bytes
    seguidas, cortada, hechos, recuperados = 0, False, 0, 0
    for variable, horas in HORAS.items():
        for h in horas:
            if h in sobre['cuadros'][variable] or cortada:
                continue
            kp, kj = k_cuadro(fuente.id, cc, variable, h, 'png'), k_cuadro(fuente.id, cc, variable, h, 'json')
            # [n3-312a 2] un cuadro ya publicado (en una pasada que no llegó a guardar el sobre) se RECUPERA, no se rehace:
            # el JSON se escribe después del PNG, así que si está el JSON están los dos.
            previa = _firma_publicada(almacen, kj)
            if previa:
                sobre['cuadros'][variable].append(h)
                sobre['firmas']['%s/%03d' % (variable, h)] = previa
                # [312c · Codex n3-312c-col 2] su v2, si estaba; leerla NUNCA tumba el v1 recuperado
                try:
                    if _firma_publicada(almacen, k_valores(fuente.id, cc, variable, h, 'json')):
                        sobre['valores'][variable].append(h)
                except Exception as e:
                    log('  %s %s %s +%d h: recuperado sin poder leer su v2 (%s)' % (fuente.id, cc, variable, h, e))
                recuperados += 1
                continue
            try:
                arr, info = fuente.cuadro(red, corrida, variable, h)
                png = paleta.png_indexado(paleta.clasificar(arr, variable), variable)
                meta = meta_cuadro(fuente, corrida, variable, h, arr, info, png)
                # [n3-312a 2] NUNCA se pisa una clave publicada (If-None-Match: *). Si el PNG ya estaba (falló el JSON),
                # sólo se sigue si es el MISMO PNG; si no, el cuadro falta: la caché del borde ya tiene el otro.
                if not almacen.escribir(kp, png, 'image/png', CACHE_CUADRO, si_no_existe=True):
                    viejo = almacen.leer(kp)
                    if viejo is None or paleta.firma(viejo) != meta['firma']:
                        raise ValueError('ya hay otro PNG publicado en %s: no se pisa' % kp)
                if not almacen.escribir(kj, _json(meta), 'application/json', CACHE_CUADRO, si_no_existe=True):
                    if _firma_publicada(almacen, kj) != meta['firma']:
                        raise ValueError('ya hay otro JSON publicado en %s: no se pisa' % kj)
                sobre['cuadros'][variable].append(h)
                sobre['firmas']['%s/%03d' % (variable, h)] = meta['firma']
                seguidas, hechos = 0, hechos + 1
                # [312c] la grilla v2: si falla (al armarla o al publicarla), el cuadro v1 queda publicado (el front cae al v1 y
                # lo dice) y la v2 queda anotada como fallida en el sobre
                try:
                    publicar_valores(almacen, fuente, cc, variable, h, meta, info)
                    sobre['valores'][variable].append(h)
                except Exception as e:
                    sobre['valores_fallan'][variable].append(h)
                    log('  %s %s %s +%d h: sin grilla v2 (%s); el v1 queda' % (fuente.id, cc, variable, h, e))
            except (ErrorFuente, ErrorRed, ValueError) as e:
                log('  %s %s %s +%d h: falta (%s)' % (fuente.id, cc, variable, h, e))
                seguidas += 1
                if seguidas >= CORTE_FALLAS_SEGUIDAS:
                    log('  %s: %d fallas seguidas, corto esta fuente por esta vez' % (fuente.id, seguidas))
                    cortada = True
    for v in HORAS:
        sobre['cuadros'][v] = sorted(set(sobre['cuadros'][v]))
        sobre['valores'][v] = sorted(set(sobre['valores'].get(v, [])) & set(sobre['cuadros'][v]))
        sobre['valores_fallan'][v] = sorted(set(sobre['valores_fallan'].get(v, [])) - set(sobre['valores'][v]))
    sobre['faltan'] = {v: [h for h in HORAS[v] if h not in sobre['cuadros'][v]] for v in HORAS}
    sobre['estado'] = 'completa' if not any(sobre['faltan'].values()) else 'parcial'
    sobre['pedidos'] = sobre.get('pedidos', 0) + red.pedidos - p0
    sobre['bytes_bajados'] = sobre.get('bytes_bajados', 0) + red.bytes - b0
    sobre['generado'] = iso(ahora)
    escribir_sobre(almacen, fuente, cc, sobre)
    log('  %s %s: %s, %d cuadros nuevos, %d recuperados, %d pedidos, %.1f MB' % (
        fuente.id, cc, sobre['estado'], hechos, recuperados, red.pedidos - p0, (red.bytes - b0) / 1e6))
    return sobre


def terminada(sobre):
    return bool(sobre) and (sobre.get('estado') == 'completa' or sobre.get('intentos', 0) >= MAX_INTENTOS)


def pasar_fuente(fuente, red, almacen, ahora, log):
    """la corrida más nueva que la fuente ya tiene entera; devuelve (corrida, sobre) o (None, None)"""
    for c in fuente.candidatos(ahora):
        sobre = _leer_json(almacen, k_sobre(fuente.id, clave_corrida(c)))
        if terminada(sobre):
            log('  %s %s: ya está (%s)' % (fuente.id, clave_corrida(c), sobre['estado']))
            return c, sobre
        if not fuente.disponible(red, c, H_MAX):
            log('  %s %s: la fuente todavía no tiene +%d h' % (fuente.id, clave_corrida(c), H_MAX))
            continue
        return c, procesar_corrida(fuente, c, sobre, red, almacen, ahora, log)
    return None, None


def actualizar_indice(indice, fid, corrida, sobre, retener):
    """devuelve las corridas que salen por la retención"""
    e = indice['fuentes'].setdefault(fid, {'nombre': FUENTES[fid].nombre, 'ultima': None, 'corridas': [], 'estados': {}})
    if corrida is not None and sobre is not None:
        cc = clave_corrida(corrida)
        e['estados'][cc] = sobre['estado']
        if sobre['estado'] == 'completa' and cc not in e['corridas']:
            e['corridas'].append(cc)
    todas = sorted(set(e['corridas']) | set(e['estados']), reverse=True)
    quedan = set(todas[:retener])
    e['corridas'] = sorted([c for c in e['corridas'] if c in quedan], reverse=True)
    e['estados'] = {c: s for c, s in e['estados'].items() if c in quedan}
    e['ultima'] = e['corridas'][0] if e['corridas'] else None
    return [c for c in todas if c not in quedan]


def correr(red, almacen, ahora=None, llave='', fuentes=None, retener=RETENER, log=print, viento=(), viento_tope_s=VIENTO_TOPE_S,
           reloj=time.monotonic):
    """viento: las fuentes a las que además se les arma el viento (la segunda fase; vacío = ninguna). Lo decide el colector."""
    if (llave or '').strip().lower() != 'si':
        log('llave apagada (MODELOS_ON != «si»): no se hace nada')
        return {'hecho': False}
    ahora = ahora or datetime.now(timezone.utc)
    fuentes = fuentes or [FUENTES[f]() for f in FUENTES]
    previo = _leer_json(almacen, K_INDICE)
    indice = previo if previo and previo.get('v') == 1 else indice_vacio()
    indice['valores'] = valores.anuncio()   # [312c] la grilla v2 (su caja) es un DATO del índice
    antes = _json(dict(indice, actualizado=None))
    salen, errores, hechas = {}, [], []
    for f in fuentes:
        log('%s:' % f.id)
        try:
            c, sobre = pasar_fuente(f, red, almacen, ahora, log)
        except (ErrorFuente, ErrorRed) as e:
            log('  %s: la fuente no responde (%s); la próxima pasada vuelve a probar' % (f.id, e))
            c, sobre = None, None
        except IOError as e:
            errores.append('%s: %s' % (f.id, e))   # R2: la corrida queda en rojo
            continue
        hechas.append((f, c, sobre))
    for f, c, sobre in hechas:
        salen[f.id] = actualizar_indice(indice, f.id, c, sobre, retener)
    # [312d · Codex n3-312d-col] EL ÍNDICE VA AHORA, con el v1 de todas las fuentes: el viento (que viene después) nunca lo demora
    if _json(dict(indice, actualizado=None)) != antes or previo is None:
        indice['actualizado'] = iso(ahora)
        almacen.escribir(K_INDICE, _json(indice), 'application/json', CACHE_CORTA)
        if almacen.leer(K_PALETAS) is None:
            almacen.escribir(K_PALETAS, _json(paleta.paletas_json()), 'application/json', CACHE_SOBRE_COMPLETA)
    else:
        log('índice sin cambios: no se reescribe')
    borrados = 0
    for fid, ccs in salen.items():
        for cc in ccs:
            for pre in (V, valores.V2):   # [312c] y su grilla v2
                for k in almacen.listar('%s/%s/%s/' % (pre, fid, cc)):
                    almacen.borrar(k)
                    borrados += 1
    if borrados:
        log('retención: %d objetos borrados' % borrados)
    fase_viento(hechas, viento, indice, red, almacen, ahora, log, viento_tope_s, reloj)
    log('pedidos a las fuentes: %d (%s), %.1f MB bajados' % (
        red.pedidos, ', '.join('%s %d' % kv for kv in sorted(red.por_host.items())), red.bytes / 1e6))
    if errores:
        raise IOError('; '.join(errores))
    return {'hecho': True, 'indice': indice, 'borrados': borrados}
