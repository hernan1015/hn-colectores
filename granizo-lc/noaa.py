# Acceso a los buckets públicos de NOAA en AWS (noaa-goes16, noaa-goes19), sin credenciales.
# Reglas: archivos ENTEROS (nunca pedidos por rangos), de a UN pedido por vez dentro de cada
# proceso (el workflow corre a lo sumo 2 episodios a la vez => <= 2 pedidos simultáneos a NOAA).
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
AGENTE = "hn-colectores-granizo-lc/1 (investigacion; pedidos de a uno)"
PAUSA_S = 0.05  # respiro entre pedidos


def _get(url, intentos=4, timeout=180):
    ultimo = None
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENTE})  # sin cabecera Range
            with urllib.request.urlopen(req, timeout=timeout) as r:
                datos = r.read()
                largo = r.headers.get("Content-Length")
                if largo is not None and int(largo) != len(datos):
                    raise IOError("descarga incompleta: %d de %s bytes" % (len(datos), largo))
            time.sleep(PAUSA_S)
            return datos
        except Exception as e:  # noqa: BLE001 (reintentos con espera creciente)
            ultimo = e
            time.sleep(2 * (i + 1) ** 2)
    raise IOError("no se pudo bajar %s: %s" % (url, ultimo))


def listar(bucket, prefijo):
    """Lista las claves (y tamaños) bajo un prefijo, con ListObjectsV2 paginado."""
    claves, token = [], None
    while True:
        q = {"list-type": "2", "prefix": prefijo}
        if token:
            q["continuation-token"] = token
        url = "https://%s.s3.amazonaws.com/?%s" % (bucket, urllib.parse.urlencode(q))
        raiz = ET.fromstring(_get(url, timeout=60))
        for c in raiz.findall(NS + "Contents"):
            claves.append((c.find(NS + "Key").text, int(c.find(NS + "Size").text)))
        if (raiz.findtext(NS + "IsTruncated") or "false") == "true":
            token = raiz.findtext(NS + "NextContinuationToken")
        else:
            return claves


def bajar(bucket, clave, destino=None):
    """Baja el archivo entero. Si hay destino lo escribe; si no, devuelve los bytes."""
    datos = _get("https://%s.s3.amazonaws.com/%s" % (bucket, urllib.parse.quote(clave)))
    if destino is None:
        return datos
    with open(destino, "wb") as f:
        f.write(datos)
    return len(datos)
