// node --test test/estatico.test.mjs · lo que tiene que valer siempre en el TEXTO (sin base ni red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ } from './fixtures.mjs';

const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const JS = ['parseo.mjs', 'formato.mjs', 'lib/convertir.mjs', 'lib/dia.mjs', 'lib/guardar.mjs', 'fuentes/index.mjs', 'fuentes/weatherlink.mjs', 'fuentes/weathercloud.mjs'];
const sinComentarios = (t) => t.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l)).join('\n');

test('el workflow: sin schedule ni push; corre después de la ronda, detrás de la llave, y a mano en seco', () => {
  const y = sinComentarios(leer('estaciones-privadas-parseo.workflow.yml.txt'));
  assert.doesNotMatch(y, /^\s*schedule:/m); assert.doesNotMatch(y, /^\s*(push|pull_request):/m);
  assert.match(y, /workflow_run:\s*\n\s*workflows: \[colector-estaciones-privadas\]\s*\n\s*types: \[completed\]/);
  assert.match(y, /vars\.ESTACIONES_PARSEO_ON == 'si'/);
  assert.match(y, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(y, /default: seco/);
  assert.match(y, /permissions:\s*\n\s*contents: read/);
  assert.ok(!fs.existsSync(path.join(RAIZ, '..', '..', '.github', 'workflows', 'estaciones-privadas-parseo.yml')), 'no se instala acá');
});

test('sólo lee R2 y no le pide nada a ninguna fuente', () => {
  for (const f of JS) {
    const t = sinComentarios(leer(f));
    assert.doesNotMatch(t, /\bfetch\(/, f);
    assert.doesNotMatch(t, /\.(escribir|borrar)\(/, f);
    assert.doesNotMatch(t, /weatherlink\.com|weathercloud\.net\/map/i, f);
  }
});

test('la salida del job: sólo cantidades (no se imprimen ids, nombres ni coordenadas)', () => {
  const t = leer('parseo.mjs');
  assert.equal((t.match(/console\.(log|error)\(/g) || []).length, 2);
  assert.match(t, /console\.log\(JSON\.stringify\(res\)\)/);
});

test('Weathercloud nace sin verificar; mostrar = false en las dos fuentes', () => {
  assert.match(leer('formato.mjs'), /export const WEATHERCLOUD = \{\s*\n\s*verificado: false,/);
  for (const f of ['fuentes/weatherlink.mjs', 'fuentes/weathercloud.mjs']) assert.match(leer(f), /mostrar: false/);
});

test('la migración es PROPUESTA y sin secretos; ningún archivo con claves', () => {
  assert.ok(fs.existsSync(path.join(RAIZ, 'migracion', '0152_parseo_estaciones_privadas_rol_PROPUESTA.sql')));
  for (const f of [...JS, 'PRENDER.md', 'estaciones-privadas-parseo.workflow.yml.txt', 'migracion/0152_parseo_estaciones_privadas_rol_PROPUESTA.sql']) {
    if (!fs.existsSync(path.join(RAIZ, f))) continue;
    const t = leer(f);
    assert.doesNotMatch(t, /postgres(ql)?:\/\/[^<\s'"`]*:[^<\s'"`@]{6,}@/, f);
    assert.doesNotMatch(t, /\b(ghp_|github_pat_|sb_secret_|eyJhbGci)/, f);
  }
});
