#!/usr/bin/env bash
# HN AGRO · imerg-pendientes · prender el colector (LISTO-232, paso 5). Lo corre local, a mano, con su `gh`.
# Prende (IMERG_PENDIENTES_ON=si) SÓLO si pudo LEER el imerg-backfill.yml de la rama main de hn-agro y ese archivo ya
# no tiene repository_dispatch (paso 4). Cualquier otra cosa (gh que falla, sin red, 404, contenido vacío, base64 que
# no decodifica, un archivo que no es el workflow) → NO PRENDER, sin tocar la variable.
# 3.ª vuelta (P1 de Codex, n3-232-v2-1411): antes era `N=$(gh api … | base64 -d | grep -c …)` y `[ "$N" = 0 ]`. Si gh
# fallaba, la entrada quedaba vacía, grep -c imprimía 0 y prendía. Ahora cada paso exige su propio éxito, y lo único
# que prende es la AUSENCIA comprobada sobre un archivo leído entero.
set -u -o pipefail

APP='hernan1015/hn-agro'
ESTE='hernan1015/hn-colectores'
RUTA='.github/workflows/imerg-backfill.yml'

no() { echo "NO PRENDER: $1"; exit 1; }

B64=$(gh api "repos/$APP/contents/$RUTA?ref=main" --jq '.content') || no "no se pudo leer $RUTA de $APP@main (gh api falló)"
[ -n "$B64" ] || no "gh api no devolvió contenido"
YML=$(printf '%s' "$B64" | tr -d '\r\n' | base64 -d) || no "el contenido no decodifica (base64)"
[ -n "$YML" ] || no "el workflow decodificado está vacío"
# repository_dispatch en CUALQUIER forma (bloque «repository_dispatch:» o lista «on: [push, repository_dispatch]»),
# fuera de los comentarios. Sin tubería ni grep acá: un grep que falla (estado 2) o un SIGPIPE no pueden pasar por
# «no está».
LIMPIO=$(sed -e 's/#.*$//' <<<"$YML") || no "no se pudo leer el workflow sin comentarios"
[ -n "$LIMPIO" ] || no "el workflow sin comentarios está vacío"
case "$LIMPIO" in
  *repository_dispatch*) no "hn-agro sigue con repository_dispatch (hacer antes el paso 4)" ;;
esac
# Y tiene que ser el workflow de verdad: el paso 4 le deja el workflow_dispatch de emergencia.
case "$LIMPIO" in
  *workflow_dispatch*) ;;
  *) no "no parece el imerg-backfill.yml (no tiene workflow_dispatch)" ;;
esac
gh variable set IMERG_PENDIENTES_ON -b si -R "$ESTE" || no "gh variable set falló"
echo "PRENDIDO"
