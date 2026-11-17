// Control negativo CONTADO: se rompe a propósito una cosa por vez (en una copia de lib/) y se corre la suite.
// Cada mutante tiene que hacer fallar al menos un test. Al final: «N de N mutantes detectados».
// Antes se corre la copia SIN romper (tiene que pasar entera), así un fallo no es culpa de la copia.
// Correr: node test/control-negativo.mjs  (dentro de gremlin/)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUTANTES = [
  // claves
  ['clave de tesela con columna_fila', 'colector.mjs', 'export const nombreTesela = ({ fila, col }) => `${p3(fila)}_${p3(col)}`;', 'export const nombreTesela = ({ fila, col }) => `${p3(col)}_${p3(fila)}`;'],
  ['clave sin el zoom', 'colector.mjs', "`${dirTiempo(t)}/${String(ZOOM).padStart(2, '0')}/${nombreTesela(tes)}.png`", '`${dirTiempo(t)}/${nombreTesela(tes)}.png`'],
  ['acepta tiempos imposibles', 'slider.mjs', 'return Number.isFinite(ms) && isoTiempo(ms) === aIso(t);', 'return true;'],
  ['URL de tesela con el zoom sin cero', 'slider.mjs', '/${p2(zoom)}/${p3(fila)}_${p3(col)}.png', '/${zoom}/${p3(fila)}_${p3(col)}.png'],
  // recorte
  ['zoom 2 (4 km) en vez del nativo', 'slider.mjs', 'export const ZOOM = 3;', 'export const ZOOM = 2;'],
  ['lon0 de GOES-West (−137.2)', 'slider.mjs', 'LON0 = -75.0,', 'LON0 = -137.2,'],
  ['caja sin Patagonia sur', 'slider.mjs', 'lat_min: -56.5,', 'lat_min: -45,'],
  ['filas y columnas cruzadas', 'slider.mjs', 'const fila = Math.floor(p.fila / TESELA_PX), col = Math.floor(p.col / TESELA_PX);', 'const col = Math.floor(p.fila / TESELA_PX), fila = Math.floor(p.col / TESELA_PX);'],
  ['sin el test de visibilidad del disco', 'slider.mjs', 'sy * sy + (REQ * REQ / (RPOL * RPOL)) * sz * sz) return null;', 'sy * sy + (REQ * REQ / (RPOL * RPOL)) * sz * sz) { /* nada */ }'],
  // idempotencia
  ['rebaja tiempos completos', 'colector.mjs', "if (e && e.estado === 'completo') continue;", ''],
  ['rebaja las teselas ya guardadas', 'colector.mjs', 'const aPedir = esperadas.filter((x) => !guardadas.has(nombreTesela(x)));', 'const aPedir = esperadas;'],
  ['olvida el índice entre tiempos del mismo día', 'colector.mjs', '    indices.set(ki, ind);\n', '\n'],
  // faltantes y basura
  ['guarda un 200 que no es PNG', 'colector.mjs', '      else motivo = motivoTeselaMala(r.buf);', '      else motivo = null;'],
  ['no compara el tamaño anunciado', 'colector.mjs', 'else if (r.largo && r.buf.length !== r.largo)', 'else if (false)'],
  ['no exige el IEND', 'slider.mjs', "if (!buf.subarray(buf.length - 8).equals(FIN_PNG)) return 'PNG cortado (sin IEND)';", ''],
  ['incompleto marcado como completo', 'colector.mjs', "const estado = faltantes.length === 0 && teselas.length === esperadas.length ? 'completo' : 'incompleto';", "const estado = 'completo';"],
  ['olvida las teselas previas al reintentar', 'colector.mjs', 'const guardadas = new Map((previo?.teselas || []).map((x) => [nombreTesela(x), x]));', 'const guardadas = new Map();'],
  ['reintenta sin tope de intentos', 'colector.mjs', 'if (e && (e.intentos || 0) >= MAX_INTENTOS) continue;', ''],
  ['ventana sin límite hacia atrás', 'colector.mjs', 'if (ms < ahoraMs - VENTANA_H * HORA || ms > ahoraMs + 15 * 60000) continue;', 'if (ms > ahoraMs + 15 * 60000) continue;'],
  // tope y cortesía
  ['sin tope de pedidos', 'colector.mjs', 'if (res.pedidos + aPedir.length > maxPedidos) {', 'if (false) {'],
  ['tope sin acotar', 'colector.mjs', 'return Math.min(TOPE_MAX, Math.max(TOPE_MIN, n));', 'return n;'],
  ['sin pausa entre pedidos', 'colector.mjs', 'if (res.pedidos > 0 && pausaMs > 0) await esperar(pausaMs);', ''],
  ['sin UA', 'colector.mjs', "headers: { 'user-agent': UA, accept: 'image/png,application/json' }", "headers: { accept: 'image/png,application/json' }"],
  ['no corta ante un 429', 'colector.mjs', "if (r.status === 429 || r.status === 403) cortar = `SLIDER respondió ${r.status}`;\n      else ", ''],
  ['no corta ante fallas seguidas', 'colector.mjs', 'else if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;', ''],
  ['del más nuevo al más viejo', 'slider.mjs', 'return [...ok].sort();', 'return [...ok].sort().reverse();'],
  // la llave
  ['llave ignorada', 'colector.mjs', "if (llave !== 'si') {", 'if (false) {'],
  ['llave sin distinguir mayúsculas', 'colector.mjs', "if (llave !== 'si') {", "if (String(llave).toLowerCase() !== 'si') {"],
  ['seco que baja igual', 'colector.mjs', "if (modo === 'seco') {", 'if (false) {'],
  // el sobre
  ['sobre sin caja', 'colector.mjs', 'zoom: ZOOM, resolucion: RESOLUCION, tesela_px: TESELA_PX, caja: { ...CAJA },', 'zoom: ZOOM, resolucion: RESOLUCION, tesela_px: TESELA_PX,'],
  ['sobre sin cita', 'slider.mjs', "  cita: 'GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER · GREMLIN (CIRA)',\n", ''],
  ['sobre sin faltantes', 'colector.mjs', '      teselas, faltantes, generado: isoTiempo(ahoraMs),', '      teselas, faltantes: [], generado: isoTiempo(ahoraMs),'],
  ['sobre con el tiempo de la corrida', 'colector.mjs', 'tiempo: isoTiempo(tiempoMs(t)),', 'tiempo: isoTiempo(ahoraMs),'],
  ['índice sin faltantes', 'colector.mjs', 'faltantes: faltantes.map(nombreTesela), intentos,', 'faltantes: [], intentos,'],
  ['SLIDER caído escribe igual', 'colector.mjs', "    return { ...res, estado: 'slider-caido' };", '    tiempos = [];'],
];

