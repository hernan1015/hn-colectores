// HN AGRO · parseo · módulo de WeatherLink público (Davis) → red WEATHERLINK_PUB. USO INTERNO (mostrar = false).
// Lee SÓLO R2 (lo que guardó ronda.mjs). Convierte °F → °C, mph → m/s, in → mm, inHg → hPa; arregla el doble
// encoding de los nombres. Ver ../formato.mjs para lo verificado y lo supuesto del formato.
import { num, unidadEnValor, dir, instante, arreglarNombre, controlar, fAc, mphAms, kmhAms, inAmm, inhgAhpa, r2d } from '../lib/convertir.mjs';
import { WEATHERLINK } from '../formato.mjs';

export const fuente = 'weatherlink';
export const red = 'WEATHERLINK_PUB';
export const muestreo_min = 60;     // ronda.mjs pasa una vez por hora por cada estación activa
const PREF = 'estaciones-internas/weatherlink/';
const META = { permiso: 'interno', mostrar: false, fuente: 'WeatherLink público (mapa de Davis), vía ronda.mjs',
  terminos: 'Davis ToS 1/8/2019 prohíbe robots; bajada autorizada por el maker el 15/11/2026, uso interno' };

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
  if (edad != null && edad > formato.edad_max_s) return { ok: false, motivo: 'vieja', claves, lectura: l };
  return { ok: true, lectura: l };
}

/** Lee de R2 los días `dias` (AAAA-MM-DD) → { estaciones, lecturas, cuentas, formato }. Nunca imprime ids. */
export async function leer({ r2, dias, formato = WEATHERLINK }) {
  const cuentas = { archivos: 0, renglones: 0, lecturas: 0, descartadas: {}, indices: 0 };
  const motivosClaves = {};
  const lecturas = []; const nombres = new Map(); const indice = new Map();
  for (const dia of dias) {
    const idx = await r2.leer(`${PREF}indices/${dia}.json`);
    if (idx) {
      cuentas.indices++;
      let lista = [];
      try { lista = JSON.parse(idx.toString('utf8')); } catch { cuentas.descartadas.indice_no_es_json = (cuentas.descartadas.indice_no_es_json || 0) + 1; }
      for (const s of Array.isArray(lista) ? lista : []) {
        if (s && s.id != null && /^[A-Za-z0-9_-]{1,64}$/.test(String(s.id))) indice.set(String(s.id), { lat: num(s.lat), lon: num(s.lng ?? s.lon), tb: s.tb, dia });
      }
    }
    for (const k of await r2.listar(`${PREF}${dia}/`)) {
      if (!/\/\d{4}\.jsonl$/.test(k)) continue;
      cuentas.archivos++;
      const txt = (await r2.leer(k))?.toString('utf8') || '';
      for (const linea of txt.split(/\r?\n/)) {
        if (!linea.trim()) continue;
        cuentas.renglones++;
        let o;
        try { o = JSON.parse(linea); } catch { cuentas.descartadas.no_es_json = (cuentas.descartadas.no_es_json || 0) + 1; continue; }
        const id = o && o.id != null ? String(o.id) : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { cuentas.descartadas.sin_id = (cuentas.descartadas.sin_id || 0) + 1; continue; }
        const r = leerDetalle(id, o.d, instante(o.leido), formato);
        if (!r.ok) {
          cuentas.descartadas[r.motivo] = (cuentas.descartadas[r.motivo] || 0) + 1;
          if (!motivosClaves[r.motivo]) motivosClaves[r.motivo] = r.claves.slice(0, 40);
          continue;
        }
        if (r.lectura.nombre) nombres.set(id, r.lectura.nombre);
        lecturas.push(r.lectura);
      }
    }
  }
  cuentas.lecturas = lecturas.length;
  const ids = new Set([...indice.keys(), ...lecturas.map((l) => l.id)]);
  const estaciones = [...ids].sort().map((id) => {
    const i = indice.get(id);
    return { red, estacion_id: id, nombre: nombres.get(id) ?? null, lat: i?.lat ?? null, lon: i?.lon ?? null,
      fuente_ubicacion: i ? 'índice del mapa de WeatherLink' : null, precision_ubicacion: i ? 'declarada por el dueño' : null,
      activa: i ? i.tb !== -1 : true, metadatos: { ...META, ...(i ? { indice_visto: i.dia, tb: i.tb ?? null } : {}) } };
  });
  return { estaciones, lecturas, cuentas, claves_descartadas: motivosClaves, presentes: indice.size >= 100 ? [...indice.keys()] : null };
}
