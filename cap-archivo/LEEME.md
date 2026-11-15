# cap-archivo · el archivo del índice CAP del SMN (225)

**Por qué existe:** el 13/11 no se pudo reconstruir qué avisos del SMN había a qué hora. El índice CAP sólo muestra lo
vigente, y los avisos a corto plazo (ACP) vencen en 3 h. Nadie los guardaba (caso del 14/11, `INFORME.md` §4 y §5, en
hn-cortex). Este colector guarda, cada 10 min, el índice con su hora y los XML de cada aviso nuevo.

**Está APAGADO.** El workflow viene como `.txt`, y el `schedule` corre sólo con la variable `CAP_ARCHIVO_ON=si`.
Lo prende local; los pasos están en **`PRENDER.md`**.

## Fuente y licencia

> **Fuente:** Servicio Meteorológico Nacional (SMN) de Argentina, avisos y alertas en formato CAP (Common Alerting
> Protocol 1.2), índice `https://ssl.smn.gob.ar/CAP/AR.php` y los XML que enlaza.
> **Licencia:** [Creative Commons Atribución 4.0 Internacional (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/deed.es).
> El propio índice lo dice: «Copyright 2025 SMN | Derechos de autor, Servicio Meteorologico Nacional (SMN). Licencia CC BY 4.0.»
> El archivo guarda el contenido **sin cambios**. Quien use algo de acá cita al SMN como fuente.

La misma cita va en las notas de cada release (`notasRelease` en `lib/flujo.mjs`) y en cada sobre (`fuente` y `licencia`).

## Qué hace una corrida (`archivar.mjs`)

1. **Lee el estado.** Es el `estado__<sello>.json.gz` de la release del día o, si todavía no hay, el de hasta 3 días
   antes. Si hay una **pausa** vigente por un corte del SMN, **no le pide nada** y sólo anota en `registro_procesos`.
2. **Pide el índice, UNA vez.** Se guarda con su hora (UTC y ART). Si cambió, va **entero**. Si es igual al anterior
   (mismo sha256), va sólo el hash y el nombre del asset donde está.
3. **Pide los XML de los avisos nuevos**, de a uno, con 1,5 s de pausa y como mucho 150 por corrida.
   - **Por URL:** una URL ya guardada no se vuelve a pedir.
   - **Por hash:** si un contenido ya está guardado con otra URL, queda sólo la referencia.
4. **Sube el sobre de la corrida** como `<AAAAMMDDTHHMMSS>Z.cap.json.gz` a la release `smn-cap-AAAA-MM-DD` (día
   argentino). Las fallas también se guardan: lo que el SMN contestó a esa hora también es un dato.
5. **Guarda el estado nuevo**: primero sube el nuevo y después borra el viejo (`lib/releases.mjs · reemplazar`).
6. **Anota en `registro_procesos`** (proceso `smn_cap_archivo`): los pedidos, el índice (HTTP, bytes, si cambió,
   ítems, enlaces por carpeta) y los XML (en el índice, ya guardados, fallidos antes, pendientes, pedidos, nuevos,
   repetidos por hash, no disponibles, redirigidos, cortados y sin pedir). También van los avisos y las fallas.
   - **Ya guardados** son sólo los que tienen su contenido en un asset. Los que quedaron finales sin contenido (un
     404, un redirect, una URL cortada dos veces) van aparte, en **fallidos antes**: un faltante no se cuenta como
     archivado. Siempre: en el índice = ya guardados + fallidos antes + pendientes.

## Dónde guarda y por qué

**En releases diarias de `hernan1015/hn-radar`, que es privado.** Es el mismo molde que el granizo (147) y los
crudos de la SIPAN. No se guarda en este repo ni en R2, por cuatro razones:
- **Este repo es público y no guarda datos** (lo dice el README).
- **Un commit cada 10 min** haría crecer la historia de git sin límite, y no se puede achicar sin reescribirla.
- **No hace falta ningún secreto nuevo para guardar:** el `RADAR_TOKEN` ya existe, y sólo tiene permiso sobre hn-radar.
- **R2 está apagado en el molde** (SIPAN: «opción futura»). Habría que darle 4 secretos nuevos.

**El tamaño:** todo va comprimido con gzip.
- La primera corrida, con el índice del 14/11 y 96 XML mínimos, pesó **8 KB**.
- Una corrida con el índice igual pesa **~0,6 KB**, y el estado, ~4 KB.
- Con los XML reales (~2 KB cada uno, sin comprimir), un día da unos **145 assets** y **pocos MB**. El tope de GitHub es de 1000 assets por release.

Si alguna vez se quiere un archivo público (la licencia lo permite, citando), alcanza con cambiar `CAP_REPO` y su token.

## La lista blanca (la regla de la 222)

- **Cómo se lee:** como XML, con una pila de etiquetas, después de sacar los comentarios y de tomar los CDATA como texto.
  Cuentan sólo los `<item>` hijos de `rss > channel`, y de cada uno sólo sus `<link>` hijos directos. Un ítem
  dentro de un comentario o de un CDATA no se pide, ni tampoco un `<link>` comentado o anidado en otro elemento.
- **Qué se sigue:** sólo los `<link>` de un `<item>` con la forma completa y anclada
  `http(s)://(ssl|forms).smn.gob.ar/feeds/CAP/<carpeta>/<archivo>.xml`, y sólo de las carpetas `xml_generados`,
  `avisocortoplazo` (los ACP) y `oladecalor`.
- **Una carpeta nueva del SMN:** no se pide, y es **falla** (`carpeta_nueva`), para que alguien la mire y la sume. Así
  se perdieron los ACP hasta el 14/11.
- **Un link con otra forma** (otro host, cortado o vacío): no se pide, y es **falla** (`enlace_raro`). Se cuenta
  **cada** link rechazado, aunque el mismo ítem tenga otro bueno, y cada ítem sin ningún `<link>`.
- **El índice se guarda entero igual:** lo que no se siguió queda en el archivo.

## Anti-spam (el SMN nos frenó el 14/11)

- **UN pedido al índice por corrida**, y **UN pedido por URL**: el pedidor rechaza una URL ya pedida.
- **De a uno**, con 1,5 s entre pedidos y un tope de 150 XML por corrida. Lo que queda va en la próxima (aviso `tope`).
- **User-Agent identificable:** `hn-colectores-cap-archivo/1.0 (HN AGRO; archivo de avisos CAP del SMN, un pedido cada 10 min)`.
- **Ante un 429, un 403, un 5xx o sin conexión, se CORTA:** no se hace ningún pedido más en esa corrida.
  - Queda una **pausa** de 60 min (429 y 403) o de 20 min (5xx y red). Si el `Retry-After` pide más, se respeta
    (como mucho, 6 h). Vale en sus dos formas: en segundos o como fecha HTTP (contada desde la hora del pedido).
  - Las corridas que caen dentro de la pausa **no le piden nada al SMN**.
- **Los redirects no se siguen** (`redirect: 'manual'`): el destino no pasaría por la lista blanca ni por el
  contador de pedidos. Un 3xx queda anotado con su `Location`, es final y es **falla** (`xml_redirige`; en el
  índice, `indice_http`).
- **Un estado que existe y no se puede leer frena todo** (`estado_ilegible`): cero pedidos, ni siquiera el índice,
  y no se retrocede al estado de un día anterior. Ese estado puede tener una pausa vigente. Arrancar de cero
  (`estado_nuevo`) queda sólo para cuando no hay ningún estado. Para destrabarlo, alguien tiene que mirar el asset
  roto y borrarlo a mano, sabiendo que la corrida siguiente arranca de cero.
  Cuenta como ilegible también un estado que aparece en el listado de la release pero cuya descarga falla (por
  ejemplo, un 404 porque se borró entre el listado y la bajada), y uno a medio subir (`starter`, o cualquier
  `state` que no sea `uploaded`): puede ser el estado más nuevo, cortado en la subida.
- **Un `<!DOCTYPE` o `<!ENTITY` en el índice es falla** (`indice_dtd`, la regla de la 222): no se lee el índice y no se
  pide ningún XML. El índice igual queda archivado en el sobre.
- **Sin reintentos en bucle:** una URL cortada se reintenta **una sola vez**, en otra corrida y pasada la pausa. Después
  queda como final. Un 404 es final de entrada.

## Avisos y fallas (como en la SIPAN)

| Tipo | Clase | Qué es |
|---|---|---|
| `en_pausa` | aviso | la corrida cayó dentro de la pausa: no se pidió nada |
| `tope` | aviso | quedaron XML para la próxima |
| `xml_no_disponible` | aviso | un XML del índice dio 404 (u otro 4xx); no se vuelve a pedir |
| `xml_no_cap` | aviso | un XML llegó, pero no parece CAP (se guarda igual) |
| `estado_nuevo` | aviso | no había estado: se arranca de cero (la primera corrida) |
| `smn_corto` | **falla** | 429, 403, 5xx o sin conexión: se cortó y quedó la pausa |
| `estado_ilegible` | **falla** | hay un estado que no se pudo leer: no se le pidió nada al SMN |
| `xml_redirige` | **falla** | un XML contestó un 3xx: no se siguió y no se vuelve a pedir |
| `indice_http` · `indice_no_rss` · `indice_cortado` | **falla** | el índice no llegó, no es RSS o vino cortado |
| `indice_dtd` | **falla** | el índice trae un `<!DOCTYPE` o un `<!ENTITY`: no se pidió ningún XML |
| `carpeta_nueva` · `enlace_raro` | **falla** | la lista blanca: algo que no se siguió |
| `sin_registro` · `registro_no_anotado` | **falla** | `registro_procesos` no quedó anotado (los datos sí se guardaron) |

- **Los avisos** van a `registro_procesos` y a `::warning::`, y la corrida no se pone en rojo.
- **Una falla** sale con código 2. **Un error de GitHub** (no se pudo subir), con código 1.
- **Un tipo nuevo** cuenta como falla hasta que se lo sume a `AVISOS_DE_ESTADO`.

## Qué hay en cada release `smn-cap-AAAA-MM-DD`

- **`<AAAAMMDDTHHMMSS>Z.cap.json.gz`**, uno por corrida. Es el sobre `hn-smn-cap/1`, con estos campos:
  - `pedido_utc` y `pedido_art`;
  - `fuente`, `licencia` y `user_agent`;
  - `indice`: `url`, `http`, `bytes`, `sha256` y `cuerpo` (el texto tal cual), o `igual_a` si no cambió;
  - `xml[]`: cada aviso pedido, con su hora, `http`, `sha256` y `cuerpo`, o `igual_a` si el contenido ya estaba guardado;
  - **los cuerpos de error también** (un 429, un 404, un 5xx), si llegaron enteros: lo que el SMN contestó a esa hora;
  - `resumen`: las cantidades de los pedidos (las mismas de `registro_procesos`), sin lo de la subida, que todavía
    no se sabe cuando se arma el sobre.
  - Si un cuerpo no es UTF-8 válido, o si su texto no devuelve exactamente los mismos bytes, va en `cuerpo_b64`. Un
    BOM inicial queda en el texto (U+FEFF): el `sha256` siempre cierra con los bytes reconstruidos.
- **Si el nombre del sobre ya existía** (otro proceso, el mismo segundo), se lo baja y se compara byte por byte. Si no
  es igual, la corrida sale con error 1 y el estado **no** se guarda: no queda ninguna referencia a algo que no subió.
- **`estado__<sello>.json.gz`**: las URL ya pedidas (hash, asset, intentos), el hash del último índice y la pausa.

Para reconstruir una hora: bajar el sobre de esa hora y, si dice `igual_a`, el asset que nombra.

## Tests

```bash
npm ci --prefix cap-archivo && npm test --prefix cap-archivo      # 39 tests, sin red ni base
node cap-archivo/test/control-negativo.mjs                        # 49 mutantes: tienen que morir todos
```

- **El fixture** es el índice **real** del 14/11 a las 14:26 (`test/fixtures/cap_indice_1426.xml.gz`, el mismo de la 222, CC BY 4.0).
- **El SMN y GitHub son falsos:** ningún test sale a la red. El único HTTP de verdad es el del test de redirects, contra un servidor de fixture en 127.0.0.1.