function correrCon(nombre, archivo, viejo, nuevo) {
  const dir = path.join(RAIZ, '.mutante');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(RAIZ, 'lib'), path.join(dir, 'lib'), { recursive: true });
  if (archivo) {
    const p = path.join(dir, 'lib', archivo);
    const txt = fs.readFileSync(p, 'utf8');
    const veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'test', 'gremlin.test.mjs')], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GREMLIN_LIB: pathToFileURL(path.join(dir, 'lib')).href + '/' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const fallan = Number((r.stdout.match(/ℹ fail (\d+)/) || [])[1] || 0);
  return { codigo: r.status, fallan };
}

const base = correrCon('sin romper', null);
if (base.codigo !== 0) { console.log(`la copia SIN romper falla (${base.fallan} tests): el control no vale`); process.exit(2); }
console.log('copia sin romper: pasa entera');
let detectados = 0;
for (const [nombre, archivo, viejo, nuevo] of MUTANTES) {
  const r = correrCon(nombre, archivo, viejo, nuevo);
  const ok = r.codigo !== 0;
  if (ok) detectados++;
  console.log(`${ok ? 'detectado ' : 'NO DETECTADO'} · ${nombre} · tests que fallan: ${r.fallan}`);
}
console.log(`\n${detectados} de ${MUTANTES.length} mutantes detectados`);
process.exit(detectados === MUTANTES.length ? 0 : 1);
