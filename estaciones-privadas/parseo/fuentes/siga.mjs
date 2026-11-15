// HN AGRO · 139 interna · INTA SIGA, tiempo real. Red `SIGA_RT`. USO INTERNO (mostrar = false).
// Lee lo que guarda ronda.mjs en R2 (estaciones-internas/siga/<día>/<HHMM>.json, parte «estaciones»): la respuesta del
// .php que publica `js/urlserver.js` en URL_MYSQL_ESTACION_AUTOMATICA. Al INTA no se le pide nada desde acá.
//
// ⚠ FORMATO SIN VERIFICAR: no hay todavía una muestra de esa respuesta (no se le pidió nada al INTA, regla del proyecto).
// Se escribió sobre la forma del listado que ya usaba hn-agro (siga-vivos.js: id, nombre, provincia, latitud, longitud,
// idTipo…) y se aceptan, si vienen, los campos de una lectura con los nombres del datohorario (fecha, temperatura,
// humedad, precipitacion). Si la respuesta no es un arreglo de estaciones, se rechaza ENTERA (no se guarda nada a
// medias); si es un arreglo sin lecturas, se guarda sólo el catálogo. Ver LISTO-139-internas.md.
import { numero } from '../lib/diario.mjs';
import { localDe } from '../lib/hora.mjs';
import { parte } from '../lib/crudo.mjs';

const CAMPO_FECHA = ['fecha', 'fechaHora', 'fecha_hora', 'ultimaFecha', 'ultimoDato'];

/** La respuesta de la URL _AUTOMATICA → { estaciones, lecturas, problemas }. */
export function parsearAutomaticas(texto) {
  const a = JSON.parse(texto);
  if (!Array.isArray(a)) throw new Error('siga: la respuesta no es un arreglo');
  if (a.length && !('id' in a[0] && ('latitud' in a[0] || 'lat' in a[0]))) throw new Error('siga: formato cambiado (sin id / latitud)');
  const estaciones = [], lecturas = []; let problemas = 0;
  for (const e of a) {
    if (!e || !/^\d{1,6}$/.test(String(e.id))) { problemas++; continue; }
    if (e.idTipo != null && e.idTipo !== 2) continue;              // sólo automáticas
    if (e.visible === false || e.localidad === 'loc_prueba' || e.provincia === 'Sin asignar') continue;
    const lat = numero(e.latitud ?? e.lat), lon = numero(e.longitud ?? e.lon);
    if (lat == null || lon == null || lat < -56 || lat > -21 || lon < -75 || lon > -53) continue;
    const id = String(e.id);
    estaciones.push({ estacion_id: id, nombre: e.nombre || null, provincia: e.provincia || null, lat, lon, fuente_ubicacion: 'INTA SIGA, listado de automáticas',
      metadatos: { fuente: 'INTA SIGA', id_interno: e.idInterno ?? null, tipo: e.tipo ?? null, localidad: e.localidad ?? null, alt_m: numero(e.altura),
        licencia: 'términos no leídos (el sitio no respondió el 13/11): INTERNO' } });
    const cf = CAMPO_FECHA.find((k) => typeof e[k] === 'string');
    if (!cf) continue;
    const local = localDe(String(e[cf]).replace('[UTC]', ''));
    if (!local) { problemas++; continue; }
    const v = { temp: numero(e.temperatura ?? e.temp), hum: numero(e.humedad ?? e.hum), x: { precipitacion: numero(e.precipitacion) } };
    if (v.temp == null && v.hum == null) continue;
    lecturas.push({ id, local, v });
  }
  return { estaciones, lecturas, problemas };
}

export default {
  id: 'siga', nombre: 'INTA SIGA, tiempo real', proceso: 'interna_siga_rt',
  /* una lectura por ronda (cada hora): muestreados; la lluvia de cada lectura no se sabe de qué período es → al crudo */
  redes: { SIGA_RT: { pasoMin: 60, extremos: 'muestreados', lluvia: null, eto: false, fuente: 'INTA SIGA (listado de automáticas)', url: 'https://siga.inta.gob.ar/', maxEdadH: 12 } },
  leer(obj) {
    const c = parte(obj, 'estaciones');
    if (c == null) return [];
    const p = parsearAutomaticas(c);
    return [{ red: 'SIGA_RT', estaciones: p.estaciones, lecturas: p.lecturas, problemas: p.problemas }];
  },
};
