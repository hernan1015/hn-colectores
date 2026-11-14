# 147 · Archivo de barridos de granizo · cómo prenderlo

**Qué hace.** Cada 10 min, un pedido a `satchi-publico?que=granizo&_t=<turno de 10 min UTC>`: la misma function pública que usa SATCHI, con un parámetro que saltea la copia vencida de la red (ver «La caché», abajo). La respuesta ENTERA va a la release diaria `granizo-AAAA-MM-DD` de `hernan1015/hn-radar`, que es privado. Las parciales y las fallas también se guardan, marcadas.

Un vigía aparte avisa por mail si en 40 min no se guardó nada. Todo está apagado hasta que la variable `GRANIZO_ARCHIVO_ON` valga `si`.

## Qué hace falta

| Qué | Dónde | ¿Existe? |
|---|---|---|
| `RADAR_TOKEN` (Contents: Read and write sobre hn-radar) | secret del repo | **sí**: es el del colector del radar |
| `SATCHI_SMTP_HOST/PORT/USER/PASS`, `SATCHI_SMTP_FROM` (opcional), `SATCHI_VIGIA_DESTINO` | secrets del repo | **sí**: son los de vigia-satchi y opera-frescura |
| `GRANIZO_ARCHIVO_ON` = `si` | **variable** del repo (Settings → Secrets and variables → Actions → *Variables*) | no: se crea al final |

No hace falta ningún secreto nuevo.

## Orden

0. **Mergear el PR #3 a `main` primero.** GitHub corre el `schedule` sólo desde la rama principal, y los dos workflows leen `lib/` y `granizo-archivo/` de `main`.
1. **Instalar los dos workflows.** Los comandos van desde la raíz del repo, en `main` ya con el PR adentro. Los dos van como `.txt`, porque el token de pc-nanci no tiene el permiso `workflow`. Desde una sesión con ese permiso:
   ```bash
   cp granizo-archivo/granizo-archivo.workflow.yml.txt  .github/workflows/granizo-archivo.yml
   cp granizo-archivo/granizo-frescura.workflow.yml.txt .github/workflows/granizo-frescura.yml
   git add .github/workflows/granizo-*.yml && git commit -m "ci(granizo): instala el archivo y el vigía de frescura (147) [skip netlify]" && git push
   ```
   Sin la variable, el `schedule` no hace nada, y las corridas a mano siguen andando.
2. **Corrida en seco.** Actions → **granizo-archivo** → Run workflow → `modo: seco`. Hace un pedido y mira el release, pero no crea ni sube nada. El registro dice:
   `granizo-archivo (SECO): buena · HTTP 200 · scan 2026-11-14T00:20:20.700Z · granizo-2026-11-13/20261114T0020Z.buena.json.gz · se subiría · 37 KB gz · índice: no (seco)`.
   *(Probado así desde pc-nanci el 13/11 a las 21:54, contra el endpoint real y hn-radar real; ver «La prueba del 13/11», abajo.)*
3. **Corrida real a mano.** Lo mismo, con `modo: real`. Esta vez crea el release del día y sube el barrido y `indice__<sello>.json`.
4. **Verificar:**
   ```bash
   gh release view granizo-$(TZ=America/Argentina/Buenos_Aires date +%F) -R hernan1015/hn-radar
   # bajar uno y mirarlo:
   gh release download granizo-AAAA-MM-DD -R hernan1015/hn-radar -p '*.buena.json.gz' -D /tmp/g --clobber
   gunzip -c /tmp/g/<nombre>.json.gz | jq '{pedido_utc, pedido_art, http, estado, scan_t, bytes: (.cuerpo|length)}'
   ```
5. **Vigía en seco.** Actions → **granizo-frescura** → Run workflow → `modo: seco`. Tiene que decir `ok sin aviso`, pero sólo si corre **dentro de los 40 min** del paso 3. Más tarde dice `parado`, que es lo correcto, y en seco no manda mail.
6. **Prender.** Crear la variable `GRANIZO_ARCHIVO_ON` = `si`, que prende los dos workflows a la vez. A partir de ahí:
   - el archivo corre en los minutos 7, 17, 27…;
   - el vigía, en los minutos 9, 29 y 49.
7. **Cortar la captura de la PC de local** cuando haya 3 o 4 barridos seguidos en el release.

**Apagar:** borrar la variable o ponerla en `no`. Lo que ya se guardó queda.

## Qué queda en cada release

