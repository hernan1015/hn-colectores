"""Control negativo CONTADO: se rompe a propósito una cosa por vez (en una copia de lib/ y colector.py) y se corre la suite.
Cada mutante tiene que hacer fallar al menos un test. Antes se corre la copia SIN romper, que tiene que pasar entera.
Correr (dentro de modelos/):  python test/control_negativo.py      → «N de N mutantes detectados»
"""
import os
import shutil
import subprocess
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MUT = os.path.join(RAIZ, '.mutante')

MUTANTES = [
    # el recorte
    ('recorte corrido (la caja no entra)', 'malla.py', "(lats >= CAJA_RECORTE['sur'] - margen)", "(lats >= CAJA_RECORTE['sur'] + 5)"),
    ('lon 0..360 del GFS sin normalizar', 'malla.py', "lons = _lon180(malla['lo1'] + di * np.arange(Ni))", "lons = malla['lo1'] + di * np.arange(Ni)"),
    ('filas sur→norte ignoradas', 'malla.py', "signo = 1 if malla['scan'] & 0x40 else -1", 'signo = -1'),
    ('filas equiespaciadas en latitud, no en Mercator', 'malla.py', "    return merc_lat(y), lon\n", "    return np.linspace(CAJA['norte'], CAJA['sur'], ALTO), lon\n"),
    # la lluvia de 6 h
    ('ECMWF: la acumulada total en vez de la diferencia', 'fuentes.py', 'prev = np.zeros_like(sub) if a is None else a[0]', 'prev = np.zeros_like(sub)'),
    ('ECMWF: tp en m sin pasar a mm', 'fuentes.py', '(sub - prev) * 1000.0', '(sub - prev)'),
    ('ICON: la acumulada total en vez de la diferencia', 'fuentes.py', 'dif = b[0] - (0 if a is None else a[0])', 'dif = b[0]'),
    ('sin control de unidades', 'fuentes.py', 'if np.nanmax(arr) > tope or np.nanmin(arr) < -1:', 'if False:'),
    # el CAPE
    ('GFS toma el CAPE de superficie', 'fuentes.py', "quiero = ('CAPE', '255-0 mb above ground',", "quiero = ('CAPE', 'surface',"),
    ('ECMWF no verifica que sea MUCAPE', 'fuentes.py', 'niveles_cape = ((17, None), (255, None))', 'niveles_cape = ((1, None), (255, None))'),
    # el GRIB
    ('no valida el paso', 'grib.py', "if paso_h is not None and abs(c['paso_h'] - paso_h) > 1e-6:", 'if False:'),
    ('no valida la acumulación', 'grib.py', "if acum_h is not None and (c['acum_h'] is None", "if False and (c['acum_h'] is None"),
    ('no valida la corrida', 'grib.py', "if corrida is not None and c['corrida'] != corrida:", 'if False:'),
    # el regrillado de ICON
    ('ICON: lat y lon cruzadas en el árbol', 'malla.py', ' d, k = arbol.query(_xyz(LA.ravel(), LO.ravel()), k=1)', ' d, k = arbol.query(_xyz(LO.ravel(), LA.ravel()), k=1)'),
    ('ICON: radianes sin convertir', 'malla.py', 'clat, clon = np.degrees(clat), np.degrees(clon)', 'clat, clon = clat, clon'),
    ('ICON: no verifica la malla del campo', 'malla.py', 'if uuid != self.uuid:', 'if False:'),
    ('ICON: no verifica la distancia', 'malla.py', 'if d.max() * 6371.0 > self.DIST_MAX_KM:', 'if False:'),
    # la paleta
    ('tramo con el «desde» excluido', 'paleta.py', "side='right'", "side='left'"),
    ('un faltante se pinta como debajo del umbral', 'paleta.py', "        raise ValueError('valores faltantes en la caja')", '        pass'),
    ('el índice 0 no es transparente', 'paleta.py', "trns = b'\\x00' + b'\\xff' * len(colores)", "trns = b'\\xff' * (len(colores) + 1)"),
    # la tubería
    ('llave ignorada', 'tuberia.py', "if (llave or '').strip().lower() != 'si':", 'if False:'),
    ('llave ignorada en el colector', '../colector.py', "    if (llave or '').strip().lower() != 'si':\n        print(", "    if False:\n        print("),
    ('rehace corridas terminadas (no idempotente)', 'tuberia.py', '        if terminada(sobre):', '        if False:'),
    ('reescribe cuadros ya publicados', 'tuberia.py', "if h in sobre['cuadros'][variable] or cortada:", 'if cortada:'),
    ('reintenta sin tope', 'tuberia.py', "sobre.get('intentos', 0) >= MAX_INTENTOS", 'False'),
    ('una parcial entra como «la última»', 'tuberia.py', "if sobre['estado'] == 'completa' and cc not in e['corridas']:", "if cc not in e['corridas']:"),
    ('retiene 9 corridas', 'tuberia.py', 'quedan = set(todas[:retener])', 'quedan = set(todas[:retener + 1])'),
    ('reescribe el índice aunque no cambie', 'tuberia.py', "if _json(dict(indice, actualizado=None)) != antes or previo is None:", 'if True:'),
    ('publica una corrida que la fuente no terminó', 'tuberia.py', 'if not fuente.disponible(red, c, H_MAX):', 'if False:'),
    # la red y R2
    ('otro User-Agent', 'red.py', "UA = 'hn-colector/1.0'", "UA = 'Python-urllib/3.12'"),
    ('un 404 no es «todavía no está»', 'red.py', 'if e.code == 404:', 'if e.code == 4040:'),
    ('reintenta también los 4xx', 'red.py', 'if intento == 0 and e.code >= 500:', 'if intento == 0:'),
    ('acepta un 200 cuando se pidió un rango', 'red.py', 'if r.status != 206:', 'if False:'),
    ('no mira el Content-Range', 'red.py', "if not cr.startswith('bytes %d-%d/' % rango):", 'if False:'),
    ('lee el cuerpo entero aunque sea un rango', 'red.py', 'cuerpo = r.read(n + 1)', 'cuerpo = r.read()'),
    ('no recupera los cuadros ya publicados', 'tuberia.py', 'previa = _firma_publicada(almacen, kj)', 'previa = None'),
    ('pisa el PNG ya publicado', 'tuberia.py', "if not almacen.escribir(kp, png, 'image/png', CACHE_CUADRO, si_no_existe=True):", "if not almacen.escribir(kp, png, 'image/png', CACHE_CUADRO):"),
    ('sigue aunque el PNG publicado sea otro', 'tuberia.py', "if viejo is None or paleta.firma(viejo) != meta['firma']:", 'if False:'),
    ('la carpeta ignora si_no_existe', 'almacen.py', 'if si_no_existe and os.path.exists(p):', 'if False:'),
    ('R2 toma el 412 como error', 'almacen.py', 'if si_no_existe and st in (409, 412):', 'if False:'),
    ('acepta un promedio como acumulación', 'grib.py', "if acum_h is not None and (c['proceso'] != 1 or c['n_rangos'] != 1):", 'if False:'),
    ('no mira las superficies', 'grib.py', "if niveles is not None and not (coincide_nivel(c['nivel1'], niveles[0]) and coincide_nivel(c['nivel2'], niveles[1])):", 'if False:'),
    ('ignora el factor de escala del nivel', 'grib.py', 'esc = 0 if factor == 255 else _s(bytes([factor]))', 'esc = 0'),
    ('compara sólo el tipo del nivel', 'grib.py', '    if esperado is None:\n        return True\n', '    return True\n'),
    ('GFS acepta otra capa de CAPE', 'fuentes.py', 'niveles_cape = ((108, 25500.0), (108, 0.0))', 'niveles_cape = ((108, None), (108, None))'),
    ('firma SigV4 mal armada', 'almacen.py', "('AWS4' + secreto).encode()", "('AWS4' + secreto[::-1]).encode()"),
    # [312c] la grilla de valores v2
    ('v2: filas de sur a norte', 'malla.py', "return CAJA_V2['norte'] - np.arange(NLAT_V2) * PASO_V2,", "return CAJA_V2['sur'] + np.arange(NLAT_V2) * PASO_V2,"),
    ('v2: remuestrea a escondidas una malla corrida', 'malla.py', "> 0.01 * PASO_V2 or np.abs(lons[ii] - lo_n).max() > 0.01 * PASO_V2:", "> 9 or np.abs(lons[ii] - lo_n).max() > 9:"),
    ('v2: ICON con lat y lon cruzadas', 'malla.py', 'd2, k2 = arbol.query(_xyz(LA.ravel(), LO.ravel()), k=1)', 'd2, k2 = arbol.query(_xyz(LO.ravel(), LA.ravel()), k=1)'),
    ('v2: ICON no verifica la malla del campo', 'malla.py', "        if self.uuid != uuid:\n            raise ValueError('el campo es de otra malla (uuid %s, CLAT/CLON %s)' % (uuid, self.uuid))\n        if self.dist_max_v2_km", "        if self.dist_max_v2_km"),
    ('v2: el NaN no se marca', 'valores.py', '    q[nan] = SIN_DATO\n', '    pass\n'),
    ('v2: la lluvia en décimas', 'valores.py', "ESCALA = {'lluvia6h': 0.01,", "ESCALA = {'lluvia6h': 0.1,"),
    ('v2: PNG de 8 bits', 'valores.py', "q = np.ascontiguousarray(q, dtype='>u2')", "q = np.ascontiguousarray(q, dtype='u1')"),
    ('v2: pisa la grilla ya publicada', 'tuberia.py', "if not almacen.escribir(kvp, vpng, 'image/png', CACHE_CUADRO, si_no_existe=True):\n        viejo = almacen.leer(kvp)\n        if viejo is None or paleta.firma(viejo) != m['firma']:", "if not almacen.escribir(kvp, vpng, 'image/png', CACHE_CUADRO):\n        viejo = almacen.leer(kvp)\n        if viejo is None or paleta.firma(viejo) != m['firma']:"),
    ('v2: una falla de la v2 tumba el cuadro v1', 'tuberia.py', "                except Exception as e:\n                    sobre['valores_fallan'][variable].append(h)", "                except KeyError as e:\n                    sobre['valores_fallan'][variable].append(h)"),
    ('v2: un error al armarla tumba el v1 (fuentes)', 'fuentes.py', '        except Exception as e:   # cualquier error de la v2 no toca el v1', '        except KeyError as e:   # cualquier error de la v2 no toca el v1'),
    ('v2: leerla al recuperar tumba la corrida', 'tuberia.py', "                except Exception as e:\n                    log('  %s %s %s +%d h: recuperado sin poder leer su v2", "                except KeyError as e:\n                    log('  %s %s %s +%d h: recuperado sin poder leer su v2"),
    ('v2: la fallida no se anota', 'tuberia.py', "                    sobre['valores_fallan'][variable].append(h)\n", "                    pass\n"),
    ('v2: la caja chica de antes', 'malla.py', "CAJA_V2 = {'oeste': -100.0, 'este': -20.0, 'sur': -60.0, 'norte': -5.0}", "CAJA_V2 = {'oeste': -76.0, 'este': -45.0, 'sur': -56.0, 'norte': -15.0}"),
    ('v2: ICON no verifica la distancia de los nodos', 'malla.py', '        if self.dist_max_v2_km > self.DIST_MAX_KM:', '        if False:'),
    ('v2: el índice no anuncia la grilla', 'tuberia.py', "    indice['valores'] = valores.anuncio()", '    pass'),
    ('v2: el recorte de ICON sólo cubre la caja del v1', 'malla.py', "        sel = np.where((clat >= CAJA_RECORTE['sur'] - 1)", "        sel = np.where((clat >= CAJA['sur'] - 1)"),
    ('v2: el anuncio entra antes de comparar (un índice viejo no se reescribe)', 'tuberia.py', "    antes = _json(dict(indice, actualizado=None))   # [Codex n3-312c-area-col] ANTES de agregar el anuncio: un índice viejo sin él se reescribe\n    indice['valores'] = valores.anuncio()   # [312c] la grilla v2 (su caja) es un DATO del índice\n", "    indice['valores'] = valores.anuncio()   # [312c] la grilla v2 (su caja) es un DATO del índice\n    antes = _json(dict(indice, actualizado=None))\n"),
    ('v2: la retención no la borra', 'tuberia.py', 'for pre in (V, valores.V2):', 'for pre in (V,):'),
    ('v2: no se recupera al perder el sobre', 'tuberia.py', "                    if _firma_publicada(almacen, k_valores(fuente.id, cc, variable, h, 'json')):", '                    if False:'),
]


