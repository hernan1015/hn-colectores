// Control negativo CONTADO: se rompe UNA cosa por vez en una copia y se corre la suite; cada mutante tiene que hacer
// fallar al menos un test. Antes, la copia SIN romper tiene que pasar entera. Cada texto a romper aparece UNA vez.
// Correr: HN_PGLITE=<…>/@electric-sql/pglite node estaciones-privadas/parseo/test/control-negativo.mjs
// La copia va a <repo>/.mutante/ (en .gitignore), con sipan-alto-valle/{lib,migracion} al lado (los tests los leen).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(RAIZ, '..', '..');
if (!process.env.HN_PGLITE) { console.error('falta HN_PGLITE: sin PGlite los tests de la base se saltean y el control no vale'); process.exit(1); }

const C = 'lib/convertir.mjs', D = 'lib/dia.mjs', G = 'lib/guardar.mjs', WLm = 'fuentes/weatherlink.mjs', WCm = 'fuentes/weathercloud.mjs', P = 'parseo.mjs';
const M = 'migracion/0152_parseo_estaciones_privadas_rol_PROPUESTA.sql';
const MUTANTES = [
  // conversiones y encoding
  ['°F sin convertir', C, 'export const fAc = (x) => r2d(((x - 32) * 5) / 9);', 'export const fAc = (x) => r2d(x);'],
  ['mph → km/h', C, 'export const mphAms = (x) => r2d(x * 0.44704);', 'export const mphAms = (x) => r2d(x * 1.609344);'],
  ['in sin convertir', C, 'export const inAmm = (x) => r2d(x * 25.4);', 'export const inAmm = (x) => r2d(x);'],
  ['inHg sin convertir', C, 'export const inhgAhpa = (x) => r2d(x * 33.8639, 1);', 'export const inhgAhpa = (x) => r2d(x, 1);'],
  ['los nombres no se arreglan', C, 'for (let vuelta = 0; vuelta < 2 && /[ÃÂâ]/.test(r); vuelta++) {', 'for (let vuelta = 0; vuelta < 0; vuelta++) {'],
  ['cp1252 no se reconoce', C, 'else if (CP1252[c] != null) bytes.push(CP1252[c]);', ''],
  ['UTF-8 inválido se acepta', C, "const UTF8 = new TextDecoder('utf-8', { fatal: true });", "const UTF8 = new TextDecoder('utf-8');"],
  ['la temperatura imposible entra', C, 'temp_c: (x) => x > -40 && x < 60,', 'temp_c: () => true,'],
  ['el día en UTC', C, 'const d = new Date(ms - 3 * 3600e3);', 'const d = new Date(ms);'],
  // WeatherLink
  ['la unidad escrita no manda', WLm, 'const u = unidadEnValor(v) || c[k].unidad;', 'const u = c[k].unidad;'],
  ['la vieja cuenta', WLm, "if (edad != null && edad > formato.edad_max_s) return { ok: false, motivo: 'vieja', claves, lectura: l };", ''],
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
  // el día
  ['sin dedup por instante', D, 'const k = `${l.id}|${l.instante}`;', 'const k = `${l.id}|${l.instante}|${Math.random()}`;'],
  ['la noche incluye las 18:00', D, 'const pasada18 = min > 18 * 60 || (min === 18 * 60 && seg > 0);', 'const pasada18 = min >= 18 * 60;'],
  ['la noche sin las 09:00', D, 'const hasta9 = min < 9 * 60 || (min === 9 * 60 && seg === 0);', 'const hasta9 = min < 9 * 60;'],
  ['sin ordenar por instante (la lluvia de cualquier lectura)', D, 'const orden = [...lecturas].sort((a, b) => a.instante - b.instante || String(a.id).localeCompare(String(b.id)));', 'const orden = [...lecturas];'],
  ['esperados no se estira', D, 'f.registros_esperados = Math.max(f.registros_esperados, f.registros_validos);', ''],
  ['combinar pisa lo más completo', D, 'if ((viejo.registros_validos ?? 0) > (nuevo.registros_validos ?? 0)) {', 'if (false) {'],
  ['combinar pisa la noche más completa', D, 'if ((viejo.noche_registros ?? 0) > (nuevo.noche_registros ?? 0)) {', 'if (false) {'],
  ['se arman días que no son objetivo', D, 'if (objetivo.has(fecha)) {', 'if (true) {'],
  // el job y el guardado
  ['R2 con escritura', P, 'return Object.freeze({ leer: (k) => almacen.leer(k), listar: (p) => almacen.listar(p) });', 'return almacen;'],
  ['sin la noche de ayer (no se lee el día anterior)', P, 'return { objetivo: obj, leer: [sumarDias(obj[0], -1), ...obj] };', 'return { objetivo: obj, leer: [...obj] };'],
  ['el error sale con la URL', P, "r.error = String(e && e.message || e).slice(0, 120).replace(/https?:\\/\\/\\S+/g, '<url>');", 'r.error = String(e && e.message || e);'],
  ['la última lectura retrocede', G, 'where excluded.instante > u.instante`,', 'where true`,'],
  ['cualquier red', G, 'const red_ = (red) => { if (!REDES.has(red)) throw new Error(`red no permitida: ${red}`); return red; };', 'const red_ = (red) => red;'],
  ['metadatos de otros se pierden', G, "metadatos = (estaciones.metadatos - 'inactiva_desde' - 'motivo_inactiva') || excluded.metadatos,", 'metadatos = excluded.metadatos,'],
  ['acepta otro usuario', G, "if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) throw", 'if (false) throw'],
  ['el error del driver sale entero', G, 'const err = new Error(`${que}: ${codigo}`);', 'const err = new Error(`${que}: ${codigo} ${e && e.message}`);'],
  // la migración
  ['la política sin WEATHERCLOUD_PUB', M, "redes constant text := $r$red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO', 'WEATHERCLOUD_PUB')$r$;", "redes constant text := $r$red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO')$r$;"],
  ['la política pierde SMN_ABIERTO', M, "redes constant text := $r$red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO', 'WEATHERCLOUD_PUB')$r$;", "redes constant text := $r$red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'WEATHERCLOUD_PUB')$r$;"],
  ['sin grant a la última lectura', M, '  grant select, insert, update on table public.estaciones_ultima_lectura to colector_estaciones;\n', ''],
  ['grant de borrar', M, 'grant select, insert, update on table public.estaciones_ultima_lectura to colector_estaciones;', 'grant select, insert, update, delete on table public.estaciones_ultima_lectura to colector_estaciones;'],
  ['el proceso del parseo no se puede anotar', M, "'smn_abierto', 'estaciones_privadas_parseo'));", "'smn_abierto'));"],
];

