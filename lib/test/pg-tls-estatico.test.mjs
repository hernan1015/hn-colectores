// node --test lib/test/pg-tls-estatico.test.mjs
// La 264, test ESTÁTICO: en todo el repo (menos node_modules y las carpetas test/), ningún archivo que importe postgres
// lo hace sin lib/pg-tls.mjs, y nadie baja la verificación (rejectUnauthorized false, ssl 'require', sslmode=require…).
// Cuando entre un colector nuevo (la 257, la 260, el parseo, cap-archivo…), este test lo revisa solo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { revisar, revisarRepo } from './pg-tls-reglas.mjs';

const RAIZ = process.env.PG_TLS_RAIZ || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('ningún colector abre Postgres sin conTls/pgTls, y nadie baja la verificación', () => {
  const r = revisarRepo(RAIZ);
  assert.ok(r.archivos.length >= 5, 'el recorrido no encontró archivos: el test no estaría mirando nada');
  /* el inventario no puede quedar vacío: hoy en main abre Postgres sipan (lib/base.mjs) */
  assert.ok(r.abrenPg.includes('sipan-alto-valle/lib/base.mjs'), `inventario: ${r.abrenPg.join(', ')}`);
  assert.deepEqual(r.violaciones, []);
});

const SIPAN = path.join(RAIZ, 'sipan-alto-valle', 'lib', 'base.mjs');
test('control negativo: si se saca el helper de un colector (sipan), el estático da ROJO', () => {
  const t = fs.readFileSync(SIPAN, 'utf8').replace(/\r\n/g, '\n');
  assert.deepEqual(revisar(t, 'sipan-alto-valle/lib/base.mjs'), []);
  const sinImport = t.replace("import { conTls } from '../../lib/pg-tls.mjs';\n", '');
  assert.notEqual(sinImport, t);
  assert.ok(revisar(sinImport, 'x.mjs').some((v) => /no importa lib\/pg-tls/.test(v)));
  const sinLlamada = t.replace(/conTls\(url, (\{[\s\S]*?\}), \{ ca \}\)/, '$1');
  assert.notEqual(sinLlamada, t);
  assert.ok(revisar(sinLlamada, 'x.mjs').some((v) => /no arma el ssl/.test(v)));
  const conRequire = t.replace("connection: { application_name: 'colector-sipan' } }", "connection: { application_name: 'colector-sipan' }, ssl: 'require' }");
  assert.notEqual(conRequire, t);
  assert.ok(revisar(conRequire, 'x.mjs').length >= 2);   // ssl propio + 'require'
});

test('control negativo: las formas de abrir Postgres sin verificar se detectan', () => {
  const malos = [
    "import postgres from 'postgres';\nconst sql = postgres(process.env.URL, { ssl: 'require' });",
    "import postgres from 'postgres';\nconst sql = postgres(process.env.URL);",
    "const { default: pg } = await import('postgres');\nconst sql = pg(url, { ssl: { rejectUnauthorized: true, ca } });",   // el TLS a mano (la 257 v2): pasa a pgTls
    "const pg = require('postgres');\npg(url, { max: 1 });",
    "import { conTls } from '../../lib/pg-tls.mjs';\nimport postgres from 'postgres';\npostgres(url, { ...conTls(url), ssl: { rejectUnauthorized: false } });",
    "const s = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });",
    "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
    "const u = url + '?sslmode=require';",
  ];
  for (const m of malos) assert.ok(revisar(m).length > 0, `no detectó: ${m}`);
  assert.ok(revisar('import psycopg2\npsycopg2.connect(dsn)', 'x.py').length > 0);
  /* control: la forma buena pasa */
  assert.deepEqual(revisar("import postgres from 'postgres';\nimport { conTls } from '../../lib/pg-tls.mjs';\nconst sql = postgres(url, conTls(url, { max: 1 }));", 'x.mjs'), []);
});
