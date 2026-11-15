# zona-estaciones (257) · cómo se prende

La zona de cada estación (`agricola`, `pastizal`, `urbana`, `natural` o `sin_dato`) sale de la cobertura del suelo alrededor de su punto, con ESA WorldCover 2021 v200, que se lee del bucket público de AWS sin cuenta.

**Cita:** © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. Zanaga, D. et al. (2022). *ESA WorldCover 10 m 2021 v200*. doi:10.5281/zenodo.7254221. **Licencia:** CC BY 4.0.

## La regla r1 (`lib/regla.mjs`)
1. Se mira el círculo de 250 m alrededor del punto, unos 2.750 píxeles de 10 m.
2. Si lo construido (clase 50) llega al 30 %, la zona es `urbana`.
3. Si no, gana el grupo más grande:
   - `agricola`: cultivo (40);
   - `pastizal`: pastizal (30);
   - `natural`: árboles, arbustos, suelo desnudo, nieve, agua, humedal, manglar y musgo.

   Si hay empate, el orden es `agricola`, `pastizal`, `natural`.
4. Si no hay ningún píxel con dato, la zona es `sin_dato`.

Además se guardan `margen` (los puntos que el primer grupo le saca al segundo; por debajo de 10, la zona es dudosa), la clase del píxel y el % de cada clase en los radios de 100, 250 y 500 m, para poder recalibrar la regla sin volver a bajar nada.

## Dónde queda
En `estaciones.metadatos`:
- `zona`: el texto;
- `zona_wc`: el detalle, con la regla, los porcentajes, la coordenada usada, la cita y la fecha.

Se escribe sólo a través de las funciones de la migración `migracion/0153_estaciones_zona_PROPUESTA.sql`.

## Pasos (los hace local)
1. **Aplicar la 0153** con psql, como la 0147b. La clave llega como verificador SCRAM:
   ```
   VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f zona-estaciones/migracion/0153_estaciones_zona_PROPUESTA.sql
   ```
   Después, correr a mano las verificaciones que están al final del archivo.
2. **El secreto del repo** (no está creado): `ZONA_PG_URL` = `postgresql://clasificador_zona.<ref>:<clave>@<host-del-pooler>:6543/postgres`.
   - Es el pooler de Supabase en modo transacción.
   - El rol no tiene permisos sobre ninguna tabla. Sólo puede ejecutar:
     - `estaciones_zona_pendientes`, que lee red, id, lat y lon;
     - `estaciones_fijar_zona`, que escribe sólo `zona` y `zona_wc`.
3. **El workflow:** copiar `zona-estaciones/zona-estaciones.workflow.yml.txt` a `.github/workflows/zona-estaciones.yml`.
4. **La llave:** la variable del repo `ZONA_ON=si`. Sin ella el job no corre.
5. **Run workflow:**
   - primero con `modo = seco`, que imprime sólo cantidades por red y por zona;
   - después con `modo = real`.

   Para las estaciones nuevas o movidas se vuelve a correr en `real` sin `todas`: toma sólo las pendientes.

## Para mirar el CSV antes de escribir (desde una PC, con el mismo secreto)
```
ZONA_PG_URL=… node zona-estaciones/clasificar-zona.mjs --base --salida zona.csv --cache cache/ventanas.json
```
Sin `--real` no escribe nada. El CSV queda en la PC y no se sube a ningún lado.

## La bajada
- Va un tile de 3×3° por vez, en orden, con 2 s de pausa entre tiles y 0,1 s entre ventanas, sin pedidos en paralelo.
- Sólo se piden los bloques de 1024×1024 que toca cada ventana, con lecturas por rango HTTP del COG.
- La tanda del 15/11 (1.161 estaciones) se ve en el LISTO-257 del cortex.

## Tests
- `npm test`:
  - la regla, con fixtures de ventanas;
  - la grilla;
  - la lectura, con tiles sintéticos de valor conocido (incluido el borde entre dos tiles);
  - los controles negativos: un 404 da `sin_dato`, un 503 corta, todo agua no da `agricola`, y un galpón en el píxel no hace urbana a la estación;
  - la 0153 en PGlite, si está `HN_PGLITE`.
- `ZONA_RED=1 npm test`: además lee el COG real en el Obelisco (50), el lago Nahuel Huapi (80) y un campo de Pergamino (40).
- `npm run control-negativo`: aplica 8 mutantes y los tests tienen que fallar con cada uno.
