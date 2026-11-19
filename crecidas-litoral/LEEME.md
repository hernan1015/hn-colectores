# crecidas-litoral · TODO EL LITORAL precocido (r79 · punto 10)

Arma la mancha de la crecida de **todas las zonas con modelo** en una sola capa continua, una carpeta de teselas por fecha. Son ~45 fechas: las 30 medidas más el pronóstico. La sube al depósito público de SATCHI. La página (`_v1850` de hn-agro, «Todo el Litoral») lee `{base}/indice.json` y pide `{base}/<version>/<fecha>/<z>/<x>/<y>.png`.

- **El depósito:** `satchi-slider`, prefijo `crecidas-litoral/`, público por r2.dev (la base va en hn-agro `datos/crecidas-litoral.json`).
- **Los secrets** (por nombre):
  - `R2_OPERA_CUENTA`, `R2_OPERA_ACCESS_KEY_ID` y `R2_OPERA_SECRET_ACCESS_KEY`: el token del depósito público, el mismo del precocido satelital;
  - `EARTHDATA_TOKEN`: el de IMERG, para OPERA.
- **Sin base de datos.** Las alturas medidas y el pronóstico (p50) salen de la function pública del sitio: `satchi-publico?que=calado&zona=…`. El calado y las cajas de agua vista salen de los estáticos del sitio (`/datos/calado/*`, `/datos/opera/agua-vista.json`).
- **La llave:** la variable `CRECIDAS_LITORAL_ON` tiene que valer `si`.
  - A mano (Run workflow) corre en **seco** por defecto: «sube» a una carpeta del runner.
- **Cada 3 h, pero barato:** si la firma (alturas + pronósticos + versión del método) es la misma que la del índice publicado y es el mismo día, no genera nada.
- **El orden de escritura:**
  1. todas las teselas bajo una versión nueva;
  2. después el índice;
  3. las versiones viejas se borran recién en una corrida posterior, pasadas 6 h (borrado diferido).
  - Si falla una tesela, no se escribe el índice.
  - Los 5xx se reintentan.
- **El registro es PÚBLICO:** sólo cantidades y categorías (`error:almacen http N`, `error:red`, `error:fuente`, `error:interno`).
- **Las copias:** `marcas.py`, `precocer.py` y `prueba_componer.py` son copia textual de hn-agro `tools/satchi/crecidas-litoral/`, rama `mejora/r79-c`. Si cambian allá, se copian acá y se sube `METODO_V` en `litoral.py`.

## Tests

| comando | qué prueba |
|---|---|
| `node --test test/subir.test.mjs` | la subida, con almacén falso |
| `node test/control-negativo.mjs` | los mutantes |
| `python -I -m unittest discover -s test -p "test_*.py"` | alturas, fechas, firma, llave |
| `python -I prueba_componer.py` | la fusión: el color fijo manda, el rayado «sin dato» |
