# MODELOS · CONTRATO R2 **v2** — la grilla de VALORES (312c · 17/11/2026)

Se suma al contrato v1 (`hn-cortex/docs/satchi-modelos-2026-11/CONTRATO-R2.md`). **No cambia el v1.** Cada cuadro v1 sigue igual
(PNG indexado por tramos + JSON). La v2 se publica **junto** a él, para que el front dibuje el campo **suave**:
- interpola el VALOR y aplica la paleta continua DESPUÉS;
- es el método de `_v795` de HN AGRO;
- el maker lo pidió el 17/11 («pixelado tipo Minecraft»; referencia visual TRP).

## 1. Las claves (depósito `satchi-modelos`)

```
v2/{fuente}/{corrida}/{variable}/{fff}.val.png    la grilla: PNG gris de 16 bits
v2/{fuente}/{corrida}/{variable}/{fff}.val.json   sus metadatos
```

`fuente`, `corrida`, `variable` y `fff` son los mismos del v1. La caché es la misma del cuadro v1: `public, max-age=86400, immutable`.

**Una clave publicada no se pisa nunca.** Se escribe con `If-None-Match: *`; si ya estaba, la tubería sólo sigue si la firma es la misma.

**El orden de escritura:** PNG v1 → JSON v1 → PNG v2 → JSON v2 → sobre → índice.
- **Si falla la v2**, el cuadro v1 queda publicado y la corrida puede estar `completa`: el front cae al v1 y lo dice.
- **La retención** borra `v1/{f}/{cc}/` y también `v2/{f}/{cc}/`.

## 2. El sobre de la corrida: `valores`

`v1/{f}/{cc}/corrida.json` suma:

```json
"valores": { "lluvia6h": [6, 12, …], "cape": [0, 6, …] }
```

Son las horas que **además** tienen su grilla v2. Siempre es un subconjunto de `cuadros`.
- El front pide la v2 sólo para esas horas.
- **Un sobre sin `valores`** (de antes de la v2) quiere decir que esa corrida no tiene v2.
- **`valores_fallan`** (misma forma) son las horas cuyo v1 está publicado pero cuya v2 no se pudo armar o publicar.
  - La v2 se arma **aparte y después** del v1: un error de la v2 nunca frena el v1.
  - Al recuperar un cuadro, leer su v2 tampoco tumba la corrida.

## 3. La grilla

- **Lat-lon regular de 0,25°** (EPSG:4326). Los **nodos** son:
  - lat de −15 a −56: 165 filas, **de norte a sur**;
  - lon de −76 a −45: 125 columnas, de oeste a este.
- **Cada valor es el del NODO (lat, lon).** Para leerlo:

  ```
  lat = −15 − 0,25 · fila      lon = −76 + 0,25 · columna
  ```

- **ECMWF y GFS** (0,25°): sus puntos están exactamente en los nodos. El valor es el de la fuente, **sin remuestreo**.
  - Una malla que no cae en los nodos es un error; no se remuestrea a escondidas.
- **ICON** (icosaédrica R03B07, ~13 km): a cada nodo le toca el valor del centro de celda más cercano sobre la esfera.
  - Es el mismo árbol KD del PNG v1, con el mismo tope de 25 km.
  - Es un muestreo, no un promedio.
- **La lluvia de 6 h y el CAPE** son los mismos del v1, con las mismas cuentas (§7 del v1): diferencias, ×1000 de ECMWF, MUCAPE o MLCAPE.

## 4. El PNG `.val.png`

- **Formato:** gris de **16 bits** (tipo de color 0, profundidad 16), sin entrelazado, de **125 × 165** (ancho × alto). La fila 0 es la del norte.
- **Por fila:** el byte de filtro va en 0 (la tubería escribe filtro 0; el front deshace los 5 filtros por las dudas). Los valores van big-endian.
- **valor = q × escala:**

  | variable | escala | unidades | tope de q |
  |---|---|---|---|
  | lluvia6h | 0,01 | mm | 65534 = 655,34 mm (la tubería corta en 500) |
  | cape | 1 | J/kg | 65534 (la tubería corta en 10000) |

- **q = 65535 es «sin dato» (NaN).** Hoy la tubería no publica cuadros con NaN (§6 del v1); el valor queda reservado.
  - El front **nunca** interpola un «sin dato» con sus vecinos ni lo toma como 0.
- **Un negativo pasa a 0.** Se redondea al más cercano.
- **El PNG se escribe a mano** (zlib, filtro 0): mismos datos → mismos bytes → misma firma.

**Peso medido:**
- Con campos sintéticos, ~12 KB por cuadro.
- Lo real se estima en 15-30 KB. Son 41 cuadros × 3 fuentes × 4 corridas por día, ≈ 5-15 MB por día.
- Con la retención de 8 corridas por fuente, ≈ 15-30 MB guardados.

