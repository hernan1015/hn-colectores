// node --test imerg-pendientes/test/imerg-pendientes.test.mjs   · sin red ni base: la NASA y la base son falsas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsearCsv, pedirSerie, ErrorNasa, DATAFIELD, MS_PEDIDO } from '../lib/giovanni.mjs';
import { barrer, tope, TOPE_MAX, PRESUPUESTO_MS } from '../lib/barrido.mjs';
import { crearBase, usuarioDeUrl, hostDeUrl, errorLimpio } from '../lib/base.mjs';
import { main, esperaLazy } from '../imerg-pendientes.mjs';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIN = 60 * 1000;

// ── la NASA ──────────────────────────────────────────────────────────────────────────────────────────────
test('csv: encabezado afuera, relleno y negativos sin dato (no 0), repetidas una vez y ordenado', () => {
  const csv = 'Timestamp (UTC),Data\n2000-06-02T00:00:00,1.5\n2000-06-01T00:00:00,0.0\n2000-06-03T00:00:00,-9999.9\n'
    + '2000-06-04T00:00:00,-0.5\n2000-06-02T00:00:00,2.25\nbasura\n,\n2000-6-5,3\n2000-06-06T00:00:00,abc\n2000-06-07T00:00:00,1e1';
  assert.deepEqual(parsearCsv(csv), [['2000-06-01', 0], ['2000-06-02', 2.25], ['2000-06-07', 10]]);
  assert.deepEqual(parsearCsv(''), []);
});

test('pedido: Giovanni con el token, el centro de la celda y el rango desde 2000-06-01', async () => {
  let visto;
  const fetch = async (url, op) => { visto = { url, op }; return { status: 200, text: async () => 'h,d\n2000-06-01T00:00:00,3' }; };
  const f = await pedirSerie({ lat: -34.05, lon: -60.75, token: 'tk', hasta: '2026-11-14T23:59:59', fetch });
  assert.deepEqual(f, [['2000-06-01', 3]]);
  const u = new URL(visto.url);
  assert.equal(u.origin + u.pathname, 'https://api.giovanni.earthdata.nasa.gov/timeseries');
  assert.equal(u.searchParams.get('data'), DATAFIELD);
  assert.equal(u.searchParams.get('location'), '[-34.05,-60.75]');
  assert.equal(u.searchParams.get('time'), '2000-06-01T00:00:00/2026-11-14T23:59:59');
  assert.equal(visto.op.headers.Authorization, 'Bearer tk');
  assert.ok(visto.op.signal, 'el pedido tiene corte');
  assert.ok(MS_PEDIDO <= 40 * MIN);
});

test('pedido: un 401, un 429, un 500, la red o un CSV vacío son ErrorNasa con el código solo', async () => {
  for (const [fetch, codigo] of [
    [async () => ({ status: 401, text: async () => 'login secreto' }), '401'],
    [async () => ({ status: 429, text: async () => '' }), '429'],
    [async () => ({ status: 500, text: async () => '' }), '500'],
    [async () => { throw new TypeError('fetch failed host x'); }, 'red'],
    [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'timeout'],
    [async () => ({ status: 200, text: async () => 'Timestamp,Data\n' }), 'sin_filas'],
  ]) {
    await assert.rejects(pedirSerie({ lat: 1, lon: 2, token: 't', fetch }), (e) => e instanceof ErrorNasa && e.codigo === codigo && !/secreto|host/.test(e.message));
  }
  await assert.rejects(pedirSerie({ lat: 1, lon: 2, token: '', fetch: async () => assert.fail('sin token no se pide') }), (e) => e.codigo === 'sin_token');
});

// ── el barrido ───────────────────────────────────────────────────────────────────────────────────────────
/** Una base falsa con la regla de la de verdad: nunca dos tomas vivas; guardar libera la toma; soltar la marca. */
function baseFalsa(pendientes) {
  const s = { pend: pendientes.map((c) => ({ ...c })), viva: null, guardadas: [], sueltas: [], tomas: 0 };
  return Object.assign(s, {
    async tomar() { if (s.viva) return null; const c = s.pend.shift(); if (!c) return null; s.tomas++; s.viva = c; return c; },
    async guardar(c, filas) { assert.equal(s.viva, c, 'guarda la celda tomada'); s.viva = null; s.guardadas.push(c); return filas.length; },
    async soltar(c) { s.viva = null; s.sueltas.push(c); return true; },
    async contar() { return s.pend.length; }, async cerrar() {},
  });
}
const celdas = (n) => Array.from({ length: n }, (_, i) => ({ lat: -30 - i / 10, lon: -60, latTxt: String(-30 - i / 10), lonTxt: '-60' }));
const serieOk = async () => [['2000-06-01', 1], ['2000-06-02', 0]];

