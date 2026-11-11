# Vigía de números (diario)

Corre en GitHub Actions de este repo público, **una vez por día hábil** (12:17 de Argentina).

Lee los números que **sirve la app**, del endpoint público `precios-granos` (es el que usa la pantalla de precios y no pide sesión), y los compara con fuentes públicas **sin clave**. Si algo se desvía más que su umbral, manda **un** mail.

**No usa ninguna PC, no guarda estado y no escribe en ningún lado.**

## Qué compara
| comparación | contra | umbral (en `lib/reglas.mjs`, con su motivo) |
|---|---|---|
| **El dólar** de la app (BCRA, Com. A 3500) | BNA, cotización **divisa**, vendedor (página pública de cotizaciones) | más de **2 %** de diferencia, o un dólar **más de 3 días corridos** más viejo que el último del BNA |
| **FOB de trigo pan y soja** de la app | MAGyP, precios FOB oficiales **del mismo día** (la fuente que declara la app) | fuera del rango de precios publicados ese día para el NCM, con **1 %** de margen |
| **Pizarra de Rosario** (control grueso) | BCR, Cámara Arbitral, pizarra del día | el cociente pizarra / (FOB × dólar) fuera de **0,70-1,05 en trigo** y de **0,55-1,00 en soja** |
| **Respaldos** | lo que dice la propia app | dólar de respaldo, precios de respaldo o marcados como estimados |

Los valores que se midieron al escribir los umbrales, el 10/11/2026:
- **El dólar:** app 1545 y BNA 1545,50, una diferencia de 0,03 %.
- **El FOB:** trigo 234 USD, dentro del rango de MAGyP (234-261), y soja 483 USD, dentro de 444-503.
- **El cociente de la pizarra:** trigo 0,87 y soja 0,72.

La banda de la pizarra es ancha a propósito. No mide la retención: caza errores gruesos, como pesos tomados como dólares, un ×10, un respaldo de meses o el precio de otro grano.

**Si una fuente no contesta, esa comparación no se hace y no se avisa con un dato viejo.** Pero **no se calla**: una comparación que no se pudo hacer es un aviso en sí mismo.
- **Qué cuenta como faltante:** la fuente caída o ilegible, MAGyP sin dato del día pedido (los posts de otro día no se usan) y la pizarra «S/C» o vieja.
- **Tolerancia: cero** (`faltantes_tolerados`). Con un solo faltante, el resumen dice `verificacion: INCOMPLETO`, el mail sale **el mismo día** con lo que no se pudo comparar y su motivo, y la corrida termina con **código 1**: Actions queda en rojo.
- **No hay estado**, así que no se espera a un segundo día.
- Si la que no contesta es **la app**, se avisa como desvío (`app_no_sirve`).

## Códigos de salida (lo que ve Actions)
| código | cuándo |
|---|---|
| **0** | la verificación está **completa**. Si hubo desvío, el mail salió |
| **1** | **INCOMPLETO** (alguna comparación no se pudo hacer, aunque sea una, o ninguna), **`ENVIO_FALLO`** (el mail no salió) o un error del vigía |

- **El orden en el registro:** primero sale la línea de cantidades y recién después se intenta el envío. Si el envío falla, se agrega `{"envio":"ENVIO_FALLO"}`, un código fijo: el error del SMTP puede traer el nombre del servidor o del certificado.
- **El módulo SMTP** (`vigia/lib/correo.mjs`) es el mismo del vigía de SATCHI.
  - Si el servidor cierra a mitad del diálogo, o no contesta dentro del tope, **rechaza**: nunca queda colgado ni termina en silencio.
  - Un cierre después de que el servidor aceptó el mensaje no cuenta como falla.

## Lo que queda afuera
- **A3, los futuros de MATba-Rofex:** su API pide usuario y clave, y el endpoint de futuros de la app (`precios-futuros-ver`) pide sesión. No entra hasta que haya una fuente pública sin clave.
- **La pizarra con «S/C» (sin cotización):** se saltea. El valor estimado «(E)» no se usa.

## Costo
- **Pedidos por corrida:** son 4, más 1 si la URL primaria de MAGyP no contesta y hay que ir a la alternativa: la app, el BNA, la BCR y MAGyP.
- **El pedido a la app:** su caché pública es de 30 min. Cuando no hay nada guardado, la app consulta a MAGyP y al BCRA.
- **Actions:** unos 20-30 s por día. En un repo público no tiene costo.

## Para prenderlo (lo hace local)
1. **Secretos:** no hace falta ninguno nuevo. Usa los del vigía de SATCHI: `SATCHI_SMTP_HOST`, `SATCHI_SMTP_PORT`, `SATCHI_SMTP_USER`, `SATCHI_SMTP_PASS`, `SATCHI_SMTP_FROM` y `SATCHI_VIGIA_DESTINO`.
2. **Variables:**
   - `VIGIA_NUMEROS_MODO`: `prueba` (por defecto; el asunto dice «[prueba]») o `produccion`.
   - **`VIGIA_NUMEROS_ON` = `si`** prende el horario. Mientras no esté, el workflow corre sólo a mano.
3. **El workflow:** copiar `vigia-numeros/vigia-numeros.workflow.yml.txt` a `.github/workflows/vigia-numeros.yml`. El token con el que se sube este código no tiene el permiso «workflow» de GitHub, igual que con el vigía de SATCHI.
4. **La primera corrida, a mano:** Actions → `vigia-numeros` → Run workflow con `seco`. Después, una con `real`.

## Probar
```
node --test vigia-numeros/test/vigia-numeros.test.mjs vigia-numeros/test/correo-y-cli.test.mjs   # 35 tests: respuestas reales del 10/11/2026, SMTP falso local y el CLI con su código de salida
node vigia-numeros/test/control-negativo.mjs              # rompe 21 cosas, una por vez: cada una tiene que hacer caer algún test
node vigia-numeros/vigia-numeros.mjs --seco               # contra la red de verdad, sin mandar nada: imprime SÓLO la línea de cantidades (lo mismo que en Actions)
node vigia-numeros/vigia-numeros.mjs --seco --detalle     # en una PC: además muestra el mail que mandaría (no usarlo en Actions)
```

## Este repo es público
En el código no hay claves, ni direcciones de mail, ni datos de nadie.
- **Los datos de prueba:** son las respuestas públicas del 10/11/2026, recortadas a la parte que se usa. Un test verifica que no traigan direcciones ni claves.
- **El registro de Actions:** muestra sólo cantidades, también en `--seco`. El detalle va en el mail, y en una PC con `--detalle`.
