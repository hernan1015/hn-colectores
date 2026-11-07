# granizo-g3 · SATCHI Granizo, etapa 3 en lote

Seguimiento de celdas de tormenta con GOES ABI banda 13 (cada 10 min) y GLM de 20 s, **un episodio por trabajo** (día convectivo de 12 a 12 UTC). **Sin etiquetas:** el cruce con el catálogo de granizo se hace del lado privado, no acá. Corre **sólo a mano** (`workflow_dispatch`), sin programación.

> Experimental. No es un aviso oficial del SMN. La salida son atributos por celda: ningún porcentaje ni probabilidad de granizo.

## Archivos
- `analisis_g3.py`: copia del prototipo G3 con los cambios para el lote marcados `LOTE:` (ver su encabezado). Lo principal: **el ABI se baja como archivo entero** y se recorta; no se leen rangos HTTP.
- `lote.py`: arma el episodio, elige `noaa-goes16` (hasta el 6/4/2025) o `noaa-goes19` (desde el 7/4/2025), corre bajada + seguimiento y escribe la salida sin etiquetas. La evaluación (`--catalogo`, `--solo-evaluar`) sólo corre del lado privado, con el catálogo que no está en este repositorio.
- `episodios.csv`: la lista sellada de 42 episodios (28 con granizo confirmado y 14 controles con tormenta sin granizo observado). sha256 `d7f9572669c08d4c2cc7a78624f39195a633ffa80051956c8cd2da2e9ffdda01`.
- `granizo-g3.workflow.yml.txt`: el workflow. Para activarlo hay que copiarlo a `.github/workflows/granizo-g3.yml`.
- `requirements.txt`: dependencias, todas con licencia permisiva (tobac y trackpy BSD-3). Nada GPL.

## Correr
- Todo el lote: Actions → `granizo-g3` → Run workflow con `episodios = todos`.
- Desde la terminal: `gh workflow run granizo-g3.yml -R hernan1015/hn-colectores --ref <rama> -f episodios=todos`
- Prueba corta: `-f episodios=2026-11-03 -f horas=20-21`.
- Bajar resultados: `gh run download <id> -R hernan1015/hn-colectores` (un artefacto `g3-<episodio>` por episodio).

## Uso del servidor de NOAA
- Archivos enteros, nunca rangos. Un pedido a la vez por trabajo y 2 trabajos a la vez: **como mucho 2 pedidos simultáneos**.
- Por episodio: 144 imágenes ABI de disco completo (se recortan y se borran) y 4.320 archivos GLM. Los intermedios no se suben.

## Salida por episodio
- `atributos_probsevere.csv`: celda tobac × imagen, con nombres de columnas al estilo ProbSevere v3 (sólo los nombres: no se copió código GPL).
- `saltos.csv`: saltos de rayos 2σ, por versión (celda, linaje, sin regla, familia, sistema).
- `senales_provisorias.csv`: señales provisorias por celda (salto GLM, enfriamiento ABI, las dos), con hora de disponibilidad, vencimiento y celda de 25 km. Los umbrales son provisorios y no están sellados.
- `cobertura.json`: hora efectiva de cada imagen y archivos ABI/GLM por hora (los faltantes son «sin datos», nunca cero).
- Además: `celdas_resumen.csv`, `celdas_frames.csv`, `meta.json`, `abi_log.json`, `fusiones_divisiones.json`.

Fuentes: NOAA GOES-16/19 ABI L2 CMIPF y GLM L2 LCFA (NOAA Open Data Dissemination, buckets públicos en AWS). Seguimiento: tobac (BSD-3).
