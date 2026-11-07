# rayos-hora · caché horaria de rayos GLM, recortada a la Argentina

Cada hora UTC cerrada queda guardada en R2 como `rayos-hora/AAAA/MM/DD/HH.json`. Trae los flashes del GLM (GOES) que cayeron dentro de la caja Argentina.
Con esto, la app puede mirar 5 a 15 días hacia atrás desde un foco: le bastan 120 a 360 lecturas chicas, sin bajar nada de NOAA en cada consulta.

**Es un indicio, nunca una causa.** Que haya habido un rayo cerca antes de un foco no prueba que lo haya encendido. Que no haya habido ninguno tampoco prueba que no fue un rayo.

## Qué hace una corrida

1. **Candado.** Escribe `rayos-hora/candado.json` sólo si no existe; después lo vuelve a leer para confirmar que es el suyo.
   - Si hay uno vigente de otra corrida, no hace nada.
   - El candado vence a los 50 min. El trabajo se corta a los 45, así que una corrida muerta no lo deja trabado.
   - Al terminar se suelta siempre, aunque la corrida haya fallado.
2. **Qué falta.** Lista en R2 los días de las **últimas 48 h cerradas** y toma estas horas:
   - las que no están;
   - las ilegibles;
   - las incompletas que vale la pena reintentar (ver más abajo).
   - Una hora se da por cerrada 15 min después de terminar.
   - Va de la más nueva a la más vieja. El tope es de 48 horas por corrida.
3. **Cada hora:**
   - Lista los archivos de `GLM-L2-LCFA/AAAA/DDD/HH/` en el bucket público de NOAA, que no pide cuenta.
   - Baja los 180 archivos de 20 s, 8 a la vez. Cada uno se baja **entero** y se compara el tamaño con el del listado.
   - Se queda con los flashes dentro de la caja y sube el JSON.
   - **Nunca se lee por rangos.** Un HDF5 cortado o leído a pedazos da números inventados.
4. **Resumen.** Muestra sólo cantidades: horas, flashes, MB bajados y alertas.

### Satélite

- Hasta el **6/4/2025** se usa **GOES-16** (`noaa-goes16`).
- Desde el **7/4/2025 00:00 UTC** se usa **GOES-19** (`noaa-goes19`). Ese día GOES-19 pasó a ser GOES-East operativo (NOAA).
- Es la misma fecha que usa el análisis de rayos e incendios. Cada JSON dice de qué satélite salió.

### Flashes, no grupos

Se guardan sólo los **flashes**. Los grupos (y los eventos) no se guardan, por tres razones:
- El flash es la unidad de «un rayo», y es lo que ya usan la capa de rayos de la app y el análisis.
- Los grupos son de 5 a 10 veces más filas. El peso por año se multiplicaría sin cambiar la respuesta a «¿hubo rayos cerca?».
- Si algún día hacen falta los grupos, se pueden rellenar bajo pedido para las horas que se necesiten.

## Formato de `HH.json`

```json
{
  "v": 1,
  "hora": "2024-12-16T21:00Z",
  "estado": "completa",
  "satelite": "GOES-16",
  "producto": "GLM-L2-LCFA (flashes)",
  "caja": { "lat_min": -56.5, "lat_max": -20, "lon_min": -76.5, "lon_max": -52 },
  "archivos": { "esperados": 180, "listados": 180, "leidos": 180, "fallidos": 0 },
  "faltantes": [],
  "intentos": 1,
  "n": 9835,
  "columnas": ["t_ms", "lat", "lon", "energia_fJ", "area_km2", "calidad"],
  "flashes": [[123, -41.4132, -71.9562, 89.3, 66.69, 0], "…"],
  "nota": "Hora completa.",
  "generado": "…",
  "bytes_bajados": 64000000,
  "flashes_disco": 290000
}
```

Las columnas de `flashes`:

| Columna | Qué es |
|---|---|
| `t_ms` | Milisegundos desde el inicio de la hora, tomados del primer evento del flash. Hora del flash = `hora` + `t_ms`. |
| `lat`, `lon` | Centroide del flash, con 4 decimales. El GLM ubica con un error de unos 5–6 km sobre la Argentina: los decimales no agregan precisión. |
| `energia_fJ` | Energía óptica en femtojoules (10⁻¹⁵ J). No es la corriente del rayo. |
| `area_km2` | Área del flash en km². |
| `calidad` | `flash_quality_flag`: 0 = bueno; 1, 3 o 5 = degradado; **−1 = sin marca** (relleno). Se guardan todos: cada consumidor decide qué filtra. |

Las filas van ordenadas por `t_ms`, `lat` y `lon`. Si se rehace la misma hora, salen los mismos flashes.

### Incompleta no es «sin rayos»

- `estado: "completa"` quiere decir que se leyeron los 180 casilleros de 20 s. Recién ahí `n: 0` significa «no hubo rayos en la caja».
- `estado: "incompleta"` quiere decir que falta algún archivo:
  - porque NOAA no lo publicó;
  - o porque no se pudo bajar entero.
- En `faltantes` van los casilleros que faltan, como `MM:SS` de inicio. **En esos minutos no se sabe nada:** no hay que mostrarlos como «sin rayos».
- Una hora sin ningún archivo también queda **incompleta**, con 180 faltantes.
- **Reintentos** de una hora incompleta, en corridas distintas:
  - hasta **3 intentos** en total;
  - sólo si hubo fallas de bajada, o si la hora tiene menos de 6 h (NOAA puede publicar tarde);
  - después queda incompleta para siempre, con la alerta anotada.

## Alertas: `rayos-hora/alertas.txt` (en R2)

Es una línea por novedad, con fecha UTC. Guarda las últimas 1000.

