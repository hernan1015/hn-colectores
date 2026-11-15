// HN AGRO · 139 interna · Entre Ríos, Dirección General de Hidráulica y Obras Sanitarias: la Red Oficial de Estaciones
// Meteorológicas Automáticas (www.hidraulica.gob.ar/ema.php). Red `ER_HIDRAULICA`. USO INTERNO (mostrar = false).
// Términos: no publica; la portada avisa que el dato operacional es «el registro crudo del sensor … sin proceso de
// validación» y que «El uso de esta información es responsabilidad exclusiva del usuario» (Paso 0 de la 139, 13/11).
// Parser escrito desde cero mirando la fuente (15/11: ema.php, ema.php?station=parana y su downld08.txt). La descarga la
// hace ronda.mjs (local): acá sólo se lee lo que dejó en R2.
//
// · Los datos: `ema/ema-<id>/downld08.txt`, el «Download» de WeatherLink (Davis) en castellano y Windows-1252, un
//   registro cada 10 min (columna Int. Arc.) que cubre ~1 semana. Las columnas se ubican por la CABECERA (el número y el
//   orden pueden cambiar de una EMA a otra), alineando cada nombre con la columna de datos que termina en el mismo lugar.
// · Las consolas suben el archivo cada tanto (el de Paraná, el 15/11, era del 10/11 12:13): por eso acá se aceptan
//   registros de hasta 10 días (la regla de las 12 h es para las instantáneas, no para un archivo que llega atrasado).
// · tmin/tmax: los extremos de la CONSOLA (Temp. Máx./Mín. de cada registro; muestreo_min NULL), la lluvia y la ET
//   sumando los registros. Unidades del export en métrico: °C, %, mm, hPa. El viento queda sólo en el crudo.
import { numero } from '../lib/diario.mjs';

export const BASE = 'https://www.hidraulica.gob.ar/';
export const urlDatos = (id) => `${BASE}ema/ema-${id}/downld08.txt`;

const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/�/g, '?').toLowerCase();

const tokens = (s) => { const o = []; const re = /\S+/g; let m; while ((m = re.exec(s))) o.push({ t: m[0], fin: m.index + m[0].length }); return o; };

/* nombre de la columna (sin tildes, en minúscula) → campo nuestro */
const CAMPOS = {
  'temp. ext.': 'temp', 'temp. max.': 'tmax', 'temp. min.': 'tmin', 'temp. m?x.': 'tmax', 'temp. m?n.': 'tmin', 'hum. ext.': 'hum', 'lluvia': 'lluvia', 'et': 'eto',
  'bar': 'presion', 'vel. viento': 'viento', 'dir. viento': 'dir', 'int. arc.': 'paso',
};
/** Las 20 EMA del selector de ema.php (leído el 15/11): id → [nombre, departamento]. */
export const EMA = Object.freeze({"basavilbaso":["Basavilbaso","Gualeguaychú"],"bovril":["Bovril","La Paz"],"ceibas":["Ceibas","Islas del Ibicuy"],"curuguay":["Concepción del Uruguay","Uruguay"],"concordia":["Concordia","Concordia"],"feliciano":["Feliciano","Feliciano"],"racedo":["General Racedo","Paraná"],"gualeguay":["Gualeguay","Gualeguay"],"gualeguaychu":["Gualeguaychú","Gualeguaychú"],"lapaz":["La Paz","La Paz"],"larroque":["Larroque","Gualeguaychú"],"loscharruas":["Los Charrúas","Concordia"],"macia":["Maciá","Tala"],"parana":["Paraná","Paraná"],"sanjose":["San José","Colón"],"sansalvador":["San Salvador","San Salvador"],"sauceluna":["Sauce de Luna","Federal"],"urdinarrain":["Urdinarrain","Gualeguaychú"],"villaparanacito":["Villa Paranacito","Islas del Ibicuy"],"villaguay":["Villaguay","Villaguay"]});

export const OBLIGATORIAS = ['temp', 'tmax', 'tmin', 'hum', 'lluvia'];

