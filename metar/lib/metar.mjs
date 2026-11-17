// HN AGRO · metar · el PARSER del METAR/SPECI, centrado en el granizo (317).
// La idea de usar los METAR con GR como verdad de campo es de familygw/chusmeteo (MIT, © sus autores), vista en el estudio
// de la 315 (hn-cortex/docs/satchi-granizo-2026-11/315-ESTUDIO-CODIGO-ABIERTO.md). Este código es propio: no se copió nada de chusmeteo.
//
// Las reglas del formato (las que importan acá):
//   · OMM, Manual de claves (WMO-No. 306), Vol. I.1, FM 15 METAR / FM 16 SPECI: el tiempo presente w'w' (tabla 4678) es
//     [intensidad o proximidad: «-», «+» o «VC»] [descriptor: MI PR BC DR BL SH TS FZ] [fenómenos: DZ RA SN SG PL GR GS UP
//     (precipitación), BR FG FU VA DU SA HZ (oscurecimiento), PO SQ FC SS DS (otros)]. «GR» = granizo; «GS» = granizo pequeño
//     o gránulos de nieve. El tiempo reciente es «RE» + w'w' (sin intensidad), p. ej. «REGR»: granizo desde el parte anterior
//     (como mucho la hora anterior), ya no en el momento.
//   · La TENDENCIA (BECMG, TEMPO, NOSIG) es un PRONÓSTICO a 2 h: un «TEMPO TSGR» NO es granizo observado. Se corta ahí.
//   · Las OBSERVACIONES (RMK) son de cada país. En los EE. UU. (FMH-1, Federal Meteorological Handbook No. 1, cap. 12) el
//     tamaño de la piedra va como «GR 1 3/4» (pulgadas) o «GR LESS THAN 1/4», y el comienzo y el fin del fenómeno como
//     «GRB37E46» (empezó a los :37, terminó a los :46). En la Argentina las RMK casi no se usan; se leen igual, aparte.
//   · Los partes argentinos traen a veces «RE TSRA» (con espacio): se lee como tiempo reciente.
// Lo que NO es granizo acá: «VCTS» (tormenta en las cercanías, 8-16 km, sin precipitación en la estación), los CB de las nubes
// («FEW045CB»), y cualquier cosa de la tendencia.
//
// Puras: no piden nada, no escriben nada.

const DESCRIPTORES = ['MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ'];
const FENOMENOS = ['DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP', 'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY', 'PO', 'SQ', 'FC', 'SS', 'DS'];
export const GRANIZO = Object.freeze(['GR', 'GS']);
const FIN_CUERPO = new Set(['RMK', 'BECMG', 'TEMPO', 'NOSIG', 'TREND']);

/** Un grupo de tiempo presente («+TSSHGRRA», «VCTS», «-RA», «TS») → { grupo, intensidad, descriptores, fenomenos } o null */
export function grupoTiempo(tok) {
  const m = /^(-|\+|VC)?([A-Z]+)$/.exec(String(tok || ''));
  if (!m) return null;
  let resto = m[2];
  const descriptores = [], fenomenos = [];
  while (resto.length >= 2 && DESCRIPTORES.includes(resto.slice(0, 2)) && fenomenos.length === 0) { descriptores.push(resto.slice(0, 2)); resto = resto.slice(2); }
  while (resto.length >= 2 && FENOMENOS.includes(resto.slice(0, 2))) { fenomenos.push(resto.slice(0, 2)); resto = resto.slice(2); }
  if (resto.length) return null;                                   // sobran letras: no es un grupo de tiempo (p. ej. «CAVOK», «NSC»)
  if (!descriptores.length && !fenomenos.length) return null;
  if (descriptores.length > 2) return null;
  return { grupo: tok, intensidad: m[1] || '', descriptores, fenomenos };
}

/** Las observaciones (RMK) que hablan de granizo, al estilo FMH-1: tamaño («GR 1 3/4», «GR LESS THAN 1/4») y comienzo/fin («GRB37E46») */
export function granizoEnRmk(rmk) {
  const out = [];
  const t = ' ' + String(rmk || '') + ' ';
  for (const m of t.matchAll(/\s(GR|GS)\s+(LESS THAN\s+)?(\d+(?:\s+\d\/\d)?|\d\/\d)(?=\s)/g)) {
    const partes = m[3].split(/\s+/);
    let pulg = 0;
    for (const p of partes) { const f = /^(\d)\/(\d)$/.exec(p); pulg += f ? Number(f[1]) / Number(f[2]) : Number(p); }
    out.push({ fenomeno: m[1], texto: m[0].trim(), tamano_pulgadas: Math.round(pulg * 1000) / 1000, tamano_mm: Math.round(pulg * 254) / 10, menor_que: !!m[2] });
  }
  for (const tok of t.trim().split(/\s+/)) {
    // «GRB37E46», «RAB05E30GRB20E55»: cada fenómeno de 2 letras con sus B (begin) y E (end); se toman sólo GR y GS
    for (const m of tok.matchAll(/(GR|GS)((?:[BE](?:\d{4}|\d{2}))+)/g)) {
      const marcas = [...m[2].matchAll(/([BE])(\d{4}|\d{2})/g)].map((x) => ({ que: x[1] === 'B' ? 'empezo' : 'termino', minuto: x[2] }));
      out.push({ fenomeno: m[1], texto: m[0], tiempos: marcas });
    }
  }
  return out;
}

/**
 * METAR o SPECI crudo → lo parseado. Nunca tira: un parte que no se entiende sale con ok:false y su motivo.
 * @returns {{ ok, motivo?, tipo, estacion, dia, hora, minuto, cor, auto, nil, presente, reciente, rmk, rmk_granizo, tendencia, granizo }}
 */
