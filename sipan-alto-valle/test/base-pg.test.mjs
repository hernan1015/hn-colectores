// node --test sipan-alto-valle/test/base-pg.test.mjs   (sin base; el único «red» es una conexión a 127.0.0.1:1, rechazada)
// La base por Postgres directo con el rol colector_estaciones (Plan B). Cada bloque con su control negativo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearBase, usuarioDeUrl, errorLimpio } from '../lib/base.mjs';
import { correr } from '../sipan.mjs';
import { correr as medir } from '../medir.mjs';
import { claves, verificador } from '../migracion/scram.mjs';
import crypto from 'node:crypto';

test('scram.mjs: el verificador SCRAM-SHA-256 cumple el vector del RFC 7677 (la clave en texto no llega a la base)', () => {
  /* RFC 7677 §3: usuario «user», clave «pencil», sal W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iteraciones */
  const k = claves('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096);
  const auth = 'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const firma = crypto.createHmac('sha256', k.storedKey).update(auth).digest();
  assert.equal(Buffer.from(k.clienteKey.map((b, i) => b ^ firma[i])).toString('base64'), 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
  assert.equal(crypto.createHmac('sha256', k.serverKey).update(auth).digest('base64'), '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  const v = verificador('a'.repeat(32), { sal: Buffer.alloc(16, 1) });
  assert.match(v, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
  assert.ok(!v.includes('a'.repeat(32)));
  /* control negativo: una clave corta o con espacios no se acepta */
  assert.throws(() => verificador('corta'));
  assert.throws(() => verificador('con espacios y más de veinticuatro caracteres'));
});

const CLAVE = 'Cl4ve-De-Prueba-NoEsReal-9f8e7d';
const HOST = 'aws-0-sa-east-1.pooler.supabase.com';
const URL_OK = `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@${HOST}:6543/postgres`;

/** Un `sql` falso con la forma de postgres.js: plantilla → promesa de filas; sql(obj, cols) → ayudante; json; end. */
function sqlFalso({ usuario = 'colector_estaciones', sesion = usuario, fallar = null, fallarDesde = Infinity, filas = null } = {}) {
  const s = { consultas: [], cerrada: false, opciones: null };
  let n = 0;
  const sql = (a, ...b) => {
    if (Array.isArray(a) && a.raw) {
      const texto = a.join('?').replace(/\s+/g, ' ').trim();
      s.consultas.push({ texto, vals: b });
      if (fallar && n++ >= (fallarDesde === Infinity ? 0 : fallarDesde)) return Promise.reject(fallar);
      if (/current_user/.test(texto)) return Promise.resolve([{ u: usuario, s: sesion }]);
      return Promise.resolve(filas ? filas(texto) : []);
    }
    return { ayudante: true, obj: a, cols: b[0] };
  };
  sql.json = (v) => ({ json: v });
  sql.end = async () => { s.cerrada = true; };
  return { s, conectar: (url, opciones) => { s.url = url; s.opciones = opciones; return sql; } };
}

test('URL: sólo el usuario colector_estaciones (o colector_estaciones.<ref>); otro usuario ni se conecta', async () => {
  assert.equal(usuarioDeUrl(URL_OK), 'colector_estaciones.uxyewblbwzqaauzkcihf');
  const f = sqlFalso();
  const b = await crearBase({ url: URL_OK, conectar: f.conectar });
  assert.equal(b.usuario, 'colector_estaciones');
  assert.equal(f.s.opciones.prepare, false);                                  // pooler en modo transacción
  assert.equal(f.s.opciones.max, 1);
  /* control negativo: postgres, service_role o algo que no es una URL postgres no llegan a conectar */
  for (const u of [`postgresql://postgres.uxyewblbwzqaauzkcihf:${CLAVE}@${HOST}:6543/postgres`, `postgresql://service_role:${CLAVE}@${HOST}:6543/postgres`,
    `https://uxyewblbwzqaauzkcihf.supabase.co`, '']) {
    const g = sqlFalso();
    await assert.rejects(crearBase({ url: u, conectar: g.conectar }));
    assert.equal(g.s.consultas.length, 0, u);
  }
});

test('current_user: si la conexión no entró como colector_estaciones, se cierra y aborta', async () => {
  const f = sqlFalso({ usuario: 'postgres' });
  await assert.rejects(crearBase({ url: URL_OK, conectar: f.conectar }), /otro usuario/);
  assert.equal(f.s.cerrada, true);
  /* control negativo: con el usuario correcto, arranca y no cierra */
  const g = sqlFalso();
  await crearBase({ url: URL_OK, conectar: g.conectar });
  assert.equal(g.s.cerrada, false);
});

test('correr (real) con current_user equivocado: aborta ANTES de pedirle nada al INTA y no escribe', async () => {
  const f = sqlFalso({ usuario: 'authenticator' });
  let pedidos = 0;
  await assert.rejects(correr({ seco: false, env: { SIPAN_PG_URL: URL_OK }, conectar: f.conectar, fetchFn: async () => { pedidos++; throw new Error('no'); }, log: () => {} }), /otro usuario/);
  assert.equal(pedidos, 0);
  assert.equal(f.s.consultas.filter((c) => /insert/i.test(c.texto)).length, 0);
});

test('la URL y la clave NUNCA salen en un error: con el driver de verdad contra un puerto cerrado', async () => {
  const url = `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@127.0.0.1:1/postgres`;
  let err = null;
  try { await crearBase({ url, hostPermitido: (h) => h === '127.0.0.1' }); } catch (e) { err = e; }
  assert.ok(err, 'tenía que fallar');
  const todo = String(err.message) + ' ' + String(err.stack) + ' ' + JSON.stringify(err);
  for (const x of [CLAVE, '127.0.0.1', 'uxyewblbwzqaauzkcihf', 'colector_estaciones.', 'postgresql://']) assert.ok(!todo.includes(x), 'se filtró: ' + x);
  assert.match(err.message, /^conectar: (ECONNREFUSED|CONNECT_TIMEOUT|ETIMEDOUT)/);
});

test('la URL y la clave NUNCA salen: ni en el log de la corrida ni en los errores de una fila', async () => {
  const sucio = Object.assign(new Error(`connect ECONNREFUSED ${HOST}:6543 for ${URL_OK}`), { code: 'ECONNREFUSED' });
  /* 1 · al conectar (desde correr: lo que imprimiría el CLI) */
  const f = sqlFalso({ fallar: sucio });
  let err = null;
  try { await correr({ seco: false, env: { SIPAN_PG_URL: URL_OK }, conectar: f.conectar, log: () => {} }); } catch (e) { err = e; }
  assert.ok(err);
  for (const x of [CLAVE, HOST, URL_OK]) assert.ok(!(String(err.message) + String(err.stack)).includes(x));
  /* 2 · en una fila: el error va a `errores` (y de ahí a registro_procesos), limpio */
  const g = sqlFalso({ fallar: Object.assign(new Error(`insert falló en ${URL_OK}`), { code: '23503' }), fallarDesde: 1 });
  const b = await crearBase({ url: URL_OK, conectar: g.conectar });
  const r = await b.guardarObs([{ red: 'INTA_SIPAN_AV', estacion_id: '10', fecha: '2026-09-10', crudo: {} }]);
  assert.equal(r.ok, 0);
  assert.match(r.errores[0], /^10 2026-09-10: estaciones_obs: 23503 \(FK\)$/);
  assert.ok(!r.errores[0].includes(CLAVE) && !r.errores[0].includes(HOST));
  /* control negativo: el mensaje crudo SÍ traía la URL (o sea, el test mira algo real) */
  assert.ok(sucio.message.includes(CLAVE));
  assert.equal(errorLimpio(sucio, 'x').message, 'x: ECONNREFUSED (conexión rechazada)');
});

test('las consultas: upsert con on conflict, jsonb con sql.json, fecha como texto y numeric como número', async () => {
  const f = sqlFalso();
  const b = await crearBase({ url: URL_OK, conectar: f.conectar });
  await b.guardarEstaciones([{ red: 'INTA_SIPAN_AV', estacion_id: '10', nombre: 'Guerrico', metadatos: { a: 1 }, activa: true }]);
  await b.guardarObs([{ red: 'INTA_SIPAN_AV', estacion_id: '10', fecha: '2026-09-10', tmin_c: -1, crudo: { x: 1 } }]);
  await b.registrar('sipan_alto_valle', true, { n: 1 });
  const [est, obs, reg] = f.s.consultas.slice(1);
  assert.match(est.texto, /^insert into estaciones \? on conflict \(red, estacion_id\) do update set \?$/);
  assert.deepEqual(est.vals[0].obj.metadatos, { json: { a: 1 } });
  assert.ok(!est.vals[1].cols.includes('red') && !est.vals[1].cols.includes('estacion_id'));   // la clave no se «actualiza»
  assert.match(obs.texto, /^insert into estaciones_obs \? on conflict \(red, estacion_id, fecha\) do update set \?$/);
  assert.deepEqual(obs.vals[0].obj.crudo, { json: { x: 1 } });
  assert.match(reg.texto, /^insert into registro_procesos \(proceso, ok, resumen\) values/);
  /* lectura: fecha::text y numeric → número */
  const g = sqlFalso();
  const b2 = await crearBase({ url: URL_OK, conectar: g.conectar });
  await b2.obs('10', ['2026-09-10']);
  assert.match(g.s.consultas.at(-1).texto, /fecha::text as fecha/);
  /* control negativo: sin fechas no se consulta nada */
  const antes = g.s.consultas.length;
  assert.deepEqual(await b2.obs('10', []), []);
  assert.equal(g.s.consultas.length, antes);
});

test('medir.mjs también entra con el rol propio y cierra la conexión al terminar', async () => {
  const f = sqlFalso();
  const r = await medir({ seco: true, env: { SIPAN_PG_URL: URL_OK }, conectar: f.conectar, fetchFn: async () => { throw new Error('sin red'); }, log: () => {} });
  assert.equal(r.filas, 0);
  assert.equal(f.s.cerrada, true);
  /* control negativo: con otro usuario, no mide */
  await assert.rejects(medir({ seco: true, env: { SIPAN_PG_URL: URL_OK }, conectar: sqlFalso({ usuario: 'postgres' }).conectar, log: () => {} }), /otro usuario/);
});

test('session_user: con «?user=postgres&options=-c role=colector_estaciones» current_user da el rol, pero se rechaza', async () => {
  const f = sqlFalso({ usuario: 'colector_estaciones', sesion: 'postgres' });
  await assert.rejects(crearBase({ url: URL_OK, conectar: f.conectar }), /otro usuario/);
  assert.equal(f.s.cerrada, true);
  /* y al revés: entró como colector_estaciones pero el rol vigente es otro (current_user ≠ rol) */
  const g = sqlFalso({ usuario: 'postgres', sesion: 'colector_estaciones' });
  await assert.rejects(crearBase({ url: URL_OK, conectar: g.conectar }), /otro usuario/);
  /* control negativo: los dos iguales al rol, arranca */
  assert.ok(await crearBase({ url: URL_OK, conectar: sqlFalso({ sesion: 'colector_estaciones' }).conectar }));
});

test('host: sólo el pooler de Supabase, y con la clave codificada; si no, ni se conecta (ni una consulta DNS)', async () => {
  const malas = [
    `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@db.uxyewblbwzqaauzkcihf.supabase.co:5432/postgres`,   // directo, no el pooler
    `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@evil.example.com:6543/postgres`,
    `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@${HOST}.evil.com:6543/postgres`,
    `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:Zq9+Sec@reto/x@${HOST}:6543/postgres`,                       // clave sin codificar
    `postgresql://colector_estaciones.uxyewblbwzqaauzkcihf:${CLAVE}@127.0.0.1:6543/postgres`,
  ];
  for (const u of malas) {
    let llamado = false;
    await assert.rejects(crearBase({ url: u, conectar: () => { llamado = true; return null; } }), /pooler/);
    assert.equal(llamado, false, u.replace(CLAVE, '***'));
  }
  /* y el mensaje no trae la URL */
  try { await crearBase({ url: malas[1], conectar: () => null }); } catch (e) { assert.ok(!e.message.includes(CLAVE) && !e.message.includes('evil')); }
  /* control negativo: la del pooler, con la clave codificada, conecta */
  let ok = false;
  const f = sqlFalso();
  await crearBase({ url: URL_OK, conectar: (u, o) => { ok = true; return f.conectar(u, o); } });
  assert.equal(ok, true);
});

test('tipos: lat/lon como número, tmin_noche_en como texto ISO, fecha como texto y sin «select *»', async () => {
  const fecha = new Date('2026-09-10T08:40:00Z');
  const f = sqlFalso({ filas: (t) => (/from estaciones where/.test(t)
    ? [{ estacion_id: '10', nombre: 'G', lat: '-39.016667', lon: '-67.666667', activa: true, metadatos: {} }]
    : [{ estacion_id: '10', fecha: '2026-09-10', tmin_c: '-1.5', tmin_noche_c: '-2.0', tmin_noche_en: fecha, noche_registros: 90, crudo: {} }]) });
  const b = await crearBase({ url: URL_OK, conectar: f.conectar });
  const [e] = await b.estaciones();
  assert.equal(typeof e.lat, 'number'); assert.equal(e.lon, -67.666667);
  const [o] = await b.obs('10', ['2026-09-10']);
  assert.equal(o.tmin_noche_en, '2026-09-10T08:40:00.000Z');
  assert.equal(o.tmin_c, -1.5);
  const t = f.s.consultas.at(-1).texto;
  assert.ok(!t.includes("select *"), t);
  assert.equal((t.match(/fecha::text as fecha/g) || []).length, 1);
  /* control negativo: un null sigue siendo null (no 0 ni NaN) */
  const g = sqlFalso({ filas: () => [{ estacion_id: '10', fecha: '2026-09-10', tmin_c: null, tmin_noche_en: null }] });
  const [n] = await (await crearBase({ url: URL_OK, conectar: g.conectar })).obs('10', ['2026-09-10']);
  assert.equal(n.tmin_c, null); assert.equal(n.tmin_noche_en, null);
});
