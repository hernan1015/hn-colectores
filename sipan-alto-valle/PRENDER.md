# PRENDER la 138 (SIPAN Alto Valle) · la lista exacta para local

**Lo hace local** con el OK del maker (13/11 19:16) y después del ENTRA de la revisión sustituta. Ningún valor secreto va en este archivo ni en el repo.

Los comandos son de Git Bash y `gh` es `C:/Users/jeshe/AppData/Local/Programs/gh/bin/gh.exe`. Todo va contra `-R hernan1015/hn-colectores`, salvo donde se dice otra cosa.

## Los secretos, nombre por nombre

| Nombre en hn-colectores | Qué lleva | De dónde sale | ¿Existe ya? |
|---|---|---|---|
| `SIPAN_SUPABASE_URL` | la dirección del proyecto, `https://<ref>.supabase.co` | Dashboard → Project Settings → API | no |
| `SIPAN_SUPABASE_ANON_KEY` | la clave **anon** (o la *publishable*) del proyecto. Sola no da nada: con RLS sin políticas, anon no ve estas tablas | Dashboard → Project Settings → API Keys | no |
| `SIPAN_SUPABASE_JWT` | un JWT firmado con `{"role":"colector_estaciones"}` (0147b). El colector se niega a arrancar con cualquier otro rol, y **NUNCA lleva la clave de servicio** | `migracion/firmar-jwt.mjs` (paso 3) | no |
| `RADAR_TOKEN` | el token del radar, con **Contents: Read and write SÓLO sobre `hn-radar`**. Sirve tal cual para los releases `sipan-AAAA-MM-DD` | ya está cargado (colector-radar) | **sí**: no se toca |

| Variable (no es secreto) | Valor | Para qué |
|---|---|---|
| `SIPAN_ON` | `si` | prende los dos schedules: el colector cada 6 h y la medición a las 9:41 |

- **No hace falta crear ningún repo:** los crudos van a `hn-radar`, que ya es privado, con el tag `sipan-AAAA-MM-DD`. El radar usa `dia-AAAA-MM-DD`, así que no se pisan.
- **R2 queda apagado** (`SIPAN_R2_*` y `SIPAN_R2_ON`): no se cargan.

## El orden

### 1 · Aplicar la 0147 y la 0147b (en este orden)
- Copiarlas a `hn-agro/migrations/`:
  - `0147_estaciones_noche_y_muestreo.sql`;
  - `0147b_rol_colector_estaciones.sql`.
- Aplicarlas en Supabase (SQL editor o MCP), primero la 0147.
- **Verificar** con el bloque «Verificación» del final de la 0147b: `set role colector_estaciones; …`. Tienen que dar 0 filas del SNIH, *permission denied* en `campana.lotes` y en el DELETE, y la política violada con el proceso «otro».

### 2 · La clave anon y la URL
```bash
GH=/c/Users/jeshe/AppData/Local/Programs/gh/bin/gh.exe
$GH secret set SIPAN_SUPABASE_URL      -R hernan1015/hn-colectores     # pega la URL cuando la pide
$GH secret set SIPAN_SUPABASE_ANON_KEY -R hernan1015/hn-colectores     # pega la anon/publishable
```

### 3 · El JWT del rol (una vez; vence en 365 días; anotar la fecha)
- **El secreto para firmarlo:** Dashboard → Project Settings → **JWT Keys** → «Legacy JWT secret» (HS256), con el botón de revelar.
- **Se pasa por la entrada estándar** y no queda en el historial:
```bash
read -rs SUPABASE_JWT_SECRET && export SUPABASE_JWT_SECRET      # pegar el secreto (no se ve) + Enter
node sipan-alto-valle/migracion/firmar-jwt.mjs --dias 365 | $GH secret set SIPAN_SUPABASE_JWT -R hernan1015/hn-colectores
unset SUPABASE_JWT_SECRET
```
- **Probarlo antes de seguir.** Tiene que dar `[]` o la lista vacía, y **no** un 401:
```bash
curl -s "https://<ref>.supabase.co/rest/v1/estaciones?red=eq.INTA_SIPAN_AV&select=estacion_id" -H "apikey: <anon>" -H "Authorization: Bearer <el JWT>"
```
- **Plan B**, si el proyecto ya no acepta el JWT secret legado (sólo claves asimétricas), o si da 401 con un JWT bien armado: **no seguir**. Avisarme y paso el colector a Postgres directo:
  - el mismo rol, con `LOGIN` y contraseña;
  - por el *pooler*;
  - con el paquete `postgres`.
  - **Eso no está hecho en esta rama.**

