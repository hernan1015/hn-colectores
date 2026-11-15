// Control negativo CONTADO del parseo unificado: se rompe UNA cosa por vez en una copia y se corre la suite ENTERA; cada
// mutante tiene que hacer fallar al menos un test. Antes, la copia SIN romper tiene que pasar entera. Cada texto a romper
// aparece UNA sola vez en su archivo.
// Las listas: los 41 de la 138b y los 23 de la 139 (los mismos casos, apuntados a la capa unificada), más los del lote.
// Correr: HN_PGLITE=<…>/@electric-sql/pglite HN_FIXTURES_139=<cortex>/docs/red-nacional-139/fixtures/r2 \
//         node estaciones-privadas/parseo/test/control-negativo.mjs
// La copia va a <repo>/.mutante/ (en .gitignore), con sipan-alto-valle/{lib,migracion} al lado (los tests los leen).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(RAIZ, '..', '..');
if (!process.env.HN_PGLITE) { console.error('falta HN_PGLITE: sin PGlite los tests de la base se saltean y el control no vale'); process.exit(1); }
if (!process.env.HN_FIXTURES_139 || !fs.existsSync(path.join(process.env.HN_FIXTURES_139, 'estaciones-internas'))) {
  console.error('falta HN_FIXTURES_139: sin los fixtures de la 139 sus tests se saltean y el control no vale'); process.exit(1);
}

const C = 'lib/convertir.mjs', H = 'lib/hora.mjs', D = 'lib/diario.mjs', G = 'lib/base.mjs', WLm = 'fuentes/weatherlink.mjs', WCm = 'fuentes/weathercloud.mjs', P = 'parseo.mjs';
const M = 'migracion/0152_parseo_estaciones_unificada_PROPUESTA.sql';

