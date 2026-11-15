// HN AGRO · rayos-hora → el DERIVADO PÚBLICO para SATCHI [_v1815 · 15/11/2026 · la 262, camino «c» de local].
// Los rayos GLM son datos públicos de NOAA: además de la caché privada (rayos-hora/AAAA/MM/DD/HH.json), cada hora se copia,
// liviana, al depósito PÚBLICO de SATCHI (satchi-mapas, con los secretos R2_OPERA_* de opera-mosaico-diario):
//   rayos/AAAA-MM-DD/HH.json  → { v, hora, estado, satelite, faltantes, n, columnas, flashes } (t_ms, lat, lon, energia_fJ, calidad)
//   rayos/indice.json         → { v, actualizado, horas: { 'AAAA-MM-DDTHHZ': 'completa' | 'incompleta' } }
// Lo lee hn-agro netlify/functions/lib/rayos-vs-foco.mjs (por https, sin llaves). Una hora que NO está en el índice es
// «sin dato» para esa hora, nunca «no hubo rayos». Una incompleta lleva sus `faltantes` (casilleros de 20 s sin leer).
// Indicio, nunca causa.
export const PREFIJO_PUB = 'rayos/';
export const INDICE_PUB = PREFIJO_PUB + 'indice.json';
export const DEPOSITO_PUB = 'satchi-mapas';
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

/** PURA. El documento privado de una hora → el derivado público (sin área ni metadatos de la corrida). null si no sirve. */
export function derivar(doc) {
  if (!doc || doc.v !== 1 || !Array.isArray(doc.flashes) || !Array.isArray(doc.columnas)) return null;
  if (doc.estado !== 'completa' && doc.estado !== 'incompleta') return null;
  const c = doc.columnas, iT = c.indexOf('t_ms'), iLa = c.indexOf('lat'), iLo = c.indexOf('lon'), iE = c.indexOf('energia_fJ'), iQ = c.indexOf('calidad');
  if (iT < 0 || iLa < 0 || iLo < 0) return null;
  const flashes = doc.flashes.map((f) => [f[iT], f[iLa], f[iLo], iE >= 0 ? f[iE] : null, iQ >= 0 ? f[iQ] : null]);
  return {
    v: 1,
    hora: doc.hora,
    estado: doc.estado,
    satelite: doc.satelite || null,
    faltantes: Array.isArray(doc.faltantes) ? doc.faltantes : [],
    n: flashes.length,
    columnas: ['t_ms', 'lat', 'lon', 'energia_fJ', 'calidad'],
    flashes,
    fuente: 'GLM-L2-LCFA (NOAA, GOES) · recorte a la Argentina de HN AGRO (rayos-hora)',
    nota: doc.estado === 'completa' ? 'Hora completa.' : 'Hora INCOMPLETA: en los casilleros de `faltantes` no se sabe nada (no es «sin rayos»).',
  };
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
  const res = { privadas: 0, copiadas: 0, ya: 0, ilegibles: 0 };
  let idx = { v: 1, horas: {} };
  const b = await publico.leer(INDICE_PUB);
  if (b) { try { const j = JSON.parse(b.toString('utf8')); if (j && j.horas && typeof j.horas === 'object') idx = { v: 1, horas: j.horas }; } catch { /* ilegible: se rehace */ } }
  const horas = [];
  for (const d of diasEntre(desdeMs, hastaMs)) for (const k of await privado.listar(prefijoDiaPrivado(d))) {
    const h = horaDeClavePrivada(k); if (h != null && h >= desdeMs && h <= hastaMs) horas.push([h, k]);
  }
  horas.sort((a, b) => a[0] - b[0]);
  res.privadas = horas.length;
  let cambio = false, error = null;
  try {
    for (const [h, k] of horas) {
      let doc = null;
      try { doc = JSON.parse((await privado.leer(k)).toString('utf8')); } catch { doc = null; }
      const pub = derivar(doc);
      if (!pub || Date.parse(pub.hora) !== h) { res.ilegibles++; continue; }
      const marca = marcaIndice(h);
      if (idx.horas[marca] === pub.estado) { res.ya++; continue; }
      await publico.escribir(clavePublica(h), JSON.stringify(pub), { tipo: 'application/json', cache: pub.estado === 'completa' ? CACHE_COMPLETA : CACHE_INCOMPLETA });
      idx.horas[marca] = pub.estado; cambio = true; res.copiadas++;
    }
  } catch (e) { error = e; }
  if (cambio) {
    const orden = Object.keys(idx.horas).sort();
    const horasOrd = {}; orden.forEach((m) => { horasOrd[m] = idx.horas[m]; });
    await publico.escribir(INDICE_PUB, JSON.stringify({ v: 1, actualizado: new Date(ahoraMs).toISOString(), desde: orden[0] || null, hasta: orden[orden.length - 1] || null, horas: horasOrd }),
      { tipo: 'application/json', cache: CACHE_INDICE });
  }
  log(`público: ${res.copiadas} horas copiadas, ${res.ya} ya estaban, ${res.ilegibles} ilegibles (de ${res.privadas} privadas)`);
  if (error) throw error;
  return res;
}
export { HORA };
