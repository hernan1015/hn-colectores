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
   ítems, enlaces por carpeta) y los XML (en el índice, ya guardados, pendientes, pedidos, nuevos, repetidos por
   hash, no disponibles, cortados y sin pedir). También van los avisos y las fallas.

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

- **Qué se sigue:** sólo los `<link>` de un `<item>` con la forma completa y anclada
  `http(s)://(ssl|forms).smn.gob.ar/feeds/CAP/<carpeta>/<archivo>.xml`, y sólo de las carpetas `xml_generados`,
  `avisocortoplazo` (los ACP) y `oladecalor`.
- **Una carpeta nueva del SMN:** no se pide, y es **falla** (`carpeta_nueva`), para que alguien la mire y la sume. Así
  se perdieron los ACP hasta el 14/11.
- **Un link con otra forma** (otro host, cortado o vacío): no se pide, y es **falla** (`enlace_raro`).
- **El índice se guarda entero igual:** lo que no se siguió queda en el archivo.

## Anti-spam (el SMN nos frenó el 14/11)

- **UN pedido al índice por corrida**, y **UN pedido por URL**: el pedidor rechaza una URL ya pedida.
- **De a uno**, con 1,5 s entre pedidos y un tope de 150 XML por corrida. Lo que queda va en la próxima (aviso `tope`).
- **User-Agent identificable:** `hn-colectores-cap-archivo/1.0 (HN AGRO; archivo de avisos CAP del SMN, un pedido cada 10 min)`.
- **Ante un 429, un 403, un 5xx o sin conexión, se CORTA:** no se hace ningún pedido más en esa corrida.
  - Queda una **pausa** de 60 min (429 y 403) o de 20 min (5xx y red). Si el `Retry-After` pide más, se respeta (como mucho, 6 h).
  - Las corridas que caen dentro de la pausa **no le piden nada al SMN**.
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
| `indice_http` · `indice_no_rss` · `indice_cortado` | **falla** | el índice no llegó, no es RSS o vino cortado |
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
  - `resumen`: las mismas cantidades que van a `registro_procesos`.
  - Si un cuerpo no es UTF-8 válido, va en `cuerpo_b64`.
- **`estado__<sello>.json.gz`**: las URL ya pedidas (hash, asset, intentos), el hash del último índice y la pausa.

Para reconstruir una hora: bajar el sobre de esa hora y, si dice `igual_a`, el asset que nombra.

## Tests

```bash
npm ci --prefix cap-archivo && npm test --prefix cap-archivo      # 28 tests, sin red ni base
node cap-archivo/test/control-negativo.mjs                        # 35 mutantes: tienen que morir todos
```

- **El fixture** es el índice **real** del 14/11 a las 14:26 (`test/fixtures/cap_indice_1426.xml.gz`, el mismo de la 222, CC BY 4.0).
- **El SMN y GitHub son falsos:** ningún test sale a la red.
