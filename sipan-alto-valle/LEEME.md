# sipan-alto-valle · la red agrometeorológica del INTA EEA Alto Valle (SIPAN) · USO INTERNO

**⛔ Uso interno:** nada de esto se muestra en SATCHI ni en HN AGRO hasta que el INTA lo autorice (decisión del maker, 13/11/2026). Cuando se use, se cita al INTA EEA Alto Valle. **Este repositorio es público y no guarda datos:** los fixtures reales quedan afuera (ver *Tests*).

## Qué hace
1. **`sipan.mjs`, cada 6 h:** baja `https://sipan.inta.gob.ar/agrometeorologia/met/<id>/downld02.txt` de las estaciones 10 (Guerrico), 40 (Villa Regina), 41 (Cnel. Belisle), 42 (Luis Beltrán) y 45 (Cinco Saltos). Es el export de Davis WeatherLink: un registro cada 10 min, las últimas ~40 h.
   - **El diario** va a `estaciones_obs` con la red `INTA_SIPAN_AV`: tmin, tmax, lluvia y ET.
   - **La mínima de la NOCHE** (de las 18 a las 9 h) se guarda con su hora y con cuántos registros tuvo.
   - **Los crudos de 10 min** van a R2, a un depósito privado, en un archivo por estación y por día (`sipan-alto-valle/<id>/<año>/<día>.json.gz`). En la base no entran: los números están en la migración.
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
- **Dedup por estación y hora:** cada corrida une lo nuevo con el crudo ya guardado del día. Sin R2, una fila no pisa a otra más completa.
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
- `SIPAN_SUPABASE_URL` y `SIPAN_SUPABASE_KEY`: la escritura en `estaciones`, `estaciones_obs`, `registro_procesos` y `pronostico_helada_medicion`.
  - Ver la pregunta de la clave en el PR: la de servicio da acceso a toda la base.
- `SIPAN_R2_CUENTA`, `SIPAN_R2_ACCESS_KEY_ID`, `SIPAN_R2_SECRET_ACCESS_KEY` y `SIPAN_R2_DEPOSITO`: opcionales; sin ellos, no se guardan los crudos.
- **La variable `SIPAN_ON=si`** prende los dos schedules.

## Para prenderlo (lo hace local o el maker)
1. Aplicar la migración `migracion/0147_estaciones_noche_y_muestreo.sql`: copiarla a `hn-agro/migrations/`.
2. Copiar los dos `.workflow.yml.txt` a `.github/workflows/` (`sipan-alto-valle.yml` y `medicion-heladas.yml`).
3. Correr a mano en modo **seco**, con `barrer: true`, para ver si responde desde Actions y buscar Vista Alegre, Río Colorado y la estación nueva.
4. Correr a mano en modo **real**, cargar los secretos y poner `SIPAN_ON=si`.

## Tests
- `node --test sipan-alto-valle/test/sipan.test.mjs`: 26 tests, cada uno con su control negativo. Usan archivos sintéticos con los encabezados reales.
- Los dos tests con los **fixtures reales** corren si `SIPAN_FIXTURES` apunta a la carpeta. Son copias de la Wayback Machine (Guerrico 13-14/02/2026, Villa Regina 23-24/01/2020, Cinco Saltos 8-9/10/2020) y están en hn-cortex (privado): `docs/inta-alto-valle-2026-11/fixtures/`.
- `node sipan-alto-valle/test/control-negativo.mjs`: 18 mutantes, uno por regla. Tienen que morir todos.