export function parsear(crudo) {
  // «Q1009RMK CB OBS TO W» (real, SAMR 16/11 17 UTC): el RMK pegado al grupo anterior se separa
  const texto = String(crudo || '').replace(/=\s*$/, '').replace(/\s+/g, ' ').trim().replace(/(\S)RMK(?= |$)/, '$1 RMK');
  const toks = texto.split(' ').filter(Boolean);
  const r = { ok: false, crudo: texto, tipo: null, estacion: null, dia: null, hora: null, minuto: null, cor: false, auto: false, nil: false,
    presente: [], reciente: [], rmk: null, rmk_granizo: [], tendencia: null, granizo: null };
  let i = 0;
  if (toks[i] === 'METAR' || toks[i] === 'SPECI') r.tipo = toks[i++];
  if (toks[i] === 'COR') { r.cor = true; i++; }
  if (!/^[A-Z][A-Z0-9]{3}$/.test(toks[i] || '')) return { ...r, motivo: 'sin estación OACI' };
  r.estacion = toks[i++];
  if (toks[i] === 'COR') { r.cor = true; i++; }                     // los partes argentinos: «SPECI SAOU COR 161835Z …»
  const t = /^(\d{2})(\d{2})(\d{2})Z$/.exec(toks[i] || '');
  if (!t) return { ...r, motivo: 'sin hora ddhhmmZ' };
  r.dia = Number(t[1]); r.hora = Number(t[2]); r.minuto = Number(t[3]);
  if (r.dia < 1 || r.dia > 31 || r.hora > 23 || r.minuto > 59) return { ...r, motivo: 'hora imposible' };
  i++;
  if (toks[i] === 'NIL') { r.nil = true; r.ok = true; r.granizo = resumenGranizo(r); return r; }
  // el cuerpo: hasta RMK o la tendencia
  let j = i;
  for (; j < toks.length; j++) {
    const k = toks[j];
    if (FIN_CUERPO.has(k)) break;
    if (k === 'AUTO') { r.auto = true; continue; }
    if (k === 'COR') { r.cor = true; continue; }
    if (k === 'RE' && toks[j + 1]) {                                // «RE TSRA» (con espacio, partes argentinos)
      const g = grupoTiempo(toks[j + 1]);
      if (g && !g.intensidad) { r.reciente.push({ ...g, grupo: 'RE ' + toks[j + 1] }); j++; continue; }
    }
    if (/^RE[A-Z]{2,}$/.test(k)) {
      const g = grupoTiempo(k.slice(2));
      if (g && !g.intensidad) { r.reciente.push({ ...g, grupo: k }); continue; }
    }
    const g = grupoTiempo(k);
    if (g) r.presente.push(g);
  }
  if (toks[j] && toks[j] !== 'RMK') {
    const fin = toks.indexOf('RMK', j);
    r.tendencia = toks.slice(j, fin < 0 ? toks.length : fin).join(' ');
    j = fin < 0 ? toks.length : fin;
  }
  if (toks[j] === 'RMK') {
    r.rmk = toks.slice(j + 1).join(' ');
    r.rmk_granizo = granizoEnRmk(r.rmk);
  }
  r.ok = true;
  r.granizo = resumenGranizo(r);
  return r;
}

/** Lo que importa para el granizo, en limpio */
export function resumenGranizo(p) {
  const conGr = (g) => g.fenomenos.some((f) => GRANIZO.includes(f));
  const ahora = p.presente.filter((g) => g.intensidad !== 'VC' && conGr(g));
  const recientes = p.reciente.filter(conGr);
  const tipos = [...new Set([...ahora, ...recientes].flatMap((g) => g.fenomenos.filter((f) => GRANIZO.includes(f))))].sort();
  for (const x of p.rmk_granizo || []) if (!tipos.includes(x.fenomeno)) tipos.push(x.fenomeno);
  const vcts = p.presente.some((g) => g.intensidad === 'VC' && g.descriptores.includes('TS'));
  const tormenta = p.presente.some((g) => g.intensidad !== 'VC' && g.descriptores.includes('TS'));
  return {
    observado: ahora.length > 0,                       // GR o GS en el tiempo presente: está cayendo en la estación
    reciente: recientes.length > 0,                    // REGR / REGS: cayó desde el parte anterior
    en_rmk: (p.rmk_granizo || []).length > 0,          // lo dicen las observaciones (FMH-1)
    alguno: ahora.length > 0 || recientes.length > 0 || (p.rmk_granizo || []).length > 0,
    tipos,                                             // ['GR'], ['GS'] o los dos
    grupos: [...ahora, ...recientes].map((g) => g.grupo),
    intenso: ahora.some((g) => g.intensidad === '+'),
    con_tormenta: ahora.some((g) => g.descriptores.includes('TS')),
    tormenta,                                          // TS en la estación (con o sin granizo)
    tormenta_cerca: vcts,                              // VCTS: tormenta en las cercanías (no es granizo)
  };
}

/**
 * La hora del parte en ms UTC. El METAR trae sólo día, hora y minuto: el mes y el año salen de la hora de referencia
 * (la del pedido o la reportTime de la API). Si el día es mayor que el de la referencia, es del mes anterior.
 */
export function horaParte(p, refMs) {
  if (!p || !p.ok) return null;
  const ref = new Date(refMs);
  let y = ref.getUTCFullYear(), mo = ref.getUTCMonth();
  if (p.dia > ref.getUTCDate() + 1) { mo -= 1; if (mo < 0) { mo = 11; y -= 1; } }
  const ms = Date.UTC(y, mo, p.dia, p.hora, p.minuto);
  return new Date(ms).getUTCDate() === p.dia ? ms : null;
}