## 5. El JSON `.val.json`

Lleva lo común con el JSON v1 del mismo cuadro, con los mismos valores:
`fuente`, `modelo`, `corrida`, `corrida_iso`, `hora_pronostico`, `valida_iso`, `variable`, `nombre`, `unidades`, `periodo`,
`parametro_fuente`, `cape_tipo`, `caja`, `resolucion_fuente`, `cita` y `aviso`. Además:

```json
{
  "v": 2,
  "paleta": "lluvia6h-continua-v2",          // o "cape-continua-v2"
  "valores": { "png": "012.val.png", "tipo": "PNG gris 16 bits (big-endian), sin filtro",
               "escala": 0.01, "sin_dato": 65535, "formula": "valor = q × escala; q = sin_dato → NaN" },
  "grilla": { "lat0": -15.0, "dlat": -0.25, "nlat": 165, "lon0": -76.0, "dlon": 0.25, "nlon": 125,
              "orden": "filas de norte a sur, columnas de oeste a este; cada valor es el del NODO (lat, lon)",
              "proyeccion": "EPSG:4326 (lat-lon regular)" },
  "regrillado": "…",
  "estadisticas": { "min": 0, "max": 87.4, "media": 1.9, "sin_dato": 0 },
  "firma": "sha256[:16] del .val.png",
  "firma_v1": "la firma del PNG v1 del mismo cuadro"
}
```

La function `modelos` de hn-agro lo valida antes de servirlo:
- la grilla exacta, la escala, el «sin dato», la paleta y las unidades;
- el cuadro, las horas, la caja, el período o tipo de CAPE, y la cita y el aviso de esa fuente, con la regla del v1.

Uno que no coincide es «sin dato» (no-store).

## 6. Las paletas continuas (las aplica el FRONT, después de interpolar)

**Lo que hace el front:**
- Interpola el valor bilineal entre nodos (`bilineal()` de `_v795`, tal cual).
- Colorea por tramos lineales en RGB entre estas paradas (`colorVel()` de `_v795` con la paleta como parámetro). Arriba del último valor, el último color.
- **El umbral:** debajo del primer valor no se pinta. Entre los dos valores el alfa sube con smoothstep, sin contorno duro.

**`lluvia6h-continua-v2`** (mm en 6 h) · umbral 0,3 → 0,6 · marcas 0,3 · 10 · 20 · 30 · 40 · 50

| mm | 0,3 | 2 | 5 | 10 | 20 | 27 | 34 | 42 | 50 |
|---|---|---|---|---|---|---|---|---|---|
| RGB | 33,72,216 | 43,143,240 | 34,195,230 | 47,207,106 | 242,227,58 | 245,160,32 | 232,69,44 | 208,42,110 | 184,47,208 |

**`cape-continua-v2`** (J/kg) · umbral 100 → 250 · marcas 100 · 1000 · 2000 · 3000 · 4000

| J/kg | 100 | 500 | 1000 | 1500 | 2000 | 2500 | 3000 | 4000 |
|---|---|---|---|---|---|---|---|---|
| RGB | 33,72,216 | 34,195,230 | 47,207,106 | 242,227,58 | 245,160,32 | 232,69,44 | 208,42,110 | 184,47,208 |

**«Valores en este punto»:** la lectura sale del **nodo más cercano**, la celda original sin interpolar. Es un número, no un tramo.

## 7. Cómo se sirve

```
GET /.netlify/functions/modelos/v2/{fuente}/{corrida}/{variable}/{fff}.val.json|png
```

Es la misma function y la misma caché inmutable del cuadro v1. Lo imposible es 404 sin ir a R2. Lo roto es 503 no-store.

## 8. [312d · 17/11] EL VIENTO (u y v): sólo v2

Para el viento animado de MODELOS en SATCHI: el método de `_v795` de HN AGRO (el campo de color suave por velocidad y los trazos
advectados sobre u/v interpolados). **No hay cuadro v1 de viento.**

**Las claves** (la variable es el nivel):

```
v2/{fuente}/{corrida}/viento10m|viento850|viento250/{fff}.val.png
v2/{fuente}/{corrida}/viento10m|viento850|viento250/{fff}.val.json
```

- **Las horas:** ECMWF y GFS cada 6 h de 0 a 120; ICON cada 12 h de 0 a 120 (el peso, abajo).
- **El PNG:** gris de 16 bits, sin entrelazado, de **125 × 330**. Las filas 0-164 son **u** y las 165-329 son **v**, con los mismos
  nodos de la §3 (de norte a sur). **u = hacia el ESTE, v = hacia el NORTE**, en m/s, instantáneo a la hora válida.
