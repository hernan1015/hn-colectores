# modelos · ECMWF · ICON · GFS → R2, para la pestaña «Modelos» de SATCHI (la 312, etapa 1)

Cada hora, el workflow `colector-modelos` busca la corrida más nueva de cada fuente que **ya esté entera** (hasta +120 h).
Si todavía no está en R2, baja **sólo** los mensajes GRIB de lluvia y de CAPE, de a uno. Los recorta a Sudamérica sur, los pinta
con una paleta fija y sube PNG + JSON al depósito público `satchi-modelos`.

- **Contrato para el front** (claves, índice, metadatos, paletas, la function con caché en el borde):
  hn-cortex `docs/satchi-modelos-2026-11/CONTRATO-R2.md`.
- **Instalación:** hn-cortex `docs/mejora-continua/LISTO-312a.md`.
- **Es PRONÓSTICO de un modelo, no observación ni aviso oficial.** Cada JSON lo dice en `aviso`.

## Paso 0 · medido, no supuesto (17/11/2026, de 01:00 a 01:40 UTC, UA `hn-colector/1.0`, unos 60 pedidos espaciados)

| | **ECMWF IFS open data** | **DWD ICON global** | **NOAA GFS 0,25°** |
|---|---|---|---|
| Dónde | `data.ecmwf.int/forecasts/AAAAMMDD/HHz/ifs/0p25/oper/` | `opendata.dwd.de/weather/nwp/icon/grib/HH/<var>/` | bucket `noaa-gfs-bdp-pds` (S3, sin cuenta) |
| Malla (de la cabecera GRIB) | lat-lon 0,25° (1440 × 721; lon desde 180°, o sea −180) | **icosaédrica** R03B07, malla n.º 26, 2.949.120 celdas (~13 km), uuid `a27b8de6…` | lat-lon 0,25° (1440 × 721; lon 0 a 359,75) |
| Lat-lon regular del global | — | **No hay** en el open data: sólo `icosahedral` (113 archivos por variable, todos icosaédricos). El DWD ofrece pesos para CDO (`/weather/lib/cdo/`, de 2017) | — |
| Ciclos | 00, 06, 12 y 18 UTC | 00, 06, 12 y 18 UTC | 00, 06, 12 y 18 UTC |
| Horizonte y paso | 00/12: hasta 360 h (cada 3 h hasta 144, después cada 6); 06/18: hasta 144 h cada 3 h | 00/12: hasta 180 h (cada 1 h hasta 78, después cada 3); 06/18: hasta 120 h | hasta 384 h (cada 1 h hasta 120, después cada 3) |
| Retraso desde la hora de la corrida | toda la corrida junta: **+6 h 27 min** (06 y 18) y **+7 h 34 min** (00 y 12) | hora 0: **+2 h 39 min**; hora 120: **+3 h 14 min**; hora 180: +3 h 22 min | f000: **+3 h 34 min**; f120: **+4 h 05 min**; f384: +5 h 15 min |
| Licencia | **CC BY 4.0** (texto abajo) | **CC BY 4.0** (condiciones del DWD) | **dominio público** (EE. UU.) |
| Formato | GRIB2, CCSDS (plantilla 5.42), `.index` JSON por línea (`_offset`, `_length`) | GRIB2 + **bz2**, CCSDS (5.42); **un archivo = un mensaje**, sin índice | GRIB2, compresión compleja con diferencias espaciales (5.3), `.idx` de texto |
| Lluvia | `tp` (0/1/193, **m**, acumulada desde el inicio, plantilla 4.8) | `TOT_PREC` (0/1/52, kg/m², acumulada desde el inicio, rango en **minutos**) | `APCP` (0/1/8, kg/m²): **dos** registros por archivo, el balde «(N−6)-N hour acc» y el total «0-N» |
| CAPE | `mucape` (0/7/6, superficie tipo 17 = parcela **más inestable**) → **MUCAPE** | `CAPE_ML` (0/7/6, superficie tipo 192, capa de mezcla) → **MLCAPE**; y `CAPE_CON` (la del esquema de convección) | `CAPE` en `surface` (**SBCAPE**), `90-0 mb` (~MLCAPE), `180-0 mb` y **`255-0 mb above ground` (MUCAPE)** |
| Peso de un mensaje | tp ≈ 0,31 MB · mucape ≈ 0,30 MB (el archivo entero de una hora pesa ~95 MB) | TOT_PREC ≈ 1,9 MB · CAPE_ML ≈ 2,8 MB (bz2) · CLAT/CLON ≈ 1,3 MB | APCP ≈ 0,37 MB · CAPE ≈ 0,48 MB (el archivo entero pesa ~540 MB) |