test('barrido: una celda por vez, como mucho 2 por corrida, con pausa entre las dos', async () => {
  const b = baseFalsa(celdas(5)); const pausas = []; let pedidos = 0, enVuelo = 0;
  const r = await barrer({ base: b, tope: 20, serie: async (c) => { enVuelo++; assert.equal(enVuelo, 1); pedidos++; const f = await serieOk(c); enVuelo--; return f; },
    dormir: async (ms) => { pausas.push(ms); }, log: () => {} });
  assert.equal(TOPE_MAX, 2);
  assert.equal(r.guardadas, 2); assert.equal(pedidos, 2); assert.equal(r.motivo, 'tope');
  assert.deepEqual(pausas, [60000]);
  assert.equal(tope(20), 2); assert.equal(tope(0), 2); assert.equal(tope('1'), 1); assert.equal(tope(-3), 1);
});

test('barrido: la 2.ª celda no empieza si ya se fue el presupuesto (una celda tarda ~27 min)', async () => {
  let t = 0; const b = baseFalsa(celdas(3));
  const r = await barrer({ base: b, serie: async () => { t += 46 * MIN; return serieOk(); }, reloj: () => t, dormir: async () => {}, log: () => {} });
  assert.equal(r.guardadas, 1); assert.equal(r.motivo, 'presupuesto'); assert.equal(b.tomas, 1);
  assert.ok(PRESUPUESTO_MS <= 45 * MIN);
});

test('barrido: un error de la NASA suelta la celda y TERMINA la corrida (no sigue pidiendo)', async () => {
  const b = baseFalsa(celdas(3)); let pedidos = 0;
  const r = await barrer({ base: b, serie: async () => { pedidos++; throw new ErrorNasa(429); }, dormir: async () => {}, log: () => {} });
  assert.equal(pedidos, 1); assert.equal(b.sueltas.length, 1); assert.equal(r.fallos, 1); assert.equal(r.motivo, 'fallo_nasa'); assert.equal(r.error, 'nasa_429');
});

test('barrido: un error al guardar suelta la celda y termina', async () => {
  const b = baseFalsa(celdas(2)); b.guardar = async () => { throw new Error('guardar: 23505'); };
  const r = await barrer({ base: b, serie: serieOk, dormir: async () => {}, log: () => {} });
  assert.equal(r.motivo, 'fallo_base'); assert.equal(b.sueltas.length, 1); assert.equal(r.guardadas, 0);
});

test('barrido: sin pendientes no le pide nada a la NASA', async () => {
  const r = await barrer({ base: baseFalsa([]), serie: async () => assert.fail('no se pide'), log: () => {} });
  assert.equal(r.motivo, 'nada_pendiente'); assert.equal(r.tomadas, 0);
});

test('barrido: el registro (público) no muestra coordenadas', async () => {
  const lineas = []; const b = baseFalsa([{ lat: -34.05, lon: -60.75, latTxt: '-34.05', lonTxt: '-60.75' }, { lat: -33.15, lon: -61.25, latTxt: '-33.15', lonTxt: '-61.25' }]);
  await barrer({ base: b, serie: async (c) => { if (c.lat === -33.15) throw new ErrorNasa(503); return serieOk(); }, dormir: async () => {}, log: (l) => lineas.push(l) });
  assert.ok(lineas.length >= 2);
  for (const l of lineas) assert.doesNotMatch(l, /34[.,]05|60[.,]75|33[.,]15|61[.,]25/);
});

test('el caso del 13/11: 9 celdas trabadas se llenan solas en corridas de ≤ 2, ninguna pasa de 100 min, aunque GitHub corte una', async () => {
  // Modelo: cada corrida es el cron de una hora; una celda tarda 27 min; la corrida 2 la corta GitHub a mitad de la 1.ª celda.
  const b = baseFalsa(celdas(9)); let corrida = 0; const duraciones = [];
  while (b.guardadas.length < 9 && corrida < 12) {
    corrida++; let t = 0;
    const cortar = corrida === 2;
    const r = await barrer({ base: b, reloj: () => t, dormir: async (ms) => { t += ms; }, log: () => {},
      serie: async () => { if (cortar) { const e = new Error('cancelado por GitHub'); e.cortado = true; throw e; } t += 27 * MIN; return serieOk(); } })
      .catch(() => null);
    duraciones.push(t);
    if (cortar) {
      // GitHub mató el job: en la base la toma quedó viva y vence a los 90 min (la corrida siguiente, una hora y pico después)
      b.pend.unshift(b.viva || b.sueltas.pop()); b.viva = null;
    }
    assert.ok(!r || r.tomadas <= 2);
  }
  assert.equal(b.guardadas.length, 9, 'se llenan las 9 sin disparar nada a mano');
  assert.ok(Math.max(...duraciones) < 100 * MIN, 'ninguna corrida llega al timeout del job');
});