const MUTANTES_138B = [
  // conversiones y encoding
  ['°F sin convertir', C, 'export const fAc = (x) => r2d(((x - 32) * 5) / 9);', 'export const fAc = (x) => r2d(x);'],
  ['mph → km/h', C, 'export const mphAms = (x) => r2d(x * 0.44704);', 'export const mphAms = (x) => r2d(x * 1.609344);'],
  ['in sin convertir', C, 'export const inAmm = (x) => r2d(x * 25.4);', 'export const inAmm = (x) => r2d(x);'],
  ['inHg sin convertir', C, 'export const inhgAhpa = (x) => r2d(x * 33.8639, 1);', 'export const inhgAhpa = (x) => r2d(x, 1);'],
  ['los nombres no se arreglan', C, 'for (let vuelta = 0; vuelta < 2 && /[ÃÂâ]/.test(r); vuelta++) {', 'for (let vuelta = 0; vuelta < 0; vuelta++) {'],
  ['cp1252 no se reconoce', C, 'else if (CP1252[c] != null) bytes.push(CP1252[c]);', ''],
  ['UTF-8 inválido se acepta', C, "const UTF8 = new TextDecoder('utf-8', { fatal: true });", "const UTF8 = new TextDecoder('utf-8');"],
  ['la temperatura imposible entra', C, 'temp_c: dentro(LIMITES.temp),', 'temp_c: () => true,'],
  ['el día en UTC', H, 'return new Date(t - OFFSET_MS).toISOString().slice(0, 16);', 'return new Date(t).toISOString().slice(0, 16);'],
  // WeatherLink
  ['la unidad escrita no manda', WLm, 'const u = unidadEnValor(v) || c[k].unidad;', 'const u = c[k].unidad;'],
  ['la vieja cuenta', WLm, "if (edad != null && edad > MAX_EDAD_H * 3600) return { ok: false, motivo: 'vieja', claves, lectura: l };", ''],
  ['sin variables igual se guarda', WLm, "if (!hay) return { ok: false, motivo: 'sin_variables', claves };", ''],
  ['instante futuro aceptado', WLm, "if (Number.isFinite(leido) && inst > leido + 10 * 60e3) return { ok: false, motivo: 'instante_futuro', claves };", ''],
  ['tb −1 sigue activa', WLm, 'activa: i ? i.tb !== -1 : true,', 'activa: true,'],
  ['WL se muestra', WLm, "const META = { permiso: 'interno', mostrar: false,", "const META = { permiso: 'interno', mostrar: true,"],
  ['el nombre sin arreglar', WLm, "l.nombre = typeof n === 'string' ? arreglarNombre(n) || null : null;", "l.nombre = typeof n === 'string' ? n : null;"],
  // Weathercloud
  ['WC sin verificar guarda igual', WCm, 'if (!formato.verificado) continue;                     // ⚠ sin verificar: sólo se cuenta', ''],
  ['WC sin las décimas', WCm, "let v = x == null ? null : k === 'viento_dir_gr' ? dir(en(k)) : x * esc;", "let v = x == null ? null : k === 'viento_dir_gr' ? dir(en(k)) : x;"],
  ['WC fuera de línea aporta lecturas', WCm, 'if (enLinea) {', 'if (true) {'],
  ['WC km/h sin pasar a m/s', WCm, "if (v != null && (k === 'viento_ms' || k === 'racha_ms') && (formato.unidad[k] || 'ms') === 'kmh') v = kmhAms(v);", ''],
  // el día (lib/diario.mjs, la capa unificada)
  ['sin dedup por instante', D, 'if (!v || llenos(r.v) >= llenos(v.v)) m.set(r.local, r);', "m.set(r.local + '|' + Math.random(), r);"],
  ['la noche incluye las 18:00', D, 'return t > a && t <= b;', 'return t >= a && t <= b;'],
  ['la noche sin las 09:00', D, 'return t > a && t <= b;', 'return t > a && t < b;'],
  ['sin ordenar por instante (la lluvia de cualquier lectura)', D, 'lecturas: [...m.values()].sort((a, b) => (a.local < b.local ? -1 : 1)), repetidas', 'lecturas: [...m.values()], repetidas'],
  ['registros_validos pasa a los esperados (el CHECK salta)', D, 'registros_validos: Math.min(conT.length, esperados),', 'registros_validos: conT.length,'],
  ['la unión no trae lo guardado (pisa lo más completo)', D, 'const guardadas = viejas.flatMap((f) => (f.crudo?.lecturas || []).map(deCompacta));', 'const guardadas = [];'],
  ['no se lee el día anterior (pisa la noche más completa)', D, 's.add(sumarDias(d, -1)); s.add(d);', 's.add(d);'],
  ['una lectura de la noche no rehace la mañana siguiente', D, "if (msLocal(r.local) > msLocal(d + 'T18:00')) fechas.add(sumarDias(d, 1));", ''],
  // el job y el guardado
  ['R2 con escritura', P, 'return Object.freeze({ leer: (k) => almacen.leer(k), listar: (p) => almacen.listar(p) });', 'return almacen;'],
  ['sin la noche de ayer (la ventana no cruza la medianoche)', P, 'for (let d = diaArg(ahora - horas * 3600e3);', 'for (let d = diaArg(ahora);'],
  ['el error sale con la URL', P, "const sinUrl = (e) => String(e && e.message || e).slice(0, 120).replace(/https?:\\/\\/\\S+/g, '<url>').replace(/postgres(ql)?:\\/\\/\\S+/g, '<url>');", 'const sinUrl = (e) => String(e && e.message || e);'],
  ['la última lectura retrocede', G, 'where excluded.instante > u.instante`,', 'where true`,'],
  ['cualquier red', G, 'if (!REDES.includes(red)) throw new Error(`red no permitida: ${red}`);', ''],
  ['metadatos de otros se pierden', G, "(estaciones.metadatos - 'inactiva_desde' - 'motivo_inactiva') || excluded.metadatos", 'excluded.metadatos'],
  ['acepta otro usuario', G, "if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) throw", 'if (false) throw'],
  ['el error del driver sale entero', G, "const err = new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`);", "const err = new Error(`${que}: ${codigo} ${e && e.message}`);"],
  // la migración
  ['la política sin WEATHERCLOUD_PUB', M, "'BCP_RT', 'WEATHERCLOUD_PUB')$r$;", "'BCP_RT')$r$;"],
  ['la política pierde SMN_ABIERTO', M, "red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO', 'SIGA_RT',", "red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SIGA_RT',"],
  ['sin grant a la última lectura', M, '  grant select, insert, update on table public.estaciones_ultima_lectura to colector_estaciones;\n', ''],
  ['grant de borrar', M, 'grant select, insert, update on table public.estaciones_ultima_lectura to colector_estaciones;', 'grant select, insert, update, delete on table public.estaciones_ultima_lectura to colector_estaciones;'],
  ['el proceso del parseo no se puede anotar', M, "'interna_bcp_rt', 'estaciones_privadas_parseo'));", "'interna_bcp_rt'));"],
];

