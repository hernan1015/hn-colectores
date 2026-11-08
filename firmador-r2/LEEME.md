# firmador-r2 · los enlaces firmados de R2, desde la nube

**Qué hace:** un solo paso de Actions que, para `tormentas/`, `escenarios/`, `opera/cog/` y `rayos-hora/` del depósito privado de R2:
1. lista los objetos (ListObjectsV2, con la firma de cabeceras de `rayos-hora/lib/almacen.mjs`);
2. firma un GET por objeto (SigV4 por query, `X-Amz-Expires=604800`, `UNSIGNED-PAYLOAD`, región `auto`);
3. prueba el enlace recién firmado: los JSON se bajan enteros (de ahí sale `emitido`); de un `.tif` y de una hora de rayos se pide 1 byte;
4. hace upsert en `public.r2_enlaces` (hn-agro, migración 0129) con el rol `firmador_r2`.

**Para qué:** hoy esos enlaces los renueva la PC de local con tareas programadas. Así dejan de depender de esa PC.

## Las claves: exactamente las que buscan las functions de hn-agro

| prefijo | clave | la lee | cuántas |
|---|---|---|---|
| tormentas | `tormentas/proyeccion_tormentas.json` | `proyeccion-tormentas.js` | 1 |
| escenarios | `escenarios/{indice,brasil,parana,paraguay}.json` | `escenarios-rio.js` | 4 (el índice y 3 zonas) |
| OPERA | `opera/cog/pasadas.json` y `opera/cog/cuenca-del-plata/AAAA-MM-DD.tif` | `_lib/satchi-opera-fecha.js` (usada por `satchi-opera.js`) | 1 + 91 |
| rayos | `rayos-hora/AAAA/MM/DD/HH.json` (UTC) | `lib/rayos-previos.mjs` (rama `feat/satchi-p3-filtros-rayos`) | las horas cerradas de los últimos **3 días** (72) |

- **OPERA:** los mosaicos que se esperan son un día por fecha, entre `desde` y `hasta` de `pasadas.json`. Hoy son del 27/07 al 25/10, o sea 91.
  - Se firman todos los `.tif` que haya con ese nombre.
  - Si falta alguno del rango, se dice.
  - Si no son 91, sale un aviso.
- **Rayos, N = 3 días:**
  - la ficha mira las **24 h antes** de la primera detección (`H_H = 24`);
  - se dejan **48 h de margen** para que un foco detectado hasta 2 días atrás tenga sus 24 h completas.
  - Se cambia con la entrada `dias_rayos` (de 1 a 7).
  - Las horas firmadas en corridas anteriores siguen sirviendo hasta que vence su enlace, a los 7 días.
- **Lo que no se firma:** lo que sobra bajo esos prefijos no coincide con ninguna clave de las functions. Sale como «ignorados» en el resumen:
  - `candado.json` y `alertas.txt` de rayos;
  - `_subida/`;
  - el `.zip` de escenarios;
  - cualquier otro archivo.
- **`emitido`:**
  - tormentas y zonas: el `emitido` del JSON;
  - índice: el más nuevo de sus renglones;
  - `pasadas.json`: su `hasta`;
  - `.tif`: la fecha del nombre;
  - rayos: el día UTC de la hora.
  - Si no se puede leer, queda `null`, y **`null` no pisa el que había**.

## Reglas
- **Nunca borra filas.** Si una hora de rayos ya no está en la ventana, su fila queda como estaba (vence sola).
- **No pisa un enlace que vence después.** Si la PC firmó más tarde, queda el de la PC (`where t.vence <= excluded.vence`). Las dos pueden convivir mientras dure la mudanza.
- **Es idempotente.** Correrlo dos veces deja la tabla igual.
- **Si la prueba del enlace falla en un prefijo, ese prefijo no se escribe.** Así no se reemplaza un enlace bueno por uno malo.
- **Lo que falta se dice, no se inventa.**
  - Si falta algo de tormentas, escenarios u OPERA, la corrida sale con código 1 (rojo en Actions), pero lo que había se escribe igual.
  - Si faltan horas de rayos, es sólo un aviso, porque el colector `rayos-hora` todavía puede no estar activo.
- **Resumen al final**, en la consola y en el resumen de Actions:
  - por prefijo: en R2, firmados, ignorados, faltan y errores;
  - en la base: nuevas, actualizadas y sin cambio.
  - **Nunca se imprimen URL firmadas ni llaves.**

## Secretos (sólo los nombres; los carga local)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET`: los mismos de `rayos-hora`.
  - Alcanza con una llave de R2 **de sólo lectura** sobre el depósito: los enlaces firmados con ella sirven para GET.
  - Si se quiere separar de la de `rayos-hora`, que escribe, se puede usar un *environment* de Actions con los mismos nombres.
- `SUPABASE_FIRMADOR_URL`: la conexión con el rol `firmador_r2`, por el pooler. Las máquinas de Actions no tienen IPv6 para la conexión directa. El formato está en `0141_firmador_r2_rol.sql`.
- `SUPABASE_FIRMADOR_CA` (opcional): el certificado de Supabase en PEM.
  - Con él, la conexión TLS verifica la cadena.
  - Sin él, va como en hn-agro y hn-agro-modelos: TLS sin verificar la cadena.

