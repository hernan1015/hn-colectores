// HN AGRO · rayos-hora → el DERIVADO PÚBLICO para SATCHI [_v1815 · 15/11/2026 · la 262, camino «c» de local].
// Los rayos GLM son datos públicos de NOAA: además de la caché privada (rayos-hora/AAAA/MM/DD/HH.json), cada hora se copia,
// liviana, al depósito PÚBLICO de SATCHI (satchi-mapas, con los secretos R2_OPERA_* de opera-mosaico-diario):
//   rayos/AAAA-MM-DD/HH.json  → { v, hora, estado, satelite, faltantes, n, columnas, flashes } (t_ms, lat, lon, energia_fJ, calidad)
//   rayos/indice.json         → { v, actualizado, horas: { 'AAAA-MM-DDTHHZ': 'completa' | 'incompleta' } }
// Lo lee hn-agro netlify/functions/lib/rayos-vs-foco.mjs (por https, sin llaves). Una hora que NO está en el índice es
// «sin dato» para esa hora, nunca «no hubo rayos». Una incompleta lleva sus `faltantes` (casilleros de 20 s sin leer).
// [2.ª vuelta · Codex n3-262-1511] NUNCA se escribe `faltantes: []` sin saberlo: si el documento privado no trae una lista
// válida para su estado (incompleta sin faltantes, completa con faltantes, casilleros mal formados), la hora sale con
// estado «desconocido» y `faltantes: null` (hn-agro la toma como «sin dato» para esa hora, sin pedirla).
// [2.ª vuelta · n3 §3] cada hora lleva su `firma` (del contenido) y el índice la repite en `firmas`: una incompleta que
// suma flashes sin cambiar de estado se vuelve a copiar, y hn-agro no la confunde con la versión vieja.
// Indicio, nunca causa.
import { createHash } from 'node:crypto';
export const PREFIJO_PUB = 'rayos/';
export const INDICE_PUB = PREFIJO_PUB + 'indice.json';
export const DEPOSITO_PUB = 'satchi-rayos'; // 16/11: depósito propio y público SÓLO de rayos (satchi-mapas guarda estaciones-internas, no se abre)
export const CACHE_COMPLETA = 'public, max-age=86400', CACHE_INCOMPLETA = 'public, max-age=900', CACHE_INDICE = 'public, max-age=300';
const HORA = 3600000;
const pad = (n) => String(n).padStart(2, '0');

/** La clave pública de la hora que empieza en ms (UTC) */
export function clavePublica(horaMs) {
  const d = new Date(horaMs);
  return `${PREFIJO_PUB}${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}/${pad(d.getUTCHours())}.json`;
}
/** La marca de la hora en el índice: AAAA-MM-DDTHHZ */
export const marcaIndice = (horaMs) => new Date(horaMs).toISOString().slice(0, 13) + 'Z';
/** De la clave privada (rayos-hora/AAAA/MM/DD/HH.json) a la hora en ms; null si no es una hora */
export function horaDeClavePrivada(k) {
  const m = /^rayos-hora\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\.json$/.exec(k);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : null;
}

