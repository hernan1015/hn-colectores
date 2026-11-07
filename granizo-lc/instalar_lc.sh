#!/usr/bin/env bash
# Instala ProbSevere LightningCast (CIMSS / Univ. de Wisconsin, GPL-3.0) EN TIEMPO DE CORRIDA,
# desde su GitLab oficial, en un entorno aparte. Nada de su código ni de sus pesos queda en este repo.
# Versión FIJADA: paquete de la release 1.4.4 (sha256 controlado) y el tag 1.4.4 tiene que seguir
# apuntando al mismo commit; si no, la corrida se frena.
# Uso: bash instalar_lc.sh <dir>   (deja <dir>/venv y <dir>/lc_version.json)
set -euo pipefail

LC_TAG="1.4.4"
LC_COMMIT="ae208efd4b0bf7615b2f7d716982d5167b03a219"
LC_SHA256="0c8094c71e3fb0ca80350eb4da802200acd20093814c5c683a178e067094d97c"
LC_PROYECTO="https://gitlab.ssec.wisc.edu/api/v4/projects/1015"
LC_URL="${LC_PROYECTO}/packages/generic/lightningcast/${LC_TAG}/lightningcast-${LC_TAG}.tar.gz"

DIR="${1:?falta el directorio}"
mkdir -p "$DIR"
cd "$DIR"

echo "== tag ${LC_TAG} del repositorio oficial"
commit=$(curl -sfL "${LC_PROYECTO}/repository/tags/${LC_TAG}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["commit"]["id"])')
if [ "$commit" != "$LC_COMMIT" ]; then
  echo "ERROR: el tag ${LC_TAG} apunta a ${commit}, no a ${LC_COMMIT}. No se corre." >&2
  exit 1
fi

echo "== paquete de la release ${LC_TAG}"
curl -sfL -o lightningcast.tar.gz "$LC_URL"
echo "${LC_SHA256}  lightningcast.tar.gz" | sha256sum -c -
tar xzf lightningcast.tar.gz

uv venv -q -p 3.10 venv
PY="$DIR/venv/bin/python"
uv pip install -q -p "$PY" --no-deps ./lightningcast.tar.gz
# Las dependencias de su requirements.txt, menos pygrib (sólo radar MRMS de EE. UU.),
# más lo que faltaba en la lista (setuptools<70 para yaml_cascade, mysql, numba, h5netcdf).
uv pip install -q -p "$PY" \
  "setuptools<70" "numpy<2" "tensorflow==2.15.*" "tensorflow-addons" \
  "lmatools @ git+https://github.com/deeplycloudy/lmatools" \
  "stormdrain @ git+https://github.com/deeplycloudy/stormdrain" \
  "yaml_cascade @ git+https://gitlab.ssec.wisc.edu/rayg/yaml_cascade.git@v0.9.0" \
  "./lightningcast-${LC_TAG}/lightningcast/glm/glmtools" \
  cartopy cython descartes geojson geojson-rewind h5py imageio ipython lightgbm matplotlib metpy \
  mysql-connector-python netcdf4 pandas pika pyclipper pyorbital pyproj pyresample \
  rasterio satpy scikit-image scikit-learn scipy seaborn shap shapely six statsmodels tables \
  "timezonefinder[pytz]" xarray zarr numba h5netcdf

ver=$("$PY" -c 'from lightningcast.__version__ import __version__ as v; print(v)')
if [ "$ver" != "$LC_TAG" ]; then
  echo "ERROR: quedó instalada la versión ${ver}, no ${LC_TAG}" >&2
  exit 1
fi
uv pip freeze -p "$PY" > lc_freeze.txt
cat > lc_version.json <<EOF
{"programa": "ProbSevere LightningCast (CIMSS/UW-Madison)", "licencia": "GPL-3.0",
 "fuente": "https://gitlab.ssec.wisc.edu/jcintineo/lightningcast",
 "tag": "${LC_TAG}", "commit": "${LC_COMMIT}", "paquete": "${LC_URL}", "paquete_sha256": "${LC_SHA256}",
 "version_instalada": "${ver}", "modelo": "static/fit_conv_model.h5 (el de la release, sin cambios)"}
EOF
echo "LightningCast ${ver} instalado en ${DIR}/venv"