- **NOAA no responde el listado:** se anota y **se corta la corrida**. No se escribe una hora vacía. La corrida siguiente vuelve a probar, una vez.
- **Una hora incompleta:** se anota. Si fallaron más de la mitad de los archivos, también se corta la corrida, para no seguir golpeando a NOAA.
- **Reintentos de bajada:** como mucho uno por archivo, a los 2 s. No hay bucles.
- **Si falla R2,** la corrida queda en **rojo** en Actions. Si falla NOAA, queda en verde con la alerta anotada: es un problema externo y la corrida siguiente lo vuelve a intentar.

## Workflow

- **Dónde está:** `rayos-hora/rayos-hora.workflow.yml.txt`. Para activarlo hay que copiarlo a `.github/workflows/rayos-hora.yml`. Vino como `.txt` porque el token con el que se armó la rama no tiene el permiso «workflow».
- **Horario:** está **comentado** (minuto 23 de cada hora). Se activa recién después de probar una corrida a mano.
- **A mano:** Actions → colector-rayos-hora → Run workflow. Entradas:
  - Sin entradas: se pone al día con las últimas 48 h.
  - `desde` / `hasta` (UTC, `AAAA-MM-DD` o `AAAA-MM-DDTHH`): relleno bajo pedido. Saltea las horas ya completas.
  - `max_horas`: tope por corrida, 48 por defecto y hasta 200.
- **No se rellena 2018–2026 entero:** serían unos 4–5 TB de bajada. Sólo se rellenan los días que se piden.
- **Secretos del repo:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET`, los mismos del colector del SHN. Nunca se imprimen.

### Probar sin R2

```
cd rayos-hora && npm ci
ALMACEN_CARPETA=/una/carpeta DESDE=2024-12-16T21 HASTA=2024-12-16T21 node rayos-hora.mjs
```

## Costo estimado

**Minutos de Actions:**
- Una corrida normal baja **1 hora**, unos 60 MB. Medido desde una PC: **8 s** por hora.
- Con la preparación (checkout, Node y `npm ci` de una sola dependencia), cada corrida se cobra **1 minuto**, porque se redondea hacia arriba.
- **24 × 30 ≈ 720 min por mes.** Ponerse al día después de un corte de 48 h suma unos 8–10 min.
- El repo es público, así que **no se cobra**. Si fuera privado, 720 min entrarían en los 2000 gratis del plan, pero se comerían un tercio.

**Peso en R2:** se midieron 41,6 bytes por flash en JSON sin comprimir.

| Muestra | Flashes por hora en la caja | Peso por hora | Peso por año |
|---|---|---|---|
| 302 horas de verano del análisis de incendios, cargadas a días de tormenta: **mediana** | 1424 | ~59 KB | **~0,5 GB** |
| Las mismas 302 horas: **media** | 4379 | ~182 KB | **~1,6 GB** (techo) |
| Dos horas de tormenta del 16/12/2024 | 8040 y 9835 | 334 y 409 KB | — |

- Lo esperable está **entre 0,5 y 1,6 GB por año**: el invierno tiene muchos menos rayos que esa muestra. El plan gratis de R2 tiene 10 GB.
- Comprimido con gzip pesaría un 35 % de eso. Se dejó sin comprimir para que cualquier cliente lo lea sin sorpresas; se puede cambiar más adelante.
- **Operaciones en R2:** cada corrida hace unas 5 escrituras y unas 50 lecturas, porque relee las horas de la ventana para ver si están completas. Por mes son unas 3.600 escrituras y 36.000 lecturas, lejos de los topes gratis.

## Tests

`npm test` corre 18 tests con `node:test`. Usan un almacén en carpeta y archivos GLM **sintéticos con la misma estructura** que los reales: mismas variables, int16 con `_Unsigned`, y `scale_factor`, `add_offset` y `_FillValue` copiados de un archivo real de GOES-16. No bajan nada.

Qué cubren:
- el recorte a la caja;
- el decodificado: `_Unsigned`, escala y relleno;
- que una hora incompleta no sea lo mismo que una vacía, y que una hora sin archivos quede incompleta;
- la idempotencia;
- ponerse al día con 48 h exactas: ni la hora abierta ni la de hace 49 h;
- el tope por corrida;
- el candado: vigente, vencido, dos corridas a la vez, y que se suelte aunque la corrida falle;
- el error de NOAA: sin bucles, con la alerta anotada y reintento recién en la corrida siguiente;
- los reintentos de una hora incompleta;
- el satélite según la fecha;
- la firma SigV4, contra el ejemplo publicado por AWS;
- el cliente R2 con un servidor de mentira.

**Control negativo contado:** `node test/control-negativo.mjs`.
- Rompe a propósito una cosa por vez, en una copia de `lib/`, y corre la suite. Cada mutante tiene que hacer fallar al menos un test.
- Antes corre la copia sin romper, que tiene que pasar entera.
- Ejemplos de mutantes: sin recorte, `_Unsigned` ignorado, incompleta marcada como completa, ventana de 47 h, candado ignorado o no soltado, seguir golpeando a NOAA después de un error.

**Verificación con datos reales**, hecha una vez a mano y sin subir nada:
- Se procesaron las horas 18 y 21 UTC del 16/12/2024 (GOES-16, 180 de 180 archivos cada una).
- Se compararon con los flashes que había decodificado el análisis de incendios con netCDF4 de Python, en un radio de 20 km de un incendio de ese día.
- Dieron **91 de 91 flashes iguales**: hora al ms, posición, energía, área y calidad.

## Pendiente para unificar

El colector del SHN tiene su propio cliente R2 (SigV4 sin dependencias). Acá se duplicó lo mínimo en `lib/almacen.mjs`, a propósito.
Cuando los dos estén en main, conviene dejar un solo cliente en una carpeta común y que ambos lo importen.
