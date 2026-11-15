# 225 · Archivo del índice CAP del SMN · cómo prenderlo

**Lo prende local.** Hasta entonces no se le pide nada al SMN desde acá: el workflow es un `.txt` y, aunque se
instale, el `schedule` no corre sin la variable.

## Qué hace falta

| Qué | Dónde | ¿Existe? |
|---|---|---|
| `RADAR_TOKEN` (Contents: Read and write sobre hn-radar) | secret del repo | **sí**: es el del radar y del granizo |
| el rol `colector_cap` (migración `0225`) | la base (Supabase) | no: paso 2 |
| `CAP_PG_URL` | secret del repo | no: paso 3 |
| `CAP_ARCHIVO_ON` = `si` | **variable** del repo | no: se crea al final |

## Orden

0. **Mergear el PR a `main`.** GitHub corre el `schedule` sólo desde la rama principal.
1. **Instalar el workflow**, desde una sesión con permiso `workflow`:
   ```bash
   cp cap-archivo/cap-archivo.workflow.yml.txt .github/workflows/cap-archivo.yml
   git add .github/workflows/cap-archivo.yml && git commit -m "ci(cap): instala el archivo del índice CAP (225) [skip netlify]" && git push
   ```
   Sin la variable, el `schedule` no hace nada.
2. **El rol de la base:**
   ```bash
   CLAVE=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
   VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f cap-archivo/migracion/0225_rol_colector_cap.sql
   ```
   Después, correr las verificaciones del final de la migración: el insert de otro `proceso` tiene que fallar.
3. **El secreto:**
   ```bash
   gh secret set CAP_PG_URL -R hernan1015/hn-colectores   # pegar: postgresql://colector_cap.<ref>:<CLAVE>@<host-del-pooler>:6543/postgres
   unset CLAVE VERIF
   ```
4. **Corrida en seco** (cuando el SMN ya no nos tenga frenados). Actions → **cap-archivo** → Run workflow → `modo: seco`.
   Hace **un** pedido al índice y nada más. El registro dice algo como:
   `cap-archivo (SECO): índice HTTP 200 · 68 KB · NUEVO · 96 ítems, 96 XML en la lista blanca · pedidos 1 · … · sin pedir 96 …`
   Si dice `HTTP 429` o `403`, **no seguir**: esperar y avisar.
5. **Corrida real a mano**, con `modo: real`. La primera pide el índice y todos los XML vigentes (~100, de a uno, con
   1,5 s de pausa: unos 3 min). Para ir más despacio, usar `tope: 30`: el resto va en las corridas siguientes.
6. **Verificar:**
   ```bash
   gh release view smn-cap-$(TZ=America/Argentina/Buenos_Aires date +%F) -R hernan1015/hn-radar
   gh release download smn-cap-AAAA-MM-DD -R hernan1015/hn-radar -p '*Z.cap.json.gz' -D /tmp/cap --clobber
   gunzip -c /tmp/cap/<nombre> | jq '{pedido_art, indice: {http: .indice.http, sha256: .indice.sha256, entero: (.indice.cuerpo != null)}, xml: (.xml|length)}'
   ```
   Y en la base:
   ```sql
   select creado_at, ok, resumen->'xml', resumen->'avisos' from registro_procesos where proceso = 'smn_cap_archivo' order by id desc limit 5;
   ```
7. **Prender:** crear la variable `CAP_ARCHIVO_ON` = `si`. A partir de ahí corre en los minutos 4, 14, 24…
   ```bash
   gh variable set CAP_ARCHIVO_ON -R hernan1015/hn-colectores --body si
   ```

**Apagar:** borrar la variable o ponerla en `no`. Lo que ya se guardó queda.

## Qué mirar los primeros días

- **Un `smn_corto`:** el SMN cortó. La pausa ya frena las corridas siguientes. Si se repite, subir `PAUSA_CORTE` o
  espaciar el cron.
- **Una `carpeta_nueva`:** el SMN publica en una carpeta que no está en la lista blanca. Mirar el índice guardado y,
  si corresponde, sumarla a `CARPETAS` (`lib/smn.mjs`), con su test.
- **GitHub atrasa los cron** (10-30 min) y a veces saltea alguno. Lo salteado se pierde: no hay forma de pedirle al
  SMN un índice viejo.
- **GitHub desactiva los `schedule`** de un repo público tras 60 días sin actividad.
