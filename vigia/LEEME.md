# Vigía de SATCHI (piloto: crecidas y focos de calor)

Corre solo en GitHub Actions de este repo público, cada 15 minutos. **No usa ninguna PC y no deja tareas de fondo en Netlify.** Lee SATCHI público (`satchi-publico`, con la caché de la red de Netlify), se fija qué hay de nuevo respecto de lo que ya avisó y, si hay algo, manda **un** mail por SMTP.

## El estado (qué ya se avisó)

**Por defecto, el estado vive en el repo.** Es el archivo `estado.json` de la rama huérfana **`vigia-estado`**. Lo decidió local el 10/11, con el OK del maker.
- **Qué guarda:** sólo claves públicas: la escala o el foco, si está activo y las fechas. De los focos guarda también la posición, que hace falta para no repetirlos.
- **Qué no guarda:** destinatarios ni datos de nadie.
- **Permisos:** el job escribe con el `GITHUB_TOKEN` de Actions (`contents: write` sólo en ese job), sin PAT.
- **El orden, para no mandar dos veces el mismo aviso:**
  1. Se aplica lo de la corrida **sobre el estado más nuevo del remoto**. Si otra corrida avisó lo mismo mientras tanto, ese aviso se cae de la lista.
  2. Se hace commit y push. Si el push se rechaza, hay **un** reintento con `git pull --rebase`.
  3. **Si el estado no se pudo guardar, no se manda el mail**, y la próxima corrida lo vuelve a intentar.
  4. Si el mail falla **después** de guardar, ese aviso se pierde. Es mejor perder uno que mandarlo dos veces.
- **Opcional:** Supabase, con la variable `SATCHI_VIGIA_ESTADO` = `supabase`, la migración de `vigia/migracion/` y los dos secretos `SATCHI_VIGIA_SUPABASE_*`. Hoy no hace falta.

**Este repo es público.** En el código no hay claves, ni direcciones de mail, ni datos de nadie. El registro de Actions muestra sólo cantidades.

## Qué avisa
| aviso | regla (la de SATCHI, no una nueva) | cuándo vuelve a avisar |
|---|---|---|
| **Crecida** | una escala del Paraná (INA / Prefectura) en **evacuación**, con el nivel 1 de `satchi-ina`, que exige lectura de hoy o de ayer | cuando la escala baja a alerta o a normal y después vuelve a cruzar |
| **Crecida, pronóstico** | el pronóstico del INA a 4 días (fase experimental) cruza la cota de evacuación en las próximas **72 h**, mirando la altura central, en una ciudad que hoy no está en evacuación. La cota sale de la escala del mismo nombre | lo mismo |
| **Foco de calor grande** | un grupo de `grandes` de `?que=focos&zona=pais`, que es la regla del cartel «zonas con mucho calor»: 30 o más detecciones FIRMS, o 4 o más píxeles GOES. Se filtra por las provincias de `SATCHI_VIGIA_PROVINCIAS`; vacío = todo el país | si no hubo otro aviso a ≤ 15 km en las últimas 24 h |

Si SATCHI no contesta, o contesta a medias, **no se avisa con lo viejo**: esa fuente queda en `faltan`.

## Costo (medido el 10/11/2026)
- **Pedidos por corrida:** 2 (escalas y focos del país). Cada 3 h se suma el pronóstico.
- **Invocaciones reales de functions:** lo dicen las cabeceras `Cache-Status`. Lo que se sirve de la caché (`Netlify Durable; hit`) no invoca.
  - **escalas:** guarda 1 h → como mucho **1 invocación por hora**;
  - **focos del país:** guarda 10 min y la corrida es cada 15 → **1 por corrida, 4 por hora**;
  - **pronóstico:** sale a medias (`parcial`) y no se guarda (`bypass`) → **1 cada 3 h**.
  - **Total: unas 5 por hora, unas 130 por día, unas 4.000 por mes.** Además, esas mismas respuestas las usa cualquiera que abra SATCHI.
  - Medido: la primera corrida dio 3 pedidos y 1 invocación (el pronóstico); las dos siguientes, 2 pedidos y 0 invocaciones.