## La base: rol `firmador_r2`
- **La migración propuesta está en hn-agro:** rama `feat/firmador-r2-rol`, archivo `migrations/0141_firmador_r2_rol.sql`. **No está aplicada.**
- **Qué permite:** SELECT, INSERT y UPDATE sobre `public.r2_enlaces`, más USAGE del schema `public`. Nada más.
- **RLS:** 3 políticas sólo para ese rol. El INSERT y el UPDATE se limitan a los 4 prefijos.
- **Límites del rol:** `statement_timeout` de 30 s y `connection limit 3`.
- **La contraseña no va en el archivo.** Local la pone al aplicarla, con `\password firmador_r2`.
- **Copias en este repo:** `test/fixtures/0129_r2_enlaces.sql` y `test/fixtures/0141_firmador_r2_rol.sql` son copias literales para los tests. Si cambia la de hn-agro, se vuelve a copiar.

## Cómo lo engancha local desde Supabase (como el radar)
**Se dispara una vez por día desde Supabase, con `pg_cron` y `pg_net`.**
- **El token es el mismo `gh_dispatch_token` del Vault que propone el radar** (0139, rama `feat/radar-disparo-horario`). Es un token fine-grained sobre `hernan1015/hn-colectores` con permiso «Actions: Read and write».
- **Con ese token hay que usar `workflow_dispatch`:**
  - `repository_dispatch` pide además «Contents: write», y ese permiso el token no lo tiene ni le hace falta.
  - El `.yml` igual acepta `repository_dispatch` (tipo `firmar-r2-enlaces`), por si algún día se usa otro token.
- **El workflow tiene que estar en `main`** para que `workflow_dispatch` lo encuentre.

**Ejemplo de disparo, para que local lo adapte. NO está aplicado ni en ninguna migración.** Mejor si sigue el patrón completo de 0139, con bitácora:
```sql
select cron.schedule('firmador-r2', '20 9 * * *', $cron$
  select net.http_post(
    url     := 'https://api.github.com/repos/hernan1015/hn-colectores/actions/workflows/firmador-r2.yml/dispatches',
    body    := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('dias_rayos', '3')),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select btrim(decrypted_secret) from vault.decrypted_secrets where name = 'gh_dispatch_token'),
      'Accept', 'application/vnd.github+json', 'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json', 'User-Agent', 'hn-agro-firmador-r2/1.0 (Supabase pg_net)'),
    timeout_milliseconds := 15000)
$cron$);
-- apagarlo: select cron.unschedule('firmador-r2');
```
La hora del ejemplo, 09:20 UTC (06:20 ART), queda después de las tareas nocturnas de la PC. Con enlaces de 7 días, una corrida diaria deja 6 días de margen.

## Qué NO se muda con esto
**El firmador sólo firma lo que ya está en R2.** La generación y la subida de los archivos siguen donde están:
- la proyección de tormentas;
- los escenarios de los ríos;
- los mosaicos y el índice de OPERA.

Eso se muda después, uno por uno.

## Instalarlo
1. Copiar `firmador-r2/firmador-r2.workflow.yml.txt` a `.github/workflows/firmador-r2.yml`. El token de la rama no tiene permiso `workflow`.
2. Aplicar 0141 y ponerle la contraseña al rol.
3. Cargar `SUPABASE_FIRMADOR_URL`.
4. Primera corrida a mano: Actions → firmador-r2 → Run workflow.
5. Recién después, el disparo diario desde Supabase.

## Tests (sin red)
`npm ci --prefix firmador-r2 && npm test --prefix firmador-r2`.

PGlite es devDependency y se instala por usuario. En Actions no se instala, porque se usa `--omit=dev`.
- **`test/presign.test.mjs`:** el ejemplo oficial de AWS de URL firmada (S3, «Authenticating Requests: Using Query Parameters», con las llaves públicas `AKIAIOSFODNN7EXAMPLE`).
  - Comprueba el pedido canónico, su hash, la cadena a firmar, la firma `aeeed9bb…d404` y la URL entera.
  - Control negativo: secreto, clave, ruta, host, región, expira y fecha.
- **`test/base.test.mjs`:** PGlite (Postgres 16 en WASM) con 0129 y 0141, y el upsert corriendo como `firmador_r2`.
  - Prueba el contrato: renueva, no pisa uno más nuevo, `coalesce` de emitido, idempotente y sin borrar.
  - Prueba los permisos: 9 operaciones negadas, `anon` y `authenticated` sin acceso, privilegios exactos.
  - Control negativo: 5 upserts mutados, todos en rojo.
- **`test/firmador.test.mjs`:** de punta a punta, con un R2 falso que verifica las firmas como R2 (incluido el vencimiento) y con PGlite.
  - Las claves esperadas están escritas a mano, copiadas de las functions.
  - Prueba la paginación, lo que falta, la idempotencia y que el resumen salga sin URL.
  - Control negativo contado (6): secreto equivocado, firma del GET rota, reloj 8 días adelante, enlace bueno de la PC que no se pisa, base caída y base que pierde filas.