/* un casillero de 20 s: «MM:SS», MM 00–59 y SS 00, 20 o 40 (lo que escribe lib/cache.mjs) */
const CASILLERO_RE = /^([0-5]\d):(00|20|40)$/;
/** PURA. [2.ª vuelta] La lista de faltantes, validada para su estado; null si no se sabe qué falta. */
export function faltantesValidos(estado, faltantes) {
  if (!Array.isArray(faltantes) || faltantes.some((s) => typeof s !== 'string' || !CASILLERO_RE.test(s))) return null;
  const u = Array.from(new Set(faltantes));
  if (estado === 'completa') return u.length === 0 ? u : null;
  if (estado === 'incompleta') return u.length > 0 ? u : null;
  return null;
}
/** PURA. La firma del contenido de una hora (estado, faltantes y flashes): 16 hex de sha256 */
export function firmaDe(estado, faltantes, flashes) {
  return createHash('sha256').update(JSON.stringify([estado, faltantes, flashes])).digest('hex').slice(0, 16);
}
/** PURA. El documento privado de una hora → el derivado público (sin área ni metadatos de la corrida). null si no sirve. */
export function derivar(doc) {
  if (!doc || doc.v !== 1 || !Array.isArray(doc.flashes) || !Array.isArray(doc.columnas)) return null;
  if (doc.estado !== 'completa' && doc.estado !== 'incompleta') return null;
  const c = doc.columnas, iT = c.indexOf('t_ms'), iLa = c.indexOf('lat'), iLo = c.indexOf('lon'), iE = c.indexOf('energia_fJ'), iQ = c.indexOf('calidad');
  if (iT < 0 || iLa < 0 || iLo < 0) return null;
  const flashes = doc.flashes.map((f) => (Array.isArray(f) ? [f[iT], f[iLa], f[iLo], iE >= 0 ? f[iE] : null, iQ >= 0 ? f[iQ] : null] : null));
  /* [2.ª vuelta] el estado VERDADERO: si la lista de faltantes no cierra con el estado, no se sabe qué falta → «desconocido» */
  const fal = faltantesValidos(doc.estado, doc.faltantes);
  const estado = fal ? doc.estado : 'desconocido';
  return {
    v: 1,
    hora: doc.hora,
    estado,
    satelite: doc.satelite || null,
    faltantes: fal,
    n: flashes.length,
    columnas: ['t_ms', 'lat', 'lon', 'energia_fJ', 'calidad'],
    flashes,
    firma: firmaDe(estado, fal, flashes),
    fuente: 'GLM-L2-LCFA (NOAA, GOES) · recorte a la Argentina de HN AGRO (rayos-hora)',
    nota: estado === 'completa' ? 'Hora completa.'
      : estado === 'incompleta' ? 'Hora INCOMPLETA: en los casilleros de `faltantes` no se sabe nada (no es «sin rayos»).'
        : 'Hora DESCONOCIDA: no se sabe qué casilleros faltan; toda la hora es «sin dato» (no es «sin rayos»).',
  };
}
/**
 * PURA. [3.ª vuelta · 16/11, datos reales: 64 de 73 horas salían «filas_ilegibles»] Cada flash a SU hora.
 * Un archivo GLM que empieza en la hora h puede traer flashes de unos ms ANTES (t_ms negativo) y, en el otro borde, de la
 * hora siguiente (t_ms ≥ 3.600.000). El lector de hn-agro es estricto (bien): una fila fuera de [0, HORA) descarta la hora
 * entera. Acá se arregla el DATO: lo que cae antes va a la hora anterior y lo que cae después a la siguiente, con t_ms
 * corrido; si esa hora no está, se descarta y se cuenta (`fuera`). Un mismo flash repetido en las dos horas no se duplica.
 * pubs: Map<horaMs, derivado> (lo modifica: flashes, n y firma). Devuelve { movidos, fuera }.
 * Determinístico: el resultado de una hora depende sólo de ella y de sus dos vecinas, así que corridas con rangos
 * distintos dan la misma firma (cada corrida lee también la hora anterior y la siguiente del rango).
 */
export function repartirFlashes(pubs) {
  const res = { movidos: 0, fuera: 0 };
  const llega = new Map();   // horaMs → flashes que le llegan de las vecinas (ya con t_ms corrido)
  const propias = new Map();
  for (const [h, pub] of pubs) {
    const quedan = [];
    for (const f of pub.flashes) {
      const t = Array.isArray(f) ? f[0] : null;
      if (typeof t !== 'number' || !Number.isFinite(t) || (t >= 0 && t < HORA)) { quedan.push(f); continue; }   // ilegible: se deja (el lector lo ve)
      const destino = t < 0 ? h - HORA * Math.ceil(-t / HORA) : h + HORA * Math.floor(t / HORA);
      const f2 = [t - (destino - h), ...f.slice(1)];
      if (!pubs.has(destino)) { res.fuera++; continue; }
      if (!llega.has(destino)) llega.set(destino, []);
      llega.get(destino).push(f2); res.movidos++;
    }
    propias.set(h, quedan);
  }
  for (const [h, pub] of pubs) {
    const visto = new Set(), todos = [];
    for (const f of [...propias.get(h), ...(llega.get(h) || [])]) { const k = JSON.stringify(f); if (!visto.has(k)) { visto.add(k); todos.push(f); } }
    todos.sort((a, b) => (Array.isArray(a) && Array.isArray(b) && typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : 0));
    pub.flashes = todos; pub.n = todos.length; pub.firma = firmaDe(pub.estado, pub.faltantes, todos);
  }
  return res;
}
/** PURA. [2.ª vuelta · n3] El texto de un error para la consola: sin URLs (pueden llevar firmas) ni tiras largas que parezcan llaves. */
export function textoError(e) {
  return String((e && e.message) || e).replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9+/=_-]{24,}/g, '[…]').slice(0, 200);
}

