#!/usr/bin/env bash
# HN AGRO · colector del radar SINARAME (uso interno) · 14/10/2026
# Cada corrida mira las últimas 4 h en pasos de 10 min. El nombre de cada imagen es la hora ARGENTINA
# redondeada a 10 min (…/cache/RMA14/20261014010000.png) y el sitio guarda 3-6 h: así una corrida
# por hora recupera lo que una corrida atrasada o salteada se perdió.
# Guarda en un release por día (dia-AAAA-MM-DD): un .tar por corrida con las imágenes nuevas y un
# manifiesto.txt con TODO lo ya guardado ese día (para no bajar dos veces lo mismo).
set -uo pipefail
RADARES="${RADARES:-RMA1 RMA2 RMA8 RMA10 RMA14 RMA16 RMA17 RMA19}"
UA='HN-AGRO (contacto: info@hninge.com)'
BASE='https://radares.hidricosargentina.gob.ar/cache'
TZAR='America/Argentina/Buenos_Aires'
VENTANA_MIN="${VENTANA_MIN:-240}"
trabajo=$(mktemp -d); cd "$trabajo"
hoy=$(TZ=$TZAR date +%F); ayer=$(TZ=$TZAR date -d '-1 day' +%F)

# 1. lo que ya está guardado (hoy y ayer: la ventana puede cruzar la medianoche)
: > ya.txt
for d in "$ayer" "$hoy"; do
  mkdir -p "man/$d"
  if gh release download "dia-$d" -p manifiesto.txt -D "man/$d" --clobber >/dev/null 2>&1; then cat "man/$d/manifiesto.txt" >> ya.txt; else : > "man/$d/manifiesto.txt"; fi
done

# 2. bajar lo que falta
ahora=$(date +%s); nuevas=0; faltan=0; viejas404=0
declare -A porRadar
for ((k=1; k*10<=VENTANA_MIN; k++)); do
  ts=$(( (ahora - k*600) / 600 * 600 ))
  slot=$(TZ=$TZAR date -d "@$ts" +%Y%m%d%H%M00); fecha=$(TZ=$TZAR date -d "@$ts" +%F)
  for R in $RADARES; do
    clave="$R/$slot"
    grep -qxF "$clave" ya.txt && continue
    mkdir -p "nuevo/$fecha"
    f="nuevo/$fecha/${R}_${slot}.png"
    code=$(curl -s -A "$UA" --max-time 25 -o "$f" -w '%{http_code}' "$BASE/$R/$slot.png" || echo ERR)
    if [ "$code" = "200" ] && [ -s "$f" ]; then
      echo "$clave" >> "nuevo/$fecha/agregar.txt"; nuevas=$((nuevas+1)); porRadar[$R]=$(( ${porRadar[$R]:-0} + 1 ))
    else
      rm -f "$f"; faltan=$((faltan+1))
      [ $k -ge 6 ] && viejas404=$((viejas404+1))   # más de 1 h atrás y no está: perdida o radar caído
    fi
    sleep 0.3
  done
done

fallo_subida=0
# 3. subir un .tar por día tocado + el manifiesto actualizado
for dir in nuevo/*/; do
  [ -f "$dir/agregar.txt" ] || continue
  d=$(basename "$dir"); tag="dia-$d"
  gh release view "$tag" >/dev/null 2>&1 || gh release create "$tag" --title "Radar SINARAME · $d" --notes "Imágenes PNG (dBZ) de los radares $RADARES, cada 10 min, hora argentina. Uso interno HN AGRO." >/dev/null
  sort -u "man/$d/manifiesto.txt" "$dir/agregar.txt" > "man/$d/manifiesto.txt.n" && mv "man/$d/manifiesto.txt.n" "man/$d/manifiesto.txt"
  lote="lote_$(date -u +%Y%m%dT%H%M)Z_${GITHUB_RUN_ID:-local}.tar"
  tar -cf "$lote" -C "$dir" $(cd "$dir" && ls *.png)
  if gh release upload "$tag" "$lote" >/dev/null && gh release upload "$tag" "man/$d/manifiesto.txt" --clobber >/dev/null; then
    echo "subido $tag: $lote ($(wc -l < "$dir/agregar.txt") imágenes; el día lleva $(wc -l < "man/$d/manifiesto.txt"))"
  else
    echo "NO SE PUDO SUBIR $tag ($lote): revisar el permiso RADAR_TOKEN (Contents: Read and write sobre hn-radar)"; fallo_subida=1
  fi
done

# 4. resumen
{
  echo "### Radar SINARAME · $(TZ=$TZAR date '+%d/%m %H:%M') ART"
  echo "- imágenes nuevas: **$nuevas** · todavía no publicadas o ausentes: $faltan · ausentes con más de 1 h: **$viejas404**"
  for R in $RADARES; do echo "- $R: ${porRadar[$R]:-0} nuevas"; done
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
[ "$fallo_subida" = 0 ] || exit 1   # que la corrida quede en ROJO si no se guardó nada
