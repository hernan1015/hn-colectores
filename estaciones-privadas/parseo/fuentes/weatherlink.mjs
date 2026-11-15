// HN AGRO · parseo · módulo de WeatherLink público (Davis) → red WEATHERLINK_PUB. USO INTERNO (mostrar = false).
// Lee SÓLO R2: lo que guardó ronda.mjs (<día>/<HHMM>.jsonl, un renglón { id, leido, d } por estación, más el índice del
// día) y el LOTE de la notebook (<día>/local.jsonl.gz, formato de colector-wl.mjs: ver formato.mjs · LOTE_WL).
// Convierte °F → °C, mph → m/s, in → mm, inHg → hPa; arregla el doble encoding de los nombres. Ver ../formato.mjs para
// lo verificado y lo supuesto del formato.
//
// LA EDAD: una lectura de más de MAX_EDAD_H (2 h) respecto de cuándo la leyó la ronda no cuenta. Es la regla de la red
// (cfg.maxEdadH, la que aplica el job a todas las fuentes); acá se aplica también al ageInSeconds que manda Davis, para
// contar el motivo ('vieja'). 2 h y no 12 porque el mapa muestra la última lectura de una consola de un particular,
// que puede estar parada hace días: con una pasada por hora, algo de más de 2 h ya no es de esta hora.
import { num, unidadEnValor, dir, instante, arreglarNombre, controlar, fAc, mphAms, kmhAms, inAmm, inhgAhpa, r2d } from '../lib/convertir.mjs';
import { localDe } from '../lib/hora.mjs';
import { WEATHERLINK, LOTE_WL } from '../formato.mjs';

export const PREF = 'estaciones-internas/weatherlink/';
export const RED = 'WEATHERLINK_PUB';
export const MAX_EDAD_H = 2;
const META = { permiso: 'interno', mostrar: false, fuente: 'WeatherLink público (mapa de Davis), vía ronda.mjs',
  terminos: 'Davis ToS 1/8/2019 prohíbe robots; bajada autorizada por el maker el 15/11/2026, uso interno' };
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;

/** El primer valor no nulo de `claves`, arriba o un nivel adentro. */
export function valor(o, claves) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  for (const k of claves) if (o[k] != null) return o[k];
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of claves) if (v[k] != null) return v[k];
  }
  return undefined;
}

const CONV = {
  temp_c: (x, u) => (u === 'C' ? r2d(x) : fAc(x)),
  viento_ms: (x, u) => (u === 'ms' ? r2d(x) : u === 'kmh' ? kmhAms(x) : mphAms(x)),
  presion_hpa: (x, u) => (u === 'hPa' || (u === 'inHg' && x > 100) ? r2d(x, 1) : inhgAhpa(x)),
  lluvia_dia_mm: (x, u) => (u === 'mm' ? r2d(x) : inAmm(x)),
};
CONV.racha_ms = CONV.viento_ms;

/** La respuesta del detalle → lectura convertida, o { ok: false, motivo, claves }. `leido` en ms. */
export function leerDetalle(id, d, leido, formato = WEATHERLINK) {
  const c = formato.campos;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, motivo: 'no_es_objeto', claves: [] };
  const claves = Object.keys(d).sort();
  const marcas = [];
  let inst = instante(valor(d, c.instante.claves));
  let edad = num(valor(d, c.edad.claves));
  if (inst == null && edad != null && Number.isFinite(leido)) { inst = leido - edad * 1000; marcas.push('instante_por_edad'); }
  if (inst == null) return { ok: false, motivo: 'sin_instante', claves };
  if (Number.isFinite(leido) && inst > leido + 10 * 60e3) return { ok: false, motivo: 'instante_futuro', claves };
  if (edad == null && Number.isFinite(leido) && leido >= inst) edad = Math.floor((leido - inst) / 1000);
  const l = { id: String(id), instante: inst, edad_s: edad, marcas };
  let hay = false;
  for (const k of ['temp_c', 'hum_pct', 'viento_ms', 'racha_ms', 'viento_dir_gr', 'presion_hpa', 'lluvia_dia_mm']) {
    const v = valor(d, c[k].claves);
    if (v !== undefined && k !== 'racha_ms' && k !== 'viento_dir_gr') hay = true;
    if (k === 'viento_dir_gr') { l[k] = dir(v); continue; }
    const x = num(v);
    const u = unidadEnValor(v) || c[k].unidad;
    l[k] = x == null ? null : CONV[k] ? CONV[k](x, u) : r2d(x);
  }
  if (!hay) return { ok: false, motivo: 'sin_variables', claves };
  controlar(l);
  const n = valor(d, c.nombre.claves);
  l.nombre = typeof n === 'string' ? arreglarNombre(n) || null : null;
  if (edad != null && edad > MAX_EDAD_H * 3600) return { ok: false, motivo: 'vieja', claves, lectura: l };
  return { ok: true, lectura: l };
}

/** La lectura de leerDetalle → la lectura común del job (lib/diario.mjs): { id, local, v, … }. Lo que no va a
 *  estaciones_obs (viento, presión) va en v.x y a la última lectura. */
