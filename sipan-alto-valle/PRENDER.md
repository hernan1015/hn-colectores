# PRENDER la 138 (SIPAN Alto Valle) · la lista exacta para local

**Lo hace local** con el OK del maker (13/11 19:16) y después del ENTRA de la revisión sustituta. Ningún valor secreto va en este archivo ni en el repo.

Los comandos son de Git Bash y `gh` es `C:/Users/jeshe/AppData/Local/Programs/gh/bin/gh.exe`. Todo va contra `-R hernan1015/hn-colectores`, salvo donde se dice otra cosa.

## Los secretos, nombre por nombre

| Nombre en hn-colectores | Qué lleva | De dónde sale | ¿Existe ya? |
|---|---|---|---|
| `SIPAN_PG_URL` | `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:<clave codificada>@<host-del-pooler>:6543/postgres`. Es el **único** secreto de la base: el rol `colector_estaciones` (0147b), LOGIN, sin BYPASSRLS y con CONNECTION LIMIT 3, por el pooler en modo transacción. **Nunca** el usuario `postgres` ni la clave de servicio: el colector se niega a arrancar con otro usuario en la URL, y además verifica `current_user` al conectar | se arma en el paso 2 | no |
| `RADAR_TOKEN` | el token del radar, con **Contents: Read and write SÓLO sobre `hn-radar`**. Sirve tal cual para los releases `sipan-AAAA-MM-DD` | ya está cargado (colector-radar) | **sí**: no se toca |

| Variable (no es secreto) | Valor | Para qué |
|---|---|---|
| `SIPAN_ON` | `si` | prende los dos schedules: el colector cada 6 h y la medición a las 9:41 |

- **No hace falta crear ningún repo:** los crudos van a `hn-radar`, que ya es privado, con el tag `sipan-AAAA-MM-DD`. El radar usa `dia-AAAA-MM-DD`, así que no se pisan.
- **R2 queda apagado** (`SIPAN_R2_*` y `SIPAN_R2_ON`): no se cargan.
- **Ya no se usan** `SIPAN_SUPABASE_URL`, `SIPAN_SUPABASE_ANON_KEY` ni `SIPAN_SUPABASE_JWT` (Plan B, 13/11): no se cargan.

## El orden

### 1 · Aplicar la 0147
- Copiar `0147_estaciones_noche_y_muestreo.sql` y `0147b_rol_colector_estaciones.sql` a `hn-agro/migrations/`.
- **La 0147** se aplica como siempre (SQL editor o MCP).
- **La 0147b NO:** lleva la contraseña por una variable de psql y se aplica en el paso 2.

### 2 · La clave, el rol (0147b) y el secreto, en la misma terminal
Necesita `psql` (cliente de PostgreSQL) y `node`, y se corre desde el clon de hn-colectores en esta rama (o en main ya mergeado).

- **La URL de administración** es la de siempre: el `DATABASE_URL` de Netlify, que es el usuario `postgres.uxyewblbwzqaauzkcihf` por el pooler. Sirve sólo para aplicar la 0147b y **no va a ningún secreto**.
- **El host del pooler** sale de esa misma URL (lo que va entre `@` y `:`, del estilo `aws-0-<región>.pooler.supabase.com`), o del MCP de Supabase (`get_project_url` / la cadena de conexión del pooler).
- **Nada queda en pantalla, en el historial ni en la base en texto plano:**
  - la clave vive sólo en una variable de esta terminal;
  - a la base le llega su **verificador SCRAM** (`migracion/scram.mjs`), no la clave;
  - al secreto le llega por la entrada estándar;
  - al final, `unset`.
```bash
set -o pipefail
GH=/c/Users/jeshe/AppData/Local/Programs/gh/bin/gh.exe
REF=uxyewblbwzqaauzkcihf
read -rs ADMIN_URL                         # pegar el DATABASE_URL de Netlify (no se ve) + Enter
POOLER=$(U="$ADMIN_URL" node -e 'process.stdout.write(new URL(process.env.U).hostname)')
echo "pooler: $POOLER"                      # tiene que terminar en .pooler.supabase.com (si no, no seguir)
CLAVE=$(openssl rand -base64 32)
VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs) || { echo "no salió el verificador: no seguir"; }
# la 0147b, con la contraseña por variable (ON_ERROR_STOP: si algo falla, no sigue)
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f sipan-alto-valle/migracion/0147b_rol_colector_estaciones.sql
# la URL del colector: la clave base64 trae + / = y en una URL van codificadas
CLAVE_URL=$(CLAVE="$CLAVE" node -e 'process.stdout.write(encodeURIComponent(process.env.CLAVE))')
SIPAN_PG_URL="postgresql://colector_estaciones.$REF:$CLAVE_URL@$POOLER:6543/postgres"
```

