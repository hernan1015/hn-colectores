# PRENDER la 139 · SMN, datos abiertos (`SMN_ABIERTO`) · la lista exacta para local

**Lo hace local**, después del Codex del PR. Ningún valor secreto va en este archivo ni en el repo. Los comandos son de Git Bash; `gh` es `C:/Users/jeshe/AppData/Local/Programs/gh/bin/gh.exe` (`$GH`).

## Qué es
- **La fuente:** el archivo «datos horarios» del catálogo de datos abiertos del SMN, `https://ssl.smn.gob.ar/dpd/zipopendata.php?dato=datohorario`. Es un ZIP con `datohorarioAAAAMMDD.txt`: las lecturas **horarias del día anterior** (TEMP, HUM, PNM, DD, FF) de todas las estaciones. **No trae lluvia** ni coordenadas.
- **La licencia:** Dato Abierto del SMN, **CC BY 2.5 AR**, «incluso comercialmente», atribuyendo al SMN. Lo dice la política de datos del SMN (IF-2022-12826402-APN-SMN#MD, §4.A y Apéndice I.2.5): https://argentina.gob.ar/normativa/361173_disp25_pdf/archivo. Por eso la red va **MOSTRAR**: cada fila de `estaciones` lleva `metadatos.mostrar = true`, `licencia`, `licencia_url`, `cita`, `cita_textual`, `politica_url` y `cambios` (lib/licencia.mjs). Mostrarla en pantalla es otra pieza: la maqueta de la 139b.
- **La política del SMN, §4.C:** la demanda periódica con garantía de servicio se cobra. Acá **no se pide ninguna garantía**: se lee el archivo público tal como está, sin clave ni acuerdo.
- **La frecuencia:** el SMN publica el archivo una vez por día. pg_cron dispara a las **10:17** y a las **16:17** de Argentina; la segunda corrida **no pide nada** si la primera ya cargó el archivo de ayer. **UN pedido** por corrida, con User-Agent genérico.
- **Cloudflare:** `smn.gob.ar` pone un desafío a los programas, pero `ssl.smn.gob.ar/dpd` respondió **200 sin desafío** (14/11 03:29, un solo pedido desde pc-nanci). Si responde un desafío, 402, 403, 429 o 5xx, la corrida **se corta y avisa `smn_corto`**. No se evade.

## Secretos y variables: no hay nada nuevo
| Lo que usa el workflow | De dónde | ¿Existe? |
|---|---|---|
| `SMN_PG_URL` | **el mismo secreto `SIPAN_PG_URL`**: el rol `colector_estaciones` (0147b), que con la 0149 también escribe `SMN_ABIERTO` | sí |
| `SMN_CRUDOS_TOKEN` | `RADAR_TOKEN`: la copia del ZIP va a `hn-radar` (privado), un release por día `smn-AAAA-MM-DD` | sí |

## El orden

### 1 · El número y los archivos
- **0149:** al 14/11 03:40 ninguna rama tenía una 0149. Confirmalo antes de aplicar; si está tomado, renombro las dos.
- Copiar `smn-abierto/migracion/0149_smn_abierto_rol.sql` y `smn-abierto/migracion/0149b_smn_abierto_disparo.sql` a `hn-agro/migrations/`.

### 2 · Aplicar la 0149 (el rol)
- Con el editor SQL o el MCP: no lleva variables de psql. Necesita la 0147b aplicada; si no está, se corta sola.
- **Sólo amplía** las dos políticas de la 0147b: suma la red `SMN_ABIERTO` y el proceso `smn_abierto`. Las redes y procesos de antes quedan igual. No toca grants, atributos ni la contraseña.
- Verificar: `select tablename, qual, with_check from pg_policies where policyname like 'colector_estaciones_sus_%' order by 1;`

### 3 · Mergear el PR e instalar el workflow (hace falta el permiso `workflow`)
```bash
cd <clon de hn-colectores en main, al día>
git mv smn-abierto/smn-abierto.workflow.yml.txt .github/workflows/smn-abierto.yml
git commit -m "ci(smn): instala el colector del SMN, datos abiertos (sin schedule: lo dispara pg_cron) [skip netlify]" && git push
```

### 4 · La primera corrida, a mano y en SECO (no escribe nada)
```bash
$GH workflow run colector-smn-abierto -R hernan1015/hn-colectores -f modo=seco
$GH run list -R hernan1015/hn-colectores -w colector-smn-abierto --event workflow_dispatch -L 3
$GH run watch -R hernan1015/hn-colectores <el id de la de recién>
```
**Qué mirar** en el renglón JSON del paso «Colectar»:
- `pedidos`: **1**.
- **`avisos` con `smn_corto`:** el SMN corta desde los servidores de GitHub (EE. UU.); en julio ya había rechazado a un servidor de EE. UU. **No reintentar** y avisarme. No se evade.
- **`estado: "vacio"`:** el archivo de ayer todavía no está. Probar de nuevo más tarde, a mano. Si a las 16 sigue vacío, avisame y movemos el horario.
- **`formato_no_se_entiende` o `formato_cambiado`:** pasame el `motivo`. **El formato no está verificado con un archivo con datos.** El único pedido real trajo el `.txt` vacío, así que el lector exige el formato documentado y, si es distinto, **no carga nada**.
- **`estado: "ok"`:** `estaciones` ≈ 118, `descartadas` 0, `repetidas_en_archivo` 0 y `filas_obs` ≈ 2 × estaciones. Los días son el de ayer y el de anteayer, que se completa con la lectura de las 00.

### 5 · La primera corrida REAL, a mano
```bash
$GH workflow run colector-smn-abierto -R hernan1015/hn-colectores -f modo=real
```
- **Verde:** quedaron filas guardadas. **Rojo (código 2):** hay avisos o errores. Mirar `registro_procesos` (`resumen->'errores_detalle'`). La primera corrida real deja aceptado el formato (`metadatos.formato_firma`).
```sql
select estacion_id, nombre, activa, metadatos->>'mostrar', metadatos->>'licencia', metadatos->>'ultimo_archivo' from estaciones where red = 'SMN_ABIERTO' order by 1;
select estacion_id, fecha, tmin_c, tmax_c, registros_validos, tmin_noche_c, noche_registros, muestreo_min, lluvia_mm
  from estaciones_obs where red = 'SMN_ABIERTO' order by fecha desc, estacion_id limit 40;    -- lluvia_mm SIEMPRE null
select creado_at, ok, resumen->'avisos', resumen->>'estado' from registro_procesos where proceso = 'smn_abierto' order by creado_at desc limit 3;
```
- **Una segunda corrida real el mismo día** tiene que decir `estado: "ya_cargado"` y `pedidos: 0`.
- **La copia del ZIP:** `$GH release view smn-<fecha del archivo> -R hernan1015/hn-radar` (1 asset `datohorario__….zip`).

### 6 · El disparo: la 0149b y la llave
- Aplicar `0149b_smn_abierto_disparo.sql` (editor SQL o MCP, como postgres). Necesita la 0148 y se corta si no está.
- Crea la llave `smn-abierto` **APAGADA** y dos jobs: `smn-abierto-disparo` (`17 13 * * *` = 10:17) y `smn-abierto-disparo-tarde` (`17 19 * * *` = 16:17, con `ultimo=si`: si el archivo sigue vacío, avisa).
- Con el OK, prenderla:
```sql
update public.colector_llaves set activa = true, cambiada_en = now() where etiqueta = 'smn-abierto';
```

## Para apagarlo
- `update public.colector_llaves set activa = false, cambiada_en = now() where etiqueta = 'smn-abierto';` (lo guardado queda).
- La red sale del rol con el ROLLBACK comentado de la 0149.

## Lo que falta (no es de este PR)
- **Las coordenadas:** el datohorario no las trae y las estaciones quedan con `lat`/`lon` null. Salen del archivo de estaciones del mismo catálogo: es **otro pedido**, y lo hago con tu OK.
- **«Tiempo presente»** (`dato=tiepre`, cada hora): sirve para la helada en vivo. Es otro conector.
- **La regla de los 2 km** (139, la preferida entre fuentes duplicadas) y **la capa en pantalla** (139b, primero la maqueta).
- **El id de cada estación es su nombre** (`AEROPARQUE_AERO`), porque el archivo no trae el número OMM. Si el SMN cambia un nombre, aparece una estación nueva y la vieja queda inactiva a los 30 días.
