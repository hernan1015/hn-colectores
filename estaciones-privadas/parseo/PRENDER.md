# PRENDER el parseo de las estaciones internas (las 9 fuentes, un solo job) · la lista para local

**Lo hace local.** Ningún valor secreto va en este archivo ni en el repo. `gh` es `$GH`.

## Qué es
- **Un solo job,** `parseo-estaciones-privadas`, para las 9 fuentes, con un módulo por fuente (`fuentes/`).
  - **138b:** WeatherLink (`WEATHERLINK_PUB`) y Weathercloud (`WEATHERCLOUD_PUB`).
  - **139:** SIGA (`SIGA_RT`), EEAOC, Mendoza (`DACC_MZA`), San Luis (`REM_SL`), BCP (`BCP_RT`), Entre Ríos (`ER_HIDRAULICA`) e INA (`INA_METEO` e `INA_ALERTA`).
  - **Corre solo** cuando termina bien una ronda de `colector-estaciones-privadas` (`workflow_run`), en REAL.
  - **A mano** corre en SECO por defecto.
  - **Detrás de la llave** `ESTACIONES_PARSEO_ON = 'si'` (variable del repo). Sin la llave no corre nada.
- **Sólo LEE R2** (lo que dejó `ronda.mjs`, y el lote de la notebook del 15/11) y escribe en la base con el rol `colector_estaciones`. **No le pide nada a ninguna fuente.**
- **Una sola capa de guardado** (`lib/base.mjs` + `lib/diario.mjs`):
  - **idempotente:** cada fila une lo guardado con lo nuevo, deduplica por (estación, instante) y lleva una firma; sin cambios, no se escribe;
  - **nunca pisa un día más completo,** porque lo guardado entra en la unión;
  - **la última lectura** (WL y WC) nunca retrocede;
  - **`metadatos`:** se une con lo de otros (la `zona` de la 257 queda) y `mostrar = false` lo fuerza el SQL.
- **La edad, una regla por red** (`maxEdadH`), contra el `leido` de la ronda que trajo la lectura:
  - 12 h por defecto;
  - 2 h en WeatherLink y Weathercloud;
  - 240 h en Entre Ríos, porque la consola sube un archivo de una semana.
- **La ventana:** las rondas de las últimas 6 h (`--horas`, hasta 72). Para días enteros, `--desde AAAA-MM-DD`.
- **El log público** es una sola línea con cantidades, y los nombres de las claves que no se entendieron.

## ⚠ Antes de prender: el formato
- **WeatherLink:** las claves del detalle son supuestas (`formato.mjs` · `WEATHERLINK.campos`). Si no coinciden, el seco lo muestra en `claves_descartadas` (sólo los nombres) y no se guarda nada mal.
- **Weathercloud:** nace con **`verificado: false` y no guarda NADA.** Completá `posiciones` y la escala, y poné `verificado: true`. O pasame un device y lo hago yo.
- **SIGA:** el formato de la `_AUTOMATICA` está sin verificar. Si no es un arreglo de estaciones, se rechaza entero.
- **El lote de la notebook** (`<fuente>/2026-11-15/local.jsonl.gz`): el formato de `colector-wl.mjs` y `colector-wc.mjs` no lo vi. Se aceptan las formas de `LOTE_WL` y `LOTE_WC` (`formato.mjs`), y lo demás se descarta contado (`lote_sin_forma`).

## 1 · La migración 0152 (una sola)
- **`migracion/0152_parseo_estaciones_unificada_PROPUESTA.sql`.** Es la única: la de la 138b ya no existe.
- **Confirmá el número.** 0149 es de la 196-2, 0150 de la 176, 0151/0151b de la 139 SMN y 0153 de la 257, que no toca estas políticas.
- **Aplicala DESPUÉS de la 0151:** las dos fijan la lista entera de redes. Ésta ya incluye `SMN_ABIERTO`. Si la 0151 va después, saca las internas: volvé a correr ésta, que es idempotente.
- **Cómo:** copiala a `hn-agro/migrations/` y aplicala con el editor SQL o el MCP, como postgres.
- **Verificar:**
  ```sql
  select tablename, qual, with_check from pg_policies where policyname like 'colector_estaciones_sus_%' order by 1;
  ```
  - las cuatro tablas de redes con las 12 redes, incluida `estaciones_ultima_lectura`;
  - `registro_procesos` con los 12 procesos.

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
- Con la llave en `si` y `workflow_dispatch`:
  ```bash
  $GH variable set ESTACIONES_PARSEO_ON -R hernan1015/hn-colectores --body si
  $GH workflow run parseo-estaciones-privadas -R hernan1015/hn-colectores -f modo=seco
  ```
- **Qué mirar en el renglón JSON**, por fuente:
  - `rondas`, `lecturas` y `filas_escritas`: en seco, las filas que armaría;
  - `descartadas` y `cuentas.descartadas`;
  - `claves_descartadas`: si se llevan casi todo, son las claves (ver «Antes de prender»);
  - `weathercloud.cuentas.devices` ≈ 561 × rondas, y `lecturas` en 0 hasta que se verifique.
- **Ojo:** con la llave en `si`, la próxima ronda dispara el parseo **en REAL**. Si el seco no da bien, volvé a poner la llave en `no` antes de los :11.

## 5 · Real, y el lote de la notebook
- Desde que la llave está en `si`, corre solo después de cada ronda. A mano: `-f modo=real`.
- **El lote del 15/11, una vez:** `-f modo=real -f desde=2026-11-15`. Es idempotente con lo que bajó la nube: el mismo instante no se duplica.
- **Después,** borrá `.github/workflows/estaciones-importar-local.yml` y `estaciones-privadas/importar-local.mjs`, que eran de una sola vez.
- **Verificar:**
  ```sql
  select red, count(*) from estaciones where metadatos->>'uso' = 'interno' group by 1 order by 1;
  select red, estacion_id, fecha, tmin_c, tmax_c, registros_validos, registros_esperados, tmin_noche_c, noche_registros, muestreo_min, lluvia_mm
    from estaciones_obs where red in ('WEATHERLINK_PUB', 'EEAOC', 'INA_ALERTA') order by fecha desc, red, estacion_id limit 40;
  select proceso, creado_at, ok, resumen from registro_procesos where proceso in ('estaciones_privadas_parseo', 'interna_eeaoc') order by id desc limit 5;
  ```

## Apagar
- `$GH variable set ESTACIONES_PARSEO_ON -R hernan1015/hn-colectores --body no`. Lo guardado queda.

## Sumar una fuente
1. **El módulo:** un archivo en `fuentes/<fuente>.mjs` con la forma que describe `fuentes/index.mjs`, y su línea en `FUENTES`.
2. **La red:** en `REDES` de `lib/base.mjs`, con su `maxEdadH` en la configuración de la red.
3. **La migración:** una que repita la 0152 con la lista ENTERA de redes y procesos.
4. **Lo común ya está:**
   - `lib/diario.mjs`: el día, la noche, los imposibles, la unión y la firma;
   - `lib/base.mjs`: el guardado;
   - `lib/hora.mjs`: la hora argentina;
   - `lib/crudo.mjs`: las partes de una ronda;
   - `lib/convertir.mjs`: unidades y encoding.
