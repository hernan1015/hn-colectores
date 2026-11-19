// HN AGRO · estaciones-parseo · lo que el código NO puede hacer, mirado en el código y en el workflow:
//   no le pide nada a ninguna fuente, no escribe en R2, sólo entra con el rol, la llave está y el log es de cantidades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RAIZ, FIX, archivos } from './ayuda.mjs';
import { almacenDeCarpeta } from '../lib/almacen.mjs';
import { conectarPg, hostDeUrl } from '../lib/base.mjs';
import { REDES } from '../fuentes/index.mjs';

const codigo = archivos(RAIZ).filter((p) => p.endsWith('.mjs') && !p.includes(path.sep + 'test' + path.sep));
const WF = fs.readFileSync(path.join(RAIZ, 'estaciones-parseo.workflow.yml.txt'), 'utf8');

test('el código del job no hace pedidos (sin fetch ni http) y no escribe ni borra en el almacén', () => {
  for (const p of codigo) {
    const t = fs.readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(t, /\bfetch\s*\(|node:https?|['"]https?['"]/, path.basename(p));
    assert.doesNotMatch(t, /\.(escribir|borrar)\s*\(/, path.basename(p));
  }
});

test('el almacén que recibe el job es de SÓLO LECTURA (congelado, sin escribir ni borrar)', () => {
  const a = almacenDeCarpeta(FIX);
  assert.equal(typeof a.leer, 'function');
  assert.equal(typeof a.listar, 'function');
  assert.equal(a.escribir, undefined);
  assert.equal(a.borrar, undefined);
  assert.ok(Object.isFrozen(a));
});

test('la base: sólo el rol colector_estaciones, sólo el pooler de Supabase, y si entra otro usuario se corta', async () => {
  const falso = (u) => () => { const s = { unsafe: async () => [{ u, s: u }], end: async () => {} }; return s; };
  await assert.rejects(conectarPg({ url: 'postgresql://postgres.ref:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres', conectar: falso('postgres') }), /usuario colector_estaciones/);
  await assert.rejects(conectarPg({ url: 'postgresql://colector_estaciones.ref:x@otro.ejemplo.com:6543/postgres', conectar: falso('colector_estaciones') }), /pooler/);
  await assert.rejects(conectarPg({ url: 'postgresql://colector_estaciones.ref:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres', conectar: falso('postgres') }), /otro usuario/);
  const db = await conectarPg({ url: 'postgresql://colector_estaciones.ref:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres', conectar: falso('colector_estaciones') });
  assert.equal(db.tipo, 'pg');
  assert.equal(hostDeUrl('postgresql://u:cl@ve@h.pooler.supabase.com:6543/postgres'), null);   // un «@» sin codificar en la clave
});

test('el workflow: workflow_run después de colector-estaciones-privadas, la llave ESTACIONES_PARSEO_ON, contents: read', () => {
  assert.match(WF, /workflow_run:\s*\n\s*workflows: \[colector-estaciones-privadas\]/);
  assert.match(WF, /vars\.ESTACIONES_PARSEO_ON == 'si'/);
  assert.match(WF, /permissions:\s*\n\s*contents: read\s*\n/);
  assert.doesNotMatch(WF, /contents: write|actions: write|id-token/);
  assert.match(WF, /default: seco/);
  // sin la llave sólo entra el seco a mano; la URL de la base sólo llega en real
  assert.match(WF, /\(github\.event_name == 'workflow_dispatch' && inputs\.modo == 'seco'\) \|\|\s*\n\s*\(vars\.ESTACIONES_PARSEO_ON == 'si' &&/);
  assert.match(WF, /PARSEO_PG_URL: \$\{\{ \(github\.event_name != 'workflow_dispatch' \|\| inputs\.modo == 'real'\) && secrets\.SIPAN_PG_URL \|\| '' \}\}/);
});

test('el workflow: los secretos sólo por nombre (token de R2 de sólo lectura y el rol del colector); nada se imprime', () => {
  const secretos = [...WF.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(secretos)], ['PARSEO_R2_ACCESS_KEY_ID', 'PARSEO_R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'SIPAN_PG_URL']);
  assert.doesNotMatch(WF, /secrets\.R2_ACCESS_KEY_ID|secrets\.R2_SECRET_ACCESS_KEY/);   // NO el token de escritura de la ronda
  assert.doesNotMatch(WF, /echo .*\$\{?(PARSEO|R2|SIPAN)/);
  assert.doesNotMatch(WF, /set -x/);
});

test('las redes del parseo están todas en la política de la 0161', () => {
  const sql = fs.readFileSync(path.join(RAIZ, 'esquema', '0161_estaciones_parseo_unificada_COPIA.sql'), 'utf8');
  const nuevas = /nuevas constant text\[\] := array\[([^\]]+)\]/.exec(sql)[1];
  for (const r of REDES) assert.ok(nuevas.includes(`'${r}'`), r);
});

test('la copia de la 0161 es IGUAL a la de hn-agro (si está a mano: HN_AGRO_RAIZ)', { skip: process.env.HN_AGRO_RAIZ ? false : 'sin HN_AGRO_RAIZ' }, () => {
  const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.equal(h(path.join(RAIZ, 'esquema', '0161_estaciones_parseo_unificada_COPIA.sql')),
    h(path.join(process.env.HN_AGRO_RAIZ, 'migrations', '0161_estaciones_parseo_unificada_PROPUESTA.sql')));
});
