// HN AGRO · parseo · módulo de Weathercloud público → red WEATHERCLOUD_PUB. USO INTERNO (mostrar = false).
// Lee SÓLO R2: lo que guardó ronda.mjs (<día>/<HHMM>.json: { leido, devices: [arrays] }, ya sólo Argentina) y el LOTE
// de la notebook (<día>/local.jsonl.gz, formato de colector-wc.mjs: ver formato.mjs · LOTE_WC). Las variables vienen en
// DÉCIMAS. ⚠ Mientras formato.WEATHERCLOUD.verificado sea false NO se guarda nada: sólo se cuenta (ver formato.mjs).
// La edad: la misma regla de 2 h de WeatherLink (cfg.maxEdadH), por la misma razón (consolas de particulares).
import { num, instante, arreglarNombre, controlar, kmhAms, r2d, dir } from '../lib/convertir.mjs';
import { localDe } from '../lib/hora.mjs';
import { WEATHERCLOUD, LOTE_WC } from '../formato.mjs';

export const RED = 'WEATHERCLOUD_PUB';
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

const primera = (o, claves) => { for (const k of claves) if (o[k] != null) return o[k]; return undefined; };
/** El texto de una clave → objetos { leido, devices }. El lote (jsonl.gz) trae un renglón por pasada o por device. */
export function abrir(texto, clave, forma = LOTE_WC) {
  if (!/\.jsonl\.gz$/.test(clave)) return [JSON.parse(texto)];
  const porLeido = new Map(); let rotos = 0;
  for (const linea of String(texto).split(/\r?\n/)) {
    if (!linea.trim()) continue;
    let o;
    try { o = JSON.parse(linea); } catch { rotos++; continue; }
    const leido = o && typeof o === 'object' && !Array.isArray(o) ? primera(o, forma.leido) : undefined;
    const devs = leido == null ? null : Array.isArray(primera(o, forma.devices)) ? primera(o, forma.devices)
      : Array.isArray(primera(o, forma.device)) ? [primera(o, forma.device)] : null;
    if (!devs) { rotos++; continue; }
    const k = String(leido);
    if (!porLeido.has(k)) porLeido.set(k, { leido, devices: [] });
    porLeido.get(k).devices.push(...devs);
  }
  const out = [...porLeido.values()];
  if (rotos) out.push({ leido: null, devices: [], rotos });
  return out;
}

/** Arma el módulo con un formato (el de formato.mjs, o uno de prueba en los tests). */
export function crear(formato = WEATHERCLOUD) {
  return {
    id: 'weathercloud', nombre: 'Weathercloud público', proceso: 'estaciones_privadas_parseo',
    /* un pedido por hora (ronda.mjs): muestreados; la lluvia, el acumulado del día de la consola */
    redes: { [RED]: { pasoMin: 60, extremos: 'muestreados', lluvia: 'acumulado_consola', eto: false, fuente: 'Weathercloud público, vía ronda.mjs',
      url: null, maxEdadH: 2, ultima: true } },
    lote: /\/local[^/]*\.jsonl\.gz$/,
    abrir,
    leer(obj) {
      const leido = instante(obj && obj.leido);
      const devs = Array.isArray(obj && obj.devices) ? obj.devices : [];
      const cuentas = { devices: 0, en_linea: 0, verificado: formato.verificado, descartadas: {} };
      if (obj?.rotos) cuentas.descartadas.lote_sin_forma = obj.rotos;
      const estaciones = []; const lecturas = []; const ids = new Set();
      for (const dev of devs) {
        cuentas.devices++;
        if (Array.isArray(dev) && dev[formato.posiciones.estado] === formato.en_linea) cuentas.en_linea++;
        if (!formato.verificado) continue;                     // ⚠ sin verificar: sólo se cuenta
        const d = leerDevice(dev, leido, formato);
        if (!d) { cuentas.descartadas.sin_id = (cuentas.descartadas.sin_id || 0) + 1; continue; }
        ids.add(d.id);
        estaciones.push({ estacion_id: d.id, nombre: d.nombre, lat: d.lat, lon: d.lon, fuente_ubicacion: 'mapa de Weathercloud',
          precision_ubicacion: 'declarada por el dueño', activa: true, metadatos: { ...META } });
        const l = d.lectura;
        if (l) lecturas.push({ id: l.id, local: localDe(l.instante), instante: new Date(l.instante).toISOString(), leido, edad_s: null, marcas: l.marcas,
          v: { temp: l.temp_c, hum: l.hum_pct, lluvia_acum: l.lluvia_dia_mm,
            x: { viento_ms: l.viento_ms, racha_ms: l.racha_ms, viento_dir_gr: l.viento_dir_gr, presion_hpa: l.presion_hpa } } });
      }
      return [{ red: RED, estaciones, lecturas, problemas: 0, cuentas, presentes: ids.size >= 100 ? [...ids] : null,
        avisos: formato.verificado ? [] : ['weathercloud_formato_sin_verificar: no se guarda nada hasta completar formato.mjs'] }];
    },
  };
}

export default crear();