- **ECMWF también tiene 0,1°** (`ifs/0p1/oper/`, archivos `-sfc` y `-pl`, con `tp` y `mucape`). Pero sale **2 h más tarde** que la de
  0,25° (12 UTC a las 21:34 contra 19:34), no está en 18 UTC a la misma hora y cada mensaje pesa 5 veces más (~1,45 MB).
  En la etapa 1 se usa 0,25°, igual que el GFS, así las dos se comparan celda por celda. Pasar a 0,1° es cambiar `0p25` por
  `0p1` y el nombre del archivo (`-oper-fc-sfc`).
- **El CAPE no es el mismo en las 3.** ICON abierto no publica MUCAPE. Con la misma atmósfera, el MLCAPE suele dar menos que el
  MUCAPE. El JSON de cada cuadro lo dice en `cape_tipo` y la leyenda lo tiene que mostrar.
- **Texto de cita de ECMWF** (de `apps.ecmwf.int/datasets/licences/general`, enlazado desde `LICENCE.txt` de cada corrida):
  «Copyright "© [año] European Centre for Medium-Range Weather Forecasts (ECMWF)". Source: www.ecmwf.int. Licence Statement:
  This data is published under a Creative Commons Attribution 4.0 International (CC BY 4.0). Disclaimer: ECMWF does not
  accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage
  arising from their use.» También pide indicar si se modificaron los datos. La cita en castellano está en `lib/fuentes.py`
  y viaja en cada JSON (`cita.texto`).

## Qué hace una pasada

1. **Llave.** Si `MODELOS_ON` no vale `si`, no hace nada: el job ni arranca y el script lo vuelve a mirar.
2. **Chequeo sin dependencias** (`colector.py --chequeo`, sólo biblioteca estándar). Para cada fuente, de la corrida más nueva
   a la más vieja de las últimas 24 h:
   - si su sobre en R2 está `completa`, o `parcial` con los 3 intentos gastados, ya está;
   - si no, pregunta si la fuente ya tiene la hora +120 (HEAD del `.index`, del `.idx` o de los dos `.bz2` de +120).

   Si no hay nada nuevo, el job termina sin instalar nada.
3. **Tests** con ecCodes de verdad sobre los GRIB sintéticos. Si fallan, no se colecta.
4. **Cada fuente**, la corrida más nueva disponible y sólo los cuadros que faltan:
   - **ECMWF:** `.index` de la hora, después el rango de `tp` y el de `mucape`.
   - **GFS:** `.idx` de la hora, después el rango del APCP «(N−6)-N» y el del CAPE «255-0 mb».
   - **ICON:** CLAT y CLON una vez, y después un `.bz2` por parámetro y hora.
   - Se verifica en la cabecera que cada mensaje sea **lo pedido**: corrida, paso, acumulación (desde, hasta), parámetro y nivel.
     Si no, el cuadro falta: no se publica otra cosa en su lugar.
5. **Orden de escritura:** PNG → JSON del cuadro → sobre de la corrida → índice → borrado de lo que sale por la retención.
   Quien lee el índice nunca ve una corrida a medias.

## Las 2 variables

- **Lluvia en 6 h:**
  - **ECMWF** e **ICON** dan la lluvia acumulada desde el inicio. La de 6 h sale por **diferencia**:
    `acum(N) − acum(N−6)`, con `acum(0) = 0`, que no se pide.
    - ECMWF da metros: se multiplica por 1000.
    - En ICON la diferencia se hace **en la malla nativa** y después se regrilla, así no se mezclan dos regrillados.
  - **GFS** trae el balde de 6 h directo («6-12 hour acc»): se usa ése. Se verificó con la corrida 16/11 12 UTC:
    `0-12 − 0-6` da una media de 0,617 mm y el balde 0,614 mm (la diferencia es del empaquetado).
  - Una diferencia negativa por el empaquetado (−0,0x mm) se lleva a 0.
  - Si un campo pasa de 500 mm en 6 h (o el CAPE de 10.000 J/kg), es un error de unidades: el cuadro no sale.
- **CAPE:** instantáneo a la hora válida. ECMWF y GFS dan MUCAPE; ICON, MLCAPE.

## El regrillado y el PNG

