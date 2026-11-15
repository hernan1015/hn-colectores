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
//   · huecos    → [227] todo lo demás anda, pero en las últimas HUECOS_VENTANA_MIN (6 h) hay un turno de 10 min (por la hora
//                 del SCAN) sin barrido BUENO, y después de él ya se guardó otro: ése no va a llegar nunca (granizo sólo da el
//                 último scan). El 14/11 faltaron las 02:50 y las 13:00 y la de las 13:20 llegó parcial, y el vigía no dijo
//                 nada. Clave: el turno del hueco MÁS NUEVO (un mail por hueco nuevo; los viejos no lo repiten);
//   · sin-lectura → no se pudo leer hn-radar (el token, la API, o un 404 del REPO: GitHub contesta 404 a un repo
//                 privado sin permiso, y eso no es «no hay barridos»). Clave: por día UTC (un aviso por día, como mucho).
// El aviso es un MAIL con lib/correo.mjs del vigía (los mismos secretos SATCHI_SMTP_* y SATCHI_VIGIA_DESTINO que
// opera-frescura) y no se repite por episodio (la clave va a la caché de Actions sólo si el mail salió).
import { leerNombre, diaAR, horaAR } from './barrido.mjs';
import { RE_INDICE, unirIndices } from './indice.mjs';

export const VENTANA_MIN = 40;
export const HUECOS_VENTANA_MIN = 360;
const DIEZ = 10 * 60000;
const limpiar = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);

export const tagsAMirar = (ahoraMs) => [...new Set([diaAR(ahoraMs - 864e5), diaAR(ahoraMs)])].map((d) => 'granizo-' + d);

/** [227] El ms del SCAN de un barrido con hora de scan (los `pedido-…` no tienen: null). */
const scanMsDe = (n) => (n && !n.porPedido
  ? Date.UTC(+n.hora.slice(0, 4), +n.hora.slice(4, 6) - 1, +n.hora.slice(6, 8), +n.hora.slice(9, 11), +n.hora.slice(11, 13)) : null);
const minutoUTC = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 13);

/** [227] Los HUECOS: turnos de 10 min (por la hora del scan) sin barrido bueno, desde el más reciente de
 *  (ahora − ventana) y el primer turno guardado, hasta ANTES del último turno guardado (lo que viene después del último
 *  todavía puede llegar; eso lo cuida «parado»). `falta` = ningún barrido de ese scan; `parcial`/`falla` = sólo eso. */
export function huecosDe({ ahoraMs, barridos = [], ventanaMin = HUECOS_VENTANA_MIN }) {
  const porTurno = new Map();
  const rango = { parcial: 1, falla: 0, buena: 2 };
  for (const a of barridos) {
    const n = leerNombre(a.name), ms = scanMsDe(n);
    if (ms == null || !Number.isFinite(ms)) continue;
    const t = Math.floor(ms / DIEZ) * DIEZ, ya = porTurno.get(t);
    if (ya == null || rango[n.estado] > rango[ya]) porTurno.set(t, n.estado);
  }
  if (!porTurno.size) return [];
  const turnos = [...porTurno.keys()].sort((a, b) => a - b);
  const ultimo = turnos[turnos.length - 1];
  const desde = Math.max(Math.ceil((ahoraMs - ventanaMin * 60000) / DIEZ) * DIEZ, turnos[0]);
  const out = [];
  for (let t = desde; t < ultimo; t += DIEZ) {
    const e = porTurno.get(t);
    if (e !== 'buena') out.push({ turno_utc: new Date(t).toISOString(), turno_art: horaAR(t).slice(11, 16), tipo: e || 'falta' });
  }
  return out;
}

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
  const huecos = huecosDe({ ahoraMs, barridos });
  if (huecos.length) {
    const nuevo = huecos[huecos.length - 1];
    const lista = huecos.slice(-20).map((h) => h.turno_art + ' ART (' + (h.tipo === 'falta' ? 'sin barrido' : 'sólo ' + h.tipo) + ')').join(', ');
    return { ...base, avisar: true, tipo: 'huecos', huecos, clave: 'granizo-archivo-hueco-' + minutoUTC(Date.parse(nuevo.turno_utc)),
      asunto: `SATCHI granizo: ${huecos.length} ${huecos.length === 1 ? 'barrido que falta' : 'barridos que faltan'} en el archivo (últimas ${HUECOS_VENTANA_MIN / 60} h)`,
      detalle: `El archivo sigue guardando, pero en las últimas ${HUECOS_VENTANA_MIN / 60} h no tiene un barrido completo de: ${lista}${huecos.length > 20 ? ' (y ' + (huecos.length - 20) + ' más)' : ''}. ` +
        'Ya hay barridos posteriores, así que esos no van a llegar: granizo-vivo sólo da el último scan. Lo más común es que GitHub atrasó el cron y el pedido siguiente ya trajo el scan nuevo; también puede ser que NOAA no publicó ese scan. Para un caso, se recalculan desde GOES-19. Si se repite seguido, mirar Actions → granizo-archivo (corridas atrasadas o salteadas) y el índice del día.' };
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
