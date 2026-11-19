# precocido · las teselas de SATCHI ya reproyectadas, en R2 (r77)

**Para qué:** que la película satelital de SATCHI (GeoColor, Visible y GREMLIN β) arranque en 1-2 s. Hoy cada tesela sale del relevo `satelite-slider` de hn-agro, que reproyecta desde SLIDER de a una nativa por vez. El primero que entra espera uno o dos minutos.

**Qué hace:** cada 10 min, por producto, pide `latest_times.json` y, para los tiempos nuevos, las nativas de SLIDER que hacen falta. Con eso reproyecta **todas las teselas de Leaflet de z3 a z5 del recorte del relevo** (−100° a −20°, 13° N a −60°): 106 por tiempo y producto. Usa la misma cuenta que el relevo: `lib/satelite-slider.copia.mjs` es una copia textual de hn-agro `netlify/functions/lib/satelite-slider.mjs`, y un test controla su sha256.

**Cita:** «GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER». En GREMLIN, «GREMLIN (CIRA) · …». Va en cada índice.

## Qué queda en el depósito público (`PRECOCIDO_DEPOSITO`, `satchi-slider` por defecto)

```
slider/{producto}/{tiempo}/{z}/{x}/{y}.png    una tesela de 256 × 256 (RGBA), Cache-Control: public, max-age=86400, immutable
slider/{producto}/indice.json                 { v, producto, z_min, z_max, recorte, ruta, cita, tiempos: { t: { estado, n, faltan, intentos } }, borrar }
```

## Las reglas

- **Un fallo parcial nunca es una imagen buena** (la regla de la _v1829). Si a un píxel le faltó su nativa, esa tesela **no se escribe**. El tiempo queda `incompleto`, con la cantidad que falta, y se reintenta hasta 4 corridas. La página y el relevo, al no encontrarla, van a CIRA como hoy.
- **El orden:** primero las teselas y después el índice. Al borrar, al revés: primero el índice y después las teselas.
- **Del más nuevo al más viejo**, intercalando productos: la película arranca por el último cuadro.
- **El visible de noche:** la tesela entera sin sol se escribe transparente, sin pedir nativas.
- **Retención:** `RETENCION_H`, 6 h por defecto (de 1 a 24), medida contra SLIDER, es decir, contra el tiempo más nuevo de `latest_times`, no contra el reloj. Si el reloj y SLIDER difieren en más de 1 h, no se borra nada.
- **El borrado es diferido** (revisión de Codex n3-r77-colector):
  - Un tiempo vencido sale del índice y pasa a `borrar` como `{ t, salio }`.
  - Sus teselas se borran recién en una corrida posterior, a más de 5 min. Así cubre el max-age del índice (30 s), la memoria del relevo (60 s) y un margen.
  - `tiempos` y `borrar` tienen que ser disjuntos, y `borrar` sólo acepta tiempos con forma válida y vencidos según SLIDER.
  - Si el índice no valida, no se borra nada.
  - Las claves salen de la geometría, sin listar. El DELETE de R2 es gratis.
- **La hora en el PNG:** cada tesela lleva un chunk `tEXt` `hn-slider` = `producto/tiempo/z/x/y`. El relevo sirve una tesela del depósito sólo si la etiqueta es exactamente la pedida y el tiempo está en `latest_times`.
- **Cortesía:** UA `hn-colector/1.0`, 1 s entre pedidos y un tope por corrida (`TOPE`, 120 por defecto, de 20 a 400). Un 429 o un 403 cortan la corrida, y también 3 fallas seguidas.
- **Los 5xx y los errores de red de R2 se reintentan** (la primera corrida real cortó con un 500, 18/11):
  - Cada PUT y cada DELETE: hasta 4 intentos, con esperas de 0,5 s, 1,5 s y 4 s (± 25 % de jitter), sin pasarse del presupuesto de la corrida (7 min; el workflow corta a los 9). Con el presupuesto gastado no se empieza otro tiempo.
  - Un 4xx no se reintenta: un 403 o un 400 es configuración y corta la corrida.
  - Si una tesela no quedó después de los reintentos, su tiempo **no se publica** en el índice ni gasta un intento: la próxima corrida lo rehace. La corrida sigue con el tiempo siguiente y termina en rojo (`error:almacen escritura-con-fallas`).
  - Con 20 escrituras fallidas en la corrida, se corta (`error:almacen tope-de-fallas`).
  - El índice se reintenta igual. Si al final no se pudo escribir, en esa corrida no se borra nada.
  - En el registro: `reintento:almacen http 500 (2/4)` y, al final, el total de reintentos y de escrituras fallidas.
- **El registro de Actions es público:** sólo se imprimen cantidades. Un error sale como una categoría fija (`error:almacen`, `error:red` o `error:interno`) y, si lo hay, el código HTTP numérico. Nunca sale el mensaje.

## Probar sin R2 (la llave seca)

```
PRECOCIDO_ON=si PUBLICO_CARPETA=/una/carpeta node gremlin/precocido.mjs            # baja de SLIDER y escribe en la carpeta
PRECOCIDO_ON=si MODO=seco PUBLICO_CARPETA=/una/carpeta node gremlin/precocido.mjs  # sólo cuenta
```

## Tests

```
cd gremlin
node --test test/precocido.test.mjs     # 31 tests, sin red
node test/control-precocido.mjs         # control negativo contado (mutantes), en una carpeta temporal fuera del repo
```

## Para activarlo (lo decide el maker)

