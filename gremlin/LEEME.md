# gremlin · GREMLIN (CIRA/RAMMB SLIDER) sobre la Argentina, en R2, cada 10 min (311)

**Qué es GREMLIN:** radar sintético de CIRA, estimado desde GOES-19 (ABI + GLM) con una red neuronal entrenada en EE. UU. contra MRMS. **No es radar.** SLIDER lo publica cada 10 min, pero guarda sólo unas 17 h. Este colector lo guarda para validarlo después contra los casos de granizo y el radar.

**Cita:** «GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER · GREMLIN (CIRA)». Va en cada sobre.

## Los nombres exactos (leídos el 16/11/2026)

De `https://slider.cira.colostate.edu/js/define-products.js` y de `latest_times.json`:

| Qué | Valor |
|---|---|
| satélite | `goes-19` («GOES-19 (East; 75.2W)») |
| sector | `full_disk` (`max_zoom_level` 5, `tile_size` 678, cada 10 min) |
| producto | `gremlin` («GREMLIN (CIRA)», `zoom_level_adjust` 2, `resolution` «2 km») |
| zoom nativo | **3** = 5 − 2 (en `imagery_resolutions`, el 3 es «2 km») |
| tiempos | `https://slider.cira.colostate.edu/data/json/goes-19/full_disk/gremlin/latest_times.json` → `{ "timestamps_int": [20261117003000, …] }`, 100 tiempos del más nuevo al más viejo (~17-18 h, con algún hueco) |
| tesela | `https://slider.cira.colostate.edu/data/imagery/AAAA/MM/DD/goes-19---full_disk/gremlin/AAAAMMDDhhmmss/03/FFF_CCC.png` (fila_columna, con 3 cifras) |

Una tesela es un PNG de 678×678 con paleta de 8 bits (la de `mrms_merged_base_reflectivity_qc`) y fondo transparente. Viene con `Cache-Control: public, immutable`. Se probaron dos: 59,6 KB (`006_004`) y 40,2 KB (`005_005`), las dos del 17/11 a las 00:30 UTC, con tormentas en el NEA.

## El recorte

- **Caja:** la misma de rayos-hora: lat −56,5 a −20 y lon −76,5 a −52.
- **Geometría:** la proyección geoestacionaria de la grilla fija de ABI, con los números de `lat_lon_query` de SLIDER (`lon0` −75,0, `sat_alt` 42171,7 km, `max_rad_x` 0,151337, `max_rad_y` 0,150988). Al zoom 3, la imagen del disco mide 678 × 8 = 5424 px, que es la grilla de 2 km de ABI.
- La caja toca **9 teselas: las filas 5 a 7 y las columnas 3 a 5**. Por ejemplo, Córdoba cae en `006_004`, Ushuaia en `007_004`, La Quiaca en `005_004` e Iguazú en `005_005`.
- Las teselas traen también algo de Chile, Bolivia, Paraguay, Uruguay, el sur de Brasil y el mar. Es lo que trae la tesela; no se recorta el PNG.

## Qué hace una corrida

1. **La llave.** Sin `GREMLIN_ON=si`, la corrida no pide nada ni toca R2.
2. **Pide `latest_times.json`, un pedido.** Si SLIDER no responde o la respuesta no sirve:
   - lo anota en `gremlin/alertas.txt`;
   - no guarda ningún tiempo;
   - termina en verde, y la corrida siguiente vuelve a probar.
3. **Qué falta.** Lee el índice de cada día de la lista y toma los tiempos de SLIDER que:
   - tienen menos de 18 h;
   - no están completos;
   - y no agotaron los 4 intentos.
   Van **del más viejo al más nuevo**, porque los viejos son los primeros que SLIDER borra.