const DEST = path.join(REPO, '.mutante');
const DESTP = path.join(DEST, 'estaciones-privadas', 'parseo');
function copiar() {
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DESTP, { recursive: true });
  for (const d of ['lib', 'migracion', 'test', 'fuentes']) fs.cpSync(path.join(RAIZ, d), path.join(DESTP, d), { recursive: true });
  for (const f of ['parseo.mjs', 'formato.mjs', 'package.json', 'PRENDER.md', 'estaciones-privadas-parseo.workflow.yml.txt']) fs.copyFileSync(path.join(RAIZ, f), path.join(DESTP, f));
  if (fs.existsSync(path.join(RAIZ, 'node_modules'))) fs.cpSync(path.join(RAIZ, 'node_modules'), path.join(DESTP, 'node_modules'), { recursive: true });
  for (const d of ['lib', 'migracion']) fs.cpSync(path.join(REPO, 'sipan-alto-valle', d), path.join(DEST, 'sipan-alto-valle', d), { recursive: true });
}
const TESTS = ['test/convertir.test.mjs', 'test/fuentes.test.mjs', 'test/dia.test.mjs', 'test/parseo.test.mjs', 'test/guardado-pglite.test.mjs', 'test/estatico.test.mjs'];
const correr = () => spawnSync(process.execPath, ['--test', ...TESTS], { cwd: DESTP, encoding: 'utf8', env: process.env, timeout: 300e3 });

copiar();
const base = correr();
if (base.status !== 0) { console.error('la copia SIN romper no pasa:\n' + (base.stdout || '').slice(-3000)); process.exit(1); }
console.log('copia sin romper: pasa');
let vivos = 0, malos = 0;
for (const [nombre, archivo, de, a] of MUTANTES) {
  const texto = fs.readFileSync(path.join(RAIZ, archivo), 'utf8').replace(/\r\n/g, '\n');
  const veces = texto.split(de).length - 1;
  if (veces !== 1) { console.log(`✗ NO VALE (aparece ${veces} veces): ${nombre}`); malos++; continue; }
  copiar();
  fs.writeFileSync(path.join(DESTP, archivo), texto.replace(de, a));
  const r = correr();
  if (r.status === 0) { console.log(`✗ VIVO: ${nombre}`); vivos++; } else console.log(`✓ muerto: ${nombre}`);
}
fs.rmSync(DEST, { recursive: true, force: true });
console.log(`\n${MUTANTES.length} mutantes · ${MUTANTES.length - vivos - malos} muertos · ${vivos} vivos · ${malos} que no valen`);
process.exit(vivos || malos ? 1 : 0);
