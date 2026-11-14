// node --test smn-abierto/test/base-pg.test.mjs   (sin base; el único «red» es una conexión a 127.0.0.1:1, rechazada)
// La base por Postgres directo con el rol colector_estaciones (la copia de sipan-alto-valle/lib/base.mjs con la red
// SMN_ABIERTO). Lo esencial de los tests del SIPAN, más obsFechas. Cada bloque con su control negativo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearBase, errorLimpio, RED } from '../lib/base.mjs';
import { correr } from '../smn.mjs';

const CLAVE = 'Cl4ve-De-Prueba-NoEsReal-9f8e7d';
const HOST = 'aws-0-sa-east-1.pooler.supabase.com';
const URL_OK = `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@${HOST}:6543/postgres`;

/** Un `sql` falso con la forma de postgres.js: plantilla → promesa de filas; sql(obj, cols) → ayudante; json; end. */
function sqlFalso({ usuario = 'colector_estaciones', sesion = usuario, fallar = null, filas = null } = {}) {
  const s = { consultas: [], cerrada: false, opciones: null };
  const sql = (a, ...b) => {
    if (Array.isArray(a) && a.raw) {
      const texto = a.join('?').replace(/\s+/g, ' ').trim();
      s.consultas.push({ texto, vals: b });
      if (/current_user/.test(texto)) return Promise.resolve([{ u: usuario, s: sesion }]);
      if (fallar) return Promise.reject(fallar);
      return Promise.resolve(filas ? filas(texto) : []);
    }
    return { ayudante: true, obj: a, cols: b[0] };
  };
  sql.json = (v) => ({ json: v });
  sql.end = async () => { s.cerrada = true; };
  return { s, conectar: (url, opciones) => { s.url = url; s.opciones = opciones; return sql; } };
}

test('la red es SMN_ABIERTO y las lecturas filtran por ella', async () => {
  assert.equal(RED, 'SMN_ABIERTO');
  const f = sqlFalso();
  const b = await crearBase({ url: URL_OK, conectar: f.conectar });
  await b.estaciones();
  await b.obsFechas(['2026-11-12', '2026-11-13']);
  for (const c of f.s.consultas.slice(1)) assert.ok(c.vals.includes('SMN_ABIERTO'), c.texto);
  assert.match(f.s.consultas.at(-1).texto, /fecha = any\(\?::date\[\]\)/);
  assert.match(f.s.consultas.at(-1).texto, /fecha::text as fecha/);
  assert.equal(f.s.opciones.prepare, false);
  assert.equal(f.s.opciones.connection.application_name, 'colector-smn-abierto');
  /* control negativo: sin fechas no se consulta nada */
  const n = f.s.consultas.length;
  assert.deepEqual(await b.obsFechas([]), []);
  assert.equal(f.s.consultas.length, n);
});

test('sólo el usuario colector_estaciones, por el pooler; current_user y session_user los dos', async () => {
  for (const u of [`postgresql://postgres.uxyewblbwzqaauzkcihf:${CLAVE}@${HOST}:6543/postgres`, `postgresql://colector_estaciones.x:${CLAVE}@evil.example.com:6543/postgres`, '']) {
    let llamado = false;
    await assert.rejects(crearBase({ url: u, conectar: () => { llamado = true; return null; } }));
    assert.equal(llamado, false);
  }
  for (const [usuario, sesion] of [['postgres', 'postgres'], ['colector_estaciones', 'postgres'], ['postgres', 'colector_estaciones']]) {
    const f = sqlFalso({ usuario, sesion });
    await assert.rejects(crearBase({ url: URL_OK, conectar: f.conectar }), /otro usuario/);
    assert.equal(f.s.cerrada, true);
  }
  /* control negativo: con el rol correcto arranca */
  assert.ok(await crearBase({ url: URL_OK, conectar: sqlFalso().conectar }));
});

test('correr (real) con el usuario equivocado: aborta ANTES de pedirle nada al SMN y no escribe', async () => {
  const f = sqlFalso({ usuario: 'authenticator' });
  let pedidos = 0;
  await assert.rejects(correr({ seco: false, env: { SMN_PG_URL: URL_OK }, conectar: f.conectar, fetchFn: async () => { pedidos++; throw new Error('no'); }, log: () => {} }), /otro usuario/);
  assert.equal(pedidos, 0);
  assert.equal(f.s.consultas.filter((c) => /insert/i.test(c.texto)).length, 0);
  /* control negativo: en seco no se conecta a ninguna base */
  let conecto = false;
  await correr({ seco: true, env: { SMN_PG_URL: URL_OK }, conectar: () => { conecto = true; }, fetchFn: async () => ({ status: 404, ok: false, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) }), log: () => {} });
  assert.equal(conecto, false);
});

test('la URL y la clave NUNCA salen en un error (driver de verdad contra un puerto cerrado, y errores de fila)', async () => {
  const url = `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@127.0.0.1:1/postgres`;
  let err = null;
  try { await crearBase({ url, hostPermitido: (h) => h === '127.0.0.1' }); } catch (e) { err = e; }
  assert.ok(err);
  const todo = String(err.message) + ' ' + String(err.stack);
  for (const x of [CLAVE, '127.0.0.1', 'uxyewblbwzqaauzkcihf', 'postgresql://']) assert.ok(!todo.includes(x), 'se filtró: ' + x);
  const sucio = Object.assign(new Error(`insert falló en ${URL_OK}`), { code: '23514' });
  const b = await crearBase({ url: URL_OK, conectar: sqlFalso({ fallar: sucio }).conectar });
  const r = await b.guardarObs([{ red: RED, estacion_id: 'A', fecha: '2026-11-13', crudo: {} }]);
  assert.match(r.errores[0], /^A 2026-11-13: estaciones_obs: 23514 \(CHECK\)$/);
  /* control negativo: el mensaje crudo SÍ traía la clave */
  assert.ok(sucio.message.includes(CLAVE));
  assert.equal(errorLimpio(sucio, 'x').message, 'x: 23514 (CHECK)');
});
