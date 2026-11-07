# Colector del SHN (uso interno)

Baja datos del Servicio de Hidrografía Naval para uso interno de HN AGRO: alturas horarias de 7 estaciones del Río de la Plata, las curvas del modelo de altura total, el pronóstico y los avisos por crecida, y el nivel de referencia de cada estación.

**Este repositorio es público y sólo tiene el programa.** Los datos del SHN son «todos los derechos reservados»: se guardan en un depósito **R2 privado**, bajo el prefijo `shn/`, sin enlaces públicos (sin `r2.dev` ni dominio propio). No se publican ni se muestran en ninguna app hasta tener permiso escrito del SHN. Los registros de Actions, que en un repo público ve cualquiera, muestran sólo cantidades: el detalle va a `shn/log/shn.log`, dentro de R2.

Es Node 18 o más nuevo, sin dependencias. La firma S3 (SigV4) para R2 está hecha a mano en `lib/almacen.mjs`, y se prueba contra los vectores publicados por AWS.

## Qué guarda (en R2, bajo `shn/`)

Usa la misma estructura que la carpeta `datos/` del colector de la PC, así la historia se sube tal cual:

```
shn/
  horario/{COD}.csv                       hora_local;medida_m;astronomica_m;diferencia_m
  crudos/horario/{COD}/AAAAMM.jsonl       un renglón por pedido: {pedido, bajado, json de la API}
  modelo/svg/{Puerto}_{AAAAMMDD_hhmm}Z.svg   SVG crudo (la hora es el Last-Modified GMT de la corrida)
  modelo/valores/{Puerto}.jsonl           {corrida_gmt, bajado, titulo, n, etiquetas[97], valores[97]}
  pronostico/AAAAMMDD_hhmm_{pronostico|aviso}.html / .txt, indice.csv
  referencia/nivel_cero.csv, tabla_{COD}_{AAAAMM}.html
  alertas.txt                             alertas (sin repetir la misma)
  log/shn.log                             detalle de cada corrida
  estado/estado.json                      última hora medida por estación (control)
  estado/candado.json                     corrida en curso (vence a las 2 h)
  estado/bloqueo.json                     último 429/403 del SHN (pausa de 12 h)
```

Hay una diferencia con la PC: las alertas van en `shn/alertas.txt`, no en `alertas/alertas.txt`. `subir-historia.mjs` hace ese cambio solo.

- Las estaciones son SFER (San Fernando), MAGA (Martín García), BSAS (Buenos Aires), LPLA (La Plata), PNOR (Pilote Norden), ATAL (Atalaya) y OYAR (Oyarvide).
- La **hora local** es la oficial argentina (UTC-3), la misma que usa la API. Las horas caen siempre a los :45.
- `diferencia_m` es la medida menos la astronómica, o sea el efecto del viento o de la sudestada.
- Los puertos del modelo son San Fernando, Palermo, La Plata, Oyarvide y Martín García. Cada SVG trae 97 valores (4 días, uno por hora).

### Pilote Norden: corrección de nivel

**Desde el 01/01/2026 el SHN suma +0,35 m a las alturas de PNOR para referirlas al Plano Único de Reducción de Sondajes; corregir en el análisis, no en el crudo.**

El colector guarda lo que publica la API sin tocarlo. Para comparar alturas de PNOR anteriores y posteriores al 1/1/2026 hay que sumarles 0,35 m a las anteriores, y eso se hace en el análisis.

## Estado, candado y cuidado con el servidor

- **Al arrancar, el estado sale de R2.** La última hora medida de cada estación se toma del CSV `horario/{COD}.csv` y se controla contra `estado/estado.json`. Si no coinciden, queda una alerta. `horario` se pone al día solo: si faltan horas desde la última medida, retrocede de a 13 h, con un tope de 72 h por corrida.
- **Candado:** antes de empezar, la corrida escribe `estado/candado.json`, con escritura condicional (`If-None-Match: *`). Si encuentra uno vigente, no hace nada y sale con el código 3. El candado vence a las 2 h, así que una corrida que se cortó no deja todo colgado. Además, el workflow tiene `concurrency`, que no deja correr dos a la vez.
- **Un pedido por vez**, con una pausa base de **6 s** entre pedidos.
- **429 o 403 del SHN** (límite de pedidos, o bloqueo de las IP de GitHub): hay **un solo reintento**, después de 60 s. Si vuelve a dar lo mismo, pasa esto:
  - se anota en `shn/alertas.txt`;
  - se escribe `estado/bloqueo.json`;
  - **la corrida se corta** y queda en rojo, sin pedir nada más.

  Durante las 12 h siguientes, las corridas programadas no le piden nada al SHN. Para probar antes, hay que correrlo a mano con **forzar**.
- Otros errores (500, timeouts): un reintento a los 30 s. Si falla, la corrida sigue con la estación o el puerto siguiente y deja una alerta.

## Horarios

El workflow está en `shn/shn.workflow.yml.txt`, y hay que copiarlo a mano a `.github/workflows/shn.yml`: el token con el que se subió esta rama no tenía permiso para escribir workflows. **La programación está apagada (comentada)** hasta cargar los secretos y probar a mano.