- **valor (m/s) = (q − 32768) × 0,1** (de −3276,8 a +3276,6). q = 65535 es «sin dato» (el front no lo interpola con los vecinos).
- **Los valores:** ECMWF y GFS, el de la fuente en el nodo, sin remuestreo; ICON, el centro de celda más cercano (las U y V del
  open data del DWD son geográficas, en el centro de la celda). Todos son respecto del norte geográfico.
- **Lo que se pide a cada fuente:**

  | | 10 m | 850 hPa | 250 hPa |
  |---|---|---|---|
  | ECMWF (`.index` + rango) | `10u` / `10v`, levtype `sfc` | `u` / `v`, levtype `pl`, levelist `850` | ídem `250` |
  | GFS (`.idx` + rango) | `UGRD` / `VGRD` «10 m above ground» | «850 mb» | «250 mb» |
  | ICON (un `.bz2` por archivo) | `U_10M` / `V_10M` (single-level) | `U` / `V` pressure-level `_850_` | ídem `_250_` |

  En la cabecera se verifica el parámetro (0/2/2 y 0/2/3), el paso y el NIVEL en valor físico (103 = 10 m; 100 = 85000 o 25000 Pa).
  Un viento de más de 150 m/s es un error de unidades: ese cuadro no sale.

**El JSON** (`.val.json`) lleva lo común de la §5 (fuente, modelo, corrida, horas, caja, resolución, cita y aviso, con la misma
regla) y además:

```json
{ "v": 2, "variable": "viento850", "nombre": "Viento en 850 hPa (~1500 m)", "nivel": { "tipo": "isobárico", "hPa": 850 },
  "unidades": "m/s", "paleta": "viento-continua-v2", "periodo": null, "cape_tipo": null,
  "componentes": "u = hacia el este, v = hacia el norte (m/s); el rumbo «de dónde viene» es atan2(−u, −v)",
  "valores": { "png": "012.val.png", "escala": 0.1, "cero": 32768, "sin_dato": 65535, "componentes": ["u", "v"],
               "formula": "valor = (q − cero) × escala; q = sin_dato → NaN" },
  "grilla": { …la de la §5… }, "estadisticas": { "vel_max": 41.2, "vel_media": 9.8, "sin_dato": 0 }, "firma": "…" }
```

**El sobre** suma `viento` (las horas publicadas por nivel), `viento_fallan`, `viento_intentos` y `pedidos_viento`/`bytes_viento`.
Un sobre sin `viento` quiere decir que esa corrida no tiene viento: el front lo dice, no dibuja un mapa vacío.

**El v1 sale SIEMPRE:**
- El viento va en una **segunda fase**, cuando el v1 de TODAS las fuentes ya está publicado y su sobre escrito.
- Cada cuadro de viento tiene su try; la fase entera, otro. Ningún error del viento (bajar, armar, publicar, uno inesperado) toca un
  cuadro v1, su sobre ni el índice.
- **Topes:** 3 fallas seguidas cortan el viento de esa fuente por esta pasada; 20 min para toda la fase (`VIENTO_TOPE_S`); 3
  pasadas por corrida (`viento_intentos`).
- El índice se escribe DESPUÉS de la fase, para que el sobre que guarda la caché del borde ya traiga el viento. Por eso los topes:
  el índice (lo que hace visible el v1) se demora, como mucho, eso.

**El peso medido** (HEAD y los índices de la corrida 17/11 00 UTC):

| | por mensaje o archivo | por hora (6) | por corrida |
|---|---|---|---|
| ECMWF (rango) | 0,48-0,74 MB | ~3,7 MB | 21 h → **~78 MB** |
| GFS (rango) | 0,56-0,96 MB | ~4,2 MB | 21 h → **~88 MB** |
| ICON (`.bz2` entero) | 3,4-3,9 MB | ~22 MB | **cada 12 h:** 11 h → **~240 MB** (cada 6 h serían ~460 MB) |

- Los `.index`/`.idx` de ECMWF y GFS ya se bajaron para el v1: el viento suma sólo los rangos (126 pedidos por corrida; ICON 66).
- **R2:** con los sintéticos, ~5,5 KB por cuadro; real, estimado en 30-60 KB. Son 3 niveles × (21 + 11 + 21) × 4 corridas ≈ 640
  cuadros por día, ≈ 20-40 MB por día; con la retención de 8 corridas, ≈ 40-80 MB guardados.
- **Para apagarlo sin tocar código:** la variable `MODELOS_VIENTO` del repo (`no`, o la lista de fuentes, p. ej. `ecmwf,gfs`).