4. **Cada tiempo, entero o nada.** Si sus teselas no entran en el tope de la corrida, el tiempo queda para la próxima. Para cada tiempo:
   - Pide sólo las teselas que no estén guardadas: las 9, o las faltantes de una corrida anterior.
   - Antes, lista la carpeta del tiempo en R2 y **adopta las teselas que quedaron de una corrida cortada a mitad**, si validan (311b). Así no se vuelven a bajar.
   - Una tesela se guarda sólo si cumple todo esto:
     - HTTP 200;
     - el tamaño coincide con el anunciado;
     - es un **PNG válido según la especificación, para paleta** (tipo 3, lo que trae SLIDER). Ver «Qué valida el PNG», abajo.
   - Si no, queda en `faltantes` con el motivo, y **en su clave no se escribe nada**.
   - Escribe el sobre del tiempo y actualiza el índice del día.
5. **Resumen:** imprime sólo cantidades (el registro de Actions es público).

**Un faltante** se reintenta en la corrida siguiente, y se pide sólo esa tesela. Se reintenta hasta 4 corridas por tiempo, mientras SLIDER lo siga listando. Después el tiempo queda `incompleto` para siempre. **En las zonas faltantes no se sabe nada: no es «sin ecos».**

## Cortesía con SLIDER

- UA `hn-colector/1.0` en cada pedido.
- **1 s** entre pedido y pedido.
- **Tope de pedidos por corrida:** 60 por defecto (latest_times incluido). A mano se puede poner de 10 a 300.
- En el día a día, una corrida hace 10 pedidos: la lista y las 9 teselas de un tiempo.
- **Corte inmediato:** con un 429 o un 403, o con 3 fallas seguidas de red o 5xx. Lo que no se pidió queda faltante, y se anota la alerta.
- No hay reintentos dentro de una misma corrida.

## Qué queda en R2 (depósito `R2_BUCKET`, privado)

```
gremlin/AAAA/MM/DD/AAAAMMDDhhmmss/03/FFF_CCC.png   una tesela (el PNG tal cual vino de SLIDER)
gremlin/AAAA/MM/DD/AAAAMMDDhhmmss/sobre.json        el sobre del tiempo
gremlin/AAAA/MM/DD/indice.json                      el índice del día
gremlin/alertas.txt                                 una línea por novedad (las últimas 500)
```

El día de la clave es el **día UTC del tiempo de SLIDER**, no el de la corrida.

**Sobre** (`sobre.json`):

```json
{
 "v": 1, "producto": "gremlin", "titulo": "GREMLIN (CIRA)", "satelite": "goes-19", "sector": "full_disk",
 "zoom": 3, "resolucion": "2 km", "tesela_px": 678,
 "caja": { "lat_min": -56.5, "lat_max": -20, "lon_min": -76.5, "lon_max": -52 },
 "teselas_esperadas": ["005_003", "…", "007_005"],
 "fuente": { "nombre": "CIRA/RAMMB SLIDER", "producto": "GREMLIN (CIRA)", "url": "…", "url_tiempos": "…", "url_teselas": "…",
             "cita": "GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER · GREMLIN (CIRA)",
             "aclaracion": "Radar sintético estimado desde satélite (ABI + GLM), entrenado en EE. UU. contra MRMS: no es radar." },
 "tiempo": "2026-11-17T00:30:00Z", "tiempo_slider": "20261117003000",
 "estado": "completo | incompleto", "intentos": 1,
 "teselas": [{ "fila": 5, "col": 3, "clave": "gremlin/…/03/005_003.png", "bytes": 40191, "sha256": "…" }],
 "faltantes": [{ "fila": 6, "col": 4, "motivo": "HTTP 404" }],
 "generado": "…", "nota": "…"
}
```

**El índice del día** (`indice.json`) lleva la misma cabecera y, además, `tiempos`:

```
{ "AAAAMMDDhhmmss": { "estado", "n", "faltantes": ["FFF_CCC"], "intentos", "sobre" } }
```

La idempotencia sale de acá:
- un tiempo `completo` no se vuelve a pedir;
- de uno `incompleto` se piden sólo sus faltantes.

