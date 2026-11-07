// HN AGRO · colector del SHN (Servicio de Hidrografía Naval) para GitHub Actions, con los datos en R2.
// Adaptado del colector de una sola PC: mismos modos y misma estructura de archivos, pero el estado
// (última hora por estación, candado, bloqueo) se lee del almacén al arrancar y no queda nada en el runner.
// Reglas con el servidor: de a UN pedido, pausa base 6 s; ante 429/403 se anota la alerta y la corrida se corta.
import crypto from 'node:crypto';

export const ESTACIONES = ['SFER', 'MAGA', 'BSAS', 'LPLA', 'PNOR', 'ATAL', 'OYAR'];
export const NOMBRES = { SFER: 'San Fernando', MAGA: 'Martin Garcia', BSAS: 'Buenos Aires', LPLA: 'La Plata', PNOR: 'Pilote Norden', ATAL: 'Atalaya', OYAR: 'Oyarvide' };
const COD_TABLA = { SFER: 'SANF', MAGA: 'MAGA', BSAS: 'BSAS', LPLA: 'LPLA', PNOR: 'NORD', ATAL: 'ATAL', OYAR: 'OYAR' };
export const PUERTOS_MODELO = {
  San_Fernando: 'Alturatotal_San_Fernando.svg',
  Palermo: 'Alturatotal_Palermo.svg',
  La_Plata: 'Alturatotal_La_Plata.svg',
  Oyarvide: 'Alturatotal_Oyarvide.svg',
  Martin_Garcia: 'Alturatotal_Martin_Garcia.svg',
};
export const URL_API = 'https://www.hidro.gob.ar/api/v1/AlturasHorarias';
export const URL_SVG = 'https://api.shn.gob.ar/imagenes-modelo/curvas_altura-total/';
export const URL_PRONO = 'https://www.hidro.gov.ar/Oceanografia/Pronostico.asp';
export const URL_AVISO = 'https://www.hidro.gov.ar/oceanografia/AACRIOPLA.asp';
export const URL_TABLA = 'https://www.hidro.gov.ar/Oceanografia/Tmareas/RE_TablasDeMarea.asp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const K = {
  candado: 'estado/candado.json',
  bloqueo: 'estado/bloqueo.json',
  estado: 'estado/estado.json',
  alertas: 'alertas.txt',
  log: 'log/shn.log',
  horario: (c) => `horario/${c}.csv`,
  crudo: (c, aaaamm) => `crudos/horario/${c}/${aaaamm}.jsonl`,
};
export const CAB = 'hora_local;medida_m;astronomica_m;diferencia_m';

// Corte de la corrida: el servidor dijo basta (429) o bloqueó (403). No se reintenta en bucle.
export class Bloqueo extends Error {
  constructor(status, url) { super(`HTTP ${status}`); this.status = status; this.url = url; }
}

const p2 = (n) => String(n).padStart(2, '0');
// Argentina es UTC-3 todo el año: "hora local" = Date en UTC corrida -3 h.
export const isoLocal = (d) => d.toISOString().slice(0, 16);
const stampLocal = (d) => d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
const parseLocal = (s) => new Date(s.slice(0, 16) + ':00Z');

// ---------- contexto de una corrida ----------
// ctx: { almacen, fetchFn, dormir, ahora: () => ms, pausaBaseMs, esperaReintentoMs, venceCandadoMs, pausaBloqueoMs, corrida, salida }
export function crearContexto(o) {
  const ctx = {
    fetchFn: fetch,
    dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
    ahora: () => Date.now(),
    pausaBaseMs: 6000,
    esperaReintentoMs: 60000,
    venceCandadoMs: 2 * 3600e3,
    pausaBloqueoMs: 12 * 3600e3,
    corrida: process.env.GITHUB_RUN_ID || 'local-' + process.pid,
    salida: (m) => console.log(m),
    ...o,
  };
  ctx.lineasLog = [];
  ctx.pendientes = new Map(); // clave -> texto acumulado para agregar al final (crudos .jsonl)
  ctx.pedidos = 0;
  ctx.ultimoPedido = 0;
  ctx.alertasNuevas = 0;
  ctx.ahoraLocal = () => new Date(ctx.ahora() - 3 * 3600e3);
  return ctx;
}

