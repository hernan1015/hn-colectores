# PRENDER la 138 (SIPAN Alto Valle) · la lista exacta para local

**Lo hace local** con el OK del maker (13/11 19:16) y después del ENTRA de la revisión sustituta. Ningún valor secreto va en este archivo ni en el repo.

Los comandos son de Git Bash y `gh` es `C:/Users/jeshe/AppData/Local/Programs/gh/bin/gh.exe`. Todo va contra `-R hernan1015/hn-colectores`, salvo donde se dice otra cosa.

## Los secretos, nombre por nombre

| Nombre en hn-colectores | Qué lleva | De dónde sale | ¿Existe ya? |
|---|---|---|---|
| `SIPAN_PG_URL` | `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:<clave hex>@<host-del-pooler>:6543/postgres`. Es el **único** secreto de la base: el rol `colector_estaciones` (0147b), LOGIN, sin BYPASSRLS y con CONNECTION LIMIT 3, por el pooler en modo transacción. **Nunca** el usuario `postgres` ni la clave de servicio: el colector se niega a arrancar con otro usuario en la URL, y además verifica `current_user` al conectar | se arma en el paso 2 | no |
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

### 2 · La clave, el rol (0147b) y la URL, en la misma terminal
Necesita `psql` (cliente de PostgreSQL ≥ 16) y `node`, y se corre desde el clon de hn-colectores, en esta rama o en main ya mergeado. **En Windows, `psql` lleva TODAS las opciones (`-v`, `-f`, `-c`, `-X`, `-At`) ANTES de la URL**: en Windows `psql` no reordena los argumentos, así que una opción escrita después de la URL no se toma como opción (lo marcó local al prenderlo, 13/11). Los comandos de abajo ya van así.

- **La URL de administración** es la de siempre: el `DATABASE_URL` de Netlify, que es el usuario `postgres.uxyewblbwzqaauzkcihf` por el pooler. Sirve sólo para aplicar la 0147b y **no va a ningún secreto**.
- **El host del pooler** sale de esa misma URL (lo que va entre `@` y `:`, del estilo `aws-0-<región>.pooler.supabase.com`) o del MCP de Supabase. El colector **sólo** conecta a un host `….pooler.supabase.com`.
- **La clave es hexadecimal** (`openssl rand -hex 32`, 64 caracteres). No trae `+ / =`, no hay que codificarla y Git Bash no la toca: con base64, una clave que empieza con `/` se convierte en `C:/Program Files/Git/…`.
- **Nada queda en pantalla, en el historial ni en la base en texto plano:**
  - la clave vive sólo en una variable de esta terminal;
  - a la base le llega su **verificador SCRAM** (`migracion/scram.mjs`);
  - al secreto le llega por la entrada estándar, en el paso 3e.
- **Cada paso CORTA si el anterior falló:** todo va encadenado con `&&`, y el último `echo` dice si se llegó al final.
  - Mientras corre `psql`, la URL de administración y el verificador se ven en la lista de procesos de esta PC. Es aceptable en la PC propia.
```bash
set -o pipefail
GH=/c/Users/jeshe/AppData/Local/Programs/gh/bin/gh.exe
REF=uxyewblbwzqaauzkcihf
read -rs ADMIN_URL                         # pegar el DATABASE_URL de Netlify (no se ve) + Enter
POOLER=$(U="$ADMIN_URL" node -e 'process.stdout.write(new URL(process.env.U).hostname)') \
 && case "$POOLER" in *.pooler.supabase.com) true ;; *) echo "el host no es el pooler: NO SEGUIR"; false ;; esac \
 && CLAVE=$(openssl rand -hex 32) && [ ${#CLAVE} -eq 64 ] \
 && VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs) && [ -n "$VERIF" ] \
 && psql -v ON_ERROR_STOP=1 -v clave="$VERIF" -f sipan-alto-valle/migracion/0147b_rol_colector_estaciones.sql "$ADMIN_URL" \
 && SIPAN_PG_URL="postgresql://colector_estaciones.$REF:$CLAVE@$POOLER:6543/postgres" \
 && echo "PASO 2 OK" || echo "PASO 2 FALLÓ: no seguir (ver el error de arriba)"
```
- **Si la 0147b corta con «colector_estaciones tiene atributos de más»,** el rol ya existía con SUPERUSER, REPLICATION, BYPASSRLS, CREATEROLE, CREATEDB o INHERIT. Hay que borrarlo con el usuario de administración (`drop role colector_estaciones;`, si todavía no tiene objetos) y volver a correr el paso 2.
- **Si aparece la advertencia «authenticator sigue siendo miembro…»,** quedó de la versión JWT, otorgado por otro usuario. Hay que sacarlo con ese usuario.

