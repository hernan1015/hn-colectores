# PRENDER el parseo de las estaciones internas (138b: WeatherLink y Weathercloud) · la lista para local

**Lo hace local.** Ningún valor secreto va en este archivo ni en el repo. `gh` es `$GH`.

## Qué es
- **Un solo job,** `parseo-estaciones-privadas`, para todas las fuentes, con un módulo por fuente (`fuentes/`).
  - **Corre solo** cuando termina bien una ronda de `colector-estaciones-privadas` (`workflow_run`), en REAL.
  - **A mano** corre en SECO por defecto.
  - **Detrás de la llave** `ESTACIONES_PARSEO_ON = 'si'` (variable del repo). Sin la llave no corre nada.
- **Sólo LEE R2** (lo que dejó `ronda.mjs`) y escribe en la base con el rol `colector_estaciones`. **No le pide nada a ninguna fuente.**
- **Es idempotente:** cada corrida vuelve a armar ayer y hoy (ARG) desde todo el crudo de esos días.
  - Deduplica por (estación, instante).
  - Lo guardado sólo se reemplaza por algo igual o más completo.
- **Las redes son `WEATHERLINK_PUB` y `WEATHERCLOUD_PUB`,** con `metadatos.mostrar = false`.
  - **WeatherLink:** °F → °C, mph → m/s, in → mm, inHg → hPa, y los nombres sin el doble encoding.
  - **Weathercloud:** las décimas.
  - **Las dos:** `muestreo_min = 60`, porque la ronda pasa una vez por hora.
- **El log público** sólo trae cantidades, y los nombres de las claves que no se entendieron.

## ⚠ Antes de prender: el formato (no lo pude ver)
Desde pc-nanci no hay ninguna muestra del crudo, y no se hizo ningún pedido, ni a R2. Lo verificado y lo supuesto está en `formato.mjs`.
- **WeatherLink:** las claves del detalle son supuestas (`temperature`, `humidity`, `windSpeed`, `barometer`, `rainDay`, `lastTimestamp`, `ageInSeconds`, `stationName`).
  - **Si no coinciden,** la corrida en seco lo muestra en `claves_descartadas` (sólo los nombres) y no se guarda nada mal: se descarta contado.
  - Se corrigen en `formato.mjs` (`WEATHERLINK.campos`).
- **Weathercloud:** de los arrays sólo están verificados `[2]` lat, `[3]` lon y `[4]` estado (de `ronda.mjs`). Por eso nace con **`verificado: false` y no guarda NADA**.
  - **Mirá un device** de `estaciones-internas/weathercloud/<día>/<HHMM>.json` y completá `posiciones`: `id`, `nombre`, y la posición de cada variable.
  - **Confirmá la escala:** décimas = `0.1`. El viento, en km/h o m/s.
  - **Poné `verificado: true`.** O pasame un device y lo hago yo.

## 1 · La migración 0152 (el rol)
- **Confirmá que el número siga libre.** 0149 es de la 196-2, 0150 de la 176 y 0151/0151b de la 139 SMN.
- **Aplicala DESPUÉS de la 0151:** las dos fijan la lista entera de redes. Esta ya incluye `SMN_ABIERTO`. Si la 0151 va después, volvé a correr esta.
- **Cómo:** copiá `migracion/0152_parseo_estaciones_privadas_rol_PROPUESTA.sql` a `hn-agro/migrations/` y aplicala con el editor SQL o el MCP, como postgres.
- **Verificar:**
  ```sql
  select tablename, qual, with_check from pg_policies where policyname like 'colector_estaciones_sus_%' order by 1;
  ```
  - Cuatro tablas con `WEATHERCLOUD_PUB`, incluida `estaciones_ultima_lectura`.
  - `registro_procesos` con `estaciones_privadas_parseo`.

## 2 · Los secretos (los creás vos; yo no toco ninguno)
| Secreto | Qué es | ¿Existe? |
|---|---|---|
| `PARSEO_R2_ACCESS_KEY_ID` / `PARSEO_R2_SECRET_ACCESS_KEY` | **token de R2 NUEVO, SÓLO LECTURA** («Object Read only»), limitado al depósito de los crudos | **no: crearlo** |
| `R2_ACCOUNT_ID`, `R2_BUCKET` | los mismos de la ronda | sí |
| `SIPAN_PG_URL` | la URL del rol `colector_estaciones` (el workflow la pasa como `PARSEO_PG_URL`) | sí |

## 3 · Instalar el workflow (hace falta el permiso `workflow`)
```bash
cd <clon de hn-colectores en main, al día, con el PR mergeado>
git mv estaciones-privadas/parseo/estaciones-privadas-parseo.workflow.yml.txt .github/workflows/estaciones-privadas-parseo.yml
git commit -m "ci(parseo): instala el parseo de las estaciones internas (apagado por ESTACIONES_PARSEO_ON) [skip netlify]" && git push
```

## 4 · La primera corrida, a mano y en SECO
- Con la llave prendida sólo para probar, o con `workflow_dispatch` y la llave en `si`:
  ```bash
  $GH variable set ESTACIONES_PARSEO_ON -R hernan1015/hn-colectores --body si
  $GH workflow run parseo-estaciones-privadas -R hernan1015/hn-colectores -f modo=seco
  ```
- **Qué mirar en el renglón JSON:**
  - `weatherlink.lecturas` ≈ estaciones × rondas del día;
  - `descartadas` y `claves_descartadas`: si se llevan casi todo, son las claves (paso «Antes»);
  - `weathercloud.devices` ≈ 561 × rondas, y `lecturas` 0 hasta que se verifique.
- **Ojo:** con la llave en `si`, la próxima ronda dispara el parseo **en REAL**. Si el seco no da bien, volvé a poner la llave en `no` antes de los :11.

## 5 · Real
- Desde que la llave está en `si`, corre solo después de cada ronda. A mano: `-f modo=real`.
- **Verificar:**
  ```sql
  select red, count(*) from estaciones where red in ('WEATHERLINK_PUB', 'WEATHERCLOUD_PUB') group by 1;
  select red, estacion_id, fecha, tmin_c, tmax_c, registros_validos, registros_esperados, tmin_noche_c, noche_registros, muestreo_min, lluvia_mm
    from estaciones_obs where red in ('WEATHERLINK_PUB', 'WEATHERCLOUD_PUB') order by fecha desc, red, estacion_id limit 40;
  select creado_at, ok, resumen from registro_procesos where proceso = 'estaciones_privadas_parseo' order by id desc limit 5;
  ```

## Apagar
- `$GH variable set ESTACIONES_PARSEO_ON -R hernan1015/hn-colectores --body no`. Lo guardado queda.

## Sumar una fuente (la 139: SIGA, EEAOC, DACC, REM, BCP, INA, Entre Ríos)
1. Un archivo en `fuentes/<fuente>.mjs` con la forma de `fuentes/index.mjs`, más su línea en `FUENTES`.
2. La red, en `REDES` de `lib/guardar.mjs`.
3. Una migración que repita la de la 0152 con la lista ENTERA de redes: las cuatro de hoy más las nuevas.
4. **Lo común ya está:** `lib/convertir.mjs` (conversiones, encoding, rangos), `lib/dia.mjs` (el día, la noche, el dedup y combinar) y `lib/guardar.mjs` (estaciones, estaciones_obs, la última lectura y registro_procesos).
