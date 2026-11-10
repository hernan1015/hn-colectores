#!/usr/bin/env node
// Control negativo del vigía: rompe una cosa por vez (en una copia temporal) y cuenta cuántos tests la detectan.
// Si alguna falla pasa sin que ningún test caiga, el control falla. Uso: node vigia/test/control-negativo.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const V = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALLAS = [
  ['avisa también en alerta', 'lib/reglas.mjs', 'e.nivel === 1 && typeof e.h', '(e.nivel === 1 || e.nivel === 2) && typeof e.h'],
  ['el umbral del foco grande no se mira', 'lib/reglas.mjs', ".filter((g) => (g.firms_n || 0) >= R.firms_n || (g.goes_n || 0) >= R.goes_n)", '.filter(() => true)'],
  ['se repite el aviso activo', 'lib/reglas.mjs', 'if (!v || !v.activo) out.push(c);', 'out.push(c);'],
  ['foco repetido a 15 km', 'lib/reglas.mjs', 'kmEntre(c.lat, c.lon, v.detalle.lat, v.detalle.lon) <= FOCO_RADIO_KM', 'false'],
  ['un hit cuenta como invocación', 'lib/fuentes.mjs', 'if (/"Netlify Durable";', 'if (false && /"Netlify Durable";'],
  ['--seco manda el mail', 'vigia-satchi.mjs', 'if (!seco) {', 'if (true || !seco) {'],
  ['587 manda la clave sin STARTTLS', 'lib/correo.mjs', "if (!/STARTTLS/i.test(ehlo.todo)) throw new Error('el servidor no ofrece STARTTLS: no se manda la clave en claro');", ''],
  ['escalas a medias se usan igual', 'vigia-satchi.mjs', "if (!escalas || escalas.ok === false || !escalas.parana || !escalas.parana.ok) faltan.push('escalas');", "if (!escalas || escalas.ok === false || !escalas.parana) faltan.push('escalas');"],
  ['pronóstico a cualquier hora', 'vigia-satchi.mjs', 'const prono = (todo || horaProno) ?', 'const prono = true ?'],
  ['manda aunque no se guardó', 'vigia-satchi.mjs', 'if (guardado && van.length) {', 'if (van.length || avisar.length) {'],
  ['sin reintento con rebase', 'lib/estado-git.mjs', "if (git([...QUIEN, 'pull', '-q', '--rebase', remoto, rama], dir, true) == null) {", 'if (true) {'],
  ['push fallido cuenta como guardado', 'lib/estado-git.mjs', "return git(['push', '-q', remoto, 'HEAD:refs/heads/' + rama], dir, true) != null ? efectivos : false;", 'return efectivos;'],
  ['pisa lo que guardó otra corrida', 'lib/estado-git.mjs', 'const m = new Map(ultimo);', 'const m = new Map(base || []);'],
  ['repite lo que ya avisó otra corrida', 'lib/estado-git.mjs', 'const efectivos = nuevos(avisar, ultimo, ahoraMs);', 'const efectivos = avisar;'],
];
function correrTests(dir) {
  const r = spawnSync(process.execPath, ['--test', 'test/vigia.test.mjs', 'test/estado-git.test.mjs'], { cwd: dir, encoding: 'utf8' });
  const n = (k) => Number(((r.stdout || '').match(new RegExp('(?:ℹ|#) ' + k + ' ([0-9]+)')) || [])[1] ?? NaN);
  return { pasan: n('pass'), fallan: n('fail') };
}
const base = correrTests(V);
console.log('sin fallas: ' + base.pasan + ' pasan, ' + base.fallan + ' fallan');
if (!(base.pasan > 0) || base.fallan !== 0) { console.log('la suite tiene que pasar entera antes del control'); process.exit(1); }
let malos = 0;
for (const [nombre, archivo, de, a] of FALLAS) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-ctrl-'));
  fs.cpSync(V, d, { recursive: true });
  const f = path.join(d, archivo), src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const veces = src.split(de).length - 1;
  if (veces !== 1) { console.log('✗ ' + nombre + ': el texto a romper aparece ' + veces + ' veces'); malos++; continue; }
  fs.writeFileSync(f, src.replace(de, a));
  const r = correrTests(d);
  fs.rmSync(d, { recursive: true, force: true });
  if (r.fallan > 0) console.log('✓ ' + nombre + ': ' + r.fallan + ' test(s) en rojo');
  else { console.log('✗ ' + nombre + ': NINGÚN test la detecta'); malos++; }
}
console.log(malos ? malos + ' fallas sin detectar' : 'todas las fallas detectadas');
process.exit(malos ? 1 : 0);