// log() va SOLO al archivo del almacén (privado); publico() también a la consola, que en un repo
// público es visible para cualquiera: ahí sólo cantidades, nunca valores del SHN.
function log(ctx, msg) { ctx.lineasLog.push(`${new Date(ctx.ahora()).toISOString()} ${msg}`); }
function publico(ctx, msg) { log(ctx, msg); ctx.salida(msg); }

async function leerTexto(ctx, clave) { const b = await ctx.almacen.leer(clave); return b == null ? null : b.toString('utf8'); }

export async function alerta(ctx, msg) {
  const previo = (await leerTexto(ctx, K.alertas)) || '';
  // idempotente: no repite la misma alerta (el texto después de la marca de tiempo)
  if (previo.split('\n').some((l) => l.slice(22) === msg)) return false;
  await ctx.almacen.escribir(K.alertas, previo + `${new Date(ctx.ahora()).toISOString().slice(0, 19)}Z  ${msg}\n`);
  ctx.alertasNuevas++;
  log(ctx, 'ALERTA ' + msg);
  return true;
}

function agregarPendiente(ctx, clave, texto) { ctx.pendientes.set(clave, (ctx.pendientes.get(clave) || '') + texto); }
// Escribe lo acumulado (crudos y log). Se llama siempre al final, también si hubo bloqueo o error.
export async function vaciar(ctx) {
  for (const [clave, texto] of ctx.pendientes) {
    const previo = (await leerTexto(ctx, clave)) || '';
    await ctx.almacen.escribir(clave, previo + texto);
  }
  ctx.pendientes.clear();
  if (ctx.lineasLog.length) {
    const previo = (await leerTexto(ctx, K.log)) || '';
    await ctx.almacen.escribir(K.log, previo + ctx.lineasLog.join('\n') + '\n');
    ctx.lineasLog = [];
  }
}

// ---------- candado (con vencimiento) y bloqueo ----------
export async function tomarCandado(ctx) {
  const ficha = { corrida: ctx.corrida, token: crypto.randomBytes(8).toString('hex'), desde: new Date(ctx.ahora()).toISOString(), vence: new Date(ctx.ahora() + ctx.venceCandadoMs).toISOString() };
  const cuerpo = JSON.stringify(ficha);
  if (await ctx.almacen.escribir(K.candado, cuerpo, { soloSiNoExiste: true })) { ctx.candado = ficha; return { ok: true }; }
  let actual = null;
  try { actual = JSON.parse((await leerTexto(ctx, K.candado)) || 'null'); } catch { actual = null; }
  if (actual && Date.parse(actual.vence) > ctx.ahora()) return { ok: false, actual };
  // vencido (o ilegible): se lo toma y se verifica que haya quedado el nuestro
  await ctx.almacen.escribir(K.candado, cuerpo);
  const ahora = JSON.parse((await leerTexto(ctx, K.candado)) || 'null');
  if (ahora?.token !== ficha.token) return { ok: false, actual: ahora };
  ctx.candado = ficha;
  log(ctx, `candado vencido de la corrida ${actual?.corrida ?? '?'} (vencía ${actual?.vence ?? '?'}): tomado`);
  return { ok: true, vencido: true };
}
export async function soltarCandado(ctx) {
  if (!ctx.candado) return;
  try {
    const actual = JSON.parse((await leerTexto(ctx, K.candado)) || 'null');
    if (actual?.token === ctx.candado.token) await ctx.almacen.borrar(K.candado);
  } catch { /* si no se pudo, vence solo */ }
  ctx.candado = null;
}
export async function bloqueoVigente(ctx) {
  try {
    const b = JSON.parse((await leerTexto(ctx, K.bloqueo)) || 'null');
    if (b && Date.parse(b.hasta) > ctx.ahora()) return b;
  } catch { /* ilegible = sin bloqueo */ }
  return null;
}
async function anotarBloqueo(ctx, e, modo) {
  const hasta = new Date(ctx.ahora() + ctx.pausaBloqueoMs).toISOString();
  await ctx.almacen.escribir(K.bloqueo, JSON.stringify({ desde: new Date(ctx.ahora()).toISOString(), hasta, status: e.status, modo, corrida: ctx.corrida }));
  const dia = isoLocal(ctx.ahoraLocal()).slice(0, 10);
  await alerta(ctx, `${dia} BLOQUEO: el SHN contestó ${e.message} en modo ${modo}; corrida cortada, sin pedidos hasta ${hasta.slice(0, 16)}Z (o forzar a mano)`);
}

