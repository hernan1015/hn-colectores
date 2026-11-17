# metar · los METAR de los aeropuertos argentinos, con el granizo (GR/GS) parseado, en R2 (317)

**Para qué:** el METAR (y el SPECI) es la **observación oficial** del aeródromo, hecha por el observador del SMN o la estación automática. Cuando cae granizo en el aeropuerto, el parte lo dice (`GR`, `GS`, `+TSGR`, o `REGR` en el parte siguiente). Es **verdad de campo gratis** para validar el ojo del granizo de SATCHI, y una marca pública para el mapa («granizo observado en el aeropuerto X a las HH:MM»).

**La idea es de [familygw/chusmeteo](https://github.com/familygw/chusmeteo)** (MIT): una app de terminal argentina centrada en el granizo, que lee METAR con `GR` de aviationweather.gov. Se vio en el estudio de la 315 (`hn-cortex/docs/satchi-granizo-2026-11/315-ESTUDIO-CODIGO-ABIERTO.md`). **No se copió código de chusmeteo:** el parser y el colector son propios.

**Cita:** «METAR · aviationweather.gov (NOAA)». Va en cada parte guardado y en el derivado público. El dato es de NOAA/NWS (Aviation Weather Center), de dominio público; el parte en sí es del SMN (la red OACI).

## La fuente (leída el 17/11/2026)

- **La API:** `https://aviationweather.gov/api/data/metar` (la «Data API» de aviationweather.gov, sin llave). Documentación: `https://aviationweather.gov/data/api/` y la OpenAPI `https://aviationweather.gov/data/schema/openapi.yaml`.
  - `ids`: una lista de OACI **separada por comas** (también `@XX` para un estado de los EE. UU.). `format=json`. `hours`: horas hacia atrás. `date`: la hora final (`aaaammdd_hhmm` o ISO).
  - **Lo que pide la documentación:** «100 requests per minute» como máximo; «set a custom user agent»; «keep requests limited in scope and frequency»; «Most endpoints return a maximum of 400 entries»; para consultas grandes, los archivos de caché.
  - **La historia:** «up to the previous 30 days of data». **Probado el 17/11:** con `date=20261117_0000&hours=10` devolvió los partes del 16/11 de 14 a 24 UTC (119 partes de 9 estaciones).
- **La lista de aeropuertos:** `https://aviationweather.gov/data/cache/stations.cache.json.gz` (la caché de estaciones, se actualiza una vez por día), filtrada a `icaoId` que empieza con `SA`, `country = AR` y `siteType` con `METAR`. **Son 93.** Queda afuera SAWB (Marambio, `country AQ`). Está escrita en `lib/estaciones.mjs`, con la fecha.
- **Pedidos de exploración a aviationweather: 5** (la página de la API, la OpenAPI, la caché de estaciones, las 93 estaciones de las últimas 2 h y la historia del 16/11). Las dos respuestas de METAR quedaron como fixtures en `test/datos/`.

## Qué hace una corrida (cada 30 min)

1. **La llave.** Sin `METAR_ON=si`, la corrida no pide nada ni toca R2.
2. **UN pedido** con las 93 estaciones juntas y las últimas **3 h** (`hours=3`): cubre el atraso del cron de GitHub y los SPECI que salen entre hora y hora. El 17/11 a las 03 UTC, 2 h dieron 94 partes de 42 estaciones (las que no son de 24 h no dan parte de noche).
   - Si la respuesta llega a **400** (el tope de la API), puede estar cortada: se parte la lista en dos y se piden las mitades (2 pedidos más). Si el tope de la corrida no deja, se guarda lo que vino, se anota la alerta y **no se revisan las horas** (para no inventar faltantes).
3. **Cada parte se guarda UNA vez.** La clave lleva la estación, la hora del parte y un sha256 del texto. Correr dos veces no escribe nada nuevo. Una corrección (`COR`) es otro texto: otra clave. Un parte que quedó escrito por una corrida cortada antes del índice se adopta, no se reescribe.
4. **Los faltantes.** Por cada hora cerrada de la ventana, el índice del día anota qué estaciones tienen parte (`con_dato`) y cuáles no (`sin_dato`). **Una estación sin parte es «sin dato», nunca «sin granizo».** Un parte que llega tarde pasa la estación a `con_dato`; lo que tenía dato no se borra.
5. **El derivado público** para SATCHI: `metar/v1/ultimas.json` (las últimas 24 h): la última hora leída de cada estación (`null` = sin dato) y los partes con granizo, con su texto crudo.
6. **Resumen:** sólo cantidades (el registro de Actions es público).

**La API caída** (5xx, red, una respuesta que no es JSON): se anota en `metar/alertas.txt`, no se guarda ningún parte ni índice y la corrida termina en verde. La siguiente vuelve a probar (y como pide 3 h, recupera lo de la anterior).

## Cortesía con aviationweather

- UA `hn-colector/1.0` en cada pedido.
- **2 s** entre pedido y pedido (la API admite 100 por minuto; acá, como mucho 30).
- **Tope por corrida:** 3 pedidos (1 a 10 a mano). En el día a día, **1 pedido cada 30 min = 48 por día**.
- **Corte inmediato:** con un 429 o un 403, o con 3 fallas seguidas. Sin reintentos dentro de la corrida.

## El relleno (la historia de 30 días)

`modo: relleno` pide de a **3 h** (93 estaciones × 3 h ≈ 150-300 partes, debajo de 400), **del más viejo al más nuevo** (lo más viejo es lo primero que la API deja de tener), con un tope de 30 pedidos por corrida (hasta 120). Lo hecho queda en `metar/relleno.json` y no se vuelve a pedir. 30 días son 240 tramos: **8 corridas de 30**, o 2 de 120.

**Los casos del granizo (3/11, 13-14/11 y 16/11) todavía están dentro de los 30 días.** El del 3/11 sale de la API el **3/12**: hay que correr el relleno antes.

## Qué queda en R2

**Privado (`R2_BUCKET`, los secretos de rayos-hora y gremlin):**
```
metar/AAAA/MM/DD/<OACI>/<hhmm>-<METAR|SPECI>-<sha8>.json   un parte: el crudo, lo parseado y el objeto de la API entero
metar/AAAA/MM/DD/indice.json                                el índice del día: los partes (con el crudo de los que tienen granizo) y las horas con y sin dato
metar/relleno.json                                          los tramos del relleno ya hechos
metar/alertas.txt                                           una línea por novedad (las últimas 500)
metar/validacion/<días>.md y .json                          la tabla de validación (workflow metar-validacion)
```
El día de la clave es el **día UTC del parte**, no el de la corrida.

**Público (`METAR_DEPOSITO_PUBLICO`, `satchi-metar` por defecto, con los secretos `R2_OPERA_*`):**
```
metar/v1/ultimas.json      { v, generado, ventana_h: 24, fuente, estaciones: [{ id, nombre, lat, lon, ultima }], granizo: [{ estacion, nombre, lat, lon, hora, tipo, observado, reciente, en_rmk, tipos, grupos, crudo }], nota }
```
`Cache-Control: public, max-age=300`. Lo lee la function `metar-granizo` de hn-agro (por https, sin llaves, desde `SATCHI_METAR_URL_BASE`).

## El parser (`lib/metar.mjs`)

- **El tiempo presente** según la OMM (WMO-No. 306, FM 15/16, tabla 4678): intensidad o `VC`, descriptor (`TS`, `SH`, …) y fenómenos. `GR` = granizo, `GS` = granizo pequeño. Cuenta en cualquier lugar del grupo: `+TSSHGRRA`, `+TSRAGR`, `SHGS`.
- **El reciente:** `REGR`, `REGS` (y `RE TSRA` con espacio, como lo mandan algunas estaciones argentinas). Cayó desde el parte anterior: como mucho, la hora anterior.
- **No es granizo:** `VCTS` (tormenta en las cercanías), los `CB` de las nubes, y **todo lo que viene en la tendencia** (`BECMG`, `TEMPO`, `NOSIG`): es un pronóstico a 2 h.
- **Las RMK** al estilo FMH-1 (EE. UU.): el tamaño (`GR 1 3/4`, `GR LESS THAN 1/4`) y el comienzo y fin (`GRB37E46`). En la Argentina casi no se usan; se leen igual. El `RMK` pegado al grupo anterior (`Q1009RMK`, real) se separa.
- **Medido con los 213 partes reales de los fixtures:** el granizo presente coincide con el `wxString` de la API en todos. **Una diferencia a favor:** el decodificador de la API toma `RE TSRA` (San Luis, 16/11 18:40) como tormenta presente; el nuestro, como reciente.

## La validación del ojo (`validar-ojo.mjs`, `lib/validacion.mjs`)

El mismo criterio de los casos del 13/11, 14/11 y 16/11: una celda **destacada** (las 3 patas) a **≤ 30 km** del aeropuerto, en **±30 min** de la hora del parte (para `REGR`, desde 1 h antes). ACIERTO, PÉRDIDA o **SIN DATO** (sin barrido del ojo en la ventana, o el aeropuerto fuera de su zona: nunca cuenta como pérdida). Al revés: una destacada cerca de un aeropuerto con parte **sin** granizo es «no confirmada por el METAR» (no «falsa alarma»: el METAR mira unos pocos km).

- **En Actions:** el workflow `metar-validacion` (a mano, con los días) baja los barridos de la release `granizo-AAAA-MM-DD` de hn-radar (`RADAR_TOKEN`), lee los índices METAR de R2 y guarda la tabla en R2 privado.
- **Con fixtures:** `node metar/validar-ojo.mjs --barridos <carpeta> --api <respuesta.json> --md tabla.md`.

## Instalar (en este orden)

1. **El depósito público:** crear `satchi-metar` en R2 (o elegir otro y cargar la variable `METAR_DEPOSITO_PUBLICO`), con acceso público de lectura, y que el token de `R2_OPERA_*` pueda escribir en él (como se hizo con `satchi-rayos`). **No hay secretos nuevos:** se usan `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (privado) y `R2_OPERA_CUENTA`, `R2_OPERA_ACCESS_KEY_ID`, `R2_OPERA_SECRET_ACCESS_KEY` (público), que ya están.
2. **Mergear** el PR a `main` (GitHub corre el `schedule` sólo desde la rama principal).
3. **Instalar los workflows** desde una sesión con el permiso `workflow`:
   ```bash
   cp metar/metar.workflow.yml.txt            .github/workflows/metar.yml
   cp metar/metar-validacion.workflow.yml.txt .github/workflows/metar-validacion.yml
   git add .github/workflows/metar*.yml && git commit -m "ci(metar): instala el colector y la validación (317) [skip netlify]" && git push
   ```
4. **Seco:** Actions → colector-metar → Run workflow → `modo: seco`. Tiene que decir `metar (SECO): 1 pedido(s) · N partes · M estaciones con parte · … · no guardo nada`.
5. **Real a mano** (`modo: real`) y mirar `metar/AAAA/MM/DD/indice.json` y `metar/v1/ultimas.json`.
6. **Relleno** (`modo: relleno`, tope 120, dos veces): los 30 días de la API, **antes del 3/12** para que entre el 3/11.
7. **Prender la llave:** la variable `METAR_ON` = `si`. **Apagar:** borrarla o ponerla en `no`.
8. **Validar:** Actions → metar-validacion → `dias: 2026-11-13,2026-11-14,2026-11-16`.

## Tests

`npm test` (dentro de `metar/`): **34 tests**, sin red (ver la 2.ª y la 3.ª vuelta).
- **El parser:** GR, GS, `+TSGR`, `+TSSHGRRA` y `REGR` reales de Río Cuarto (16/11), `VCTS` real de San Rafael, `RE TSRA` y `COR` reales de San Luis, la tendencia real de Córdoba, el ejemplo de `rawOb` de la OpenAPI de la API (KORD … RMK AO2 SLP162 VIRGA OHD …) y las RMK de granizo del FMH-1. Los 213 partes reales de los fixtures.
- **El colector:** el pedido único con las 93 estaciones, el UA, las claves, la idempotencia (dos corridas, el COR y la corrida cortada), los faltantes (y el que llega tarde), los descartados, el tope de 400 (partir o truncar sin faltantes falsos), la API caída, el 429, la pausa, la llave, el seco, el relleno y el derivado público.
- **La validación:** ACIERTO, PÉRDIDA y SIN DATO con ±30 min y ≤ 30 km, la ventana del `REGR` y las «no confirmadas».
- **Control negativo contado:** `npm run mutantes`. 35 mutantes (el parser, el pedido, la cortesía, la idempotencia, los faltantes, la llave, el relleno, el público y la validación): **35 de 35 detectados**.

## 2.ª vuelta (Codex n3-317col-1611 y n3-317-1611, NO ENTRA → arreglado)
- **NIL** («no hubo parte») se guarda marcado (`nil: true`) para auditar, pero **no** suma `con_dato`, **no** es `ultima` en el público y **no** sirve para «no confirmada».
- **El público dice si la lectura fue completa:** `leido` (la hora de la lectura de la API) y `completo` (`false` si vino truncada: nadie puede concluir «ninguno»). Sólo lo reescribe una corrida **real** con lectura buena; el relleno y la API caída no lo tocan, así `leido` envejece y SATCHI pasa a «sin dato» a los 90 min.
- **Un 200 que no es una lista JSON es una falla** y cuenta para el corte de 3 seguidas (antes, 8 HTML seguidos terminaban `ok`).
- **Validación:** un barrido cuenta para PÉRDIDA sólo si es **útil** para el aeropuerto (no parcial, y no todas sus celdas a ≤ 30 km incompletas). Uno parcial puede dar ACIERTO, nunca PÉRDIDA. La tabla del 16/11 no cambia (5 y 8 barridos útiles: 2 pérdidas).
- **El workflow de validación** baja las releases del día argentino anterior, del día y del siguiente (un scan de 01:00 UTC es del día argentino anterior).
- **El mutante «la API caída igual escribe el índice»** ahora escribe de verdad. Tests: **32**; mutantes: **42 de 42**.

## 3.ª vuelta (Codex n3-317col-v2-1611, NO ENTRA → arreglado)
- **PÉRDIDA exige dato útil del ojo EN la celda del aeropuerto** (`coberturaUtil`): la celda leída entera (patas no null, no incompleta) o un «despejado» confirmado. Sin la celda, o con `sin_pixel`, `altura_invalida` u otro motivo: SIN DATO del ojo. Una destacada a ≤ 30 km sigue dando ACIERTO. La tabla del 16/11 no cambia (5 y 8 barridos útiles).
- **Un 200 vacío, con espacios o con una lista vacía es una falla:** no revisa horas (no inventa faltantes), cuenta para el corte y el tramo del relleno queda pendiente. «Sin partes» es sólo el 204.
- Tests: **34**; mutantes: **47 de 47**.

## 317b · el relleno que no avanzaba (17/11, runs 44121469479 y 44123550584)
**Qué pasaba:** la API contestaba bien (probado el 17/11: la ventana de 3 h del **19/10** —29 días atrás— con las 93 estaciones devolvió 173 partes en **0,4 s**). Lo lento era nuestro: cada parte se escribía en R2 **de a uno** (~170 PUT por tramo, ~30 s), y el índice y la marca de avance (`metar/relleno.json`) se guardaban **recién al final**. El `timeout-minutes: 10` cortaba antes del final y no quedaba nada: la corrida siguiente volvía a decir 239.

**El arreglo:**
- **Cada tramo se guarda apenas llega:** los índices de los días tocados y la marca de avance. Una corrida cortada deja lo hecho; la siguiente arranca en el primer tramo pendiente (siempre **del más viejo al más nuevo**: el 3/11 sale de la API el 3/12).
- **Un log por tramo:** `tramo X/Y (MM-DD hh:mm–hh:mm UTC): N partes · K nuevos · guardado`, o `… falló (motivo) · queda pendiente`.
- **Los partes de un tramo se escriben en R2 de a 8** (`ESCRITURAS_PARALELAS`).
- **Un plazo por pedido de 30 s** que cubre cabeceras y cuerpo (un pedido colgado se aborta) y **un reintento corto** (5 s) ante cuelgue, red o 5xx (nunca ante 429/403). Cada intento cuenta para las 3 fallas seguidas.
- **Un presupuesto de tiempo:** el relleno no empieza un tramo pasados `PRESUPUESTO_S` (480 s por defecto, para el job de 10 min) y corta prolijo, con la marca guardada.
- **El tope del relleno** pasa a 300 por defecto (los 30 días, ~240 tramos, entran en una corrida).
- **El workflow** (`metar.workflow.yml.txt`) trae un job propio, `rellenar`, a mano con `modo: relleno`: `timeout-minutes: 50` y `PRESUPUESTO_S=2700` (45 min). Estimado: ~7 s por tramo → ~28 min los 30 días.

**Cómo correrlo:**
- **Con el workflow que ya está instalado** (sin tocar nada): Actions → colector-metar → `modo: relleno`, `tope` vacío. Cada corrida hace ~8 min (unos 60-70 tramos) y corta prolija; **repetirla hasta que diga `0 tramos … por pedir`** (unas 4 veces).
- **Con el workflow nuevo** (una corrida sola de hasta 45 min): `cp metar/metar.workflow.yml.txt .github/workflows/metar.yml` desde una sesión con el permiso `workflow`, y la misma corrida a mano.

**2.ª vuelta (Codex n3-317b-relleno-1711):**
- **El test del corte no medía lo que decía; no era un bug.** El granizo de Río Cuarto (18:25 y 18:45 UTC) cae en el **tercer** tramo (18–21), justo el que el test cortaba, así que tras la primera corrida no podía estar indexado. Ahora el corte es en el 4.º tramo y se comprueba **antes de reanudar** que el granizo ya está en el índice. Control negativo: cortando en el 3.º no está, y al reanudar entra adoptando los partes que ya estaban escritos.
- **La marca ya no se pisa entre corridas:** `guardarMarca()` relee `relleno.json` justo antes de escribir y combina (la unión de los tramos; «hecho» gana a «truncado»). El workflow además las serializa: `concurrency: colector-metar` (sin cancelar) a nivel del workflow entero, que cubre los jobs `colectar` y `rellenar`.