- **La malla de salida es la misma para las 3 fuentes:** 248 × 422 píxeles, lon −76 a −45 cada 0,125° y filas
  equiespaciadas en **Y de Web Mercator** entre −15 y −56. Así `L.imageOverlay` (o una fuente `image` de MapLibre) cae exacta.
  Una imagen equiespaciada en latitud se correría hasta ~1° en el medio.
- **Vecino más cercano en las 3 fuentes** (como `cdo remapnn`). No inventa valores ni baja los máximos.
  - **ECMWF y GFS:** la celda de 0,25° más cercana. Cada celda queda en 2 × 2 píxeles.
  - **ICON:** el centro de celda más cercano **sobre la esfera**, con un árbol KD de scipy sobre vectores 3D. Usa los CLAT/CLON
    que publica el DWD con cada corrida.
    - Se verifica que el `uuid` de la malla del campo sea el de CLAT/CLON.
    - Ningún píxel puede quedar a más de 25 km de su celda: en R03B07 la más cercana está siempre a menos de ~8 km.
  - No se usó CDO: con los pesos del DWD habría que bajar ~45–940 MB de mallas en cada corrida. El vecino más cercano sobre
    la esfera da lo mismo que `remapnn`, sin bajar nada más.
- **PNG en lugar de teselas:**
  - Un cuadro entero de la caja pesa **~2,6 KB** (medido con GFS real; un día de mucha lluvia, unos 10 KB).
  - La animación son 21 cuadros por variable y fuente: 21 pedidos, todos cacheables para siempre.
  - Con teselas serían cientos de pedidos por cuadro, para un dato que de por sí tiene 0,125–0,25° de resolución. Y
    `capturarCuadro(t)` de la R3 sale de una sola imagen.
- **El PNG va indexado:**
  - El índice 0 es transparente (debajo del primer umbral).
  - El índice k es el tramo k de la paleta.
  - Se escribe a mano con zlib, así los mismos datos dan los mismos bytes y la firma sólo cambia si cambia el dato.
  - Un valor faltante dentro de la caja hace que **el cuadro no se publique**. Nunca se pinta como «no llueve».

## [312c · 17/11] La grilla de VALORES (contrato R2 v2)

Va **junto** a cada cuadro v1, y el v1 no cambia. Sirve para que SATCHI dibuje el campo **suave**: interpola el valor y pinta
con la paleta continua DESPUÉS (el método de `_v795` de HN AGRO). El contrato está en [CONTRATO-R2-v2.md](CONTRATO-R2-v2.md).

- **Las claves:** `v2/{f}/{cc}/{var}/{fff}.val.png`, un PNG gris de 16 bits de 125 × 165 con los nodos de 0,25° de la caja,
  más su `.val.json`.
- **La codificación:** valor = q × escala (lluvia 0,01 mm; CAPE 1 J/kg). q = 65535 es «sin dato».
- **ECMWF y GFS:** el valor de la fuente en el nodo, sin remuestreo. **ICON:** el centro de celda más cercano al nodo.
- **El sobre** suma `valores`: las horas que tienen la v2.
- **Si falla la v2, el v1 queda.** Nunca se pisa una clave publicada, y la retención también borra `v2/`.
- **El peso:** ~12 KB por cuadro con datos sintéticos; real, estimado en 15-30 KB.
- **Los tests:** `test/test_valores.py`. El control negativo suma 11 mutantes de la v2 en `test/control_negativo.py`.

## Idempotencia, reintentos y retención

- **Una corrida terminada no se rehace.** Terminada quiere decir `completa`, o `parcial` con 3 intentos.
- En una `parcial` se hacen sólo los cuadros que faltan, en corridas distintas del workflow.
- **Un cuadro publicado no se reescribe nunca** (por eso la caché del borde puede ser de 7 días). [n3-312a 2] Eso no depende del sobre:
  - antes de bajar nada, se mira si el JSON del cuadro ya está en R2; si está, el cuadro se **recupera** (su firma va al sobre)
    sin bajar ni escribir. Así, si una pasada publicó cuadros y falló al guardar el sobre, la siguiente no los rehace;
  - el PNG y el JSON se escriben con `If-None-Match: *`: si la clave ya existe, R2 no la toca (412). Si el PNG que quedó es
    el mismo (falló sólo el JSON), se completa el JSON; si es otro, el cuadro queda faltante y no se pisa.
- Si nada cambió, el índice no se reescribe.
- **Corte por fallas:**
  - Si fallan 3 cuadros seguidos de una fuente, se corta esa fuente por esta pasada; las otras siguen.
  - Por pedido: a lo sumo **un** reintento, a los 2 s, y sólo ante un 5xx o un error de red.
  - Un 404 es «todavía no está»: no se reintenta.
