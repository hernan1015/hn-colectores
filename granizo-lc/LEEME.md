# granizo-lc · LightningCast en lote (SATCHI Granizo, G3b)

Corre **ProbSevere LightningCast** (CIMSS / Universidad de Wisconsin-Madison) sobre los episodios de granizo y los controles de la lista sellada. Mide:
- la **probabilidad de rayo en los próximos 60 min** por celda de 25 km;
- el **anticipo** contra el primer rayo GLM y contra la hora del granizo informada.

Es análisis de investigación: **sólo salen resultados**. **No hay ningún % de granizo**: la única probabilidad es la de rayo que da LightningCast.

## Licencia: LightningCast es GPL-3.0 y no está en este repositorio

- **En este repo** sólo hay código propio de orquestación y análisis: bajar datos, llamar al programa y leer sus netCDF. **No hay código ni pesos de LightningCast.**
- **Instalación en cada corrida** (`instalar_lc.sh`): se baja de su GitLab oficial (`gitlab.ssec.wisc.edu/jcintineo/lightningcast`), con la versión **fijada**:
  - el paquete de la release `1.4.4`, con su sha256 controlado;
  - el tag `1.4.4` tiene que seguir apuntando al commit `ae208efd4b0bf7615b2f7d716982d5167b03a219`. Si no, la corrida se frena.
- **Cómo se usa:** en un entorno Python aparte y **como programa aparte** (`correr_lc.py` sólo lo arranca, con `runpy`). Nuestro análisis no lo importa.
- **Qué queda anotado:** cada salida guarda `lc_version.json` y `lc_freeze.txt`.
- **Si algún día se distribuye LightningCast** (contenedor, instalador, código para terceros), eso va bajo GPL-3.0, con su fuente y su aviso de copyright.

## Cómo se corre (sólo a mano)

1. Actions → **granizo-lightningcast** → *Run workflow*. Los parámetros:
   - `episodios`: por ejemplo `2026-11-03` o `todos`. **Sólo se aceptan los de `episodios_lote.csv`.**
   - `paso_min`: 10 (todos los full disk) o 20.
   - `horas`: opcional, por ejemplo `15-23`. Vacío es de 12Z a 12Z.
   - `guardar_netcdf`.
2. **No tiene schedule.** Corre a lo sumo **2 episodios a la vez**, y cada uno baja **de a un archivo**: son ≤ 2 pedidos a NOAA. Los archivos se bajan **enteros, nunca por rangos**.
3. **Salida:** un artefacto `lc-AAAA-MM-DD` por episodio, más `lc-lote-resumen`. Duran 30 días. Este primer lote no usa R2.
   - Para bajarla: `gh run download <run-id> -R hernan1015/hn-colectores`.

**Cuánto tarda (estimado, no medido en Actions):**
- Por barrido: ~520 MB de L1b, el modelo y el borrado.
- Un episodio de 24 h a 10 min: ~144 barridos más ~4.300 archivos GLM, unas 1,5-2 h.
- **Sugerencia:** primero `2026-11-03`, para comparar con la corrida de G3b, y después el resto.

## Qué hace cada archivo

| Archivo | Qué hace |
|---|---|
| `armar_lista.py` | Arma `episodios_lote.csv` desde la lista sellada de G3-lote y el catálogo G1. Se corre una vez, fuera de Actions. La primera línea guarda los sha256 de los dos. |
| `episodios_lote.csv` | Los puntos a evaluar: granizo (id, lugar, hora UTC, incertidumbre, celda) y ausencias (estación y horas). Sin nombres de personas ni de fuentes. |
| `matriz.py` | Valida el input y arma la matriz de episodios. |
| `instalar_lc.sh` | Instala LightningCast fijado, en un entorno aparte. |
| `noaa.py` | Lista y baja de los buckets públicos `noaa-goes16` y `noaa-goes19`, de a un pedido y con archivos enteros. |
| `correr_episodio.py` | Baja los flashes GLM-L2-LCFA de la caja y el ABI L1b full disk (C02, C05, C13 y C15). Corre LightningCast en lotes cortos y borra los L1b. Anota todo faltante. |
| `correr_lc.py` | Arranca LightningCast. Si falta `pygrib` (sólo sirve para el radar MRMS de EE. UU.), le pasa un módulo vacío. |
| `analizar_lote.py` | Cruza las probabilidades con GLM y con el catálogo (código propio). |
| `juntar.py` | Junta las tablas de todos los episodios. |
| `granizo-lc.workflow.yml.txt` | El workflow. Va en `.github/workflows/granizo-lightningcast.yml`. |

## Método (el mismo de la corrida de G3b del 3/11, generalizado)

**Configuración de LightningCast:**
- recorte `ll_bbox=[-66, -57, -37, -29]`;
- `netcdf=3 plax_hgt=9000`: se usa `PLTG_60min_plax`, corregida por paralaje con nube a 9 km;
- grilla de salida de ~8 km (`stride` 4).

**Satélite:** GOES-16 hasta el 6/4/2025 y GOES-19 desde el 7/4/2025. Los dos están en 75,2° O.

**Probabilidad por celda** (`prob_celdas.csv`): para cada barrido y cada una de las 226 celdas del piloto (grilla LAEA del contrato), el máximo y la media de los píxeles de la celda. También van:
- los flashes GLM de la celda en los 60 min siguientes;
- si el GLM estuvo completo en esa hora.

**Puntos del catálogo** (`puntos.csv` y `resumen.json`): se toma el máximo de la probabilidad en un radio de 15 km.
- **Primer rayo de la tormenta:** el primer flash después del último hueco de ≥ 60 min sin rayos antes del granizo (+30 min).
- **Anticipo:** desde que la probabilidad pasó el umbral (10, 25, 50 y 75 %) y se quedó arriba hasta ese rayo, o hasta la hora del granizo.
  - Si se cruza un barrido faltante, se corta y se marca.
  - La columna `_entregado` le resta 10 min de latencia: el barrido full disk más la publicación.
- **Contra el granizo sólo** si la hora tiene error ≤ 1 h. Las horas inferidas del GOES del 3/11 (C-20261103-02 y -03) quedan sólo a nivel episodio.
- **En las ausencias** (había tormenta en la estación y no granizó) se da, para cada hora, la probabilidad de la hora previa y de la hora misma, y los rayos GLM.

**Iniciaciones** (`iniciaciones_celdas.csv`): el primer flash en una celda sin rayos en ella ni en sus 8 vecinas en los 60 min previos, con el GLM completo en esa hora. El anticipo va desde el primer barrido con la celda ≥ umbral en los 90 min previos.

**Faltantes** (`faltantes.csv`): barridos o canales ABI que no están, huecos de más de 40 s entre archivos GLM, y barridos sin salida del modelo.
- **Un faltante no es cero:** las celdas o barridos sin dato quedan vacíos y se cuentan.
- Las métricas de «hubo o no hubo rayo» sólo usan horas con el GLM completo.
