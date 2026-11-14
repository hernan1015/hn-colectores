# sipan-alto-valle · la red agrometeorológica del INTA EEA Alto Valle (SIPAN) · USO INTERNO

**⛔ Uso interno:** nada de esto se muestra en SATCHI ni en HN AGRO hasta que el INTA lo autorice (decisión del maker, 13/11/2026). Cuando se use, se cita al INTA EEA Alto Valle. **Este repositorio es público y no guarda datos:** los fixtures reales quedan afuera (ver *Tests*).

## Qué hace
1. **`sipan.mjs`, cada 6 h:** baja `https://sipan.inta.gob.ar/agrometeorologia/met/<id>/downld02.txt` de las estaciones 10 (Guerrico), 40 (Villa Regina), 41 (Cnel. Belisle), 42 (Luis Beltrán) y 45 (Cinco Saltos). Es el export de Davis WeatherLink: un registro cada 10 min, las últimas ~40 h.
   - **El diario** va a `estaciones_obs` con la red `INTA_SIPAN_AV`: tmin, tmax, lluvia y ET.
   - **La mínima de la NOCHE** (de las 18 a las 9 h) se guarda con su hora y con cuántos registros tuvo.
   - **Los crudos de 10 min** van a releases diarias del repo privado `hn-radar` (tag `sipan-AAAA-MM-DD`, un asset por estación con el día entero). En la base no entran: los números están en la migración. R2 queda como opción futura, apagada.
2. **`medir.mjs`, cada mañana a las 9:41:** compara la mínima que pronosticaba SATCHI HELADAS para la noche con la observada. Usa Open-Meteo `best_match`, con 1 y 2 días de anticipación, en el punto de la estación y en la localidad de SATCHI más cercana (Neuquén o Choele Choel).
   - Guarda una fila por noche en `pronostico_helada_medicion`.
   - El resumen va a `registro_procesos`: sesgo, MAE y detección de ≤ 0 y ≤ −2 °C.

## Las reglas del INTA (no saturar)
- **Un pedido por vez**, con al menos **30 s** entre pedidos.
- **Tope de 12 pedidos por corrida** (el barrido tiene su propio tope, de 15).
- **Ante un corte, un 403, un 429 o un 5xx, se deja de pedir** en esa corrida y queda el aviso `sipan_corto`.
- **El User-Agent es genérico:** `Mozilla/5.0 (compatible; colector-agrometeorologico/1.0)`.
- ⚠ **Desde la PC de pc-nanci, el SIPAN cortó la conexión** (ECONNRESET) el 13/11 a las 16:02, dos veces. Desde la PC de local respondía a las 15:55. **Falta probar desde Actions**, con una corrida a mano en modo seco.

## Los controles
- **Dedup por estación y hora:** cada corrida une lo nuevo con el crudo ya guardado del día. Sin destino de crudos, una fila no pisa a otra más completa.
- **Los huecos no son 0:** un `---` es null, y un día sin ninguna hora completa de lluvia lleva la lluvia en NULL.
- **Los imposibles se marcan** y no entran en los resúmenes. Son los fuera de rango, la mínima mayor que la máxima, un pico aislado de más de 8 °C en 10 min y la temperatura trabada 6 h.
- **Si el formato cambió, no se carga nada.** Eso pasa con un encabezado que no se entiende, si faltan columnas obligatorias, si las filas no cuadran, si las unidades no son métricas o si la firma difiere de la guardada en `estaciones.metadatos.formato_firma`. Queda en `registro_procesos` con `ok=false`, la corrida sale con código 2 y Actions avisa.
  - Para aceptar un formato nuevo, una vez revisado: Run workflow con `aceptar_formato: id=firma`.
- **Una estación sin registros nuevos en más de 24 h da aviso.**

## La hora
El reloj de las estaciones está en **hora de Argentina (UTC−3)**. Se comprobó con la radiación de los fixtures: el sol sale a las 6:30-7:00 y el máximo cae a las 13:40-14:50.

Un registro de las «0:10» cubre de 0:00 a 0:10. Las columnas cambian según la estación y el año:
- 40 columnas con reloj de 24 h (Guerrico 2026, Cinco Saltos 2020);
- 33 columnas con reloj de 12 h y a/p (Villa Regina 2020).

El lector toma los nombres del encabezado.

