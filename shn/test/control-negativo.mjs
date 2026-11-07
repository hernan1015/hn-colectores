#!/usr/bin/env node
// Control negativo: rompe el colector a propósito (una falla por vez, en una copia temporal) y cuenta
// cuántos tests la detectan. Si alguna falla pasa sin que ningún test caiga, el control falla.
// Uso: node shn/test/control-negativo.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALLAS = [
  ['alerta repetida', 'lib/colector.mjs', "if (previo.split('\\n').some((l) => l.slice(22) === msg)) return false;", ''],
  ['reintentos en bucle', 'lib/colector.mjs', 'for (let intento = 0; intento < 2; intento++) {\n    const falta', 'for (let intento = 0; intento < 5; intento++) {\n    const falta'],
  ['429 no corta', 'lib/colector.mjs', 'if (r.status === 429 || r.status === 403)', 'if (false)'],
  ['bloqueo anotado ignorado', 'lib/colector.mjs', 'if (PIDE_AL_SHN.has(modo) && !o.forzar) {', 'if (false) {'],
  ['pausa de 2 s', 'lib/colector.mjs', 'pausaBaseMs: 6000,', 'pausaBaseMs: 2000,'],
  ['candado sin vencimiento', 'lib/colector.mjs', 'if (actual && Date.parse(actual.vence) > ctx.ahora())', 'if (actual)'],
  ['candado ajeno se suelta', 'lib/colector.mjs', 'if (actual?.token === ctx.candado.token) await', 'await'],
  ['no rellena huecos', 'lib/colector.mjs', 'if (new Date(T.getTime() - 12 * 3600e3) <= limite) break;', 'break;'],
  ['SVG mal parseado', 'lib/colector.mjs', '/<desc class="value">([^<]*)<\\/desc>/g', '/<desc class="valor">([^<]*)<\\/desc>/g'],
  ['modelo duplicado', 'lib/colector.mjs', "if (!(await ctx.almacen.escribir(kSvg, cuerpo, { soloSiNoExiste: true })))", 'if (!(await ctx.almacen.escribir(kSvg, cuerpo)))'],
  ['valores en la consola', 'lib/colector.mjs', 'publico(ctx, `horario ${cod}: ${r.pedidos} pedidos, ${r.nuevas} horas nuevas`);', 'publico(ctx, `horario ${cod}: ${r.pedidos} pedidos, ${r.nuevas} horas nuevas, ${r.ultima}`);'],
  ['firma sin ordenar la query', 'lib/almacen.mjs', 'const canonQuery = Object.keys(query).sort()', 'const canonQuery = Object.keys(query)'],
  ['R2 pisa con soloSiNoExiste', 'lib/almacen.mjs', "if (soloSiNoExiste) headers['if-none-match'] = '*';", ''],
  ['subida pisa lo existente', 'subir-historia.mjs', 'if (!yaEnR2.has(clave)) {', 'if (true) {'],
  ['fusión: manda la PC', 'lib/colector.mjs', 'm.set(h, { med: v.med ?? w.med, ast: v.ast ?? w.ast });', 'm.set(h, { med: w.med ?? v.med, ast: w.ast ?? v.ast });'],
];

function correrTests(dir) {
  const r = spawnSync(process.execPath, ['--test', 'test/colector.test.mjs', 'test/almacen.test.mjs'], { cwd: dir, encoding: 'utf8' });
  const n = (k) => Number(((r.stdout || '').match(new RegExp(`ℹ ${k} (\\d+)`)) || [])[1] ?? NaN);
  return { pasan: n('pass'), fallan: n('fail') };
}
function copia() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shn-ctrl-'));
  fs.cpSync(SHN, d, { recursive: true });
  return d;
}

const base = correrTests(SHN);
console.log(`sin fallas: ${base.pasan} pasan, ${base.fallan} fallan`);
if (!(base.pasan > 0) || base.fallan !== 0) { console.log('la suite tiene que pasar entera antes del control'); process.exit(1); }
let malos = 0;
for (const [nombre, archivo, de, a] of FALLAS) {
  const d = copia();
  const f = path.join(d, archivo);
  const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const veces = src.split(de).length - 1;
  if (veces !== 1) { console.log(`✗ ${nombre}: el texto a romper aparece ${veces} veces (actualizar el control)`); malos++; continue; }
  fs.writeFileSync(f, src.replace(de, a));
  const r = correrTests(d);
  const ok = r.fallan > 0;
  if (!ok) malos++;
  console.log(`${ok ? '✓' : '✗'} ${nombre}: ${r.fallan} tests caen`);
  fs.rmSync(d, { recursive: true, force: true });
}
console.log(`control negativo: ${FALLAS.length - malos} de ${FALLAS.length} fallas detectadas`);
process.exitCode = malos ? 1 : 0;
