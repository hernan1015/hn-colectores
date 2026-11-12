// HN AGRO · opera-mosaico/fusionar.mjs · el MOSAICO DIARIO de OPERA DSWx-S1, sin corridas a mano (DISEÑO, apagado)
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que falta entre los scripts de hn-agro (tools/satchi/cog/, rama fix/opera-mosaicos) para que una Action arme cada día
// SÓLO lo que cambió y lo sume a R2 SIN PISAR LA HISTORIA:
//   decidir  · qué fechas re-armar: las de CMR cuyo conjunto de pasadas (tesela, inicio → procesado) es nuevo, CONTIENE al
//              de R2 o trae una versión más nueva (la misma regla que decidir_rearmado() de opera_a_cog.py). Si al de hoy le
//              falta una pasada que R2 ya tiene, se CONSERVA lo de R2 (no se pisa un mosaico bueno con uno peor).
//   fusionar · el catálogo de R2 + lo armado hoy → el catálogo COMPLETO (provisional y latest recalculados con «hoy») y el
//              catálogo de SUBIDA (sólo lo de hoy + el mosaico al que apunta latest), que es el que recibe subir-r2.mjs.
//   indice   · pasadas.json: lo VIEJO de R2 (cobertura medida) para las fechas que no se tocaron + lo NUEVO para las de hoy.
//   bajar / subir-indice · GET y PUT de un objeto de satchi-mapas con la llave del entorno (firma de subir-r2.mjs).
// Llaves SÓLO del entorno: R2_CUENTA, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. El registro de Actions es PÚBLICO: no se
// imprime ninguna URL firmada ni ninguna llave; sólo claves de objeto, fechas y cantidades.
// Diseño: hn-cortex docs/opera-mosaicos-2026-11-11/AUTOMATICO.md · Tests: opera-mosaico/test/fusionar.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PREFIJO = 'opera/cog';
export const DEPOSITO = 'satchi-mapas';
export const PROVISIONAL_DIAS = 3;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const NOMBRE = /^OPERA_L3_DSWx-S1_(T\d{2}[A-Z]{3})_(\d{4})(\d{2})(\d{2})(T\d{6})Z_(\d{8}T\d{6})Z_.*_B01_WTR\.tif$/;
const rutaMosaico = (f) => PREFIJO + '/cuenca-del-plata/' + f + '.tif';
const RUTA_LATEST = PREFIJO + '/cuenca-del-plata/latest.tif';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** PURA. nombre B01_WTR → { clave: tesela|inicio, fecha, proc } (null si no es uno) */
export function leerNombre(n) {
  const m = NOMBRE.exec(path.basename(String(n || '')));
  return m ? { clave: m[1] + '|' + m[2] + m[3] + m[4] + m[5], fecha: m[2] + '-' + m[3] + '-' + m[4], proc: m[6] } : null;
}
/** PURA. nombres (o URL) → { fecha: [nombres ordenados] } */
export function porFecha(nombres) {
  const P = {};
  for (const u of nombres || []) { const n = path.basename(String(u).trim()), x = leerNombre(n); if (x) (P[x.fecha] = P[x.fecha] || []).push(n); }
  Object.values(P).forEach((L) => L.sort());
  return P;
}
function pasadas(nombres) {
  const M = new Map();
  for (const n of nombres || []) { const x = leerNombre(n); if (x && !(M.get(x.clave) >= x.proc)) M.set(x.clave, x.proc); }
  return M;
}
/** PURA. la regla de opera_a_cog.py decidir_rearmado(): 'rearmar' | 'igual' | 'conservar' */
export function decidirFecha(previos, nuevos) {
  if (!Array.isArray(previos)) return 'rearmar';                 // R2 no tiene esa fecha, o no guardó sus gránulos
  const v = pasadas(previos), n = pasadas(nuevos);
  for (const [k, p] of v) if (!n.has(k) || n.get(k) < p) return 'conservar';
  return v.size === n.size && [...v].every(([k, p]) => n.get(k) === p) ? 'igual' : 'rearmar';
}
/** PURA. CMR de hoy { fecha: [nombres] } + catálogo de R2 → { rearmar, igual, conservar } (fechas ordenadas) */
export function fechasARearmar(cmr, previo) {
  const prev = new Map(((previo && previo.mosaicos) || []).map((m) => [m.fecha, m.granulos]));
  const r = { rearmar: [], igual: [], conservar: [] };
  for (const f of Object.keys(cmr || {}).sort()) r[decidirFecha(prev.has(f) ? prev.get(f) || null : null, cmr[f])].push(f);
  return r;
}
export function esProvisional(fecha, hoy) { return (Date.parse(hoy + 'T00:00:00Z') - Date.parse(fecha + 'T00:00:00Z')) / 864e5 < PROVISIONAL_DIAS; }
function elegirLatest(mosaicos) {
  const o = mosaicos.slice().sort((a, b) => (a.fecha < b.fecha ? -1 : 1)), f = o.filter((m) => !m.provisional);
  return (f.length ? f : o).pop() || null;
}
/** PURA. catálogo de R2 (completo) + catálogo de hoy → { completo, subida, latest } */
export function fusionarCatalogo(previo, nuevo, hoy) {
  const N = new Set((nuevo.mosaicos || []).map((m) => m.fecha));
  const teselas = (previo.teselas || []).filter((t) => !N.has(t.fecha)).concat(nuevo.teselas || []).sort((a, b) => (a.r2 < b.r2 ? -1 : a.r2 > b.r2 ? 1 : 0));
  const mosaicos = (previo.mosaicos || []).filter((m) => !N.has(m.fecha)).concat(nuevo.mosaicos || [])
    .map((m) => Object.assign({}, m, { provisional: esProvisional(m.fecha, hoy) })).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  const ult = elegirLatest(mosaicos);
  const latest = ult ? { r2: RUTA_LATEST, es: ult.r2, fecha: ult.fecha, bytes: ult.bytes, sha256: ult.sha256, cog_valido: ult.cog_valido !== false, errores: [], avisos: [] } : null;
  const vent = [previo.ventana && previo.ventana[0], nuevo.ventana && nuevo.ventana[0]].filter(Boolean).sort()[0];
  const ventH = [previo.ventana && previo.ventana[1], nuevo.ventana && nuevo.ventana[1]].filter(Boolean).sort().pop();
  const base = Object.assign({}, previo, { generado_utc: nuevo.generado_utc || previo.generado_utc, ventana: [vent, ventH] });
  const resumen = (t, m, l) => { const T = t.concat(m, l ? [l] : []); return { archivos: T.length, bytes: T.reduce((a, x) => a + (x.bytes || 0), 0), cog_validos: T.filter((x) => x.cog_valido).length, fechas: [...new Set(m.map((x) => x.fecha))].sort() }; };
  const completo = Object.assign({}, base, { teselas, mosaicos, latest, resumen: resumen(teselas, mosaicos, latest) });
  // lo que se sube hoy: lo armado hoy + el mosaico al que apunta latest (el COG se sube igual; revisar() pide que esté)
  const sT = teselas.filter((t) => N.has(t.fecha)), sM = mosaicos.filter((m) => N.has(m.fecha) || (ult && m.fecha === ult.fecha));
  const fechasS = sM.map((m) => m.fecha).sort();
  const subida = Object.assign({}, base, { ventana: [fechasS[0], fechasS[fechasS.length - 1]], teselas: sT, mosaicos: sM, latest, resumen: resumen(sT, sM, latest) });
  return { completo, subida, latest, latestNuevo: !!(ult && N.has(ult.fecha)) };
}
/** PURA. pasadas.json de R2 + el armado hoy sobre el catálogo completo → el índice nuevo, SIN PISAR la historia:
    las fechas de hoy salen del nuevo (cobertura medida en los mosaicos de hoy); el resto, del viejo (medida en su día). */
