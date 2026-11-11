// Tests del vigía de frescura OPERA: sin red ni mail. «hoy» fijo = 2026-11-11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { evaluar } from '../opera-frescura.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const D = (n) => path.join(AQUI, 'datos', n);
const leer = (n) => JSON.parse(fs.readFileSync(D(n), 'utf8'));
const HOY = '2026-11-11';

test('índice de hace 4 días → avisa, con la clave de su «hasta»', () => {
  const v = evaluar(leer('opera_pasadas_hace4d.json'), HOY);
  assert.equal(v.avisar, true); assert.equal(v.tipo, 'atraso'); assert.equal(v.dias, 4); assert.equal(v.clave, 'opera-atraso-2026-11-07');
});
test('índice de hace 1 día → no avisa', () => {
  const v = evaluar(leer('opera_pasadas_hace1d.json'), HOY);
  assert.equal(v.avisar, false); assert.equal(v.dias, 1);
});
test('el borde: 3 días justos no avisa (la regla es «pasa de 3»)', () => {
  assert.equal(evaluar({ ok: true, fuente: 'r2', hasta: '2026-11-08' }, HOY).avisar, false);
  assert.equal(evaluar({ ok: true, fuente: 'r2', hasta: '2026-11-07' }, HOY).avisar, true);
});
test('fuente que no es r2 → avisa aunque la fecha esté al día', () => {
  const v = evaluar({ ok: true, fuente: 'deploy', hasta: '2026-11-10' }, HOY);
  assert.equal(v.avisar, true); assert.equal(v.tipo, 'fuente'); assert.equal(v.clave, 'opera-fuente-deploy-2026-11-10');
});
test('ok:false o sin respuesta → avisa', () => {
  assert.equal(evaluar({ ok: false }, HOY).tipo, 'caido');
  assert.equal(evaluar(null, HOY).avisar, true);
});
test('no repite: el mismo «hasta» da la misma clave en días distintos; un «hasta» nuevo, otra', () => {
  const r = { ok: true, fuente: 'r2', hasta: '2026-10-25' };
  assert.equal(evaluar(r, '2026-11-11').clave, evaluar(r, '2026-11-20').clave);
  assert.notEqual(evaluar(r, '2026-11-11').clave, evaluar({ ...r, hasta: '2026-11-01' }, '2026-11-11').clave);
});
test('el CLI en modo evaluar escribe avisar y clave en GITHUB_OUTPUT (fixture, sin red)', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opera-frescura-')), 'gh_output');
  const cli = path.join(AQUI, '..', 'opera-frescura.mjs');
  execFileSync(process.execPath, [cli, 'evaluar', '--fixture', D('opera_pasadas_hace4d.json'), '--hoy', HOY], { env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.match(fs.readFileSync(out, 'utf8'), /avisar=si\nclave=opera-atraso-2026-11-07/);
  fs.writeFileSync(out, '');
  execFileSync(process.execPath, [cli, 'evaluar', '--fixture', D('opera_pasadas_hace1d.json'), '--hoy', HOY], { env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.match(fs.readFileSync(out, 'utf8'), /avisar=no\nclave=ninguna/);
});
test('control negativo: con la regla rota (umbral 99 días) el fixture de hace 4 días dejaría de avisar', async () => {
  const src = fs.readFileSync(path.join(AQUI, '..', 'opera-frescura.mjs'), 'utf8').replace('export const DIAS_MAX = 3;', 'export const DIAS_MAX = 99;');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-frescura-cn-'));
  fs.mkdirSync(path.join(tmp, 'lib')); fs.copyFileSync(path.join(AQUI, '..', 'lib', 'correo.mjs'), path.join(tmp, 'lib', 'correo.mjs'));
  fs.writeFileSync(path.join(tmp, 'opera-frescura.mjs'), src);
  const { evaluar: rota } = await import(pathToFileURL(path.join(tmp, 'opera-frescura.mjs')).href);
  assert.equal(rota(leer('opera_pasadas_hace4d.json'), HOY).avisar, false);   // el test de «avisa» caería
});
