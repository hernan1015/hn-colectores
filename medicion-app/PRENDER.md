# 260 · medicion-app · cómo se prende (lo hace local)

El job compara cada mañana el clima que muestra la app (Open-Meteo `best_match`, el mismo pedido que hace la app para el punto del lote) con las estaciones de la víspera:
- **primero la mínima nocturna** (18 a 09), después la máxima y la HR media;
- por zona (la 257) y por región.

El criterio está sellado antes de medir: hn-cortex `docs/mejora-continua/260-medicion/SELLO.json` (regla `m1`).

**No muestra nada en pantalla.**

## Antes
- **La 0152 del parseo** (PR #13), aplicada y el parseo corriendo: sin `estaciones_obs` con lecturas no hay nada que medir.
- **La 0147b**, que prende la RLS de `registro_procesos`. Sin ella, la 0154 se corta con un error.
- **La 0153 de la 257** no hace falta: sin zona, la estación cuenta como `sin_dato`.

## Pasos
1. **El rol y la tabla.** La clave entra como verificador SCRAM, nunca en texto:
   ```
   CLAVE=$(openssl rand -base64 32)
   VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v clave="$VERIF" -f medicion-app/migracion/0154_medicion_app_PROPUESTA.sql
   ```
   Confirmá antes el número 0154. Después hacé la verificación que está al pie del archivo.
2. **Los secretos del repo** (no creé ninguno):
   - `MEDICION_PG_URL` = `postgresql://medicion_app.<ref>:<clave>@<host-del-pooler>:6543/postgres`, con la clave codificada;
   - `MEDICION_PG_CA` = la CA de Supabase en PEM: Dashboard → Database → SSL Configuration → Download certificate, `prod-ca-2021.crt`. Es la misma que `ZONA_PG_CA` de la 257.
3. **Instalar el workflow:** `git mv medicion-app/medicion-app.workflow.yml.txt .github/workflows/medicion-app.yml`.
4. **Probar:** Run workflow, `modo=seco`.
   - Tiene que imprimir una sola línea: `medicion-app seco: fecha=… estaciones=… pedidos=…`.
   - Si el pooler presenta un certificado que no sale de esa CA, corta con «certificado no confiable» y no escribe nada.
5. **Prender la llave:** la variable del repo `MEDICION_APP_ON=si`. Desde ahí corre solo a las 13:00 UTC (10:00 ARG), en real.

## Cuánto le pide a Open-Meteo
- Lotes de 50 coordenadas, de a un pedido, con 30 s de pausa.
- Sólo las estaciones con datos suficientes, y cada coordenada una vez.
- Con ~1.500 estaciones: 30 pedidos y ~1.500 llamadas por día (peso 1 por coordenada). Es el 15 % del límite gratuito diario y unas 100 por minuto.
- El tope es 2.000 coordenadas por corrida.
- Un 429 o un 5xx: un reintento a los 60 s y, si vuelve a fallar, corta.

## Apagarlo
- `MEDICION_APP_ON` en cualquier otro valor.
- **Rollback de la base:** está comentado al pie de la 0154.