export function fusionarIndice(previo, nuevo, fechasNuevas) {
  const S = new Set(fechasNuevas || []), zonas = {};
  for (const z of new Set(Object.keys((previo && previo.zonas) || {}).concat(Object.keys((nuevo && nuevo.zonas) || {})))) {
    const v = ((previo && previo.zonas && previo.zonas[z]) || []).filter((p) => !S.has(p.fecha));
    const n = ((nuevo && nuevo.zonas && nuevo.zonas[z]) || []).filter((p) => S.has(p.fecha));
    zonas[z] = v.concat(n).sort((a, b) => (a.fecha + (a.hora_utc || '') < b.fecha + (b.hora_utc || '') ? -1 : 1));
  }
  const fechas = Object.values(zonas).flat().map((p) => p.fecha).filter((f) => FECHA.test(f)).sort();
  const desde = [previo && previo.desde, nuevo && nuevo.desde, fechas[0]].filter(Boolean).sort()[0] || null;
  const hasta = [previo && previo.hasta, nuevo && nuevo.hasta].filter(Boolean).sort().pop() || null;
  return Object.assign({}, previo || {}, { generado_utc: (nuevo && nuevo.generado_utc) || new Date().toISOString().slice(0, 19) + 'Z', desde, hasta,
    fuente: (nuevo && nuevo.fuente) || (previo && previo.fuente), zonas });
}

