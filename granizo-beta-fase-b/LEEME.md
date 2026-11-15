# 226 · Granizo β · Fase B (P2: «ALTURA + salto de rayos»)

**Es una medición.** No se conecta a la app ni a ningún aviso. El V1 enciende el 86 % del dominio en la Fase A, así que no va a ningún aviso aunque acierte todo. Con MEJORA, sólo se propone un ítem aparte.

**El sello manda:** `hn-cortex/docs/satchi-granizo-2026-11/226-beta/SELLO-B.json`, sha256 `20e8fee1…`, commit `592b0b54`. Se empujó antes de escribir esto y antes de bajar nada. Cita al `SELLO.json` de la Fase A.

## Qué hace un job

Cada corrida mide **un caso**, que es un episodio de la partición de la 19 (`datos/PARTICION.json`, sha256 `37bd26f1…`).

1. **Saca la lib del granizo** de hn-agro en `148a59b4`, con `HN_AGRO_LECTURA`, y verifica los 4 sha256. Si cambia uno, no corre. La lib no se copia a este repo, que es público.
2. **Arma el plan** con los listados de S3:
   - los scans ACHAF con inicio en las ventanas `[ini − 2 h, fin]` de la 19;
   - en los confirmados, también la ventana corrida −6 h (es el control C_hora);
   - el scan de 10 min antes del primero de cada tramo seguido, para el salto.
3. **Corre `armar()` dos veces por instante**, con los mismos bytes:
   - `como_19`: sin la fase. Sirve sólo para reproducir a la 19 (I1);
   - `con_fase`: con la fase, como la Fase A. Es el que decide.
4. **Guarda sólo lo que pide el sello:**
   - las destacadas;
   - las celdas con ≥ 2 patas, con `n25_t` y `n25_t10` (los flashes a ≤ 25 km en el intervalo y en el anterior);
   - los flashes a ≤ 55 km de los 6 lugares de la muestra, para auditar. El sello dice «7»: es un error de cuenta; los lugares distintos son 6.

**De a poco con S3:**
- como mucho 4 pedidos a la vez;
- reintentos con espera de 2, 4, 8, 16 y 32 s, o el `Retry-After`;
- 1 s de pausa entre instantes;
- un caso por vez en todo el repo.

**Lo crudo no toca el disco:** vive en memoria durante el instante. Si aparece algo en `/tmp/hn-goes`, se borra.

**Si un caso pasa las 5 h:**
- a los 10 instantes estima el total y, si da más de 5 h, corta y sugiere partes;
- si llega a 5 h 30, corta limpio y dice el `desde` para seguir;
- el job tiene un timeout de 350 min.

## Dónde quedan los resultados

En un **artefacto de Actions** por corrida: `granizo-beta-fase-b-<caso>-p<i>de<n>-<modo>-<run>`, que vive 90 días. Trae:
- `instantes.jsonl.gz`
- `flashes_cerca.jsonl.gz`
- `plan.json`
- `resumen.json`, con los sha de la lib y de la partición, los bytes, los pedidos, los reintentos, el disco libre y los H0 (cuáles salieron del colector y cuáles se bajaron).

**Por qué un artefacto y no una release de hn-radar:**
- no hace falta ningún token de escritura: el job queda en `contents: read`;
- es chico, menos de 5 MB por caso;
- se lee una vez.

hn-radar guarda lo que sirve a la app, y esto no se conecta a nada.

**Para conservarlo,** quien haga el veredicto lo copia a `hn-analisis/satchi-granizo-2026-11/226-beta/fase-b/`:
```bash
gh run download <run-id> -R hernan1015/hn-colectores -D hn-analisis/satchi-granizo-2026-11/226-beta/fase-b/
```

## El veredicto, sin red y escrito antes de los datos

```bash
node granizo-beta-fase-b/evaluar.mjs <carpeta con los artefactos> --19 hn-analisis/revision-total/flujo19-granizo/instantes.jsonl
```
- Hace el I1, el C_dias, el C_hora y los criterios (a)-(e) del sello.
- Da MEJORA, NO_MEJORA o NO_INFORMA.
- Escribe `resultado-fase-b.json`.

## Los 29 casos, y cuánto pesa cada uno

El estimado es con 6 scans por hora. Se bajan ~18-23 MB por instante (ACHAF, fase y 31 GLM), en memoria.

| tipo | casos | instantes | bajada estimada |
|---|---|---|---|
| confirmado | 2022-02-27, 2022-11-09, 2023-04-03, 2023-05-25, 2023-10-29, 2024-12-05, 2025-02-04, 2025-08-01, 2025-10-04, 2025-10-11, 2025-12-11, 2026-05-06 | 26-28 cada uno | ~0,5-0,6 GB |
| confirmado | 2025-03-27, 2025-05-17 | 40 | ~0,8 GB |
| confirmado | 2025-02-24 | 52 | ~1,1 GB |
| control | 2026-03-27, 2026-04-06, 2026-06-18, 2026-08-06, 2026-09-09, 2026-09-10, 2026-10-02 | 38-44 | ~0,8-0,9 GB |
| control | 2026-04-02, 2026-04-25, 2026-08-29, 2026-09-11 | 50-56 | ~1,0-1,2 GB |
| control | 2026-04-01, 2026-09-20, 2026-04-03 | 80-98 | ~1,7-2,1 GB |

**Total:** ~1.228 instantes, ~23 GB y ~50.000 pedidos.
- **Tiempo:** no está medido. Con 4 pedidos a la vez se espera de 10 a 30 s por instante, o sea de 5 min a 50 min por caso. La primera corrida real lo dice en `resumen.json`.
- **Disco:** no crece, porque nada crudo queda escrito. El paso «Disco después» lo muestra.

## Cómo se dispara, caso por caso (lo hace local)

El detalle está en el cortex, `docs/satchi-granizo-2026-11/226-beta/LISTO-fase-B.md`. En corto:
1. Mergear el PR e instalar el workflow (`cp granizo-beta-fase-b/granizo-beta-fase-b.workflow.yml.txt .github/workflows/granizo-beta-fase-b.yml`), desde una sesión con permiso `workflow`.
2. Crear la variable: `gh variable set GRANIZO_BETA_B_ON -b si -R hernan1015/hn-colectores`.
3. Hacer una corrida **seca** de un caso: `gh workflow run granizo-beta-fase-b -R hernan1015/hn-colectores -f caso=2025-05-17 -f modo=seco`.
4. Hacer una corrida **real** de un caso chico: `-f caso=2025-05-17 -f modo=real`. Mirar `resumen.json`: los tiempos, los reintentos, el disco y `validos`.
5. Seguir con los demás, de a uno. El `concurrency` igual los pone en fila.

## Tests

`npm test` corre sin red, con un S3 falso y una lib falsa con la misma interfaz. `node test/control-negativo.mjs` rompe 26 cosas, una por vez, y cada una tiene que hacer fallar un test (hoy: 26 de 26).