const diasEntre = (h0, h1) => { const out = []; for (let d = Math.floor(h0 / 86400000) * 86400000; d <= h1; d += 86400000) out.push(d); return out; };
const prefijoDiaPrivado = (ms) => { const d = new Date(ms); return `rayos-hora/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`; };

/**
 * Copia al depósito público las horas privadas de [desdeMs, hastaMs] que el índice público no tiene (o tiene con otro
 * estado: una incompleta que después se completó). Sirve para la corrida de cada hora (últimas 48 h) y para el relleno
 * de una vez (desde el 08/11). Idempotente. Devuelve sólo cantidades.
 * Una falla al ESCRIBIR en el público tira error (la corrida queda en rojo); el índice se escribe con lo que sí se copió.
 */
export async function copiarAPublico({ privado, publico, desdeMs, hastaMs, ahoraMs = Date.now(), log = () => {} }) {
  const res = { privadas: 0, copiadas: 0, ya: 0, ilegibles: 0, movidos: 0, fuera: 0 };
  let idx = { v: 1, horas: {}, firmas: {} };
  const b = await publico.leer(INDICE_PUB);
  if (b) { try { const j = JSON.parse(b.toString('utf8')); if (j && j.horas && typeof j.horas === 'object') idx = { v: 1, horas: j.horas, firmas: j.firmas && typeof j.firmas === 'object' && !Array.isArray(j.firmas) ? j.firmas : {} }; } catch { /* ilegible: se rehace */ } }
  /* [3.ª vuelta] se leen también la hora anterior y la siguiente del rango (para repartir los flashes de los bordes),
   * pero sólo se escriben las del rango */
  const lee0 = desdeMs - HORA, lee1 = hastaMs + HORA;
  const horas = [];
  for (const d of diasEntre(lee0, lee1)) for (const k of await privado.listar(prefijoDiaPrivado(d))) {
    const h = horaDeClavePrivada(k); if (h != null && h >= lee0 && h <= lee1) horas.push([h, k]);
  }
  horas.sort((a, b) => a[0] - b[0]);
  res.privadas = horas.filter(([h]) => h >= desdeMs && h <= hastaMs).length;
  const pubs = new Map();
  for (const [h, k] of horas) {
    let doc = null;
    try { doc = JSON.parse((await privado.leer(k)).toString('utf8')); } catch { doc = null; }
    const pub = derivar(doc);
    if (!pub || Date.parse(pub.hora) !== h) { if (h >= desdeMs && h <= hastaMs) res.ilegibles++; continue; }
    pubs.set(h, pub);
  }
  const rep = repartirFlashes(pubs); res.movidos = rep.movidos; res.fuera = rep.fuera;
  let cambio = false, error = null;
  try {
    for (const [h, pub] of pubs) {
      if (h < desdeMs || h > hastaMs) continue;
      const marca = marcaIndice(h);
      /* [2.ª vuelta · n3 §3] ya está sólo si coinciden el estado Y la firma (una incompleta puede cambiar sin cambiar de estado) */
      if (idx.horas[marca] === pub.estado && idx.firmas[marca] === pub.firma) { res.ya++; continue; }
      await publico.escribir(clavePublica(h), JSON.stringify(pub), { tipo: 'application/json', cache: pub.estado === 'completa' ? CACHE_COMPLETA : CACHE_INCOMPLETA });
      idx.horas[marca] = pub.estado; idx.firmas[marca] = pub.firma; cambio = true; res.copiadas++;
      if (pub.estado === 'desconocido') res.desconocidas = (res.desconocidas || 0) + 1;
    }
  } catch (e) { error = e; }
  if (cambio) {
    const orden = Object.keys(idx.horas).sort();
    const horasOrd = {}, firmasOrd = {}; orden.forEach((m) => { horasOrd[m] = idx.horas[m]; if (idx.firmas[m]) firmasOrd[m] = idx.firmas[m]; });
    await publico.escribir(INDICE_PUB, JSON.stringify({ v: 1, actualizado: new Date(ahoraMs).toISOString(), desde: orden[0] || null, hasta: orden[orden.length - 1] || null, horas: horasOrd, firmas: firmasOrd }),
      { tipo: 'application/json', cache: CACHE_INDICE });
  }
  log(`público: ${res.copiadas} horas copiadas, ${res.ya} ya estaban, ${res.ilegibles} ilegibles (de ${res.privadas} privadas); ${res.movidos} flashes a su hora, ${res.fuera} de borde sin su hora`);
  if (error) throw error;
  return res;
}
export { HORA };