/** El downld08.txt (ya decodificado como latin1) → { columnas, lecturas, paso, descartadas }. Lanza si el formato cambió. */
export function parsearDavis(texto) {
  const lineas = String(texto).split(/\r?\n/);
  const iGuion = lineas.findIndex((l) => /^-{20,}\s*$/.test(l));
  if (iGuion < 1) throw new Error('er: no está la línea de guiones de la cabecera');
  const datos = lineas.slice(iGuion + 1).filter((l) => l.trim());
  if (!datos.length) return { columnas: [], lecturas: [], paso: null, descartadas: 0 };
  const cols = tokens(datos[0]);
  const nombres = cols.map(() => []);
  for (const h of lineas.slice(0, iGuion)) {
    for (const x of tokens(h)) {
      let mejor = -1, d = Infinity;
      cols.forEach((c, k) => { const dd = Math.abs(c.fin - x.fin); if (dd < d) { d = dd; mejor = k; } });
      if (d <= 3) nombres[mejor].push(x.t);
    }
  }
  const columnas = nombres.map((n) => sinTildes(n.join(' ')));
  if (columnas[0] !== 'fecha' || columnas[1] !== 'hora') throw new Error('er: las dos primeras columnas no son Fecha y Hora');
  const idx = {};
  columnas.forEach((c, k) => { if (CAMPOS[c] && idx[CAMPOS[c]] == null) idx[CAMPOS[c]] = k; });
  const faltan = OBLIGATORIAS.filter((k) => idx[k] == null);
  if (faltan.length) throw new Error('er: formato cambiado, faltan ' + faltan.join(','));
  const lecturas = []; let descartadas = 0; const pasos = new Map();
  for (const l of datos) {
    const t = l.trim().split(/\s+/);
    if (t.length !== cols.length) { descartadas++; continue; }
    const f = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(t[0]); const h = /^(\d{1,2}):(\d{2})$/.exec(t[1]);
    if (!f || !h || +h[1] > 23 || +h[2] > 59 || +f[1] > 31 || +f[2] > 12) { descartadas++; continue; }
    const local = `20${f[3]}-${f[2].padStart(2, '0')}-${f[1].padStart(2, '0')}T${h[1].padStart(2, '0')}:${h[2]}`;
    const v = (k) => (idx[k] == null ? null : numero(t[idx[k]]));
    const paso = v('paso');
    if (paso) pasos.set(paso, (pasos.get(paso) || 0) + 1);
    lecturas.push({ local, v: { temp: v('temp'), tmax: v('tmax'), tmin: v('tmin'), hum: v('hum'), lluvia: v('lluvia'), eto: v('eto'),
      x: { presion: v('presion'), viento: v('viento'), dir: idx.dir == null ? null : t[idx.dir] } } });
  }
  if (lecturas.length && descartadas > lecturas.length * 0.1) throw new Error(`er: ${descartadas} renglones rotos de ${datos.length}`);
  const paso = [...pasos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { columnas, lecturas, paso, descartadas };
}

import { parte } from '../lib/crudo.mjs';

/** R2 estaciones-internas/entrerios/<día>/<HHMM>.json: una parte por EMA (su downld08.txt; las que no existen, 404).
 *  ⚠ La ronda guarda el cuerpo con r.text(): el .txt es Windows-1252, así que «Máx.»/«Mín.» llegan como «M�x.»/«M�n.»
 *  (por eso las cabeceras aceptan las dos formas). */
export default {
  id: 'entrerios', nombre: 'Entre Ríos, Hidráulica (EMA)', proceso: 'interna_er_hidraulica',
  redes: { ER_HIDRAULICA: { pasoMin: 10, extremos: 'consola', lluvia: 'suma_registros', eto: true, fuente: 'Entre Ríos DGHyOS, EMA (WeatherLink downld08)', url: null, maxEdadH: 240 } },
  leer(obj) {
    const estaciones = [], lecturas = [], paso = {}; let problemas = 0;
    for (const id of Object.keys(obj?.partes || {})) {
      if (!/^[a-z0-9_-]{2,40}$/.test(id)) continue;
      const c = parte(obj, id);
      if (c == null) continue;
      let p;
      try { p = parsearDavis(c); } catch { problemas++; continue; }
      if (!p.lecturas.length) continue;
      estaciones.push({ estacion_id: id, nombre: EMA[id]?.[0] ?? null, partido: EMA[id]?.[1] ?? null, provincia: 'Entre Ríos', metadatos: { fuente: 'Entre Ríos DGHyOS, EMA', url_datos: urlDatos(id),
        licencia: 'sin términos publicados; dato crudo sin validar: INTERNO' } });
      for (const l of p.lecturas) lecturas.push({ id, ...l });
      if (p.paso) paso[id] = p.paso;
      problemas += p.descartadas;
    }
    return [{ red: 'ER_HIDRAULICA', estaciones, lecturas, paso, problemas }];
  },
};