const MUTANTES_139 = [
  ['la clave de las 00-02 UTC cae en el mismo día', P, 'return Number(m[2]) < 3 ? ms + 864e5 : ms;', 'return ms;'],
  ['sin la regla de las 12 h', P, "if (Number.isFinite(tope) && (tope - t > (cfg.maxEdadH ?? 12) * 3600e3 || t - tope > 15 * 60e3)) { r.descartadas++; continue; }", ''],
  ['lee cualquier hora de R2', P, 'if (t != null && t >= desde && t <= ahora + 600e3) out.push(k);', 'if (t != null) out.push(k);'],
  ['el log imprime nombres', P, 'log(JSON.stringify(resumen));', "log(JSON.stringify(resumen) + ' Grumbein');"],
  ['reescribe el catálogo cada vez', P, 'if (!mismo(guardadas.get(id), e) || guardadas.get(id)?.metadatos?.mostrar !== false) cat.push(e);', 'cat.push(e);'],
  ['se reescribe sin cambios', D, 'if (f && firmas.get(fecha) !== f.crudo.firma) filas.push(f);', 'if (f) filas.push(f);'],
  ['HR 0 es válida', D, 'hum: [1, 100],', 'hum: [0, 255],'],
  ['50 °C es válido', D, 'temp: [-39.9, 49.9], tmin: [-39.9, 49.9], tmax: [-39.9, 49.9],', 'temp: [-39.9, 60], tmin: [-39.9, 60], tmax: [-39.9, 60],'],
  ['mostrar no se fuerza en el SQL', G, "metadatos = ((estaciones.metadatos - 'inactiva_desde' - 'motivo_inactiva') || excluded.metadatos || '{\"mostrar\": false, \"uso\": \"interno\"}'::jsonb)", 'metadatos = (excluded.metadatos || estaciones.metadatos)'],
  ['BCP por posición fija', 'fuentes/bcp.mjs', "if (faltan.length) throw new Error('bcp: la página cambió, no declara ' + faltan.join(','));", ''],
  ['BCP: la humedad se usa', 'fuentes/bcp.mjs', "temp: valor(D(i, 'iSensorTemp')), tmin:", "hum: valor(D(i, 'iSensorHum_Rel')), temp: valor(D(i, 'iSensorTemp')), tmin:"],
  ['BCP: entran las viejas', 'fuentes/bcp.mjs', 'if (rot[i] == null || Number(habil[i]) !== 1) continue;', 'if (rot[i] == null) continue;'],
  ['ER: sin el alias del carácter de reemplazo', 'fuentes/er.mjs', "'temp. m?x.': 'tmax', 'temp. m?n.': 'tmin', ", ''],
  ['ER: el 404 se lee', 'lib/crudo.mjs', "if (!p || p.status !== 200 || typeof p.cuerpo !== 'string') return null;", "if (!p || typeof p.cuerpo !== 'string') return null;"],
  ['INA: la lluvia va a la fila de la temperatura', 'fuentes/ina.mjs', "if (s.campo === 'lluvia_diaria') {", 'if (false) {'],
  ['INA: estacion_id = la serie', 'fuentes/ina.mjs', "const k = s.estacion.estacion_id + '|' + local;", "const k = String(o.series_id) + '|' + local;"],
  ['INA: la lluvia de otra hora entra', 'fuentes/ina.mjs', "if (local.slice(11) !== '09:00' || v < 0 || v >= 450) { problemas++; continue; }", 'if (v < 0 || v >= 450) { problemas++; continue; }'],
  ['INA: corte a las 00', 'fuentes/ina.mjs', "hora_corte: '09:00', lluvia_mm", "hora_corte: '00:00', lluvia_mm"],
  ['San Luis: entran los PRONO', 'fuentes/rem.mjs', "if (red === 'PRONO') { pronostico++; continue; }", ''],
  ['Mendoza: la precipitación va a la lluvia', 'fuentes/dacc.mjs', "lluvia: null, eto: false, fuente: 'DACC", "lluvia: 'acumulado_consola', eto: false, fuente: 'DACC"],
  ['SIGA: entran las convencionales', 'fuentes/siga.mjs', 'if (e.idTipo != null && e.idTipo !== 2) continue;', ''],
  ['SIGA: acepta cualquier forma', 'fuentes/siga.mjs', "if (!Array.isArray(a)) throw new Error('siga: la respuesta no es un arreglo');", 'if (!Array.isArray(a)) return { estaciones: [], lecturas: [], problemas: 1 };'],
  ['0152 sin las internas', M, ", 'SIGA_RT', 'EEAOC', 'DACC_MZA', 'REM_SL', 'ER_HIDRAULICA', 'INA_METEO', 'INA_ALERTA', 'BCP_RT', 'WEATHERCLOUD_PUB')$r$", ')$r$'],
];

