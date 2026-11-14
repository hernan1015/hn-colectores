// node --test smn-abierto/test/estatico.test.mjs   (sin red ni base)
// El workflow (apagado, sólo workflow_dispatch, sin secretos en el texto) y el PRENDER. Cada uno con su control negativo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WF = fs.readFileSync(path.join(RAIZ, 'smn-abierto.workflow.yml.txt'), 'utf8').replace(/\r\n/g, '\n');
const PRENDER = fs.readFileSync(path.join(RAIZ, 'PRENDER.md'), 'utf8');
const sinComentarios = (s) => s.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
const SECRETO = /postgres(ql)?:\/\/[^<\s$]+:[^<\s$]+@|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/;

test('workflow: APAGADO (sin schedule), sólo workflow_dispatch, seco por defecto, contents: read', () => {
  const w = sinComentarios(WF);
  assert.doesNotMatch(w, /^\s*schedule\s*:/m);
  assert.doesNotMatch(w, /^\s*-\s*cron\s*:/m);
  assert.match(w, /^\s*workflow_dispatch\s*:/m);
  assert.match(w, /options: \[seco, real\]\n\s+default: seco/);
  assert.match(w, /permissions:\n\s+contents: read/);
  assert.match(w, /node smn-abierto\/smn\.mjs/);
  /* los secretos van por secrets.*, nunca literales */
  assert.match(w, /SMN_PG_URL: \$\{\{ secrets\.SIPAN_PG_URL \}\}/);
  assert.doesNotMatch(WF, SECRETO);
  /* control negativo: el detector de schedule encuentra uno si lo hubiera */
  assert.match('on:\n  schedule:\n    - cron: "1 * * * *"', /^\s*schedule\s*:/m);
  assert.match('postgresql://u:clave@host:6543/postgres', SECRETO);
});

test('PRENDER: el orden (0149, 0149b, instalar, seco, real, llave) y nada secreto', () => {
  const orden = ['0149_smn_abierto_rol.sql', '0149b_smn_abierto_disparo.sql', 'smn-abierto.workflow.yml.txt', 'modo=seco', 'modo=real', "etiqueta = 'smn-abierto'"];
  let i = -1;
  for (const o of orden) { const j = PRENDER.indexOf(o, i + 1); assert.ok(j > i, 'falta o fuera de orden: ' + o); i = j; }
  assert.match(PRENDER, /CC BY 2\.5 AR/);
  assert.doesNotMatch(PRENDER, SECRETO);
});
