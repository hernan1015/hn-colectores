#!/usr/bin/env bash
# HN AGRO · imerg-pendientes · prender el colector (LISTO-232, paso 5). Lo corre local, a mano, con su `gh`, después de
# `npm ci --prefix imerg-pendientes` (hace falta el paquete `yaml`, fijado en package-lock).
# Prende (IMERG_PENDIENTES_ON=si) SÓLO si pudo LEER ENTERO el imerg-backfill.yml de la rama main de hn-agro y ese
# archivo, PARSEADO como YAML, ya no tiene repository_dispatch entre las claves de `on` (paso 4). Cualquier otra cosa
# (gh que falla, sin red, 404, JSON de error, contenido incompleto o que no coincide con su sha, YAML que no parsea, un
# archivo que no es el workflow, sin node o sin `yaml`) → NO PRENDER, sin tocar la variable.
# 3.ª vuelta (n3-232-v2-1411): antes prendía si gh fallaba (grep -c de nada = 0).
# 4.ª vuelta (n3-232-v3-1511): la 3.ª limpiaba comentarios con sed y un `#` dentro de una cadena escondía un
# repository_dispatch en forma de flujo; y un archivo truncado prendía. Ahora el chequeo es lib/prender.mjs.
set -u -o pipefail

APP='hernan1015/hn-agro'
ESTE='hernan1015/hn-colectores'
RUTA='.github/workflows/imerg-backfill.yml'
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || { echo "NO PRENDER: no se encuentra la carpeta del script"; exit 1; }

no() { echo "NO PRENDER: $1"; exit 1; }

# La respuesta ENTERA (JSON con path, size, sha y content), no sólo .content: el chequeo verifica tamaño y sha.
RESP=$(gh api "repos/$APP/contents/$RUTA?ref=main") || no "no se pudo leer $RUTA de $APP@main (gh api falló)"
[ -n "$RESP" ] || no "gh api no devolvió nada"
R=$(node "$DIR/lib/prender.mjs" <<<"$RESP" 2>&1) || no "${R:-el chequeo (node lib/prender.mjs) falló; ¿npm ci --prefix imerg-pendientes?}"
[ "$R" = 'SIN_REPOSITORY_DISPATCH' ] || no "el chequeo no confirmó el workflow sin repository_dispatch ($R)"
gh variable set IMERG_PENDIENTES_ON -b si -R "$ESTE" || no "gh variable set falló"
echo "PRENDIDO"