- **R2 falla:** la corrida queda en rojo. **Una fuente no responde:** la corrida queda en verde, con el aviso, y la próxima
  pasada vuelve a probar.
- **Retención: las últimas 8 corridas completas de cada fuente (48 h).**
  - Alcanza para comparar con la corrida anterior y con la misma hora de ayer (la ECMWF llega 7 h tarde, así que con menos de
    un día se perdería esa comparación).
  - Ocupa ~10 MB en total.
  - La etapa 1 es para mirar el pronóstico, no para archivarlo: guardar más no le sirve al front y suma borrados.
- **Concurrencia:** un solo workflow, con `concurrency: colector-modelos`; nunca corren dos pasadas a la vez.

## Costo (medido o calculado con lo medido)

| | ECMWF | ICON | GFS |
|---|---|---|---|
| **Pedidos por corrida** | 63: 1 de disponibilidad + 21 `.index` + 20 rangos de `tp` + 21 de `mucape` | 45: 2 de disponibilidad + CLAT + CLON + 20 TOT_PREC + 21 CAPE_ML | 63: 1 + 21 `.idx` + 20 APCP + 21 CAPE |
| **Bajado por corrida** | ~13 MB (31 KB por `.index`) | ~100 MB (bz2) | ~18 MB |

- **Pedidos:**
  - Los cuenta el sobre (`pedidos`, `bytes_bajados`) y los imprime cada pasada, por host.
  - Van de a uno y con 0,5 s entre pedido y pedido.
  - El chequeo de cada hora hace 1 a 5 lecturas de R2 y, si hay corrida candidata, 1 o 2 HEAD por fuente.
- **Minutos de Actions:**
  - Una pasada sin trabajo dura ~20 s (checkout + Python + chequeo) y se cobra 1 min.
  - Con una corrida nueva de una fuente: + ~30 s de `pip install` y tests + ~40–60 s de pedidos (63 × 0,5 s de pausa) +
    decodificar. Son unos **2 min**.
  - Las 3 fuentes juntas, unos 4 min.
  - Por día: 12 corridas (3 fuentes × 4 ciclos), que caen en pasadas distintas porque las fuentes salen a horas distintas.
    Son ~12 × 2 + 12 × 1 ≈ **36 min/día**, unos **1100 min/mes**.
  - El repo es público: **no se cobra**. Ningún job se acerca a las 6 h: el tope está en 60 min.
  - Probado acá con los sintéticos: 3 corridas completas (123 cuadros) se arman en 2 s, sin red.
- **R2:**
  - **Por corrida:** 41 PNG (2–10 KB) + 41 JSON (~2 KB) + el sobre: **~0,2–0,5 MB por corrida y fuente**.
  - **Por día:** 12 corridas → ~3–6 MB escritos.
  - **Por mes:** ~**100–180 MB escritos**. Lo **guardado** se mantiene en **~10 MB** por la retención.
  - **Operaciones:** ~85 escrituras por corrida → ~1.000 por día, ~31.000 por mes. Las lecturas son las del chequeo
    (~24 × 5 por día). Todo lejos de los topes gratis de R2.

## Tests

`python -m unittest discover -s modelos/test -t modelos/test` corre 62 tests con GRIB **sintéticos**:
- tienen las mismas plantillas, parámetros, niveles y acumulaciones que se midieron en los archivos reales;
- van con empaquetado simple, para poder leerlos también sin ecCodes;
- se sirven con una red de mentira que imita los `.index`, los `.idx` y los `.bz2`.

No usan la red. En Actions corren con ecCodes; en una PC sin ecCodes, `MODELOS_GRIB_PURO=1` usa el lector puro, sólo para el
empaquetado simple.

Qué cubren, cada uno con su control negativo adentro:
- **El GRIB:** la cabecera, el mapa de bits de faltantes, los minutos de ICON, y que rechace otro paso, otra corrida, otro
  parámetro, algo que no es acumulación o un mensaje cortado.
- **El recorte:** sólo la caja; píxel por píxel contra la celda más cercana, con lon 0..360 y −180..180; filas norte→sur y
  sur→norte; la malla de Mercator. Si la caja no entra, falla.
