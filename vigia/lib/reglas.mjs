// HN AGRO · vigía de SATCHI · LAS REGLAS (puras: sin red, sin base, sin reloj propio).
// Las reglas son las de SATCHI, no unas nuevas:
//   · nivel de una escala (lo calcula satchi-ina de hn-agro: 1 evacuación · 2 alerta · 4 normal; null = lectura vieja);
//   · «foco de calor grande» = la regla del cartel «zonas con mucho calor» (focos-litoral.js de hn-agro, `grandes`
//     de ?que=focos&zona=pais: un grupo de FIRMS de 30 o más o de GOES de 4 o más). Acá NO se recalcula: se usa lo que
//     manda SATCHI y sólo se vuelve a mirar el umbral que viene en `regla_grande`, como control.
// El vigía sólo decide CUÁNDO avisar: lo que es nuevo respecto de lo ya avisado (el estado).

export const PRONO_HORAS = 72;
export const FOCO_RADIO_KM = 15;        // un grande a ≤ 15 km de uno ya avisado en las últimas 24 h es el mismo
export const FOCO_VIGENCIA_H = 24;

export function kmEntre(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}
const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/* ── CRECIDAS ─────────────────────────────────────────────────────────────────────────────────────── */
/** Las escalas en evacuación hoy (nivel 1 de SATCHI, con lectura de hoy o ayer). */
export function escalasEnEvacuacion(escalasJson) {
  const L = (escalasJson && escalasJson.parana && Array.isArray(escalasJson.parana.escalas)) ? escalasJson.parana.escalas : [];
  return L.filter((e) => e && e.nivel === 1 && typeof e.h === 'number' && typeof e.evacuacion_m === 'number')
    .map((e) => ({ clave: 'escala:' + e.id + ':evacuacion', tipo: 'crecida', id: e.id, nombre: e.nombre, provincia: e.provincia,
      rio: e.rio, h: e.h, evacuacion_m: e.evacuacion_m, alerta_m: e.alerta_m, fecha: e.fecha, url: e.url }));
}
/** Las escalas con lectura reciente que NO están en evacuación (para «rearmar» el aviso cuando bajan). */
export function escalasFueraDeEvacuacion(escalasJson) {
  const L = (escalasJson && escalasJson.parana && Array.isArray(escalasJson.parana.escalas)) ? escalasJson.parana.escalas : [];
  return L.filter((e) => e && (e.nivel === 2 || e.nivel === 4)).map((e) => 'escala:' + e.id + ':evacuacion');
}
/** Las ciudades cuyo pronóstico del INA cruza la cota de evacuación en las próximas 72 h (con la altura central),
 *  y que HOY no están en evacuación. La cota sale de la escala del mismo nombre; sin escala, no se puede decir. */
export function pronosticoQueCruza(pronoJson, escalasJson, ahoraMs, horas = PRONO_HORAS) {
  const E = (escalasJson && escalasJson.parana && escalasJson.parana.escalas) || [];
  const porNombre = new Map(E.map((e) => [sinTildes(e.nombre), e]));
  const out = [];
  for (const c of (pronoJson && pronoJson.ciudades) || []) {
    const e = porNombre.get(sinTildes(c.nombre));
    if (!e || typeof e.evacuacion_m !== 'number' || e.nivel === 1 || e.nivel == null) continue;   // sin cota o sin lectura de hoy: nada
    const hasta = ahoraMs + horas * 3600e3;
    const cruza = (c.puntos || []).filter((p) => p && typeof p.h === 'number' && Date.parse(p.t) >= ahoraMs && Date.parse(p.t) <= hasta && p.h >= e.evacuacion_m);
    if (!cruza.length) continue;
    out.push({ clave: 'prono:' + e.id + ':evacuacion72', tipo: 'crecida_pronostico', id: e.id, nombre: e.nombre, provincia: e.provincia,
      h_hoy: e.h, evacuacion_m: e.evacuacion_m, cuando: cruza[0].t, h_max: Math.max(...cruza.map((p) => p.h)), emitido: c.emitido });
  }
  return out;
}
export function pronosticoQueNoCruza(pronoJson, escalasJson, ahoraMs) {
  const si = new Set(pronosticoQueCruza(pronoJson, escalasJson, ahoraMs).map((x) => x.clave));
  const E = (escalasJson && escalasJson.parana && escalasJson.parana.escalas) || [];
  const porNombre = new Map(E.map((e) => [sinTildes(e.nombre), e]));
  return ((pronoJson && pronoJson.ciudades) || []).map((c) => porNombre.get(sinTildes(c.nombre))).filter(Boolean)
    .map((e) => 'prono:' + e.id + ':evacuacion72').filter((k) => !si.has(k));
}