### 3 · Verificar con ESA URL (antes de cargar el secreto), cargarlo y borrar todo
```bash
# 3a-3d: cada chequeo tiene que dar lo esperado; si alguno no, VERIF_OK queda vacío y el 3e no carga nada
VERIF_OK=
q() { psql -X -At -v ON_ERROR_STOP=1 -c "$1" "$SIPAN_PG_URL" 2>&1; }
r1=$(q "select current_user || ' ' || session_user") ; echo "3a: $r1"            # colector_estaciones colector_estaciones
r2=$(q "insert into registro_procesos (proceso, ok, resumen) values ('sipan_alto_valle', false, '{\"prueba\": \"PRENDER paso 3, no es una corrida\"}')"); echo "3b: $r2"   # INSERT 0 1
r3=$(q "insert into estaciones (red, estacion_id) values ('SNIH', 'prueba-no-va')"); echo "3c: $r3"   # ERROR … row-level security policy
r4=$(q "select count(*) from estaciones where red = 'SNIH'"); echo "3d1: $r4"                         # 0
r5=$(q "select has_schema_privilege('public', 'CREATE')"); echo "3d2: $r5"                             # f
r6=$(q "create table public.prueba_no_va (i int)"); echo "3d3: $r6"                                     # ERROR … permission denied
r7=$(q "select count(*) from campana.lotes"); echo "3d4: $r7"                                           # ERROR … permission denied
r8=$(q "delete from estaciones_obs where red = 'INTA_SIPAN_AV'"); echo "3d5: $r8"                       # ERROR … permission denied
[ "$r1" = "colector_estaciones colector_estaciones" ] && [[ "$r2" == *"INSERT 0 1"* ]] \
 && [[ "$r3" == *"row-level security"* ]] && [ "$r4" = "0" ] && [ "$r5" = "f" ] \
 && [[ "$r6" == *"permission denied"* ]] && [[ "$r7" == *"permission denied"* ]] && [[ "$r8" == *"permission denied"* ]] \
 && VERIF_OK=si && echo "PASO 3 OK" || echo "PASO 3 FALLÓ: NO cargar el secreto (mirar cuál dio distinto)"
```
```bash
# 3e: SÓLO si el bloque de arriba dijo «PASO 3 OK»
[ "$VERIF_OK" = si ] && printf %s "$SIPAN_PG_URL" | $GH secret set SIPAN_PG_URL -R hernan1015/hn-colectores && echo "secreto cargado"
unset CLAVE VERIF SIPAN_PG_URL ADMIN_URL POOLER VERIF_OK r1 r2 r3 r4 r5 r6 r7 r8
```
- **El renglón de prueba del 3b** queda con `ok=false` y `resumen = {"prueba": …}`: no se confunde con una corrida. Si se quiere, se borra después con el usuario de administración: `delete from registro_procesos where proceso = 'sipan_alto_valle' and resumen ? 'prueba';`.
- **Si el 3a no entra** («password authentication failed», «tenant or user not found»): revisar el usuario `colector_estaciones.<ref>` y el host del pooler. El puerto es **6543** (modo transacción).
- **Si el 3a muestra dos usuarios distintos:** la URL no es la que se armó en el paso 2. No seguir.
- **Si el 3b falla con «violates row-level security policy»:** la política de `registro_procesos` no se creó. Volver a correr la 0147b.
- **Si el 3c PASA:** la RLS no rige para el rol. **No seguir:** borrar esa fila con el usuario de administración y avisarme.
- **Si el 3d2 da `t` o el 3d3 crea la tabla:** PUBLIC tiene CREATE en `public`, en esta base. Hay que avisarme antes de seguir y borrar `public.prueba_no_va` con el usuario de administración.
- **Que lo de siempre siga anotando:** con la URL de administración,
  - `select relrowsecurity from pg_class where oid = 'public.registro_procesos'::regclass;` tiene que dar `true`;
  - la próxima corrida de cualquier function de Netlify tiene que aparecer en `select proceso, max(creado_at) from registro_procesos group by 1;`.
- **Para cambiar la clave:** se repiten los pasos 2 y 3. La 0147b es idempotente y vuelve a fijar la contraseña.


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