- **Actions:** son unos 20-40 s por corrida (checkout, Node, tests y la corrida, que tarda 0,3-1,2 s): **unos 30-60 minutos por día**. En un repo público no tiene costo.
- **FIRMS y el INA no se piden directo:** los lee SATCHI una vez por ciclo de su caché. Por eso **no hace falta la clave de FIRMS**.

## Para prenderlo (lo hace local)
1. **El estado:** no hace falta nada. La rama `vigia-estado` la crea la primera corrida real. La migración de Supabase queda como opción, sin aplicar.
2. **Los secretos del repo** (Settings → Secrets and variables → Actions → *Secrets*):

   | secreto | qué es |
   |---|---|
   | `SATCHI_VIGIA_SUPABASE_URL` y `SATCHI_VIGIA_SUPABASE_KEY` | **sólo** con `SATCHI_VIGIA_ESTADO=supabase`, que es opcional: la URL del proyecto y un JWT con `{"role":"satchi_vigia"}` (o la `service_role`) |
   | `SATCHI_SMTP_HOST`, `SATCHI_SMTP_PORT` | el servidor de la cuenta info@ (465 = TLS; 587 = STARTTLS obligatorio) |
   | `SATCHI_SMTP_USER`, `SATCHI_SMTP_PASS` | la cuenta info@ y su clave, o una clave de aplicación |
   | `SATCHI_SMTP_FROM` | opcional: el remitente (si no está, el usuario) |
   | `SATCHI_VIGIA_DESTINO` | los destinatarios, separados por coma. **Para la prueba: hernanr y nancio**, nada más |

   **El JWT del rol** hace falta sólo con Supabase. Se arma una vez, en una máquina de local y no en el repo. Con el JWT secret en una variable de entorno:
   ```
   node -e "const c=require('crypto'),b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const h=b({alg:'HS256',typ:'JWT'}),p=b({role:'satchi_vigia',iss:'supabase',iat:Math.floor(Date.now()/1e3),exp:Math.floor(Date.now()/1e3)+3e7});console.log(h+'.'+p+'.'+c.createHmac('sha256',process.env.JWT_SECRET).update(h+'.'+p).digest('base64url'))"
   ```
3. **Las variables** (*Variables*, no son secretas):
   - `SATCHI_VIGIA_PROVINCIAS`: para los focos, por ejemplo `Santa Fe,Chaco`. Vacío = todo el país.
   - `SATCHI_VIGIA_MODO`: `prueba` (default; el asunto dice «prueba») o `produccion`.
4. **El workflow.** Copiar `vigia/vigia.workflow.yml.txt` a `.github/workflows/vigia-satchi.yml`.
5. **La primera corrida, a mano:**
   - Actions → vigia-satchi → Run workflow → `seco`: muestra lo que avisaría.
   - Después, `real`: manda el mail y guarda el estado.
   - **Ojo: la primera corrida real avisa todo lo que hoy cruza el umbral.** El 10/11 eran 8 escalas en evacuación y 12 focos grandes en el país. Después, sólo lo nuevo.
6. **Prenderlo:** la variable `SATCHI_VIGIA_ON` = `si`. Para apagarlo, cualquier otro valor o borrarla.

## Probar
- `node --test vigia/test/vigia.test.mjs vigia/test/estado-git.test.mjs`: 28 tests. Usan datos reales del 10/11 y, para el estado, un repo git temporal (un remoto «bare» y dos clones). Sin red ni base.
- `node vigia/test/control-negativo.mjs`: rompe 14 cosas, una por vez, y cada una tiene que poner algún test en rojo.
- `node vigia/vigia-satchi.mjs --seco [--todo] [--estado archivo.json]`: contra SATCHI de verdad, sin mail ni base.