- **La lluvia de 6 h:**
  - ECMWF e ICON por diferencia, y GFS con el balde directo;
  - la acumulada total no pasa por la de 6 h;
  - una acumulación equivocada (360–720 en vez de 0–720) no se publica;
  - [n3-312a 3] un **promedio** (proceso 0) con el mismo intervalo no pasa por acumulación: se exige plantilla 4.8 con un
    rango y proceso 1; la lluvia tiene que estar en **superficie** (tipo 1, sin segunda superficie) y cada CAPE en la suya
    (ECMWF 17, ICON 192, GFS 108/108 con 25500–0 Pa); un APCP isobárico o con segunda superficie se rechaza;
  - [n3-312a v2] los niveles se comparan en **valor físico** (valor × 10^(−factor de escala), Pa o m, con tolerancia):
    25500 con factor 1 (= 2550 Pa, 25,5 hPa) NO es el CAPE de 255-0 hPa y se rechaza; 2550 × 10¹ (factor −1) sí lo es y
    se acepta; la superficie de la lluvia tiene que valer 0 (o faltar) con cualquier escala;
  - un tp en mm en vez de m se rechaza.
- **El CAPE:** cada fuente el suyo. El GFS no toma el de superficie aunque venga antes en el `.idx`.
- **El regrillado de ICON:**
  - fuerza bruta sobre la esfera en 300 píxeles;
  - grados y radianes, lon 0..360;
  - otro uuid, celdas demasiado lejos o ninguna celda en la caja, todo falla.
- **La paleta:** los bordes de cada tramo; el PNG de ida y vuelta (transparencia y colores); los mismos bytes para el mismo
  campo; un NaN no se pinta; otro dato da otra firma; el CRC.
- **La tubería:** las claves, el sobre, los metadatos (cita, aviso, `cape_tipo`, `periodo`) y el índice; los pedidos por corrida.
  - **Idempotencia:** la segunda pasada hace 0 pedidos y 0 escrituras.
  - **Llave apagada:** 0 pedidos y 0 lecturas. Se probó con `''`, `no`, `off`, `1`, `true` y `sí`, y también desde el colector
    sin llaves de R2.
  - **Corrida parcial:** el cuadro que faltaba llega después, sin rehacer nada.
  - **Reintentos:** tope de intentos.
  - **Fuentes:** una caída no frena a las otras, y no se publica una corrida que la fuente no terminó.
  - **Retención:** se guardan 8 corridas y la novena sale de R2. Sin corrida nueva no se borra nada.
  - **Chequeo:** dice «hay trabajo» y después «nada», con 0 pedidos.
- **R2 y la red:** SigV4 contra el ejemplo publicado por AWS; el cliente R2 contra un servidor de mentira; el UA; los rangos;
  un 404 sin reintento; un 4xx sin reintento; un solo reintento.
  - [n3-312a 1] **un servidor que ignora el rango se corta ANTES de leer** (0 bytes leídos de un 200 de 1 MB): se exige 206 y
    un `Content-Range` igual al pedido, y se lee como mucho el largo pedido + 1.
- **Sin pisar:** si falla guardar el sobre, la pasada siguiente recupera los 41 cuadros sin bajar ni escribir nada; un PNG
  distinto ya publicado no se pisa; R2 manda `If-None-Match: *` y un 412 es «ya estaba».
- **En Actions** la suite corre ENTERA antes de colectar, con `MODELOS_EXIGIR_ECCODES=1` (sin ecCodes no arranca, nunca
  cae al lector puro); si un test falla, «Colectar» no corre.

**Control negativo contado:** `python modelos/test/control_negativo.py`. Rompe una cosa por vez en una copia de `lib/` y
`colector.py` y corre la suite: cada mutante tiene que hacerla fallar. Antes corre la copia sin romper, que tiene que pasar.
Resultado: **46 de 46 mutantes detectados** (con la copia sin romper en verde).

**Verificación con datos reales (una vez, sin subir nada):**
- GFS 16/11 12 UTC: el balde 6-12 h y el CAPE 255-0 de +12 h, decodificados con GDAL (en esta PC no se puede instalar ecCodes),
  pasaron por `recortar` → `regular_a_salida` → paleta.
- Dio máx. 60 mm y 2509 J/kg, y PNG de 2,6 KB. El CAPE alto cae sobre el norte argentino y Paraguay, y el corte está en los Andes.
- ECMWF e ICON (CCSDS) no se pudieron decodificar acá. Quedan verificados con sus cabeceras reales (malla, paso, acumulación,
  parámetro, nivel y uuid; ver la tabla del Paso 0), y la decodificación se prueba en la primera pasada en seco de Actions
  (LISTO-312a, paso 4).