| Modo | Cuándo (ART) | cron (UTC) | Pedidos |
|---|---|---|---|
| `horario` | cada 6 h: 03:23, 09:23, 15:23, 21:23 | `23 0,6,12,18 * * *` | 7 si no hay huecos |
| `modelo` | 08:47 y 20:47 | `47 11,23 * * *` | 5 |
| `pronostico` | 07:15, 15:15, 23:15 | `15 2,10,18 * * *` | 2 |
| `referencia` | día 2 de cada mes, 09:31 | `31 12 2 * *` | 7 |
| `chequeo` | diario, 09:53 | `53 12 * * *` | 0 (sólo revisa R2) |

`horario` también corre un chequeo de 3 días al final. Cada pedido de `horario` trae 13 horas, así que cada 6 h alcanza sin perder ninguna, aunque GitHub atrase el cron. En total son unos **45 pedidos por día** al SHN.

Para activar la programación:
1. Sacar los `#` del bloque `schedule:` en `shn.yml`.
2. Si se cambia una hora, cambiarla igual en el paso «Elegir modo». Ese paso reconoce el modo por el texto exacto del cron.

## Secretos necesarios (Settings → Secrets and variables → Actions)

| Secreto | Qué es |
|---|---|
| `R2_ACCOUNT_ID` | ID de la cuenta de Cloudflare (el endpoint es `https://<cuenta>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY_ID` | clave de un token de API de R2 con **Object Read & Write sólo sobre ese depósito** |
| `R2_SECRET_ACCESS_KEY` | secreto de ese token |
| `R2_BUCKET` | nombre del depósito privado |

El programa no imprime nunca estos valores. Si falta alguno, sale con el código 2 y lo avisa.

## Cómo correrlo a mano

- **En GitHub:** Actions → **colector-shn** → *Run workflow*, y elegir el `modo`. Opcionales:
  - `forzar`: pedir aunque haya un bloqueo anotado;
  - `estacion`: por ejemplo `SFER,MAGA`;
  - `maxatras`: horas hacia atrás como máximo.

  Con `modo = pruebas` corren los tests y el control negativo, sin R2 ni SHN.
- **En una PC, contra R2:** con las 4 variables `R2_*` en el entorno, correr `node shn/shn.mjs horario`. Lo mismo sirve para `modelo`, `pronostico`, `referencia` y `chequeo`.
- **Prueba local sin R2:** `node shn/shn.mjs horario --estacion SFER --maxatras 12 --carpeta /tmp/shn-prueba` guarda en esa carpeta (también sirve `SHN_CARPETA`). Ojo: **sí le pide al SHN**.
- **Tests (no salen a internet):** `node --test "shn/test/*.test.mjs"`. Las respuestas del SHN son de muestra, armadas a mano.
- **Control negativo:** `node shn/test/control-negativo.mjs` rompe el código de 15 maneras, en una copia temporal, y verifica que algún test caiga en cada una.

Códigos de salida: 0 bien · 1 error o bloqueo del SHN · 2 uso o secretos faltantes · 3 candado ocupado.

## La historia: se sube una vez desde la PC que la bajó

La historia larga (hacia atrás, hasta donde llega la API) **no se baja desde acá**. La bajó una sola vez el colector de la PC, y se sube **una sola vez** a R2 con `shn/subir-historia.mjs`, con el mismo prefijo `shn/`:

1. En la PC donde está la historia, poner las 4 variables `R2_*` en el entorno.
2. Ver qué va a hacer, sin escribir nada:

   ```
   node shn/subir-historia.mjs <carpeta datos> --probar
   ```
3. Subir:

   ```
   node shn/subir-historia.mjs <carpeta datos>
   ```

   **No pisa nada:** lo que ya existe en R2 queda como está. La lista de lo subido queda en un `subida-historia-AAAAMMDD_hhmm.txt` local y en `shn/log/` de R2.
4. Si el colector de la nube ya corrió antes (y hay `horario/{COD}.csv`, crudos o índices que existen en los dos lados), repetir el paso 3 con `--fusionar`:
   - los CSV horarios se unen por hora, y si las dos versiones tienen el dato queda el de R2;
   - los `.jsonl` y los demás textos se unen por renglón;
   - SVG, HTML y JSON que ya existen no se tocan nunca.

   Repetir la fusión no cambia nada.

No se sube el candado (`.candado`) ni los temporales.

## Costo

- **GitHub Actions:** el repo es público, así que los minutos son **gratis**. Son unas 10 corridas por día de alrededor de 1 minuto (`horario` tarda unos 50 s, con 7 pedidos a 6-7 s cada uno), o sea unos 300 minutos al mes sin cargo.
- **R2:** cada corrida hace unas decenas de operaciones y guarda unos pocos MB por mes. Eso entra en el nivel gratuito de R2 (conviene mirarlo en el panel de Cloudflare). La salida de datos de R2 no se cobra.
- **SHN:** unos 45 pedidos por día, de a uno.

## Límites conocidos

- La API del SHN no está documentada: la pueden cambiar o cerrar. El colector falla en voz alta (registro y alerta) y no inventa datos.
- El SHN podría cortar las IP de GitHub. En ese caso queda la alerta y la pausa de 12 h; no hay reintentos en bucle.
- Los huecos que deja el SHN (estación fuera de servicio) los marca `chequeo`. No se pueden rellenar si la API no los tiene.
- Sin licencia: uso interno hasta tener permiso escrito.