/* ── FOCOS DE CALOR ───────────────────────────────────────────────────────────────────────────────── */
/** Los focos grandes de las provincias elegidas (vacío = todas), con el control del umbral de SATCHI. */
export function focosGrandes(focosJson, provincias = []) {
  const R = (focosJson && focosJson.regla_grande) || { firms_n: 30, goes_n: 4 };
  const P = new Set(provincias.map(sinTildes).filter(Boolean));
  return ((focosJson && focosJson.grandes) || [])
    .filter((g) => g && typeof g.lat === 'number' && typeof g.lon === 'number')
    .filter((g) => (g.firms_n || 0) >= R.firms_n || (g.goes_n || 0) >= R.goes_n)
    .filter((g) => !P.size || P.has(sinTildes(g.provincia)))
    .map((g) => ({ clave: 'foco:' + sinTildes(g.provincia).replace(/\s+/g, '-') + ':' + g.lat.toFixed(1) + ':' + g.lon.toFixed(1), tipo: 'foco',
      provincia: g.provincia, lat: g.lat, lon: g.lon, firms_n: g.firms_n || 0, goes_n: g.goes_n || 0, goes_area_ha: g.goes_area_ha || 0,
      extension_km: g.extension_km, ultima_firms_utc: g.ultima_firms_utc || null, por: g.por }));
}

/* ── QUÉ ES NUEVO ─────────────────────────────────────────────────────────────────────────────────── */
/**
 * @param candidatos  lo que cruza el umbral hoy
 * @param estado      Map clave → { activo, ultimo_aviso (ISO), detalle } (lo que ya se avisó)
 * Crecidas: se avisa si no hay un aviso ACTIVO de esa clave (se rearma cuando la escala vuelve a alerta/normal).
 * Focos: se avisa si no hay un foco avisado a ≤ 15 km en las últimas 24 h.
 */
export function nuevos(candidatos, estado, ahoraMs) {
  const out = [];
  const focosRecientes = [...estado.values()].filter((v) => v && v.tipo === 'foco' && v.ultimo_aviso && ahoraMs - Date.parse(v.ultimo_aviso) < FOCO_VIGENCIA_H * 3600e3 && v.detalle);
  for (const c of candidatos) {
    if (c.tipo === 'foco') {
      const visto = focosRecientes.some((v) => kmEntre(c.lat, c.lon, v.detalle.lat, v.detalle.lon) <= FOCO_RADIO_KM)
        || out.some((o) => o.tipo === 'foco' && kmEntre(c.lat, c.lon, o.lat, o.lon) <= FOCO_RADIO_KM);
      if (!visto) out.push(c);
    } else {
      const v = estado.get(c.clave);
      if (!v || !v.activo) out.push(c);
    }
  }
  return out;
}

/* ── EL TEXTO DEL MAIL ────────────────────────────────────────────────────────────────────────────── */
const coma = (x, d = 2) => (typeof x === 'number' ? x.toFixed(d).replace('.', ',') : '—');
export function textoDe(avisos, { prueba = true, ahoraMs } = {}) {
  const hora = new Date(ahoraMs - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' (hora argentina)';
  const L = [];
  const cre = avisos.filter((a) => a.tipo === 'crecida'), pro = avisos.filter((a) => a.tipo === 'crecida_pronostico'), foc = avisos.filter((a) => a.tipo === 'foco');
  if (cre.length) {
    L.push('CRECIDAS · escalas en EVACUACIÓN (INA / Prefectura):');
    for (const a of cre) L.push('  · ' + a.nombre + ' (' + (a.provincia || '') + '): ' + coma(a.h) + ' m, la cota de evacuación es ' + coma(a.evacuacion_m) + ' m. Lectura del ' + a.fecha + '. ' + (a.url || ''));
    L.push('');
  }
  if (pro.length) {
    L.push('CRECIDAS · el pronóstico del INA (fase experimental) cruza la cota de evacuación en las próximas 72 h:');
    for (const a of pro) L.push('  · ' + a.nombre + ': hoy ' + coma(a.h_hoy) + ' m; llega a ' + coma(a.h_max) + ' m (evacuación ' + coma(a.evacuacion_m) + ' m) desde el ' + String(a.cuando).slice(0, 16).replace('T', ' ') + ' UTC.');
    L.push('');
  }
  if (foc.length) {
    L.push('FOCOS DE CALOR GRANDES (la regla del cartel de SATCHI; un foco de calor puede ser un incendio, una quema, una chimenea…):');
    for (const a of foc) L.push('  · ' + a.provincia + ' · ' + coma(a.lat, 3) + ', ' + coma(a.lon, 3) + ': ' + a.firms_n + ' detecciones FIRMS' + (a.goes_n ? ', ' + a.goes_n + (a.goes_n === 1 ? ' píxel' : ' píxeles') + ' GOES (' + coma(a.goes_area_ha, 1) + ' ha)' : '') + (a.extension_km != null ? ', ' + coma(a.extension_km, 1) + ' km de largo' : '') + '. https://www.google.com/maps?q=' + a.lat + ',' + a.lon);
    L.push('');
  }
  L.push('Visto por el vigía de SATCHI el ' + hora + '. Son señales observadas: confirmalo en https://app.hnagroapp.com/satchi/ antes de actuar.');
  if (prueba) L.push('MODO PRUEBA: este aviso va sólo al equipo de HN AGRO.');
  const asunto = (prueba ? '[SATCHI vigía · prueba] ' : '[SATCHI vigía] ') + [cre.length ? cre.length + ' escala' + (cre.length > 1 ? 's' : '') + ' en evacuación' : null,
    pro.length ? pro.length + ' pronóstico' + (pro.length > 1 ? 's' : '') + ' de evacuación' : null, foc.length ? foc.length + ' foco' + (foc.length > 1 ? 's' : '') + ' de calor grande' + (foc.length > 1 ? 's' : '') : null].filter(Boolean).join(' · ');
  return { asunto, cuerpo: L.join('\n') };
}
