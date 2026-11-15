// [_v1815] Control negativo CONTADO de test/publico.test.mjs: rompe una cosa por vez en una copia de lib/ y exige rojo.
// Correr: node test/control-publico.mjs (dentro de rayos-hora/).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUT = [
  ['otra clave pública', 'publico.mjs', "}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}/", "}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/"],
  ['pierde los faltantes', 'publico.mjs', 'faltantes: Array.isArray(doc.faltantes) ? doc.faltantes : [],', 'faltantes: [],'],
  ['no es idempotente', 'publico.mjs', 'if (idx.horas[marca] === pub.estado) { res.ya++; continue; }', ''],
  ['no respeta el rango', 'publico.mjs', 'if (h != null && h >= desdeMs && h <= hastaMs)', 'if (h != null)'],
  ['sin Cache-Control', 'almacen.mjs', "if (cache) headers['cache-control'] = cache;", ''],
  ['copia la de otra hora', 'publico.mjs', 'if (!pub || Date.parse(pub.hora) !== h) { res.ilegibles++; continue; }', 'if (!pub) { res.ilegibles++; continue; }'],
];
const correr = (dir) => spawnSync(process.execPath, ['--test', path.join(dir, 'test', 'publico.test.mjs')], { encoding: 'utf8' }).status === 0;
let mal = 0;
for (const [n, arch, de, a] of MUT) {
  const dir = path.join(RAIZ, '.mutante-pub');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const f of fs.readdirSync(path.join(RAIZ, 'lib'))) fs.copyFileSync(path.join(RAIZ, 'lib', f), path.join(dir, 'lib', f));
  fs.copyFileSync(path.join(RAIZ, 'test', 'publico.test.mjs'), path.join(dir, 'test', 'publico.test.mjs'));
  const p = path.join(dir, 'lib', arch), s = fs.readFileSync(p, 'utf8');
  if (s.split(de).length !== 2) { console.log('✗ ' + n + ': no encontré el texto'); mal++; continue; }
  fs.writeFileSync(p, s.replace(de, a));
  const verde = correr(dir);
  console.log((verde ? '✗ SIGUE VERDE · ' : '✓ rojo · ') + n); if (verde) mal++;
  fs.rmSync(dir, { recursive: true, force: true });
}
const ok = correr(RAIZ); console.log((ok ? '✓ verde' : '✗ ROJO') + ' · sin romper nada'); if (!ok) mal++;
console.log(mal ? mal + ' mal' : MUT.length + ' de ' + MUT.length + ' mutantes detectados');
process.exit(mal ? 1 : 0);
