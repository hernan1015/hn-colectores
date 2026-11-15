// HN AGRO · parseo · módulo de Weathercloud público → red WEATHERCLOUD_PUB. USO INTERNO (mostrar = false).
// Lee SÓLO R2 (lo que guardó ronda.mjs: { leido, devices: [arrays] }, ya sólo Argentina). Las variables vienen en
// DÉCIMAS. ⚠ Mientras formato.WEATHERCLOUD.verificado sea false NO se guarda nada: sólo se cuenta (ver formato.mjs).
import { num, instante, arreglarNombre, controlar, kmhAms, r2d, dir } from '../lib/convertir.mjs';
import { WEATHERCLOUD } from '../formato.mjs';

export const fuente = 'weathercloud';
export const red = 'WEATHERCLOUD_PUB';
export const muestreo_min = 60;     // un pedido por hora (ronda.mjs)
const PREF = 'estaciones-internas/weathercloud/';
const META = { permiso: 'interno', mostrar: false, fuente: 'Weathercloud público (mapa), vía ronda.mjs',
  terminos: 'Weathercloud ToS 13/9/2021 prohíbe robots y scraping; bajada autorizada por el maker el 15/11/2026, uso interno' };
const VARS = ['temp_c', 'hum_pct', 'viento_ms', 'racha_ms', 'viento_dir_gr', 'presion_hpa', 'lluvia_dia_mm'];

/** Un device (array) → { id, nombre, lat, lon, enLinea, lectura | null }, o null si no tiene id. `leido` en ms. */
export function leerDevice(dev, leido, formato = WEATHERCLOUD) {
  if (!Array.isArray(dev)) return null;
  const p = formato.posiciones;
  const en = (k) => (p[k] == null ? undefined : dev[p[k]]);
  const id = en('id') == null ? '' : String(en('id'));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const nombre = typeof en('nombre') === 'string' ? arreglarNombre(en('nombre')) || null : null;
  const lat = num(en('lat')), lon = num(en('lon'));
  const enLinea = en('estado') === formato.en_linea;
  let lectura = null;
  if (enLinea) {
    const marcas = [];
    let inst = instante(en('instante'));
    if (inst == null) { inst = leido; marcas.push('instante_de_lectura'); }
    if (Number.isFinite(inst)) {
      const l = { id, instante: inst, edad_s: null, marcas };
      for (const k of VARS) {
        const x = num(en(k));
        const esc = formato.escala[k] ?? 1;
        let v = x == null ? null : k === 'viento_dir_gr' ? dir(en(k)) : x * esc;
        if (v != null && (k === 'viento_ms' || k === 'racha_ms') && (formato.unidad[k] || 'ms') === 'kmh') v = kmhAms(v);
        l[k] = v == null ? null : r2d(v, k === 'presion_hpa' ? 1 : 2);
      }
      lectura = controlar(l);
    }
  }
  return { id, nombre, lat, lon, enLinea, lectura };
}

export async function leer({ r2, dias, formato = WEATHERCLOUD }) {
  const cuentas = { archivos: 0, devices: 0, en_linea: 0, lecturas: 0, descartadas: {}, verificado: formato.verificado };
  const lecturas = []; const est = new Map(); let ultimoArchivo = null;
  for (const dia of dias) {
    for (const k of await r2.listar(`${PREF}${dia}/`)) {
      if (!/\/\d{4}\.json$/.test(k)) continue;
      cuentas.archivos++;
      let o;
      try { o = JSON.parse((await r2.leer(k))?.toString('utf8') || ''); } catch { cuentas.descartadas.no_es_json = (cuentas.descartadas.no_es_json || 0) + 1; continue; }
      const leido = instante(o && o.leido);
      const devs = Array.isArray(o && o.devices) ? o.devices : [];
      if (!ultimoArchivo || k > ultimoArchivo.k) ultimoArchivo = { k, ids: new Set() };
      for (const dev of devs) {
        cuentas.devices++;
        if (Array.isArray(dev) && dev[WEATHERCLOUD.posiciones.estado] === formato.en_linea) cuentas.en_linea++;
        if (!formato.verificado) continue;                     // ⚠ sin verificar: sólo se cuenta
        const d = leerDevice(dev, leido, formato);
        if (!d) { cuentas.descartadas.sin_id = (cuentas.descartadas.sin_id || 0) + 1; continue; }
        if (ultimoArchivo.k === k) ultimoArchivo.ids.add(d.id);
        est.set(d.id, d);
        if (d.lectura) lecturas.push(d.lectura);
      }
    }
  }
  cuentas.lecturas = lecturas.length;
  const estaciones = [...est.values()].sort((a, b) => a.id.localeCompare(b.id)).map((d) => ({
    red, estacion_id: d.id, nombre: d.nombre, lat: d.lat, lon: d.lon, fuente_ubicacion: 'mapa de Weathercloud',
    precision_ubicacion: 'declarada por el dueño', activa: true, metadatos: { ...META } }));
  const presentes = formato.verificado && ultimoArchivo && ultimoArchivo.ids.size >= 100 ? [...ultimoArchivo.ids] : null;
  return { estaciones, lecturas, cuentas, claves_descartadas: {}, presentes,
    avisos: formato.verificado ? [] : ['weathercloud_formato_sin_verificar: no se guarda nada hasta completar formato.mjs'] };
}