/* ── R2 (con la llave del entorno; la firma S3 v4 es la de hn-agro tools/satchi/cog/subir-r2.mjs) ───────────── */
async function firmador() {
  const p = path.resolve(process.env.HN_AGRO || path.join(process.cwd(), 'hn-agro'), 'tools', 'satchi', 'cog', 'subir-r2.mjs');
  return (await import(pathToFileURL(p).href)).firmar;
}
function llaves() {
  const L = { cuenta: process.env.R2_CUENTA, clave: process.env.R2_ACCESS_KEY_ID, secreto: process.env.R2_SECRET_ACCESS_KEY };
  if (!L.cuenta || !L.clave || !L.secreto) throw new Error('faltan R2_CUENTA / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
  return { cuenta: L.cuenta.trim(), clave: L.clave.trim(), secreto: L.secreto.trim() };
}
async function r2(metodo, clave, cuerpo, cab) {
  if (!clave.startsWith(PREFIJO + '/') || clave.includes('..')) throw new Error('clave fuera de ' + PREFIJO + '/: ' + clave);
  const firmar = await firmador(), L = llaves(), host = L.cuenta + '.r2.cloudflarestorage.com', camino = '/' + DEPOSITO + '/' + clave;
  const f = firmar({ metodo, host, camino, cabeceras: cab || {}, hashCuerpo: sha(cuerpo || Buffer.alloc(0)), fecha: new Date(), region: 'auto', clave: L.clave, secreto: L.secreto });
  const r = await fetch('https://' + host + camino.split('/').map(encodeURIComponent).join('/'), { method: metodo, body: cuerpo,
    headers: Object.assign({}, cab || {}, { authorization: f.authorization, 'x-amz-date': f['x-amz-date'], 'x-amz-content-sha256': f['x-amz-content-sha256'] }) });
  if (!r.ok) throw new Error(metodo + ' ' + clave + ': R2 respondió ' + r.status);   // sin cuerpo ni URL: el registro es público
  return Buffer.from(await r.arrayBuffer());
}

/* ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────── */
function salidaGH(pares) {
  const t = Object.entries(pares).map(([k, v]) => k + '=' + v).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, t); else process.stdout.write(t);
}
const leerJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
async function cli(a) {
  const op = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; }, cmd = a[0];
  if (cmd === 'bajar') { fs.mkdirSync(path.dirname(a[2]), { recursive: true }); const b = await r2('GET', a[1]); fs.writeFileSync(a[2], b); console.log('bajado ' + a[1] + ' · ' + b.length + ' bytes'); return; }
  if (cmd === 'subir-indice') {
    const b = fs.readFileSync(a[1]); const j = JSON.parse(b.toString('utf8'));
    if (!j.zonas || !FECHA.test(String(j.hasta || ''))) throw new Error('no es un índice de pasadas');
    await r2('PUT', PREFIJO + '/pasadas.json', b, { 'content-type': 'application/json', 'cache-control': 'public, max-age=900' });
    console.log('índice subido · hasta ' + j.hasta + ' · ' + b.length + ' bytes'); return;
  }
  if (cmd === 'decidir') {
    const cmr = porFecha(fs.readFileSync(op('--cmr'), 'utf8').split(/\r?\n/)), urls = fs.readFileSync(op('--cmr'), 'utf8').split(/\r?\n/).filter(Boolean);
    const d = fechasARearmar(cmr, leerJ(op('--previo'))), S = new Set(d.rearmar), sal = op('--salida');
    fs.mkdirSync(sal, { recursive: true });
    fs.writeFileSync(path.join(sal, 'fechas.txt'), d.rearmar.join('\n') + (d.rearmar.length ? '\n' : ''));
    const bajar = urls.filter((u) => { const x = leerNombre(u); return x && S.has(x.fecha); });
    fs.writeFileSync(path.join(sal, 'urls-a-bajar.txt'), bajar.join('\n') + (bajar.length ? '\n' : ''));
    console.log('fechas · re-armar ' + d.rearmar.length + ' [' + d.rearmar.join(' ') + '] · iguales ' + d.igual.length + ' · conservadas ' + d.conservar.length + (d.conservar.length ? ' [' + d.conservar.join(' ') + ']' : '') + ' · gránulos a bajar ' + bajar.length);
    const span = d.rearmar.length ? Math.round((Date.parse(d.rearmar[d.rearmar.length - 1]) - Date.parse(d.rearmar[0])) / 864e5) : 0;
    salidaGH({ hay: d.rearmar.length ? 'si' : 'no', hasta: d.rearmar[d.rearmar.length - 1] || '', dias: span, granulos: bajar.length });
    return;
  }
  if (cmd === 'fusionar') {
    const raiz = op('--raiz'), base = path.join(raiz, ...PREFIJO.split('/')), hoy = op('--hoy') || new Date().toISOString().slice(0, 10);
    const F = fusionarCatalogo(leerJ(op('--previo')), leerJ(op('--nuevo')), hoy);
    if (!F.latest) throw new Error('sin mosaicos');
    const src = path.join(raiz, ...F.latest.es.split('/'));
    if (!fs.existsSync(src)) { fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, await r2('GET', F.latest.es)); }
    const b = fs.readFileSync(src);
    if (sha(b) !== F.latest.sha256) throw new Error('el mosaico de latest (' + F.latest.fecha + ') no coincide con el catálogo');
    fs.writeFileSync(path.join(base, 'cuenca-del-plata', 'latest.tif'), b);
    fs.writeFileSync(path.join(base, 'catalogo.json'), JSON.stringify(F.completo, null, 1));   // el que sube subir-r2.mjs con esa clave
    fs.writeFileSync(path.join(base, 'subida.json'), JSON.stringify(F.subida, null, 1));      // el plan: lo de hoy + latest
    fs.writeFileSync(op('--completo') || path.join(raiz, 'catalogo-completo.json'), JSON.stringify(F.completo, null, 1));
    console.log('catálogo · ' + F.completo.mosaicos.length + ' mosaicos ' + F.completo.ventana.join(' → ') + ' · subo ' + F.subida.teselas.length + ' teselas y ' + F.subida.mosaicos.length + ' mosaicos · latest ' + F.latest.fecha + (F.latestNuevo ? '' : ' (bajado de R2)'));
    return;
  }
  if (cmd === 'indice') {
    const fechas = fs.readFileSync(op('--fechas'), 'utf8').split(/\r?\n/).filter((f) => FECHA.test(f));
    const I = fusionarIndice(leerJ(op('--previo')), leerJ(op('--nuevo')), fechas);
    fs.writeFileSync(op('--salida'), JSON.stringify(I) + '\n');
    console.log('índice · ' + I.desde + ' → ' + I.hasta + ' · ' + Object.values(I.zonas).reduce((s, L) => s + L.length, 0) + ' pasadas · ' + fechas.length + ' fechas nuevas');
    return;
  }
  console.error('uso: fusionar.mjs decidir|fusionar|indice|bajar|subir-indice …'); process.exit(2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2)).catch((e) => { console.error(String(e && e.message || e).replace(/https?:\/\/\S+/g, '<url>')); process.exit(1); });