- `AAAAMMDDTHHMMZ.<buena|parcial|falla>.json.gz`: uno por scan de GOES-19 (hora UTC del scan, al minuto) y por estado. Si una respuesta no tiene `scan_t` (casi siempre, una falla de red), el nombre lleva la hora del pedido: `pedido-AAAAMMDDTHHMMZ.<estado>.json.gz`, con el turno de 10 min.
  - Adentro, un sobre `hn-granizo-barrido/1` con:
    - `pedido_utc` y `pedido_art`;
    - `http`, `duracion_ms` y algunas cabeceras (`age`, `cache-status`, …);
    - `estado` y `motivo`;
    - `scan_t` y `scan_art`;
    - y `cuerpo`: **el texto de la respuesta tal cual**.
  - Pesa unos 38 KB comprimido, así que un día lleno queda en unos 5,5 MB y ~150 assets (el tope de GitHub es 1000 por release).
- `indice__<sello>.json`: una línea por **pedido**, también los repetidos, que no vuelven a subir el cuerpo.
- El día de la release es el **día argentino** del scan, como `dia-AAAA-MM-DD` del radar: un scan de las 23:50 queda en el día de las 23:50, aunque se pida a las 00:05.

## Cómo se tolera el cron de GitHub

- GitHub atrasa los `schedule`, a veces 10 a 30 min, y a veces saltea alguno.
- **Lo atrasado no se duplica:** el nombre del asset es la hora del scan y el estado, y un nombre que ya está no se vuelve a subir. Una falla sin scan se nombra por el turno de 10 min.
- **Lo salteado se pierde:** el endpoint sólo da el último scan. Para recuperarlo, hay que recalcularlo desde GOES-19, que es el plan del caso del 13/11. El vigía avisa si el hueco pasa de 40 min.
- `concurrency` pone las corridas en fila, así que nunca hay dos a la vez.
- GitHub **desactiva los `schedule` de un repo público tras 60 días sin actividad.** Si el vigía avisa «parado» sin motivo, mirar eso primero.

## Qué avisa el vigía

Manda un mail por episodio, sin repetirlo:

| Tipo | Cuándo | Qué mirar |
|---|---|---|
| `parado` | 40 min sin barridos nuevos ni pedidos | ¿Actions en rojo, el workflow apagado, el RADAR_TOKEN, o GitHub sin disparar el cron? |
| `repite` | hubo pedidos, pero todos con un scan ya guardado | SATCHI sirve un scan viejo (la caché de la red, o granizo-vivo trabado) |
| `fallando` | todos los barridos nuevos son falla | el endpoint: 403 apagado, 429, 5xx, `ok:false` |
| `parciales` | hay barridos nuevos, pero ninguno bueno (parciales, o parciales y fallas) | los `faltantes` del sobre: NOAA, GLM, Open-Meteo |
| `sin-lectura` | no puede leer hn-radar, también si el repo da 404 (token sin permiso) | el token o la API (como mucho un aviso por día) |

## La caché (147a)

- El 13/11 a las 21:54 la red de Netlify sirvió un scan de 34 min: `age: 958` y `cache-status: "Netlify Durable"; hit; ttl=-358`. Es la buena guardada `durable` con stale-while-revalidate.
- El pedido lleva `&_t=AAAAMMDDTHHMMZ`, con el turno de 10 min UTC.
  - `granizo` no declara `Netlify-Vary`, así que la clave de la red es la URL entera: cada turno es una copia nueva, unos 144 cálculos por día. Un reintento en el mismo turno reusa la copia.
  - `satchi-publico` arma la consulta sólo con los parámetros que conoce, y granizo no lee ninguno. `_t` no está en `PARAMS_LOTE` ni en `QS_CREDENCIAL`, así que no cambia la respuesta ni la saca de la red compartida.
- Cada sobre guarda `age` y `cache-status`, para medir.

## La prueba del 13/11 (21:54 ART, desde pc-nanci)

- Un solo pedido al endpoint real, todavía sin `_t`: `buena`, HTTP 200, scan `2026-11-14T00:20:20.700Z`, 382 KB de JSON y 38 KB comprimido.
- `archivar` en seco contra hn-radar real, sólo lectura: `granizo-2026-11-13/20261114T0020Z.buena.json.gz`, «se subiría». No se subió nada.
- El sobre quedó como fixture en el cortex: `docs/satchi-granizo-2026-11/caso-2026-11-13/archivo-147-fixture/barrido-manual.json.gz`.

## Tests

```bash
node --test granizo-archivo/test/granizo-archivo.test.mjs   # 27 tests, sin red
node granizo-archivo/test/control-negativo.mjs              # 38 de 38 mutantes detectados
```