### 4 · Mergear el PR #2
```bash
$GH pr merge 2 -R hernan1015/hn-colectores --merge
```

### 5 · Instalar los dos workflows (hace falta el permiso `workflow`: el token de local lo tiene)
```bash
cd <clon de hn-colectores en main, al día>
git mv sipan-alto-valle/sipan-alto-valle.workflow.yml.txt  .github/workflows/sipan-alto-valle.yml
git mv sipan-alto-valle/medicion-heladas.workflow.yml.txt  .github/workflows/medicion-heladas.yml
git commit -m "ci(sipan): instala el colector y la medición (apagados hasta SIPAN_ON=si) [skip netlify]" && git push
```

### 6 · La primera corrida, a mano y en modo SECO (no escribe nada)
```bash
$GH workflow run colector-sipan-alto-valle -R hernan1015/hn-colectores -f modo=seco -f barrer=true
$GH run watch -R hernan1015/hn-colectores $($GH run list -R hernan1015/hn-colectores -w colector-sipan-alto-valle -L 1 --json databaseId -q '.[0].databaseId')
```
**Qué mirar en el registro** (el renglón JSON del paso «Colectar»):
- `pedidos`: entre 6 y 7 (más el barrido).
- `estaciones`: las 5, con `registros` ≈ 240 y `horas_desde_ultimo` ≤ 1.
- `avisos`: vacío. Si aparece **`sipan_corto`**, el SIPAN también corta desde Actions: **no reintentar** ese día y avisarme.
- `barrido.en_pagina` / `barrido.probados`: los ids de Vista Alegre, Río Colorado y la estación nueva. Pasármelos y los sumo al catálogo.
- **El primer formato de cada estación queda como el aceptado.** Si alguna dice `formato_no_se_entiende`, pasame el motivo.

### 7 · La primera corrida REAL, a mano
```bash
$GH workflow run colector-sipan-alto-valle -R hernan1015/hn-colectores -f modo=real
```
**Cómo verificar que anduvo:**
- **El paso termina en verde.** En rojo (código 2) quiere decir avisos: mirar `registro_procesos`.
- **En Supabase:**
```sql
select estacion_id, fecha, tmin_c, tmax_c, lluvia_mm, eto_mm, tmin_noche_c, tmin_noche_en, noche_registros, registros_validos
  from estaciones_obs where red = 'INTA_SIPAN_AV' order by fecha desc, estacion_id;          -- 2-3 fechas × 5 estaciones
select estacion_id, nombre, metadatos->>'formato_firma', metadatos->>'ultimo_registro' from estaciones where red = 'INTA_SIPAN_AV';
select creado_at, ok, resumen->'avisos' from registro_procesos where proceso = 'sipan_alto_valle' order by creado_at desc limit 3;
```
- **Los crudos:** tiene que haber un release de hoy con 5 assets (`10__….json.gz` … `45__….json.gz`) y, probablemente, otro de ayer.
```bash
$GH release view sipan-$(TZ=America/Argentina/Buenos_Aires date +%F) -R hernan1015/hn-radar
```
- **Una segunda corrida real** (a mano o la del schedule) **no tiene que duplicar nada:** cada release sigue con 1 asset por estación y `registros_validos` del día anterior sube hasta 144.

### 8 · Prender los schedules
```bash
$GH variable set SIPAN_ON -R hernan1015/hn-colectores --body si
```

### 9 · La medición (a la mañana siguiente, o a mano en seco)
```bash
$GH workflow run medicion-heladas-sipan -R hernan1015/hn-colectores -f dias=2 -f seco=true
```
- El registro muestra `noches` y `filas`. Sin noches completas (≥ 90 %) da 0: es normal la primera mañana.
- En real, queda en `pronostico_helada_medicion` y en `registro_procesos` (`sipan_medicion_heladas`).

## Para apagarlo
- `gh variable set SIPAN_ON --body no`: los schedules dejan de correr y lo guardado queda.
- **Revocar el rol:** el ROLLBACK comentado de la 0147b.