## Workflow, secretos y llave

- **Workflow:** `gremlin/gremlin.workflow.yml.txt`. Para instalarlo hay que copiarlo a `.github/workflows/gremlin.yml`. Viene como `.txt` porque el token de pc-nanci no tiene el permiso `workflow`.
- **Horario:** cron `4,14,24,34,44,54 * * * *`. `timeout-minutes: 9`, y `concurrency` evita que corran dos a la vez.
- **Secretos:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET`. Son los mismos de rayos-hora y del SHN, y ya están cargados en el repo. Nunca se imprimen.
- **Llave:** la **variable** del repo `GREMLIN_ON`. **Nace apagada:** no existe hasta que se crea. Mientras no valga `si`, el `schedule` no corre.
- **A mano:** Actions → colector-gremlin → Run workflow.
  - `modo: seco` hace un pedido y cuenta lo pendiente, sin bajar ni guardar.
  - `modo: real` baja y guarda. Acepta `tope` (10 a 300).
- **Sin dependencias:** no hay `npm ci`. El cliente R2 es el de `rayos-hora/lib/almacen.mjs`, que se importa (el checkout es sparse, con `rayos-hora/lib` y `gremlin`).

### Probar sin R2

```
GREMLIN_ON=si MODO=seco ALMACEN_CARPETA=/una/carpeta node gremlin/gremlin.mjs
```

Probado así el 16/11 a las 22:05 ART:

```
gremlin (SECO): 100 tiempos en SLIDER · 95 por bajar · 9 teselas por tiempo · no bajo ni guardo nada
```

## Costo estimado

| Qué | Cuánto |
|---|---|
| Teselas por tiempo | **9** (zoom 3, 2 km) |
| Peso por tiempo | ~450 KB, con 50 KB por tesela (medidas: 40 y 60 KB con tormentas; con cielo limpio pesan menos), más un sobre de ~3 KB |
| Por día (144 tiempos) | **~65 MB** (entre ~40 y ~90 MB, según cuánta convección haya) |
| Por mes / por año | ~2 GB / **~24 GB** |
| R2 gratis | 10 GB, compartidos con rayos-hora (0,5 a 1,6 GB por año): **se llenan en unos 4 o 5 meses.** Después, US$ 0,015 por GB y por mes: al año, unos 14 GB de más, ≈ US$ 0,21 por mes, y sigue creciendo. Conviene decidir una regla de ciclo de vida en R2 (por ejemplo, borrar a los 90 días, salvo los días de casos de granizo) |
| Operaciones en R2 | por corrida, ~11 escrituras y ~4 lecturas: ~1.600 escrituras por día, ~48.000 por mes (el plan gratis da 1 millón) |
| Pedidos a SLIDER | 10 por corrida, **1.440 por día**, ~65 MB por día |
| Minutos de Actions | una corrida dura ~20-30 s (sparse checkout, Node, 10 pedidos con 1 s de pausa) y se cobra **1 min**: **144 min por día**, ~4.300 por mes. El repo es público, así que **no se cobran** |
| Ponerse al día al prender | ~95 tiempos × 9 = ~855 teselas. Con el tope de 60 entran 6 tiempos por corrida, unas 16 corridas (~2,7 h): en ese lapso se pierden los tiempos más viejos. Si no se quiere perderlos, una corrida a mano con `tope: 300` hace 33 tiempos en ~5 min, así que 3 corridas a mano bastan |

## Revisión de Codex (311b, n3-311b-1611): corregido

- **[P1] PNG de verdad.** El validador ahora mira el CRC de cada chunk y descomprime el IDAT. Un IDAT corrupto, aunque tenga el mismo largo y el mismo IEND, queda faltante.
- **[P1] Corte a mitad.** La corrida siguiente adopta de R2 las teselas ya guardadas que validan, con su sha256, y baja sólo las que faltan.
- **[P1, 2.ª vuelta, n3-311b-v2] La paleta.** Una PLTE vacía pasaba. Ahora se valida todo lo de «Qué valida el PNG»:
  - hay un test por cada caso inválido (20 casos);
  - de esos 20, el validador de la v2 (2976a887) dejaba pasar 16.
- **Visibilidad del disco:** se compara `sx·(H − sx)` (antes decía `H·(H − sx)`). El test usa un punto a 81,4° del subsatélite.

## Qué valida el PNG (`motivoTeselaMala`, en lib/slider.mjs)

- **Firma y chunks:** cada chunk entero, con un nombre legible y su CRC. Un chunk crítico desconocido (con mayúscula inicial) lo invalida.
- **IHDR:**
  - primero, uno solo y de 13 bytes;
  - 678×678;
  - **tipo de color 3 (paleta)**, con una profundidad válida para ese tipo (1, 2, 4 u 8);
  - compresión 0, filtro 0 y sin entrelazado.
- **PLTE:**
  - una sola, **antes del IDAT**;
  - con un largo múltiplo de 3;
  - con entre 1 y min(256, 2^profundidad) entradas.
- **tRNS (si está):** una sola, después de la PLTE y antes del IDAT, con **no más entradas que la PLTE**.
- **IDAT:**
  - al menos uno, y todos seguidos;
  - se descomprime entero con zlib y da justo alto × (1 + bytes por fila);
  - cada fila trae un filtro de 0 a 4;
  - **se deshace el filtro, y todos los índices de píxel tienen que ser menores que la cantidad de entradas de la PLTE.**
- **IEND:** último, vacío, y nada después.

## Tests

```bash
cd gremlin
npm test                          # 44 tests, sin red: SLIDER de mentira y almacén en carpeta
node test/control-negativo.mjs    # 55 de 55 mutantes detectados
```

Qué cubren:
- **Las claves y las URLs.** Las URLs son las probadas a mano. El día de la clave es el UTC del tiempo, y se rechazan los tiempos imposibles.
- **El recorte:**
  - las 9 teselas exactas;
  - puntos conocidos de adentro y de afuera;
  - la antípoda queda fuera del disco;
  - en una corrida se piden sólo esas 9, al zoom 3.
- **El sobre y el índice:** todos los campos, la cita, los bytes y el sha256.
- **La idempotencia:** una segunda corrida hace un solo pedido y no escribe nada; con un tiempo nuevo, baja sólo ése.
- **Un faltante:**
  - un 404 queda como faltante y no deja nada en su clave;
  - la corrida siguiente pide sólo esa tesela y el tiempo queda completo;
  - no se guarda basura: un HTML con 200, un PNG cortado, uno de otro tamaño o uno con tamaño distinto del anunciado. Hay una tesela real de SLIDER como fixture.
- **Los intentos:** el tope de 4 por tiempo y la ventana de 18 h.
- **El tope de pedidos:** un tiempo entra entero o espera, se empieza por el más viejo y el tope se acota.
- **La cortesía:** el UA y 1 s entre pedidos. Un 429 corta, y 3 fallas de red seguidas también. Con SLIDER caído se anota la alerta y no se escribe ningún tiempo.
- **La llave apagada** (sin valor, `''`, `no`, `SI`, `true`): ni un pedido ni una lectura de R2. Con `si`, sí pide (control).
- **Seco:** un solo pedido y nada guardado.
- **El workflow:** nace apagado, a mano corre en seco y usa los 4 secretos R2.

**Control negativo contado:** `node test/control-negativo.mjs`.
- Rompe a propósito una cosa por vez, en una copia de `lib/`. Hay 55 mutantes, de las claves, el recorte, la idempotencia, los faltantes, el tope, la cortesía, la llave y el sobre.
- Cada mutante tiene que hacer fallar al menos un test.
- Antes corre la copia sin romper, que tiene que pasar entera.
