// HN AGRO · ARCHIVO DEL ÍNDICE CAP DEL SMN (225) · UNA CORRIDA.
//   1. el estado (de la release del día, o de los días anteriores); si hay uno que no se puede leer, o una PAUSA vigente
//      por un corte del SMN, no se le pide NADA y se termina (queda anotado en registro_procesos);
//   2. UN pedido al índice; se guarda con su hora (entero si cambió; si es igual al anterior, sólo su hash y dónde está);
//   3. los XML de los avisos que no están guardados (por URL), de a uno, con pausa y tope; un contenido que ya está
//      guardado con otra URL (mismo sha256) no se guarda dos veces: queda la referencia;
//   4. el sobre de la corrida → `<sello>Z.cap.json.gz` en la release `smn-cap-AAAA-MM-DD` (día argentino);
//   5. el estado nuevo (el nuevo antes que el viejo);
//   6. registro_procesos (proceso smn_cap_archivo): las cantidades, los avisos y las fallas.
// AVISOS Y FALLAS (como en la SIPAN): los avisos de ESTADO (AVISOS_DE_ESTADO) se anotan y se ven, pero no ponen la
// corrida en rojo. Cualquier otro tipo, y uno nuevo que se agregue, es FALLA: código 2.
import zlib from 'node:zlib';
import { selloUTC } from '../../lib/releases.mjs';
import { INDICE_URL, UA, TOPE_XML, leerIndice, pareceCap, cuerpoDe, minutosDePausa, motivoCorte, minutos } from './smn.mjs';
import { vacio, leerEstado, unirEstados, empaquetarEstado, pendiente, hashesGuardados, podar, RE_ESTADO, DIAS_ATRAS, INTENTOS_MAX } from './estado.mjs';

export const PROCESO = 'smn_cap_archivo';
export const FORMATO = 'hn-smn-cap/1';
export const RE_SOBRE = /^\d{8}T\d{6}Z\.cap\.json\.gz$/;
export const LICENCIA = 'CC BY 4.0 · Servicio Meteorológico Nacional (SMN) de Argentina';
export const AVISOS_DE_ESTADO = new Set(['en_pausa', 'tope', 'xml_no_disponible', 'xml_no_cap', 'estado_nuevo']);
export const esFalla = (a) => !AVISOS_DE_ESTADO.has(a && a.tipo);
/** 2 si hay alguna falla; 1 si sólo falló GitHub (el almacén); 0 si sólo hay avisos de estado (o nada). */
export function codigoSalida({ avisos = [], errores = [] } = {}) { return avisos.some(esFalla) ? 2 : errores.length ? 1 : 0; }