export const aComun = (l, leido) => ({
  id: l.id, local: localDe(l.instante), instante: new Date(l.instante).toISOString(), leido, edad_s: l.edad_s, marcas: l.marcas,
  v: { temp: l.temp_c, hum: l.hum_pct, lluvia_acum: l.lluvia_dia_mm,
    x: { viento_ms: l.viento_ms, racha_ms: l.racha_ms, viento_dir_gr: l.viento_dir_gr, presion_hpa: l.presion_hpa } },
});

const primera = (o, claves) => { for (const k of claves) if (o[k] != null) return o[k]; return undefined; };
/** Un renglón del lote de la notebook → { id, leido, d } (la forma de ronda.mjs), o null si no tiene esa forma. */
export function renglonLote(o, forma = LOTE_WL) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const id = primera(o, forma.id), leido = primera(o, forma.leido);
  if (id == null || leido == null) return null;
  let d = primera(o, forma.detalle);
  if (d == null) { d = { ...o }; for (const k of [...forma.id, ...forma.leido]) delete d[k]; }
  return { id: String(id), leido, d };
}

/** El texto de una clave de R2 → los objetos que lee `leer`: { leido (ms), renglones }. */
export function abrir(texto, clave) {
  const lote = /\.jsonl\.gz$/.test(clave);
  const renglones = []; let leido = null;
  for (const linea of String(texto).split(/\r?\n/)) {
    if (!linea.trim()) continue;
    let o;
    try { o = JSON.parse(linea); } catch { renglones.push({ roto: 'no_es_json' }); continue; }
    if (lote) { o = renglonLote(o); if (!o) { renglones.push({ roto: 'lote_sin_forma' }); continue; } }
    const t = instante(o && o.leido);
    if (t != null && (leido == null || t > leido)) leido = t;
    renglones.push(o);
  }
  return [{ leido: leido == null ? null : new Date(leido).toISOString(), renglones }];
}

/** El índice de los días de la ventana → Map(id → { lat, lon, tb, dia }) (el día más nuevo manda). */
export async function contexto({ r2, dias }) {
  const indice = new Map(); let rotos = 0;
  for (const dia of [...dias].sort()) {
    const b = await r2.leer(`${PREF}indices/${dia}.json`);
    if (!b) continue;
    let lista = [];
    try { lista = JSON.parse(b.toString('utf8')); } catch { rotos++; }
    for (const s of Array.isArray(lista) ? lista : []) {
      if (s && s.id != null && ID_OK.test(String(s.id))) indice.set(String(s.id), { lat: num(s.lat), lon: num(s.lng ?? s.lon), tb: s.tb, dia });
    }
  }
  return { indice, indices_rotos: rotos };
}

const sumar = (o, k) => { o[k] = (o[k] || 0) + 1; };

/** Un objeto (una ronda o el lote) → la salida del job. Nunca imprime ids. */
export function leer(obj, ctx = { indice: new Map() }, formato = WEATHERLINK) {
  const cuentas = { renglones: 0, descartadas: {} };
  const claves_descartadas = {};
  const lecturas = []; const nombres = new Map();
  for (const o of obj?.renglones || []) {
    cuentas.renglones++;
    if (o.roto) { sumar(cuentas.descartadas, o.roto); continue; }
    const id = o && o.id != null ? String(o.id) : '';
    if (!ID_OK.test(id)) { sumar(cuentas.descartadas, 'sin_id'); continue; }
    const leido = instante(o.leido);
    const r = leerDetalle(id, o.d, leido, formato);
    if (!r.ok) {
      sumar(cuentas.descartadas, r.motivo);
      if (!claves_descartadas[r.motivo]) claves_descartadas[r.motivo] = r.claves.slice(0, 40);
      continue;
    }
    if (r.lectura.nombre) nombres.set(id, r.lectura.nombre);
    lecturas.push(aComun(r.lectura, leido));
  }
  const indice = ctx.indice || new Map();
  const ids = new Set([...indice.keys(), ...lecturas.map((l) => l.id)]);
  const estaciones = [...ids].sort().map((id) => {
    const i = indice.get(id);
    return { estacion_id: id, nombre: nombres.get(id) ?? null, lat: i?.lat ?? null, lon: i?.lon ?? null,
      fuente_ubicacion: i ? 'índice del mapa de WeatherLink' : null, precision_ubicacion: i ? 'declarada por el dueño' : null,
      activa: i ? i.tb !== -1 : true, metadatos: { ...META, ...(i ? { indice_visto: i.dia, tb: i.tb ?? null } : {}) } };
  });
  return [{ red: RED, estaciones, lecturas, problemas: 0, cuentas, claves_descartadas, presentes: indice.size >= 100 ? [...indice.keys()] : null }];
}

export default {
  id: 'weatherlink', nombre: 'WeatherLink público (Davis)', proceso: 'estaciones_privadas_parseo',
  /* ronda.mjs pasa una vez por hora por cada estación activa: muestreados; la lluvia, el acumulado del día de la consola */
  redes: { [RED]: { pasoMin: 60, extremos: 'muestreados', lluvia: 'acumulado_consola', eto: false, fuente: 'WeatherLink público, vía ronda.mjs',
    url: null, maxEdadH: MAX_EDAD_H, ultima: true } },
  ext: /\.jsonl$/, lote: /\/local[^/]*\.jsonl\.gz$/,
  abrir, contexto, leer,
};