// ---------- pedidos ----------
// Un pedido por vez, con pausa base desde el anterior. Como mucho UN reintento:
//   429/403 -> espera esperaReintentoMs y reintenta una vez; si vuelve a dar 429/403, Bloqueo (corta la corrida).
//   otro error -> espera esperaReintentoMs/2 y reintenta una vez; si falla, Error (sigue con lo próximo).
export async function pedir(ctx, url, opts = {}, { texto = true } = {}) {
  let ultimo;
  for (let intento = 0; intento < 2; intento++) {
    const falta = ctx.ultimoPedido + ctx.pausaBaseMs + Math.random() * 1000 - ctx.ahora();
    if (falta > 0) await ctx.dormir(falta);
    if (intento === 1) {
      const espera = ultimo instanceof Bloqueo ? ctx.esperaReintentoMs : ctx.esperaReintentoMs / 2;
      log(ctx, `reintento en ${Math.round(espera / 1000)} s: ${url}`);
      await ctx.dormir(espera);
    }
    ctx.ultimoPedido = ctx.ahora();
    ctx.pedidos++;
    let r;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 30000);
      r = await ctx.fetchFn(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: ctl.signal });
      clearTimeout(to);
    } catch (e) {
      ultimo = e; log(ctx, `error pedido ${url}: ${e.message}`); continue;
    }
    if (r.status === 429 || r.status === 403) { ultimo = new Bloqueo(r.status, url); log(ctx, `${r.status} en ${url}`); continue; }
    if (!r.ok) { ultimo = new Error('HTTP ' + r.status); log(ctx, `error pedido ${url}: HTTP ${r.status}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    let cuerpo = buf;
    if (texto) {
      cuerpo = buf.toString('utf8');
      if (cuerpo.includes('�')) cuerpo = buf.toString('latin1'); // utf-8 primero, latin-1 si falla
    }
    const headers = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { cuerpo, headers };
  }
  if (ultimo instanceof Bloqueo) throw ultimo;
  throw new Error(`fallo definitivo ${url}: ${ultimo?.message}`);
}

// ---------- horario ----------
export function parseHorario(texto) {
  const m = new Map(); // hora -> {med, ast}
  if (!texto) return m;
  for (const l of texto.split('\n').slice(1)) {
    if (!l.trim()) continue;
    const [h, med, ast] = l.split(';');
    m.set(h, { med: med === '' || med == null ? null : Number(med), ast: ast === '' || ast == null ? null : Number(ast) });
  }
  return m;
}
export function textoHorario(m) {
  const filas = [...m.keys()].sort().map((h) => {
    const { med, ast } = m.get(h);
    const dif = med != null && ast != null ? (med - ast).toFixed(3) : '';
    return `${h};${med ?? ''};${ast != null ? Number(ast.toFixed(3)) : ''};${dif}`;
  });
  return CAB + '\n' + filas.join('\n') + '\n';
}
// Une dos tablas horarias: manda la primera (`a`) cuando las dos tienen el dato.
export function fusionarHorario(a, b) {
  const m = new Map(b);
  for (const [h, v] of a) {
    const w = m.get(h) || { med: null, ast: null };
    m.set(h, { med: v.med ?? w.med, ast: v.ast ?? w.ast });
  }
  return m;
}
export function ultimaMedida(m) {
  let u = null;
  for (const [h, v] of m) if (v.med != null && (u === null || h > u)) u = h;
  return u;
}
async function cargarHorario(ctx, cod) { return parseHorario(await leerTexto(ctx, K.horario(cod))); }

// Pide la ventana que termina en T (hora local con :45).
async function ventana(ctx, cod, T, m) {
  const clave = `${T.toISOString().slice(0, 13).replace(/[-T]/g, '')}45`; // AAAAMMDDhh45
  const { cuerpo } = await pedir(ctx, `${URL_API}/${cod}/${clave}`);
  const j = JSON.parse(cuerpo);
  agregarPendiente(ctx, K.crudo(cod, clave.slice(0, 6)), JSON.stringify({ pedido: clave, bajado: new Date(ctx.ahora()).toISOString(), json: j }) + '\n');
  if (j.observaciones) log(ctx, `${cod} observaciones: ${j.observaciones}`);
  let nuevas = 0;
  for (const a of j.astronomica || []) {
    const h = a.fecha.slice(0, 16);
    const v = m.get(h) || { med: null, ast: null };
    v.ast = a.altura; m.set(h, v);
  }
  for (const l of j.lecturas || []) {
    const h = l.fecha.slice(0, 16);
    const v = m.get(h) || { med: null, ast: null };
    if (v.med == null) nuevas++;
    v.med = l.altura; m.set(h, v);
  }
  return { lect: (j.lecturas || []).length, nuevas };
}

// Pone una estación al día desde la última medida guardada (retrocede de a 13 h, tope maxAtras horas).
async function ponerAlDia(ctx, cod, { maxAtras = 72 } = {}) {
  const m = await cargarHorario(ctx, cod);
  const ult = ultimaMedida(m);
  const ahora = ctx.ahoraLocal();
  let T = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), ahora.getUTCHours(), 45));
  if (T > ahora) T = new Date(T.getTime() - 3600e3);
  const limite = new Date(Math.max(ult ? parseLocal(ult).getTime() : 0, ahora.getTime() - maxAtras * 3600e3));
  let pe = 0, nuevas = 0;
  try {
    for (;;) {
      const r = await ventana(ctx, cod, T, m);
      pe++; nuevas += r.nuevas;
      if (new Date(T.getTime() - 12 * 3600e3) <= limite) break;
      T = new Date(T.getTime() - 13 * 3600e3);
    }
  } finally {
    // lo que se haya bajado antes de un corte también se guarda
    if (pe) await ctx.almacen.escribir(K.horario(cod), textoHorario(m));
  }
  return { pedidos: pe, nuevas, ultima: ultimaMedida(m), previa: ult };
}

export async function modoHorario(ctx, o = {}) {
  const lista = o.estacion ? String(o.estacion).split(',') : ESTACIONES;
  const maxAtras = o.maxatras ? Number(o.maxatras) : 72;
  let estado = {};
  try { estado = JSON.parse((await leerTexto(ctx, K.estado)) || '{}'); } catch { estado = {}; }
  estado.ultima = estado.ultima || {};
  let nuevasTot = 0, fallas = 0;
  try {
    for (const cod of lista) {
      try {
        const r = await ponerAlDia(ctx, cod, { maxAtras });
        // control: el estado guardado no puede ir por delante del CSV (sería una escritura perdida)
        if (estado.ultima[cod] && (!r.previa || r.previa < estado.ultima[cod])) {
          await alerta(ctx, `${cod}: el estado decía última medida ${estado.ultima[cod]} y el CSV tenía ${r.previa ?? 'nada'} (¿escritura perdida?)`);
        }
        if (r.ultima) estado.ultima[cod] = r.ultima;
        nuevasTot += r.nuevas;
        log(ctx, `horario ${cod}: ${r.pedidos} pedidos, ${r.nuevas} horas medidas nuevas, última ${r.ultima}`);
        publico(ctx, `horario ${cod}: ${r.pedidos} pedidos, ${r.nuevas} horas nuevas`);
      } catch (e) {
        if (e instanceof Bloqueo) throw e;
        fallas++;
        publico(ctx, `horario ${cod} FALLO: ${e.message}`);
        await alerta(ctx, `horario ${cod}: no se pudo bajar (${e.message.slice(0, 120)})`);
      }
    }
  } finally {
    estado.actualizado = new Date(ctx.ahora()).toISOString();
    await ctx.almacen.escribir(K.estado, JSON.stringify(estado, null, 1));
  }
  publico(ctx, `horario: ${nuevasTot} horas nuevas en total, ${fallas} estaciones con falla`);
  await modoChequeo(ctx, { dias: 3, silencioso: true });
  return { nuevas: nuevasTot, fallas };
}

// ---------- chequeo (sin pedidos al SHN) ----------
export async function modoChequeo(ctx, o = {}) {
  const dias = o.dias ? Number(o.dias) : 3;
  const ahora = ctx.ahoraLocal();
  const hoy = isoLocal(ahora).slice(0, 10);
  let faltas = 0;
  for (const cod of o.estacion ? String(o.estacion).split(',') : ESTACIONES) {
    const m = await cargarHorario(ctx, cod);
    if (!m.size) continue;
    const ult = ultimaMedida(m);
    const primera = [...m.entries()].filter(([, v]) => v.med != null).map(([h]) => h).sort()[0];
    if (ult && ahora - parseLocal(ult) > 6 * 3600e3) {
      if (await alerta(ctx, `${cod} ${NOMBRES[cod]}: sin medidas desde ${ult} (hace más de 6 h)`)) faltas++;
    }
    for (let k = 0; k <= dias; k++) {
      const d = new Date(ahora.getTime() - k * 86400e3).toISOString().slice(0, 10);
      const esperadas = [];
      for (let h = 0; h < 24; h++) {
        const hh = `${d}T${p2(h)}`;
        if (d === hoy && hh > isoLocal(new Date(ahora.getTime() - 2 * 3600e3)).slice(0, 13)) continue; // hoy: hasta 2 h antes
        if (primera && `${hh}:45` < primera) continue; // antes de empezar a guardar
        esperadas.push(`${hh}:45`);
      }
      const sin = esperadas.filter((h) => m.get(h)?.med == null);
      if (sin.length) {
        const horas = sin.map((h) => h.slice(11, 13)).join(',');
        if (await alerta(ctx, `${cod} ${NOMBRES[cod]} ${d}: faltan ${sin.length} de ${esperadas.length} horas (${horas})`)) faltas++;
      }
    }
  }
  if (!o.silencioso || faltas) publico(ctx, `chequeo: ${faltas} alertas nuevas`);
  return { faltas };
}

// ---------- modelo ----------
export function parseSvg(svg) {
  const valores = [...svg.matchAll(/<desc class="value">([^<]*)<\/desc>/g)].map((x) => x[1]);
  const etiquetas = [...svg.matchAll(/<desc class="x_label">([^<]*)<\/desc>/g)].map((x) => x[1]);
  return { valores, etiquetas };
}
export async function modoModelo(ctx) {
  let nuevos = 0, fallas = 0;
  for (const [puerto, archivo] of Object.entries(PUERTOS_MODELO)) {
    try {
      const { cuerpo, headers } = await pedir(ctx, URL_SVG + archivo);
      const lm = headers['last-modified'] ? new Date(headers['last-modified']) : null; // GMT: hora de la corrida publicada
      const corrida = lm && !isNaN(lm) ? lm.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_') + 'Z' : 'sinfecha_' + stampLocal(ctx.ahoraLocal());
      const { valores, etiquetas } = parseSvg(cuerpo);
      if (valores.length !== 97) await alerta(ctx, `modelo ${puerto}: el SVG trae ${valores.length} valores en vez de 97`);
      const kSvg = `modelo/svg/${puerto}_${corrida}.svg`;
      if (!(await ctx.almacen.escribir(kSvg, cuerpo, { soloSiNoExiste: true }))) { log(ctx, `modelo ${puerto}: corrida ${corrida} ya guardada`); continue; }
      const titulo = (cuerpo.match(/<title[^>]*>([^<]*)/) || [])[1]?.replace(/\s+/g, ' ').trim();
      agregarPendiente(ctx, `modelo/valores/${puerto}.jsonl`, JSON.stringify({
        corrida_gmt: lm && !isNaN(lm) ? lm.toISOString() : null, bajado: new Date(ctx.ahora()).toISOString(), anio_descarga: ctx.ahoraLocal().getUTCFullYear(),
        titulo, n: valores.length, etiquetas, valores: valores.map(Number),
      }) + '\n');
      nuevos++;
      log(ctx, `modelo ${puerto}: corrida ${corrida}, ${valores.length} valores, ${etiquetas[0]} -> ${etiquetas.at(-1)}`);
    } catch (e) {
      if (e instanceof Bloqueo) throw e;
      fallas++;
      publico(ctx, `modelo ${puerto} FALLO: ${e.message}`);
      await alerta(ctx, `modelo ${puerto}: no se pudo bajar (${e.message.slice(0, 120)})`);
    }
  }
  publico(ctx, `modelo: ${nuevos} corridas nuevas, ${fallas} fallas`);
  return { nuevos, fallas };
}

// ---------- pronóstico y avisos ----------
export function aTexto(html) {
  let t = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<\/(tr|p|div|h\d|li|br)>|<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&([aeiou])acute;/g, (_, v) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' }[v])).replace(/&ntilde;/g, 'ñ').replace(/&Ntilde;/g, 'Ñ');
  t = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  const mm = t.match(/Compartir en\s+redes sociales/);
  return mm ? t.slice(mm.index + mm[0].length).trim() : t;
}
export async function modoPronostico(ctx) {
  const kIdx = 'pronostico/indice.csv';
  let idx = (await leerTexto(ctx, kIdx)) || 'bajado_local;tipo;sha1_texto;archivo_html;cambio\n';
  const previo = idx.trim().split('\n').slice(1).map((l) => l.split(';'));
  let cambios = 0, fallas = 0;
  try {
    for (const [tipo, url] of [['pronostico', URL_PRONO], ['aviso', URL_AVISO]]) {
      try {
        const { cuerpo } = await pedir(ctx, url);
        const texto = aTexto(cuerpo);
        const sha = crypto.createHash('sha1').update(texto).digest('hex').slice(0, 12);
        const base = `${stampLocal(ctx.ahoraLocal())}_${tipo}`;
        const ultimo = previo.filter((r) => r[1] === tipo).at(-1);
        const cambio = !ultimo || ultimo[2] !== sha;
        // siempre guarda el crudo y el texto: el índice marca cuándo cambió el contenido
        await ctx.almacen.escribir(`pronostico/${base}.html`, cuerpo);
        await ctx.almacen.escribir(`pronostico/${base}.txt`, texto + '\n');
        const fila = [isoLocal(ctx.ahoraLocal()), tipo, sha, base + '.html', cambio ? 'si' : 'no'];
        idx += fila.join(';') + '\n';
        previo.push(fila);
        if (cambio) cambios++;
        publico(ctx, `${tipo}: ${texto.length} caracteres, cambio=${cambio}`);
        if (texto.length < 200) await alerta(ctx, `${tipo}: texto muy corto (${texto.length} caracteres), puede haber cambiado la página`);
      } catch (e) {
        if (e instanceof Bloqueo) throw e;
        fallas++;
        publico(ctx, `${tipo} FALLO: ${e.message}`);
        await alerta(ctx, `${tipo}: no se pudo bajar (${e.message.slice(0, 120)})`);
      }
    }
  } finally {
    await ctx.almacen.escribir(kIdx, idx);
  }
  return { cambios, fallas };
}

// ---------- referencia (nivel cero, desde la tabla de marea del mes) ----------
export async function modoReferencia(ctx) {
  const kf = 'referencia/nivel_cero.csv';
  let csv = (await leerTexto(ctx, kf)) || 'bajado_local;estacion_api;codigo_tabla;nivel_medio_m;plano_reduccion_m_bajo_nivel_medio;texto_plano\n';
  const ahora = ctx.ahoraLocal();
  let ok = 0, fallas = 0;
  try {
    for (const cod of ESTACIONES) {
      try {
        const { cuerpo } = await pedir(ctx, URL_TABLA, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `FAnio=${ahora.getUTCFullYear()}&Localidad=${COD_TABLA[cod]}&FMes=${ahora.getUTCMonth() + 1}`,
        });
        const t = aTexto(cuerpo).replace(/\s+/g, ' ');
        const nm = (t.match(/Nivel medio:\s*([\d.,]+)\s*m/i) || [])[1];
        const pl = t.match(/referidas? al plano de reducci[oó]n[^.]*?([\d.,]+)\s*m\s*(debajo|arriba|sobre|por encima)[^.]*\./i);
        const txtPlano = (t.match(/Las alturas est[aá]n referidas[^.]*\./i) || [''])[0];
        csv += `${isoLocal(ahora)};${cod};${COD_TABLA[cod]};${nm ? nm.replace(',', '.') : ''};${pl ? pl[1].replace(',', '.') : ''};${txtPlano.replace(/;/g, ',')}\n`;
        await ctx.almacen.escribir(`referencia/tabla_${cod}_${ahora.getUTCFullYear()}${p2(ahora.getUTCMonth() + 1)}.html`, cuerpo);
        ok++;
        log(ctx, `referencia ${cod}: nivel medio ${nm}, plano ${pl ? pl[1] : '?'}`);
      } catch (e) {
        if (e instanceof Bloqueo) throw e;
        fallas++;
        publico(ctx, `referencia ${cod} FALLO: ${e.message}`);
      }
    }
  } finally {
    await ctx.almacen.escribir(kf, csv);
  }
  publico(ctx, `referencia: ${ok} estaciones registradas, ${fallas} fallas`);
  return { ok, fallas };
}

export const MODOS = { horario: modoHorario, modelo: modoModelo, pronostico: modoPronostico, referencia: modoReferencia, chequeo: modoChequeo };
const PIDE_AL_SHN = new Set(['horario', 'modelo', 'pronostico', 'referencia']);

// Corrida completa: bloqueo vigente -> candado -> modo -> vaciar -> soltar candado.
// Devuelve el código de salida: 0 bien, 1 error o bloqueo, 3 candado ocupado.
export async function correr(ctx, modo, o = {}) {
  const t0 = ctx.ahora();
  if (PIDE_AL_SHN.has(modo) && !o.forzar) {
    const b = await bloqueoVigente(ctx);
    if (b) {
      publico(ctx, `${modo}: hay un bloqueo anotado (HTTP ${b.status}) hasta ${b.hasta.slice(0, 16)}Z; no se pide nada (forzar a mano si hace falta)`);
      await vaciar(ctx);
      return 0;
    }
  }
  const c = await tomarCandado(ctx);
  if (!c.ok) {
    publico(ctx, `${modo}: hay otra corrida en curso (candado de la corrida ${c.actual?.corrida ?? '?'}, vence ${c.actual?.vence?.slice(0, 16) ?? '?'}Z); no se hace nada`);
    return 3;
  }
  let codigo = 0;
  log(ctx, `inicio ${modo} (corrida ${ctx.corrida})`);
  try {
    if (o.forzar && PIDE_AL_SHN.has(modo)) await ctx.almacen.borrar(K.bloqueo);
    await MODOS[modo](ctx, o);
  } catch (e) {
    codigo = 1;
    if (e instanceof Bloqueo) {
      publico(ctx, `${modo}: el SHN contestó ${e.message}; se anota en alertas.txt y se corta la corrida`);
      await anotarBloqueo(ctx, e, modo);
    } else {
      publico(ctx, `ERROR ${modo}: ${e.message}`);
      log(ctx, e.stack || String(e));
    }
  } finally {
    publico(ctx, `fin ${modo}: ${ctx.pedidos} pedidos al SHN en ${Math.round((ctx.ahora() - t0) / 1000)} s, ${ctx.alertasNuevas} alertas nuevas`);
    try { await vaciar(ctx); } catch (e) { ctx.salida(`no se pudo escribir el log/crudos: ${e.message}`); codigo = 1; }
    await soltarCandado(ctx);
  }
  return codigo;
}
