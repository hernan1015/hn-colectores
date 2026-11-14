// HN AGRO · archivo de granizo (147) · EL VIGÍA DE FRESCURA: ¿se guardó algún barrido en los últimos 40 min?
// Mira los releases de HOY y de AYER (día argentino: a las 00:10 lo último está en el de ayer) en hn-radar: los assets de
// barrido (por su created_at, la hora en que QUEDARON guardados) y el índice (la hora de cada PEDIDO).
// Veredictos (uno por corrida):
//   · ok        → hay al menos un barrido nuevo en la ventana y no todos son falla;
//   · parado    → ni un barrido nuevo ni un pedido en la ventana: el colector no corre, no puede guardar o GitHub no
//                 dispara el cron. Clave: `…-parado-tras-<lo último guardado>` (no cambia mientras dura: no se repite);
//   · repite    → hay pedidos pero todos dieron un scan ya guardado: SATCHI sirve un scan viejo. Clave: el scan;
//   · fallando  → hay barridos nuevos pero todos son falla. Clave: `…-fallando-tras-<el último que no fue falla>`;
//   · parciales → hay barridos nuevos, ninguno bueno y alguno parcial (faltó NOAA, GLM u Open-Meteo, o sin scan_t).
//                 Clave: `…-parciales-tras-<la última buena>`;
//   · sin-lectura → no se pudo leer hn-radar (el token, la API, o un 404 del REPO: GitHub contesta 404 a un repo
//                 privado sin permiso, y eso no es «no hay barridos»). Clave: por día UTC (un aviso por día, como mucho).
// El aviso es un MAIL con lib/correo.mjs del vigía (los mismos secretos SATCHI_SMTP_* y SATCHI_VIGIA_DESTINO que
// opera-frescura) y no se repite por episodio (la clave va a la caché de Actions sólo si el mail salió).
import { leerNombre, diaAR } from './barrido.mjs';
import { RE_INDICE, unirIndices } from './indice.mjs';

export const VENTANA_MIN = 40;
const limpiar = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);

export const tagsAMirar = (ahoraMs) => [...new Set([diaAR(ahoraMs - 864e5), diaAR(ahoraMs)])].map((d) => 'granizo-' + d);

/** Regla pura. `barridos` = [{ name, created_at }] (sólo los assets de barrido); `pedidos` = líneas del índice. */
export function evaluarFrescura({ ahoraMs, barridos = [], pedidos = [], ventanaMin = VENTANA_MIN }) {
  const desde = ahoraMs - ventanaMin * 60000;
  const conHora = barridos.map((a) => ({ ...a, ms: Date.parse(a.created_at), n: leerNombre(a.name) }))
    .filter((a) => a.n && Number.isFinite(a.ms)).sort((a, b) => a.ms - b.ms);
  const nuevos = conHora.filter((a) => a.ms >= desde);
  const recientes = pedidos.filter((p) => Date.parse(p.pedido_utc) >= desde);
  const ultimo = conHora.length ? conHora[conHora.length - 1] : null;
  const base = { ventana_min: ventanaMin, nuevos: nuevos.length, pedidos: recientes.length, ultimo: ultimo ? ultimo.name : null, ultimo_guardado: ultimo ? ultimo.created_at : null };
  if (!nuevos.length && !recientes.length) {
    return { ...base, avisar: true, tipo: 'parado', clave: 'granizo-archivo-parado-tras-' + limpiar(ultimo ? ultimo.name : 'sin-registro'),
      asunto: `SATCHI granizo: ningún barrido guardado en ${ventanaMin} min`,
      detalle: `El archivo de granizo no guardó nada ni registró pedidos en los últimos ${ventanaMin} min. Último guardado: ${ultimo ? ultimo.name + ' (' + ultimo.created_at + ')' : 'ninguno'}. Mirar Actions → granizo-archivo (¿apagado, en rojo, el RADAR_TOKEN, o GitHub sin disparar el cron?).` };
  }
  if (!nuevos.length) {
    const scan = recientes.map((p) => p.scan_t).filter(Boolean).sort().pop() || 'sin-scan';
    return { ...base, avisar: true, tipo: 'repite', clave: 'granizo-archivo-repite-' + limpiar(scan),
      asunto: `SATCHI granizo: ${ventanaMin} min sirviendo el mismo scan`,
      detalle: `El colector corre (${recientes.length} pedidos en ${ventanaMin} min) pero todos dieron un scan ya guardado (el último: ${scan}). ¿Se trabó el cálculo de granizo-vivo o la caché de la red?` };
  }
  if (nuevos.every((a) => a.n.estado === 'falla')) {
    const sano = [...conHora].reverse().find((a) => a.n.estado !== 'falla');
    return { ...base, avisar: true, tipo: 'fallando', clave: 'granizo-archivo-fallando-tras-' + limpiar(sano ? sano.name : 'sin-registro'),
      asunto: `SATCHI granizo: ${ventanaMin} min sólo con fallas`,
      detalle: `Se guardaron ${nuevos.length} barridos en ${ventanaMin} min y todos son falla (sin respuesta, HTTP ≠ 200 u ok:false). El último sano: ${sano ? sano.name : 'ninguno'}.` };
  }
  if (!nuevos.some((a) => a.n.estado === 'buena')) {
    const buena = [...conHora].reverse().find((a) => a.n.estado === 'buena');
    return { ...base, avisar: true, tipo: 'parciales', clave: 'granizo-archivo-parciales-tras-' + limpiar(buena ? buena.name : 'sin-registro'),
      asunto: `SATCHI granizo: ${ventanaMin} min sin un barrido completo`,
      detalle: `Se guardaron ${nuevos.length} barridos en ${ventanaMin} min y ninguno es bueno: todos parciales (o falla). La última buena: ${buena ? buena.name : 'ninguna'}. Mirar los faltantes en el sobre (NOAA, GLM, Open-Meteo).` };
  }
  return { ...base, avisar: false, tipo: 'ok', clave: null };
}

/** Lee lo que hace falta de hn-radar con el cliente de lib/releases.mjs. Cualquier error → null (sin-lectura). */
export async function leerEstado(cliente, ahoraMs) {
  try {
    if (!(await cliente.repoVisible())) return null;   // 404 del repo = sin permiso: sin-lectura, no «parado»
    const barridos = [], textos = [];
    for (const tag of tagsAMirar(ahoraMs)) {
      const rel = await cliente.release(tag);
      if (!rel) continue;
      for (const a of await cliente.assets(rel)) if (leerNombre(a.name)) barridos.push({ name: a.name, created_at: a.created_at });
      for (const { buf } of await cliente.leerVarios(rel, (n) => RE_INDICE.test(n))) textos.push(buf);
    }
    return { barridos, pedidos: unirIndices(textos, 'vigia').pedidos };
  } catch { return null; }
}

export function sinLectura(ahoraMs) {
  const dia = new Date(ahoraMs).toISOString().slice(0, 10);
  return { avisar: true, tipo: 'sin-lectura', clave: 'granizo-archivo-sin-lectura-' + dia,
    asunto: 'SATCHI granizo: el vigía no puede leer el archivo', detalle: 'No se pudieron leer los releases granizo-* de hn-radar (¿RADAR_TOKEN vencido o sin permiso? ¿la API de GitHub?).' };
}
