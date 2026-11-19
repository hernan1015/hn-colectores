// [r79 · Codex n3-r79b-colector] CONTROL NEGATIVO contra la sha anterior de la rama (57f6cb4): su lib/ (con `git show`, en una carpeta
// temporal fuera del repo) corre test/precocido-cuadros.test.mjs, y TIENEN que fallar los dos tests de lo que pidió Codex:
//   · «una nativa que falta…» (el índice no decía cuáles metateselas faltan y el tiempo quedaba «completo»);
//   · «el ritmo se comprueba al ARRANCAR…» (el limitador sólo miraba al reservar el turno).
// Correr: node test/control-r79b.mjs [sha]  (dentro de gremlin/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = process.argv[2] || '57f6cb4';
const dir = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'control-r79b-'));
fs.mkdirSync(path.join(dir, 'lib'));
for (const a of fs.readdirSync(path.join(RAIZ, 'lib'))) {
  let txt; try { txt = execSync('git show ' + SHA + ':gremlin/lib/' + a, { cwd: RAIZ, encoding: 'utf8', maxBuffer: 1 << 26 }); } catch (e) { continue; }
  fs.writeFileSync(path.join(dir, 'lib', a), txt);
}
const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'test', 'precocido-cuadros.test.mjs')], {
  cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GREMLIN_LIB: pathToFileURL(path.join(dir, 'lib')).href + '/' },
});
fs.rmSync(dir, { recursive: true, force: true });
const fallan = (r.stdout.match(/^✖ .*$/gm) || []).filter((l) => !/failing tests/.test(l)).map((l) => l.replace(/ \(\d.*$/, ''));
const unicos = [...new Set(fallan)];
console.log(`con la lib de ${SHA} fallan ${unicos.length}:\n  ` + unicos.join('\n  '));
const deben = [/una nativa que falta/, /el ritmo se comprueba al ARRANCAR/];
const ok = deben.every((re) => unicos.some((l) => re.test(l)));
console.log(ok ? 'CONTROL OK: los dos tests de Codex fallan con la sha anterior' : 'CONTROL MAL: alguno pasa con la sha anterior');
process.exit(ok ? 0 : 1);
