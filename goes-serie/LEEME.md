# goes-serie · la serie de imágenes GOES-19 de focos de calor, en R2

Guarda en R2 **la misma imagen que lee SATCHI hoy**: GOES-19 `ABI-L2-FDCF`, disco completo, NetCDF4/HDF5, una cada 10 min. La leen `lib/goes-focos.mjs`, `focos-litoral`, `fuego-grupos`, «Lo vimos antes» y la constancia.
Se guarda **el archivo de NOAA entero y sin tocar**. goes-focos lo baja entero y lee una ventana adentro; leer un HDF5 cortado o recortado da números inventados.

**Sin secretos y sin activar.** No hay horario. Los dos workflows vienen como `.txt`.

## Dónde queda (depósito `R2_BUCKET`, hoy `satchi-mapas`)

| clave | qué es | rota |
|---|---|---|
| `goes-serie/AAAA/MM/DD/HHMM.nc` | la imagen del turno de 10 min que empieza a HH:MM UTC (inicio del barrido) | sí, a los 30 días |
| `goes-serie/AAAA/MM/DD/indice.json` | el índice del día | cuando el día entero pasa los 30 días |
| `goes-eventos/<evento>/AAAA/MM/DD/HHMM.nc` | la ventana de un evento: t0 ± 6 h, 73 turnos | **nunca** |
| `goes-eventos/<evento>/manifiesto.json` | qué se copió, qué falta y por qué | **nunca** |

**El índice del día** trae, por cada imagen: `turno`, `hhmm`, `clave`, `archivo` (el nombre de NOAA), `t_scan`, `bytes` y `sha256`.
También trae los `faltantes`, cada uno con `motivo` e `intentos`.
**Una imagen que falta es «sin dato», no «sin fuego».**

## Cuánto pesa (medido el 8/11/2026 sobre el 7/11 entero)
- **144 archivos por día:** media de 1,86 MB (de 1,74 a 2,07) y 268 MB por día.
- **30 días:** 8,05 GB (7,50 GiB).
- **Se confirmó bajando 4 archivos.** Los 4 dieron el tamaño del listado y empiezan con la firma HDF5.

## Una corrida de la serie (`MODO=serie`, por defecto)
1. Mira los turnos de las últimas `HORAS` h (3 por defecto; de 1 a 24).
2. Lista en R2 lo que ya hay. Lista NOAA de a una hora por pedido.
3. Baja lo que falta, de a 2 por vez:
   - cada archivo se baja **entero**;
   - el tamaño tiene que coincidir con el listado y con `content-length`;
   - el archivo tiene que empezar con la firma HDF5.
   - Después se sube a R2.
4. **Una imagen que falla no corta la serie.** Queda como faltante, con su motivo, y se sigue con la próxima.
   - Mientras siga dentro de la ventana, la próxima corrida la reintenta.
   - Un turno que NOAA todavía no publicó y que empezó hace menos de 30 min es **pendiente**, no faltante.
5. Actualiza el índice de cada día tocado. Lo junta con el que ya había: nunca lo pisa.
6. **Rota.** Borra las imágenes de más de 30 días, **sólo bajo `goes-serie/`** y sólo las claves con forma de imagen o de índice.
   - **Freno:** si la serie está parada (esta corrida no guardó nada y no hay ninguna imagen de las últimas 24 h), no borra nada.
7. **Salida:**
   - **0:** todo bien;
   - **1:** hubo faltantes o algún error parcial;
   - **2:** no se pudo correr.
   - El resumen muestra sólo cantidades, nunca llaves ni URL.

## La ventana de un evento (`MODO=evento`, workflow `goes-evento`)
Entradas: `evento` (minúsculas, números y guiones, de 3 a 60 caracteres), `lat`, `lon` y `t0` (UTC, `AAAA-MM-DDTHH:MMZ`).
- **Cómo copia:** con **CopyObject** de R2, del lado del servidor. Si R2 no la acepta, baja y sube, y controla el sha256 del índice.
- **Verificación:** al final lista el destino y compara cada tamaño con el del origen.
- **Nunca borra ni pisa.** Si se vuelve a correr con los mismos datos, completa lo que falte (las horas posteriores a t0 quedan «pendientes» hasta que pasan).
- **Un evento que ya existe con otro lugar u otra hora no se toca.**
- Los motivos de lo que falta:
  - `rotada`: tiene más de 30 días;
  - `sin_imagen_en_serie`;
  - el código del error.

## Para local (activar)
1. Copiar `goes-serie.workflow.yml.txt` a `.github/workflows/goes-serie.yml` y `goes-evento.workflow.yml.txt` a `.github/workflows/goes-evento.yml`. Hacer merge a main.
2. **Secrets:** los mismos 4 de rayos-hora (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET`). La llave tiene que poder leer, escribir, borrar y listar en el depósito.
3. Una corrida a mano de `goes-serie`. Recién después, el disparo cada 10 min.
   - Puede ir desde Supabase, con el mismo `gh_dispatch_token` del radar (0139) y `workflow_dispatch`. Este ejemplo **no está aplicado**:
     ```sql
     select cron.schedule('goes-serie', '*/10 * * * *', $$
       select net.http_post(
         url := 'https://api.github.com/repos/<dueño>/hn-colectores/actions/workflows/goes-serie.yml/dispatches',
         headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gh_dispatch_token'),
                                       'Accept', 'application/vnd.github+json', 'User-Agent', 'hn-agro'),
         body := '{"ref":"main","inputs":{"horas":"3"}}'::jsonb) $$);
     ```
   - O con el `schedule` de Actions (ver el `.txt`).
4. **Los enlaces:** el firmador (`firmador-r2/`) todavía no firma estos prefijos. La propuesta está en el LISTO. Lo que hay que firmar ya está armado en `lib/claves.mjs`, en `clavesAFirmar`.

## Tests (sin red)
- `npm test --prefix goes-serie`: 19 tests. R2 falso que verifica cada firma SigV4 y NOAA falso.
- `node goes-serie/test/control-negativo.mjs`: control negativo contado, 26 mutantes.
