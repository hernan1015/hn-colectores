// HN AGRO · estaciones-parseo · Entre Ríos, Dirección de Hidráulica (EMA) → red ER_HIDRAULICA. INTERNO (Paso 0 139: no
// publica términos; la portada avisa que el dato es crudo y sin validar).
// La ronda guarda una parte por EMA: su `downld08.txt`, el «Download» de WeatherLink (Davis) en castellano, un registro
// cada «Int. Arc.» minutos (10) que cubre ~1 semana. Las columnas se ubican por la CABECERA (dos renglones de nombres,
// una línea de guiones), alineando cada nombre con la columna de datos que termina en el mismo lugar: el número y el
// orden de las columnas cambian de una EMA a otra.
// · Los registros son HISTORIA (tipo 'registro'): entra hasta 8 días atrás, no la regla de las 12 h.
// · temp («Temp. Ext.»), humedad («Hum. Ext.»), lluvia del registro («Lluvia», mm, período = Int. Arc.) y presión («Bar»,
//   hPa). El viento NO: la unidad de «Vel. Viento» no está confirmada.
// · Fecha d/mm/aa y hora H:MM, hora argentina.
// · La ronda guarda el cuerpo con r.text(): las tildes de la cabecera (Windows-1252) llegan como «�»; se aceptan las dos.
import { numero, desdeLocal, parte, sumar } from '../lib/comun.mjs';

export const RED = 'ER_HIDRAULICA';
const META = { fuente: 'Entre Ríos, Hidráulica (EMA)', permiso: 'interno' };
const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/�/g, '?').toLowerCase();
const tokens = (s) => { const o = []; const re = /\S+/g; let m; while ((m = re.exec(s))) o.push({ t: m[0], fin: m.index + m[0].length }); return o; };
const CAMPOS = { 'temp. ext.': 'temp', 'hum. ext.': 'hum', 'lluvia': 'lluvia', 'bar': 'presion', 'int. arc.': 'paso' };
export const OBLIGATORIAS = ['temp', 'hum', 'lluvia', 'paso'];

/** El downld08.txt → { lecturas: [{ local, temp, hum, lluvia, presion, paso }], rotos } o null si el formato cambió. */
export function parsearDavis(texto) {
  const lineas = String(texto).split(/\r?\n/);
  const iGuion = lineas.findIndex((l) => /^-{20,}\s*$/.test(l));
  if (iGuion < 1) return null;
  const datos = lineas.slice(iGuion + 1).filter((l) => l.trim());
  if (!datos.length) return { lecturas: [], rotos: 0 };
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
  if (columnas[0] !== 'fecha' || columnas[1] !== 'hora') return null;
  const idx = {};
  columnas.forEach((c, k) => { if (CAMPOS[c] && idx[CAMPOS[c]] == null) idx[CAMPOS[c]] = k; });
  if (OBLIGATORIAS.some((k) => idx[k] == null)) return null;
  const lecturas = []; let rotos = 0;
  for (const l of datos) {
    const t = l.trim().split(/\s+/);
    if (t.length !== cols.length) { rotos++; continue; }
    const f = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(t[0]); const h = /^(\d{1,2}):(\d{2})$/.exec(t[1]);
    if (!f || !h) { rotos++; continue; }
    const local = `20${f[3]}-${f[2].padStart(2, '0')}-${f[1].padStart(2, '0')}T${h[1].padStart(2, '0')}:${h[2]}`;
    const v = (k) => (idx[k] == null ? null : numero(t[idx[k]]));
    lecturas.push({ local, temp: v('temp'), hum: v('hum'), lluvia: v('lluvia'), presion: v('presion'), paso: v('paso') });
  }
  return { lecturas, rotos };
}

export function leer(obj) {
  const estaciones = [], lecturas = [], descartadas = {};
  for (const id of Object.keys(obj?.partes || {})) {
    if (!/^[a-z0-9_-]{2,40}$/.test(id)) { sumar(descartadas, 'sin_id'); continue; }
    const c = parte(obj, id);
    if (c == null) { sumar(descartadas, 'sin_parte'); continue; }      // las EMA que no existen dan 404
    const p = parsearDavis(c);
    if (!p) { sumar(descartadas, 'formato_cambiado'); continue; }
    if (p.rotos) sumar(descartadas, 'renglon_roto', p.rotos);
    if (!p.lecturas.length) continue;
    estaciones.push({ estacion_id: id, nombre: null, provincia: 'Entre Ríos', lat: null, lon: null, metadatos: { ...META } });
    for (const r of p.lecturas) {
      const t = desdeLocal(r.local);
      if (!Number.isFinite(t)) { sumar(descartadas, 'sin_instante'); continue; }
      const paso = Number.isInteger(r.paso) && r.paso >= 1 && r.paso <= 1440 ? r.paso : null;
      lecturas.push({ estacion_id: id, instante: t, tipo: 'registro', temp_c: r.temp, hum_pct: r.hum,
        lluvia_mm: r.lluvia, lluvia_periodo_min: paso, presion_hpa: r.presion, crudo: {} });
    }
  }
  return { red: RED, estaciones, lecturas, descartadas };
}

export default { id: 'entrerios', red: RED, leer };
