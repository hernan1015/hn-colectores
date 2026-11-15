#!/usr/bin/env node
// 257 · control negativo de los tests: se rompe el código a propósito (una copia en una carpeta temporal) y los
// tests TIENEN que fallar. Si alguna mutación pasa los tests, el test no está cuidando eso.
//   node test/control-negativo.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTANTES = [
  ['umbral de urbana 30 → 3', 'lib/regla.mjs', 'export const UMBRAL_URBANA = 30;', 'export const UMBRAL_URBANA = 3;'],
  ['desempate al revés', 'lib/regla.mjs', "['agricola', 'pastizal', 'natural'].sort(", "['natural', 'pastizal', 'agricola'].sort("],
  ['el 0 cuenta como dato', 'lib/regla.mjs', 'for (const c of CLASES) total += conteos?.[c] || 0;', 'for (const c of [0, ...CLASES]) total += conteos?.[c] || 0;'],
  ['píxel corrido una columna', 'lib/grilla.mjs', 'return { gx: Math.floor((lon + 180) * PX_POR_GRADO)', 'return { gx: 1 + Math.floor((lon + 180) * PX_POR_GRADO)'],
  ['tile nombrado por la esquina norte', 'lib/grilla.mjs', 'const latS = 90 - (ty + 1) * 3;', 'const latS = 90 - ty * 3;'],
  ['un 503 se toma como tile faltante', 'lib/worldcover.mjs', "/\\b(404|403)\\b|Not Found|Forbidden/i", "/\\b(404|403|503)\\b|Not Found|Forbidden/i"],
  ['se mira sólo el píxel', 'lib/worldcover.mjs', 'if (d <= r) conteos[r][v]', 'if (gx === gxP && gy === gyP) conteos[r][v]'],
  ['la caché no se usa', 'lib/worldcover.mjs', 'if (enCache) { out.set(p.clave, enCache); continue; }', ''],
];

let malos = 0;
for (const [nombre, archivo, de, a] of MUTANTES) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zona257-'));
  fs.cpSync(RAIZ, tmp, { recursive: true, filter: (s) => !/[\\/](node_modules|cache|datos)([\\/]|$)/.test(s) });
  const f = path.join(tmp, archivo);
  const txt = fs.readFileSync(f, 'utf8');
  if (!txt.includes(de)) { console.log(`✗ ${nombre}: no encontré el texto a mutar`); malos++; continue; }
  fs.writeFileSync(f, txt.replace(de, a));
  const r = spawnSync(process.execPath, ['--test', path.join(tmp, 'test', 'zona.test.mjs')], { encoding: 'utf8' });
  const cae = r.status !== 0;
  console.log(`${cae ? '✓' : '✗'} ${nombre}: ${cae ? 'los tests fallan (bien)' : 'LOS TESTS PASAN (mal)'}`);
  if (!cae) malos++;
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(malos ? `${malos} mutantes vivos` : `los ${MUTANTES.length} mutantes caen`);
process.exit(malos ? 1 : 0);
