// [r77] Control negativo CONTADO de test/precocido.test.mjs: rompe una cosa por vez en una copia de lib/ y exige rojo.
// Antes corre la copia SIN romper (tiene que pasar entera). Correr: node test/control-precocido.mjs  (dentro de gremlin/)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const F = 'precocido.mjs';
const MUTANTES = [
  ['la ruta sin el zoom', F, '`${RAIZ}/${prod}/${t}/${z}/${x}/${y}.png`', '`${RAIZ}/${prod}/${t}/${x}/${y}.png`'],
  ['x e y cruzados', F, '`${RAIZ}/${prod}/${t}/${z}/${x}/${y}.png`', '`${RAIZ}/${prod}/${t}/${z}/${y}/${x}.png`'],
  ['sólo hasta z4', F, 'export const Z_MIN = 3, Z_MAX = 5;', 'export const Z_MIN = 3, Z_MAX = 4;'],
  ['la llave ignorada', F, "if (llave !== 'si') {", 'if (false) {'],
  ['seco que baja igual', F, "if (modo === 'seco') {", 'if (false) {'],
  ['escribe la tesela a la que le faltó una nativa', F, 'if (rp.faltan > 0) { faltan++; continue; }', ''],
  ['incompleto marcado como completo', F, "const estado = faltan === 0 ? 'completo' : 'incompleto'", "const estado = 'completo'"],
  ['acepta nativas que no son PNG válidos', F, "const img = r.status === 200 && !motivoPngMalo(r.buf) ? decodificarPng(r.buf) : null;", 'const img = decodificarPng(r.buf) || (r.status === 200 ? { w: 678, h: 678, rgba: new Uint8Array(678 * 678 * 4) } : null);'],
  ['rehace los completos', F, "if (q && (q.estado === 'completo' || (q.intentos || 0) >= MAX_INTENTOS)) continue;", "if (q && (q.intentos || 0) >= MAX_INTENTOS) continue;"],
  ['sin tope de intentos', F, "if (q && (q.estado === 'completo' || (q.intentos || 0) >= MAX_INTENTOS)) continue;", "if (q && q.estado === 'completo') continue;"],
  ['del más viejo al más nuevo', F, 'cola.sort((a, b) => b.ms - a.ms ||', 'cola.sort((a, b) => a.ms - b.ms ||'],
  ['sin tope de pedidos', F, 'if (res.pedidos + plan.nativas.size > maxPedidos) {', 'if (false) {'],
  ['sin UA', F, "headers: { 'user-agent': UA, accept:", 'headers: { accept:'],
  ['no corta ante un 429', F, "if (r.status === 429 || r.status === 403) cortar = `SLIDER respondió ${r.status}`;\n      else ", ''],
  ['retención sin límite (no borra nunca)', F, "const viejos = Object.keys(e.ind.tiempos).filter((t) => !(tiempoMs(t) >= desde));", 'const viejos = [];'],
  ['borra las teselas ANTES de sacar el tiempo del índice', F, "        res.sacados += viejos.length;\n        await almacen.escribir(claveIndice(prod), JSON.stringify(e.ind), { tipo: 'application/json', cache: CACHE_INDICE });\n", '        res.sacados += viejos.length;\n'],
  ['borra con el reloj adelantado', F, 'if (!Number.isFinite(masNuevoMs) || ahoraMs - masNuevoMs > ADELANTO_MAX_MS) {', 'if (false) {'],
  ['la retención sin acotar', F, 'export const acotarRetencion = (v) => acotar(v, RETENCION_DEF_H, RETENCION_MIN_H, RETENCION_MAX_H);', 'export const acotarRetencion = (v) => Number(v) || RETENCION_DEF_H;'],
  ['retención de 12 h por defecto', F, 'RETENCION_DEF_H = 6,', 'RETENCION_DEF_H = 12,'],
  ['el visible de noche pide nativas', F, "if (PRODUCTOS[prod].diurno && enteraDeNoche(z, x, y, ms)) {", 'if (false) {'],
  ['el índice antes de las teselas', F, "    await enParalelo(aEscribir, PARALELO_ESCRITURA, async ({ s, png }) => {", "    await almacen.escribir(claveIndice(prod), '{}', { tipo: 'application/json' });\n    await enParalelo(aEscribir, PARALELO_ESCRITURA, async ({ s, png }) => {"],
  ['cita sin GREMLIN', F, "cita: prod === 'gremlin' ? CITA_GREMLIN + ' · ' + CITA : CITA,", 'cita: CITA,'],
  ['la copia de la lib tocada', 'satelite-slider.copia.mjs', 'export const BORDE_GRADOS = 1;', 'export const BORDE_GRADOS = 2;'],
];
function correrCon(nombre, archivo, viejo, nuevo) {
  const dir = path.join(RAIZ, '.mutante-precocido');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(RAIZ, 'lib'), path.join(dir, 'lib'), { recursive: true });
  if (archivo) {
    const p = path.join(dir, 'lib', archivo), txt = fs.readFileSync(p, 'utf8'), veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'test', 'precocido.test.mjs')], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GREMLIN_LIB: pathToFileURL(path.join(dir, 'lib')).href + '/' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { codigo: r.status, fallan: Number((r.stdout.match(/ℹ fail (\d+)/) || [])[1] || 0) };
}
const base = correrCon('sin romper', null);
if (base.codigo !== 0) { console.log(`la copia SIN romper falla (${base.fallan} tests): el control no vale`); process.exit(2); }
console.log('copia sin romper: pasa entera');
let detectados = 0;
for (const [nombre, archivo, viejo, nuevo] of MUTANTES) {
  const r = correrCon(nombre, archivo, viejo, nuevo); const ok = r.codigo !== 0; if (ok) detectados++;
  console.log(`${ok ? 'detectado ' : 'NO DETECTADO'} · ${nombre} · tests que fallan: ${r.fallan}`);
}
console.log(`\n${detectados} de ${MUTANTES.length} mutantes detectados`);
process.exit(detectados === MUTANTES.length ? 0 : 1);