## Secretos (los carga local; nunca van en el código)
- **La base, con un rol propio** (`colector_estaciones`, migración `0147b`), **ni la clave de servicio ni el usuario `postgres`**. Es Postgres directo (postgres.js) contra el pooler de Supabase en modo transacción (puerto 6543, `prepare: false`), con un solo secreto:
  - `SIPAN_PG_URL` = `postgresql://colector_estaciones.<ref>:<clave>@<host-del-pooler>:6543/postgres`.
  - El rol es LOGIN, sin BYPASSRLS y con CONNECTION LIMIT 3. La contraseña llega a la base como verificador SCRAM (`migracion/scram.mjs`), nunca en texto plano.
  - Al arrancar, el colector exige que el usuario de la URL sea `colector_estaciones` y que `select current_user` lo confirme; si no, aborta.
  - Ningún error del driver sale con su mensaje original (que podría traer el host o la URL): se reemplaza por su código.
  - (Plan B del 13/11: el proyecto firma los JWT con ECC y la HS256 legada puede revocarse sin aviso, así que no se usa PostgREST.)
- **Lo que puede hacer ese rol:** leer y escribir sólo las filas de sus redes en `estaciones`, `estaciones_obs` y `pronostico_helada_medicion`, y agregar renglones a `registro_procesos` con sus procesos. No puede borrar.
- **Los crudos de 10 min** van a **releases diarias de `hn-radar`** (privado), con el tag `sipan-AAAA-MM-DD`: un asset por estación, `<id>__<sello>.json.gz`, con el día entero ya unido.
  - Usan el mismo `RADAR_TOKEN` del radar.
  - Primero se sube el nuevo y recién después se borra el viejo: si la subida falla, no se pierde nada.
- **R2 es una opción futura, apagada:** sólo se usa con `SIPAN_R2_ON=si` y sus 4 variables.
- **La variable `SIPAN_ON=si`** prende los dos schedules.

## Para prenderlo
Está todo en **`PRENDER.md`**: los secretos nombre por nombre, los comandos `gh` y el orden. También dice cómo verificar que anduvo.

## Tests
- `npm ci --prefix sipan-alto-valle && npm test --prefix sipan-alto-valle`: 53 tests (`sipan`, `crudos-rol`, `prender`, `base-pg` y `pg-real`), cada uno con su control negativo. Usan archivos sintéticos con los encabezados reales; `base-pg` usa un `sql` falso y, para probar que la URL no sale en los errores, el driver de verdad contra 127.0.0.1:1 (conexión rechazada, sin red). `pg-real` (4 tests) aplica la 0147b como NO superusuario contra un PostgreSQL de verdad: corre sólo con `SIPAN_PG_BIN` apuntando al `bin` de un PostgreSQL ≥ 16 (en pc-nanci, el portable de `hn-tools/pg-embebido`); sin eso se saltea.
- Los dos tests con los **fixtures reales** corren si `SIPAN_FIXTURES` apunta a la carpeta. Son copias de la Wayback Machine (Guerrico 13-14/02/2026, Villa Regina 23-24/01/2020, Cinco Saltos 8-9/10/2020) y están en hn-cortex (privado): `docs/inta-alto-valle-2026-11/fixtures/`.
- `node sipan-alto-valle/test/control-negativo.mjs`: 42 mutantes, uno por regla. Tienen que morir todos (los 2 de la 0147b, sólo con `SIPAN_PG_BIN`).

## El histórico (sólo para medir)
- **`historico-pdf.mjs <lista.txt> <carpeta>`** baja los resúmenes mensuales en PDF, **sólo de 2018 en adelante** y sólo de sipan.inta.gob.ar.
  - La lista de direcciones es explícita y se arma a mano.
  - Pide de a uno, con 30 s de pausa y un tope de 12 por corrida (24 como máximo).
  - Lo que ya se bajó no se vuelve a pedir, y ante cualquier señal de bloqueo, para.
- **No es una descarga masiva:** corre sólo en la corrida nocturna que el maker aprueba esa noche. Los PDF no van a este repo.
- **Leer las tablas** queda para cuando haya un PDF de muestra.

## Pensado ya para la 138b/138c (no implementado acá)
- **La 0147 sirve también para `WEATHERLINK_PUB`:**
  - `muestreo_min`, para la tmin y la tmax muestreadas;
  - `lluvia_origen='acumulado_consola'`;
  - y `estaciones_ultima_lectura`, una fila por estación, que sirve para el dedup por `lastTimestamp`, para la edad y para la caché de 15 min de las lecturas a demanda del semáforo.
- **`rad_mj_m2`** guarda la radiación del día del SIPAN, para medir el Q aparte. `motor-q.mjs` no se toca.