// ── el workflow ──────────────────────────────────────────────────────────────────────────────────────────
test('workflow: apagado por variable, cada hora, sin cancelar, timeout que alcanza para 2 celdas, tope 2, secretos por nombre', () => {
  const y = fs.readFileSync(path.join(RAIZ, 'imerg-pendientes.workflow.yml.txt'), 'utf8');
  assert.match(y, /cron: '17 \* \* \* \*'/);
  assert.match(y, /vars\.IMERG_PENDIENTES_ON == 'si'/);
  assert.match(y, /cancel-in-progress: false/);
  const to = Number(/timeout-minutes: (\d+)/.exec(y)[1]);
  assert.ok(to >= 2 * (MS_PEDIDO / MIN) + 1 + 5, 'el timeout cubre 2 pedidos con corte + la pausa');
  assert.ok(to <= 6 * 60);
  assert.match(y, /TOPE: \$\{\{ github\.event_name == 'schedule' && '2' \|\| inputs\.tope \}\}/);
  assert.match(y, /secrets\.IMERG_PG_URL/); assert.match(y, /secrets\.EARTHDATA_TOKEN/);
  assert.doesNotMatch(y, /^\s+repository_dispatch:/m, 'no se dispara desde afuera: sólo el reloj y a mano');
  assert.doesNotMatch(y, /SUPABASE_DB_URL|service_role/i, 'nunca la URL de administración');
  assert.match(y, /contents: read/);
});

// ── la base (sin conectar) y el arranque ───────────────────────────────────────────────────────────────
test('base: sólo el rol colector_imerg y sólo por el pooler; el error no trae la URL', async () => {
  const bien = 'postgresql://colector_imerg.ref:abc123@aws-0-sa-east-1.pooler.supabase.com:6543/postgres';
  assert.equal(usuarioDeUrl(bien), 'colector_imerg.ref');
  assert.equal(hostDeUrl(bien), 'aws-0-sa-east-1.pooler.supabase.com');
  const nunca = () => assert.fail('no conecta');
  await assert.rejects(crearBase({ url: '', conectar: nunca }), /falta IMERG_PG_URL/);
  await assert.rejects(crearBase({ url: bien.replace('colector_imerg', 'postgres'), conectar: nunca }), /no es del rol/);
  await assert.rejects(crearBase({ url: bien.replace('aws-0-sa-east-1.pooler.supabase.com', 'db.ref.supabase.co'), conectar: nunca }), /pooler/);
  await assert.rejects(crearBase({ url: 'postgresql://colector_imerg.ref:a@b@x.pooler.supabase.com:6543/postgres', conectar: nunca }), /pooler/);
  const e = errorLimpio(Object.assign(new Error('connect to x.pooler.supabase.com user colector_imerg.ref'), { code: '28P01' }), 'conectar');
  assert.equal(e.message, 'conectar: 28P01');
});

test('base: si current_user no es colector_imerg, cierra y no sigue', async () => {
  let cerrada = false;
  const sql = Object.assign(async () => [{ u: 'postgres' }], { end: async () => { cerrada = true; } });
  await assert.rejects(crearBase({ url: 'postgresql://colector_imerg.ref:abc@aws-0-x.pooler.supabase.com:6543/postgres', conectar: () => sql }), /ROL_DISTINTO/);
  assert.ok(cerrada);
});

test('arranque: seco sólo cuenta; real sin token no arranca; un fallo da 2; espera por defecto 180', async () => {
  const lineas = []; const log = (l) => lineas.push(l);
  const b = baseFalsa(celdas(3)); b.tomar = async () => assert.fail('seco no toma');
  assert.equal(await main({ MODO: 'seco', IMERG_PG_URL: 'x' }, { crear: async () => b, pedir: async () => assert.fail('seco no pide'), log }), 0);
  assert.ok(lineas.some((l) => /celdas para tomar: 3/.test(l)));
  assert.equal(await main({ MODO: 'real', IMERG_PG_URL: 'x', EARTHDATA_TOKEN: ' ' }, { crear: async () => assert.fail(), log }), 1);
  const b2 = baseFalsa(celdas(1));
  assert.equal(await main({ MODO: 'real', IMERG_PG_URL: 'x', EARTHDATA_TOKEN: 't' }, { crear: async () => b2, pedir: async () => { throw new ErrorNasa(401); }, log }), 2);
  const b3 = baseFalsa(celdas(1));
  assert.equal(await main({ MODO: 'real', IMERG_PG_URL: 'x', EARTHDATA_TOKEN: 't', TOPE: '1' }, { crear: async () => b3, pedir: serieOk, log }), 0);
  assert.equal(b3.guardadas.length, 1);
  assert.equal(esperaLazy(undefined), 180); assert.equal(esperaLazy(''), 180); assert.equal(esperaLazy('0'), 0); assert.equal(esperaLazy('-5'), 180); assert.equal(esperaLazy('abc'), 180);
});