1. **El depósito:** crear `satchi-slider` en R2, con lectura pública por dominio propio (con la caché de Cloudflare; `r2.dev` tiene límite de pedidos y no es para producción). Darle permiso de escritura al token de `R2_OPERA_*`.
2. **CORS** en el depósito: `GET` y `HEAD` desde los orígenes de SATCHI. Sin CORS la página igual anda, porque cae al relevo, pero pierde la ventaja.
3. **Los secretos:** **no hay secretos nuevos.** Se usan `R2_OPERA_CUENTA`, `R2_OPERA_ACCESS_KEY_ID` y `R2_OPERA_SECRET_ACCESS_KEY`, que ya están.
4. **El workflow:** copiar `gremlin/precocido.workflow.yml.txt` a `.github/workflows/precocido.yml`. Las variables del repo son `PRECOCIDO_ON=si` y, si se quiere, `PRECOCIDO_RETENCION_H` y `PRECOCIDO_DEPOSITO`. Probar primero a mano en `seco` y después en `real`.
5. **pg_cron**, como la 0159 (con el despachador de la 0148), en una migración nueva:
   ```sql
   insert into public.colector_llaves (etiqueta, activa, nota) values ('precocido', true, 'precocido.yml · modo=real') on conflict (etiqueta) do nothing;
   select cron.schedule('precocido-disparo', '6,16,26,36,46,56 * * * *',
     $cron$select public.gh_colector_disparo('precocido.yml', '{"modo":"real"}'::jsonb, 'precocido')$cron$);
   ```
6. **En hn-agro (Netlify):** `SATCHI_SLIDER_PRECOCIDO_URL` = la URL pública del depósito, sin la barra final. Sin esa variable, el relevo y la página quedan exactamente como antes.

## r79 · los cuadros enteros y las metateselas WebP (la película en < 10 s)

**Para qué:** con las teselas sueltas, una película de 18 cuadros son ~1260 pedidos a r2.dev (250 ms cada uno, de a 6): ~1 min. Ahora cada cuadro es **una imagen**.

**Qué suma por tiempo y producto** (con `PRECOCIDO_CUADROS` distinto de `no`; prendido por defecto):

```
slider/{producto}/{tiempo}/c/{z}.webp             el cuadro ENTERO del recorte, z4 (1280 × 1280) y z5 (2048 × 2304)
slider/{producto}/{tiempo}/m/{z}/{mx}/{my}.webp   metateselas de 1024 px (4 × 4 teselas) sobre la Argentina
```

- **Las metateselas** cubren la caja de la Argentina (`CAJA_META`: −74° a −53°, −21,5° a −55,2°) en GeoColor z6-z7, el visible z6-z8 y GREMLIN z6. **Sólo el zoom más alto se reproyecta** (la misma cuenta del relevo); los de abajo salen de reducirlo a la mitad (2 × 2, con el alfa). Así las nativas por tiempo son: GeoColor ~37, visible ~69, GREMLIN ~23 (de día; ~130 en total, contra ~42 de la r77).
- **La cobertura** va en el índice en TESELAS por zoom (`meta.cobertura`): una tesela fuera de ella queda transparente en la metatesela y la página la pide suelta, como hoy.
- **Las mismas reglas:** un cuadro o una metatesela se escribe sólo si todas sus teselas salieron enteras; primero las imágenes, después el índice (`c`: los zooms de cuadro escritos; `m`: `{ n, faltan, vacias, noche }`); el borrado diferido las incluye.
- **La etiqueta:** cada WebP lleva un chunk XMP `<hn-slider>producto/tiempo/c/z</hn-slider>` (o `…/m/z/mx/my`). La página la exige exacta.
- **El visible de noche:** una metatesela entera sin sol no se escribe ni pide nativas (`m.vacias`; con la caja entera de noche, `m.noche`).
- **La calidad:** GeoColor y el visible, WebP con pérdida (q 82); GREMLIN, **sin pérdida** (es una paleta de dBZ).
- **La cortesía con CIRA:** las nativas van de a 3 en vuelo, con una por segundo como máximo (contada desde el comienzo de cada pedido). El tope por corrida pasa a 300 (`PRECOCIDO_TOPE`).
- **El codificador:** `gremlin/webp.mjs` con `sharp` (versión fija en `gremlin/package-lock.json`; el workflow hace `npm ci --prefix gremlin`). La lib no tiene dependencias.

**Lo que pesa (medido el 19/11 con nativas reales de un tiempo de día):**

| | PNG z3-z5 (r77) | cuadros c4 + c5 | metateselas |
|---|---|---|---|
| GeoColor | 8,33 MB | 0,24 + 0,86 MB | z6 0,32 + z7 1,33 MB (19) |
| visible | 5,14 MB | 0,28 + 1,00 MB | z6 0,24 + z7 0,95 + z8 3,74 MB (61) |
| GREMLIN | 0,45 MB | 0,05 + 0,12 MB | z6 0,06 MB (6) |

**Probar sin R2:** como siempre, con `PUBLICO_CARPETA`. **Rollback:** `PRECOCIDO_CUADROS=no` (el colector queda exactamente como en la r77).

**Tests:** `node --test test/precocido-cuadros.test.mjs` (13) y el control `node test/control-cuadros.mjs` (mutantes en una carpeta temporal fuera del repo).

## r79 · decisión 7 del maker: con los cuadros, sin PNG sueltas

Con `PRECOCIDO_CUADROS` prendido **ya no se escriben las teselas PNG z3-z5** de la r77: z3-z5 salen del cuadro entero. El índice lo dice (`png: false`) y el relevo de hn-agro (`912f4003` en adelante: `938beb3c`) no las ofrece a la página ni las busca en el depósito; el respaldo de una tesela suelta va a CIRA, como antes de la r77. **Hay que publicar hn-agro antes de prender el colector así.** Escrituras: ~0,3 M por mes (antes, con las PNG, ~1,65 M).