/* los nuevos de la unificación: el lote de la notebook y la edad por lectura */
const MUTANTES_NUEVOS = [
  ['el lote de la notebook no se lee', P, 'if (fuente.lote && fuente.lote.test(k)) { out.push(k); continue; }', ''],
  ['el .gz no se descomprime', P, "(/\\.gz$/.test(clave) ? zlib.gunzipSync(b) : b)", 'b'],
  ['la edad contra la ronda y no contra la lectura (el lote)', P, 'const ll = l.leido != null ? localDe(l.leido) : leidoLocal;', 'const ll = leidoLocal;'],
  ['WC: el lote por device no se lee', WCm, ': Array.isArray(primera(o, forma.device)) ? [primera(o, forma.device)] : null;', ': null;'],
];

const LISTAS = [['138b', MUTANTES_138B], ['139', MUTANTES_139], ['nuevos', MUTANTES_NUEVOS]];
const DEST = path.join(REPO, '.mutante');
const DESTP = path.join(DEST, 'estaciones-privadas', 'parseo');
function copiar() {
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.cpSync(RAIZ, DESTP, { recursive: true, filter: (s) => !s.includes('node_modules') });
  if (fs.existsSync(path.join(RAIZ, 'node_modules'))) fs.cpSync(path.join(RAIZ, 'node_modules'), path.join(DESTP, 'node_modules'), { recursive: true });
  for (const d of ['lib', 'migracion']) fs.cpSync(path.join(REPO, 'sipan-alto-valle', d), path.join(DEST, 'sipan-alto-valle', d), { recursive: true });
}
const TESTS = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).scripts.test.replace(/^node --test /, '').split(/\s+/);
const correr = () => spawnSync(process.execPath, ['--test', ...TESTS], { cwd: DESTP, encoding: 'utf8', env: process.env, timeout: 300e3 });

copiar();
const base = correr();
if (base.status !== 0) { console.error('la copia SIN romper no pasa:\n' + (base.stdout || '').slice(-3000)); process.exit(1); }
if (/ℹ skipped [1-9]/.test(base.stdout || '')) { console.error('la copia SIN romper saltea tests: el control no vale'); process.exit(1); }
console.log('copia sin romper: pasa, sin salteados');
let vivos = 0, malos = 0;
const total = {};
for (const [lista, MUTANTES] of LISTAS) {
  let m = 0;
  for (const [nombre, archivo, de, a] of MUTANTES) {
    const texto = fs.readFileSync(path.join(RAIZ, archivo), 'utf8').replace(/\r\n/g, '\n');
    const veces = texto.split(de).length - 1;
    if (veces !== 1) { console.log(`✗ NO VALE (aparece ${veces} veces): [${lista}] ${nombre}`); malos++; continue; }
    copiar();
    fs.writeFileSync(path.join(DESTP, archivo), texto.replace(de, a));
    const r = correr();
    if (r.status === 0) { console.log(`✗ VIVO: [${lista}] ${nombre}`); vivos++; } else { console.log(`✓ muerto: [${lista}] ${nombre}`); m++; }
  }
  total[lista] = `${m}/${MUTANTES.length}`;
}
fs.rmSync(DEST, { recursive: true, force: true });
console.log(`\nmuertos por lista: ${JSON.stringify(total)} · ${vivos} vivos · ${malos} que no valen`);
process.exit(vivos || malos ? 1 : 0);