def preparar(archivo=None, viejo=None, nuevo=None):
    shutil.rmtree(MUT, ignore_errors=True)
    shutil.copytree(os.path.join(RAIZ, 'lib'), os.path.join(MUT, 'lib'), ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy(os.path.join(RAIZ, 'colector.py'), os.path.join(MUT, 'colector.py'))
    if archivo:
        p = os.path.normpath(os.path.join(MUT, 'lib', archivo))
        with open(p, encoding='utf-8') as f:
            t = f.read()
        if t.count(viejo) != 1:
            raise SystemExit('mutante en %s: el texto aparece %d veces (tiene que ser 1): %r' % (archivo, t.count(viejo), viejo))
        with open(p, 'w', encoding='utf-8') as f:
            f.write(t.replace(viejo, nuevo))


def suite():
    env = dict(os.environ, MODELOS_RAIZ=MUT, PYTHONIOENCODING='utf-8')
    r = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', os.path.join(RAIZ, 'test'), '-t',
                        os.path.join(RAIZ, 'test')], env=env, capture_output=True, text=True, encoding='utf-8')
    return r.returncode == 0, (r.stderr or '').strip().splitlines()[-1:]


def main():
    preparar()
    ok, cola = suite()
    if not ok:
        raise SystemExit('la copia SIN romper no pasa: %s' % cola)
    print('copia sin romper: pasa')
    detectados = 0
    for nombre, archivo, viejo, nuevo in MUTANTES:
        preparar(archivo, viejo, nuevo)
        ok, _ = suite()
        detectados += 0 if ok else 1
        print('%s  %s' % ('detectado ' if not ok else 'SOBREVIVE ', nombre))
    shutil.rmtree(MUT, ignore_errors=True)
    print('%d de %d mutantes detectados' % (detectados, len(MUTANTES)))
    return 0 if detectados == len(MUTANTES) else 1


if __name__ == '__main__':
    sys.exit(main())
