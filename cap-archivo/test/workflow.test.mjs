// node --test cap-archivo/test/workflow.test.mjs
// El workflow (como .txt hasta que local lo instale): APAGADO por variable, cada 10 min, seco a mano por defecto,
// permisos mínimos y sólo los secretos que hacen falta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WF = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cap-archivo.workflow.yml.txt'), 'utf8');

test('apagado hasta CAP_ARCHIVO_ON=si; a mano, seco por defecto', () => {
  assert.match(WF, /if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| vars\.CAP_ARCHIVO_ON == 'si' \}\}/);
  assert.match(WF, /default: seco/);
  assert.match(WF, /MODO: \$\{\{ github\.event_name == 'schedule' && 'real' \|\| inputs\.modo \}\}/);
});

test('cada 10 min (6 por hora), lejos de la hora en punto y de los minutos del granizo', () => {
  const m = /cron: '([\d,]+) \* \* \* \*'/.exec(WF);
  assert.ok(m);
  const mins = m[1].split(',').map(Number);
  assert.equal(mins.length, 6);
  for (let i = 1; i < 6; i++) assert.equal(mins[i] - mins[i - 1], 10);
  assert.ok(!mins.includes(0) && !mins.some((x) => x % 10 === 7), 'no choca con granizo-archivo (7,17,…)');
});

test('permisos mínimos, una corrida por vez, y sólo RADAR_TOKEN y CAP_PG_URL', () => {
  assert.match(WF, /permissions:\n  contents: read/);
  assert.match(WF, /concurrency:\n  group: cap-archivo\n  cancel-in-progress: false/);
  const secretos = [...WF.matchAll(/secrets\.([A-Z_]+)/g)].map((x) => x[1]).sort();
  assert.deepEqual([...new Set(secretos)], ['CAP_PG_URL', 'RADAR_TOKEN']);
  assert.match(WF, /CAP_REPO: hernan1015\/hn-radar/);
  assert.match(WF, /npm test --prefix cap-archivo/, 'los tests corren antes de archivar');
});
