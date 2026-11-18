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
- **Retención:** `RETENCION_H`, 6 h por defecto (de 1 a 24). Lo vencido sale del índice y sus teselas se borran sin listar, porque las claves salen de la geometría. El DELETE de R2 es gratis. Si el reloj está más de 1 día adelante de SLIDER, no se borra nada.
- **Cortesía:** UA `hn-colector/1.0`, 1 s entre pedidos y un tope por corrida (`TOPE`, 120 por defecto, de 20 a 400). Un 429 o un 403 cortan la corrida, y también 3 fallas seguidas.
- **El registro de Actions es público:** sólo se imprimen cantidades.

## Probar sin R2 (la llave seca)

```
PRECOCIDO_ON=si PUBLICO_CARPETA=/una/carpeta node gremlin/precocido.mjs            # baja de SLIDER y escribe en la carpeta
PRECOCIDO_ON=si MODO=seco PUBLICO_CARPETA=/una/carpeta node gremlin/precocido.mjs  # sólo cuenta
```

## Tests

```
cd gremlin
node --test test/precocido.test.mjs     # 16 tests, sin red
node test/control-precocido.mjs         # control negativo contado (mutantes)
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