### 3 · Verificar con ESA URL (antes de cargar el secreto), cargarlo y borrar todo
```bash
# 3a · ¿entra como colector_estaciones? (tiene que decir colector_estaciones)
psql "$SIPAN_PG_URL" -At -c "select current_user"
# 3b · un insert PERMITIDO (su proceso): tiene que decir INSERT 0 1
psql "$SIPAN_PG_URL" -c "insert into registro_procesos (proceso, ok, resumen) values ('sipan_alto_valle', true, '{\"prueba\": \"PRENDER paso 3\"}')"
# 3c · un insert de OTRA RED: tiene que FALLAR con «new row violates row-level security policy»
psql "$SIPAN_PG_URL" -c "insert into estaciones (red, estacion_id) values ('SNIH', 'prueba-no-va')"
# 3d · lo que no puede: tiene que FALLAR con «permission denied»
psql "$SIPAN_PG_URL" -c "select count(*) from campana.lotes"
psql "$SIPAN_PG_URL" -c "delete from estaciones_obs where red = 'INTA_SIPAN_AV'"
# si 3a-3d dieron lo que dicen: cargar el secreto
printf %s "$SIPAN_PG_URL" | $GH secret set SIPAN_PG_URL -R hernan1015/hn-colectores
unset CLAVE CLAVE_URL VERIF SIPAN_PG_URL ADMIN_URL POOLER
```
- **Si 3a no entra** («password authentication failed», «tenant or user not found»): revisar el usuario `colector_estaciones.<ref>` y el host del pooler. El puerto es **6543** (modo transacción).
- **Si 3b falla con «violates row-level security policy»,** la política de `registro_procesos` no se creó: volver a correr la 0147b.
- **Si 3c PASA,** la RLS no rige para el rol: **no seguir**, borrar esa fila con el usuario de administración y avisarme.
- **Que lo de siempre siga anotando:** con la URL de administración,
  - `select relrowsecurity from pg_class where oid = 'public.registro_procesos'::regclass;` tiene que dar `true`;
  - la próxima corrida de cualquier function de Netlify tiene que aparecer en `select proceso, max(creado_at) from registro_procesos group by 1;`. Esas functions entran con el dueño de la tabla, que saltea la RLS.
- **Si hay que cambiar la clave:** se repite el paso 2 entero. La 0147b es idempotente: vuelve a fijar la contraseña.

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
# esperar ~10 s a que GitHub la registre; después tomar la de workflow_dispatch más nueva
$GH run list -R hernan1015/hn-colectores -w colector-sipan-alto-valle --event workflow_dispatch -L 3
$GH run watch -R hernan1015/hn-colectores <el id de la de recién>
```
**Qué mirar en el registro** (el renglón JSON del paso «Colectar»):
- `pedidos`: **5**, uno por estación. `pedidos_barrido`: 1 (`clima.htm`) más uno por cada id nuevo que aparezca, hasta 15. Todos van con 30 s de pausa, también entre el último `downld02` y `clima.htm`.
- `estaciones`: las 5, con `registros` ≈ 240 y `horas_desde_ultimo` ≤ 1.
- `avisos`: vacío. Si aparece **`sipan_corto`**, el SIPAN también corta desde Actions: **no reintentar** ese día y avisarme.
- `barrido.en_pagina` / `barrido.probados`: los ids de Vista Alegre, Río Colorado y la estación nueva. Pasármelos y los sumo al catálogo.
- **El modo seco no guarda nada,** tampoco el formato. El primer formato de cada estación queda como el aceptado recién en la primera corrida **real** (paso 7). Si alguna dice `formato_no_se_entiende`, pasame el motivo.

### 7 · La primera corrida REAL, a mano
```bash
$GH workflow run colector-sipan-alto-valle -R hernan1015/hn-colectores -f modo=real
```
**Cómo verificar que anduvo:**
- **El paso termina en verde, y desde esta primera corrida** ya hay filas en `estaciones_obs`: la fila de cada estación se guarda antes que sus datos, por la FK. En rojo (código 2) quiere decir avisos o errores: mirar `registro_procesos` (`resumen->'errores_detalle'`). Una falla de GitHub con los crudos queda como error de esa estación, pero su diario se guarda igual.
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
