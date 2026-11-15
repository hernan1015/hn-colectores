// node --test test/workflow.test.mjs · el workflow (como .txt hasta que local lo instale): sólo a mano y con la variable,
// seco por defecto, un caso por vez, < 6 h, sólo el secreto de lectura, la lib en el commit del sello y nada crudo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIB_COMMIT } from '../medir-caso.mjs';

const WF = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'granizo-beta-fase-b.workflow.yml.txt'), 'utf8');

test('sólo a mano, apagado hasta GRANIZO_BETA_B_ON=si, seco por defecto', () => {
  assert.doesNotMatch(WF, /schedule:/);
  assert.match(WF, /on:\n  workflow_dispatch:/);
  assert.match(WF, /if: \$\{\{ vars\.GRANIZO_BETA_B_ON == 'si' \}\}/);
  assert.match(WF, /options: \[seco, real\]\n        default: seco/);
});

test('un caso por vez en todo el repo, y menos de 6 h', () => {
  assert.match(WF, /concurrency:\n  group: granizo-beta-fase-b\n  cancel-in-progress: false/);
  const m = /timeout-minutes: (\d+)/.exec(WF);
  assert.ok(m && +m[1] < 360 && +m[1] >= 340);
  assert.doesNotMatch(WF, /matrix:/, 'nada de los 29 juntos');
});

test('permisos mínimos y sólo HN_AGRO_LECTURA; la lib en el commit del sello, sin dejar el token', () => {
  assert.match(WF, /permissions:\n  contents: read\n/);
  const secretos = [...new Set([...WF.matchAll(/secrets\.([A-Z_]+)/g)].map((x) => x[1]))];
  assert.deepEqual(secretos, ['HN_AGRO_LECTURA']);
  assert.ok(WF.includes('ref: ' + LIB_COMMIT));
  assert.equal(LIB_COMMIT.length, 40);
  assert.equal((WF.match(/persist-credentials: false/g) || []).length, 2);
  assert.match(WF, /path: granizo-beta-fase-b\/_app/);
  for (const f of ['granizo-vivo', 'goes-focos', 'goes-rayos', 'localidades-granizo']) assert.ok(WF.includes('netlify/functions/lib/' + f + '.mjs'));
});

test('las entradas van por env (nunca ${{ inputs }} dentro de un run) y se validan', () => {
  for (const bloque of WF.split(/\n\s+- /)) {
    const run = /run: \|?([\s\S]*)/.exec(bloque);
    if (run) assert.doesNotMatch(run[1], /\$\{\{\s*inputs\./, 'inputs en un run: ' + run[1].slice(0, 60));
  }
  assert.match(WF, /\[\[ "\$CASO" =~ \^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$ \]\]/);
});

test('tests antes de medir; el artefacto sube siempre, 90 días, sólo la salida', () => {
  assert.ok(WF.indexOf('npm test --prefix granizo-beta-fase-b') < WF.indexOf('node granizo-beta-fase-b/medir-caso.mjs'));
  assert.match(WF, /uses: actions\/upload-artifact@v4\n        with:\n          name: \$\{\{ steps\.nombre\.outputs\.n \}\}\n          path: \$\{\{ runner\.temp \}\}\/gbf\/\n          retention-days: 90/);
  assert.match(WF, /- name: Subir las métricas \(sin nada crudo\)\n        if: always\(\)/);
});