export const TZ_AR = 'America/Argentina/Buenos_Aires';
const fmtAR = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** 'AAAA-MM-DDTHH:MM:SS-03:00' */
export function horaAR(ms) {
  const p = Object.fromEntries(fmtAR.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((local - Math.floor(ms / 1000) * 1000) / 60000);
  const s = off < 0 ? '-' : '+', a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
export const diaAR = (ms) => horaAR(ms).slice(0, 10);
export const tagDe = (ms) => 'smn-cap-' + diaAR(ms);

export const notasRelease = (dia) => `SMN · AVISOS CAP · ${dia} (día argentino). Un asset por corrida (cada 10 min): ` +
  `<AAAAMMDDTHHMMSS>Z.cap.json.gz, con la hora del pedido (UTC y ART), el índice ${INDICE_URL} (entero si cambió; si no, su ` +
  'sha256 y en qué asset está) y los XML CAP de los avisos nuevos, tal cual llegaron. estado__*.json.gz = lo ya guardado. ' +
  `Fuente: Servicio Meteorológico Nacional (SMN) de Argentina, ${INDICE_URL}. Licencia CC BY 4.0 ` +
  '(https://creativecommons.org/licenses/by/4.0/deed.es). Archivo de HN AGRO: el contenido es del SMN, sin cambios.';

export const empaquetar = (s) => zlib.gzipSync(Buffer.from(JSON.stringify(s), 'utf8'), { level: 9 });
export const desempaquetar = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

/** El estado: el más nuevo de la release del día; si no hay, el de los días anteriores (hasta DIAS_ATRAS).
 *  `rotos`: los assets de estado que existen pero no se pudieron leer. Con alguno roto NO se sigue (ni se retrocede a
 *  un día anterior): ese estado puede tener una pausa vigente o los intentos de una URL, y arrancar sin él sería
 *  pedirle al SMN lo que nos pidió que no le pidiéramos. Arrancar vacío queda sólo para cuando no hay ningún estado. */
async function cargarEstado(cliente, rel, ahoraMs) {
  const deRelease = async (r) => {
    if (!r) return null;
    const previos = await cliente.leerVarios(r, (n) => RE_ESTADO.test(n));
    if (!previos.length) return null;
    const leidos = [], rotos = [];
    for (const p of previos) { try { leidos.push(leerEstado(p.buf)); } catch { rotos.push(p.asset.name); } }
    return { estado: leidos.length ? unirEstados(leidos) : null, assets: previos.map((p) => p.asset), rotos };
  };
  const hoy = await deRelease(rel);
  if (hoy) return { ...hoy, de: 'hoy' };
  for (let d = 1; d <= DIAS_ATRAS; d++) {
    const r = await cliente.release(tagDe(ahoraMs - d * 864e5));
    const x = await deRelease(r);
    if (x) return { estado: x.estado, assets: [], rotos: x.rotos, de: `${d} día(s) antes` };
  }
  return { estado: vacio(), assets: [], rotos: [], de: 'nuevo' };
}

/** ¿el asset `nombre` que ya estaba en la release es EXACTAMENTE `cuerpo`? (si no se puede comprobar: no) */
async function mismoContenido(cliente, rel, nombre, cuerpo) {
  try {
    const a = (await cliente.assets(rel)).find((x) => x.name === nombre);
    if (!a) return false;
    const b = await cliente.bajar(a);
    return !!b && Buffer.from(b).equals(cuerpo);
  } catch { return false; }
}

/** La parte del pedido que va al sobre (sin el Buffer). */
function registroPedido(r) {
  return { url: r.url, pedido_utc: new Date(r.pedido_ms).toISOString(), pedido_art: horaAR(r.pedido_ms), duracion_ms: r.duracion_ms,
    http: r.http, error: r.error, retry_after: r.retry_after, ...(r.location ? { location: r.location } : {}), bytes: r.bytes, sha256: r.sha256 };
}

/**
 * Una corrida. `pedidor` = crearPedidor() (lib/smn.mjs); `cliente` = clienteReleases() (lib/releases.mjs) o uno falso;
 * `base` = crearBase() (lib/base.mjs) o null. Nunca lanza por el SMN; lo de GitHub va a `errores`.
 */
export async function correr({ cliente, pedidor, base = null, seco = false, ahora = () => Date.now(), sello = () => selloUTC(new Date(ahora())),
  tope = TOPE_XML, colector = {}, log = () => {} }) {
  const t0 = ahora();
  const tag = tagDe(t0), dia = tag.slice('smn-cap-'.length);
  const avisos = [], errores = [];
  const res = { modo: seco ? 'seco' : 'real', tag, asset: null, pedidos: 0, estado_de: null,
    indice: { http: null, bytes: 0, nuevo: null, items: 0, enlaces: 0, por_carpeta: {}, fuera: {}, raros: 0 },
    xml: { en_indice: 0, ya_guardados: 0, ya_fallidos: 0, pendientes: 0, pedidos: 0, nuevos: 0, repetidos_hash: 0, no_disponibles: 0, redirigidos: 0, cortados: 0, sin_pedir: 0 } };

  const fin = async () => {
    res.pedidos = pedidor.pedidos;
    res.fallas = avisos.filter(esFalla).length;
    res.errores = errores.length;
    res.avisos = avisos;
    if (!seco) {
      if (!base) avisos.push({ tipo: 'sin_registro' });
      else {
        try { await base.registrar(PROCESO, !avisos.some(esFalla) && !errores.length, { ...res, avisos, errores_detalle: errores.slice(0, 10) }); }
        catch (e) { avisos.push({ tipo: 'registro_no_anotado', motivo: String((e && e.message) || e).slice(0, 80) }); }
      }
      res.fallas = avisos.filter(esFalla).length;
    }
    return { resumen: res, avisos, errores, codigo: codigoSalida({ avisos, errores }) };
  };

  // 1. la release y el estado
  let rel = null, est;
  try {
    rel = await cliente.release(tag, { crear: !seco, nombre: `SMN avisos CAP · ${dia}`, notas: notasRelease(dia) });
    est = await cargarEstado(cliente, rel, t0);
  } catch (e) { errores.push('estado: ' + String((e && e.message) || e).slice(0, 120)); return fin(); }
  res.estado_de = est.de;
  if (est.rotos.length) {
    avisos.push({ tipo: 'estado_ilegible', n: est.rotos.length, de: est.de });
    return fin();   // ni un pedido: el estado roto puede tener una pausa vigente (ver cargarEstado)
  }
  const estado = est.estado;
  if (est.de === 'nuevo') avisos.push({ tipo: 'estado_nuevo' });
  if (estado.pausa_hasta && estado.pausa_hasta > t0) {
    avisos.push({ tipo: 'en_pausa', motivo: estado.pausa_motivo, hasta: new Date(estado.pausa_hasta).toISOString() });
    return fin();
  }

  // 2. el índice, UNA vez
  const ri = await pedidor.pedir(INDICE_URL);
  res.indice.http = ri.http; res.indice.bytes = ri.bytes;
  const sobre = { formato: FORMATO, fuente: 'Servicio Meteorológico Nacional (SMN) de Argentina', licencia: LICENCIA, user_agent: UA, colector,
    pedido_utc: new Date(t0).toISOString(), pedido_art: horaAR(t0), indice: registroPedido(ri), xml: [] };
  const nombre = `${sello()}Z.cap.json.gz`;
  const corte = (r) => {
    const m = motivoCorte(r);
    if (!avisos.some((a) => a.tipo === 'smn_corto')) avisos.push({ tipo: 'smn_corto', motivo: m, url: r.url === INDICE_URL ? 'indice' : 'xml' });
    estado.pausa_hasta = ahora() + minutos(minutosDePausa(m, r.retry_after, r.pedido_ms));
    estado.pausa_motivo = m;
  };
  let lectura = null;
  // un cuerpo de error que llegó entero también es «lo que el SMN contestó a esa hora»: se guarda (no decide nada)
  if (ri.http !== 200 && ri.buf) Object.assign(sobre.indice, cuerpoDe(ri.buf));
  if (motivoCorte(ri)) corte(ri);
  else if (ri.http !== 200 || !ri.buf) avisos.push({ tipo: 'indice_http', http: ri.http });
  else {
    const texto = ri.buf.toString('utf8');
    res.indice.nuevo = !estado.indice || estado.indice.sha256 !== ri.sha256;
    if (res.indice.nuevo) Object.assign(sobre.indice, cuerpoDe(ri.buf));
    else sobre.indice.igual_a = estado.indice.asset;
    lectura = leerIndice(texto);
    Object.assign(res.indice, { items: lectura.items, enlaces: lectura.enlaces.length, por_carpeta: lectura.por_carpeta, fuera: lectura.fuera, raros: lectura.raros });
    if (!/<rss[\s>]/.test(texto) || !/<channel[\s>]/.test(texto)) avisos.push({ tipo: 'indice_no_rss' });
    else if (!lectura.entero || lectura.abiertos !== lectura.items) avisos.push({ tipo: 'indice_cortado', abiertos: lectura.abiertos, items: lectura.items });
    for (const [carpeta, n] of Object.entries(lectura.fuera)) avisos.push({ tipo: 'carpeta_nueva', carpeta: carpeta.slice(0, 40), n });
    if (lectura.raros) avisos.push({ tipo: 'enlace_raro', n: lectura.raros });
  }

  // 3. los XML nuevos
  if (lectura) {
    const hashes = hashesGuardados(estado);
    const pend = lectura.enlaces.filter((e) => pendiente(estado, e.url));
    res.xml.en_indice = lectura.enlaces.length;
    // guardado = hay un asset con su contenido; lo final SIN asset (404, cortado dos veces, redirigido) es un fallido
    res.xml.ya_guardados = lectura.enlaces.filter((e) => estado.urls[e.url] && estado.urls[e.url].asset).length;
    res.xml.ya_fallidos = lectura.enlaces.length - pend.length - res.xml.ya_guardados;
    res.xml.pendientes = pend.length;
    for (const e of lectura.enlaces) if (estado.urls[e.url]) estado.urls[e.url].visto = t0;
    if (!seco) {
      let pedidos = 0;
      for (const e of pend) {
        if (pedidos >= tope) break;
        const r = await pedidor.pedir(e.url);
        if (!r.pedido) break;    // la corrida se cortó (o la URL ya se pidió): no se pide nada más
        pedidos++;
        const previo = estado.urls[e.url];
        const ent = { sha256: null, http: r.http, asset: null, intentos: ((previo && previo.intentos) || 0) + 1, visto: t0, final: true, carpeta: e.carpeta };
        const x = registroPedido(r);
        if (r.http !== 200 && r.buf) Object.assign(x, cuerpoDe(r.buf));   // el cuerpo de error, si llegó
        if (motivoCorte(r)) {
          res.xml.cortados++; ent.final = ent.intentos >= INTENTOS_MAX; corte(r);
        } else if (r.http >= 300 && r.http < 400) {
          res.xml.redirigidos++;   // no se siguió (redirect: 'manual'): queda final y es falla
        } else if (r.http === 200 && r.buf) {
          ent.sha256 = r.sha256;
          const ya = hashes.get(r.sha256);
          if (ya) { x.igual_a = ya; ent.asset = ya; res.xml.repetidos_hash++; }
          else { Object.assign(x, cuerpoDe(r.buf)); ent.asset = nombre; hashes.set(r.sha256, nombre); res.xml.nuevos++; }
          if (!pareceCap(r.buf.toString('utf8'))) x.no_parece_cap = true;
        } else { res.xml.no_disponibles++; }
        estado.urls[e.url] = ent;
        sobre.xml.push(x);
        if (pedidor.cortado) break;
      }
      res.xml.pedidos = pedidos;
      res.xml.sin_pedir = pend.length - pedidos;
      if (res.xml.sin_pedir > 0 && pedidos >= tope && !pedidor.cortado) avisos.push({ tipo: 'tope', tope, sin_pedir: res.xml.sin_pedir });
      if (res.xml.no_disponibles) avisos.push({ tipo: 'xml_no_disponible', n: res.xml.no_disponibles });
      if (res.xml.redirigidos) avisos.push({ tipo: 'xml_redirige', n: res.xml.redirigidos });
      const noCap = sobre.xml.filter((x) => x.no_parece_cap).length;
      if (noCap) avisos.push({ tipo: 'xml_no_cap', n: noCap });
    } else res.xml.sin_pedir = pend.length;
  }
  if (seco) { res.asset = '(seco: no se sube)'; return fin(); }

  // 4. el sobre de la corrida (también el de una falla: lo que el SMN contestó a esa hora es un dato)
  if (res.indice.nuevo) estado.indice = { sha256: ri.sha256, asset: nombre, en: t0 };
  // el resumen del sobre: los pedidos ya están todos hechos; lo de la subida (asset, errores) todavía no se sabe y no va
  res.pedidos = pedidor.pedidos;
  const { asset: _sinAsset, ...hastaAca } = res;
  sobre.resumen = { ...hastaAca, avisos: avisos.map((a) => a.tipo) };
  const cuerpoSobre = empaquetar(sobre);
  try {
    const s = await cliente.subir(rel, nombre, cuerpoSobre, 'application/gzip');
    if (s.yaEstaba && !(await mismoContenido(cliente, rel, nombre, cuerpoSobre))) {
      // otro proceso subió ESE nombre con otro contenido: lo de esta corrida no está ahí → el estado no se toca
      errores.push('sobre: ya había un ' + nombre + ' con otro contenido (no se guarda el estado)');
      return fin();
    }
    res.asset = s.yaEstaba ? nombre + ' (ya estaba, igual)' : nombre;
  } catch (e) {
    errores.push('sobre: ' + String((e && e.message) || e).slice(0, 120));
    return fin();   // sin el sobre no se toca el estado: lo no guardado se vuelve a pedir en la próxima
  }

  // 5. el estado nuevo, ANTES de borrar el viejo
  podar(estado, t0);
  estado.actualizado = new Date(t0).toISOString();
  if (estado.pausa_hasta && estado.pausa_hasta <= t0) { estado.pausa_hasta = null; estado.pausa_motivo = null; }
  try { await cliente.reemplazar(rel, { nombre: `estado__${sello()}.json.gz`, cuerpo: empaquetarEstado(estado), tipo: 'application/gzip', viejos: est.assets }); }
  catch (e) { errores.push('estado: ' + String((e && e.message) || e).slice(0, 120)); }
  log(`sobre ${nombre}`);
  return fin();
}
