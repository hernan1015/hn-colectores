// Tests del archivo de granizo (147): SIN red, con un GitHub falso y respuestas sintéticas.
// Correr: node --test granizo-archivo/test/   ·   control negativo contado: node granizo-archivo/test/control-negativo.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { githubFalso, respuestaGranizo, satchiFalso } from './falsos.mjs';
import { clienteReleases } from '../../lib/releases.mjs';
import { pedirGranizo, clasificar, nombreBarrido, tagDe, horaAR, desempaquetar, URL_GRANIZO, UA, TOPE_BYTES } from '../lib/barrido.mjs';
import { yaExiste } from '../../lib/releases.mjs';
import { archivar } from '../lib/flujo.mjs';
import { RE_INDICE, unirIndices } from '../lib/indice.mjs';
import { evaluarFrescura, leerEstado, tagsAMirar, VENTANA_MIN } from '../lib/frescura.mjs';
import { evaluarAhora, ejecutarMandar } from '../vigia-frescura.mjs';

const T0 = Date.parse('2026-11-13T22:23:05Z');          // 19:23 ART
const SCAN = '2026-11-13T22:10:20.700Z';                // 19:10 ART
const REPO = 'duenio/privado';
const TAG = 'granizo-2026-11-13';
const TOK = ['falso', 'de', 'prueba', String(Date.now() % 1e6)].join('-');   // armado al correr: gitleaks no lo confunde con uno real

function armar({ reloj = { t: T0 }, fallar = {} } = {}) {
  const gh = githubFalso({ ahora: () => reloj.t, fallar });
  const cliente = () => clienteReleases({ token: TOK, repo: REPO, fetchFn: gh.fetchFn });
  let n = 0;
  const sello = () => new Date(reloj.t).toISOString().replace(/[-:]/g, '').slice(0, 15).replace(/\d{2}$/, String(n++ % 100).padStart(2, '0'));
  return { gh, cliente, reloj, sello };
}
const pedido = (cuerpo, { ms = T0, http = 200, error = null } = {}) => ({ url: URL_GRANIZO, pedido_ms: ms, duracion_ms: 812, http: error ? null : http,
  cabeceras: { 'cache-control': 'public' }, cuerpo: error ? null : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)), error });
const barridoDe = (gh, nombre, tag = TAG) => desempaquetar(gh.rels.get(tag).assets.find((a) => a.name === nombre).data);
const indiceDe = (gh, tag = TAG) => { const as = gh.rels.get(tag).assets.filter((a) => RE_INDICE.test(a.name)); return as.map((a) => JSON.parse(a.data.toString())); };

// ── la hora y los nombres ──────────────────────────────────────────────────────────────────────────────────────────
test('hora argentina: −03:00 y el día argentino cruza la medianoche UTC', () => {
  assert.equal(horaAR(Date.parse('2026-11-14T00:10:20.700Z')), '2026-11-13T21:10:20-03:00');
  assert.equal(horaAR(Date.parse('2026-11-14T03:00:00Z')), '2026-11-14T00:00:00-03:00');
});

test('nombre = hora del SCAN (UTC, al minuto) + estado; el release es el día ARGENTINO del scan', () => {
  const c = clasificar(pedido(respuestaGranizo({ scan_t: '2026-11-14T02:50:20.700Z' }), { ms: Date.parse('2026-11-14T03:05:00Z') }));
  assert.equal(c.estado, 'buena');
  assert.equal(nombreBarrido(c, 0), '20261114T0250Z.buena.json.gz');
  assert.equal(tagDe(c, Date.parse('2026-11-14T03:05:00Z')), 'granizo-2026-11-13');   // 23:50 ART del 13
  // control: sin scan, por el turno de 10 min del PEDIDO y el día del pedido
  const f = clasificar(pedido(null, { ms: Date.parse('2026-11-14T03:07:59Z'), error: 'red: tiempo agotado' }));
  assert.equal(nombreBarrido(f, Date.parse('2026-11-14T03:07:59Z')), 'pedido-20261114T0300Z.falla.json.gz');
  assert.equal(tagDe(f, Date.parse('2026-11-14T03:07:59Z')), 'granizo-2026-11-14');
});

// ── buena / parcial / falla ────────────────────────────────────────────────────────────────────────────────────────
test('clasificar: buena, parcial (parcial:true o sin scan_t) y falla (red, HTTP, JSON roto, ok:false)', () => {
  assert.equal(clasificar(pedido(respuestaGranizo())).estado, 'buena');
  const p = clasificar(pedido(respuestaGranizo({ parcial: true, faltantes: ['glm'] })));
  assert.deepEqual([p.estado, p.motivo], ['parcial', 'parcial:glm']);
  assert.equal(clasificar(pedido(respuestaGranizo({ scan_t: null }))).estado, 'parcial');
  assert.equal(clasificar(pedido(respuestaGranizo({ scan_t: '1999-01-01T00:00:00Z' }))).scan_t, null, 'un scan_t fuera de rango no nombra');
  assert.equal(clasificar(pedido(null, { error: 'red: ECONNRESET' })).estado, 'falla');
  const h = clasificar(pedido({ ok: false, motivo: 'apagado' }, { http: 403 }));
  assert.deepEqual([h.estado, h.motivo], ['falla', 'http_403:apagado']);
  assert.equal(clasificar(pedido('<html>502</html>')).motivo, 'json_roto');
  const o = clasificar(pedido(respuestaGranizo({ ok: false, parcial: true })));
  assert.equal(o.estado, 'falla', 'ok:false es falla aunque diga parcial');
  assert.equal(o.scan_t, SCAN, 'la falla con scan_t conserva el scan');
});

test('pedirGranizo: UN pedido, User-Agent genérico, cabeceras de la lista, nunca lanza', async () => {
  const s = satchiFalso();
  const p = await pedirGranizo({ fetchFn: s.fetchFn, ahora: () => T0 });
  assert.equal(s.vistos.length, 1);
  assert.equal(s.vistos[0].url, URL_GRANIZO + '&_t=20261113T2220Z', 'con el turno de 10 min: saltea la copia vencida de la red');
  assert.equal(p.url, s.vistos[0].url, 'el sobre guarda la URL pedida');
  assert.equal(s.vistos[0].init.headers['User-Agent'], UA);
  assert.doesNotMatch(UA, /@|info|hninge|gmail/i, 'sin mail ni nombre en el User-Agent');
  assert.equal(p.http, 200);
  assert.deepEqual(p.cabeceras, { 'cache-control': 'public, max-age=60' }, 'sólo las cabeceras de la lista');
  // el turno: dos pedidos del mismo turno, la misma URL; el turno siguiente, otra (control)
  const s2 = satchiFalso({ headers: { age: '958', 'cache-status': '"Netlify Durable"; hit', 'x-secreto': 'no' } });
  const p1 = await pedirGranizo({ fetchFn: s2.fetchFn, ahora: () => T0 + 6 * 60000 });
  const p2 = await pedirGranizo({ fetchFn: s2.fetchFn, ahora: () => T0 + 7 * 60000 });
  assert.equal(p1.url, URL_GRANIZO + '&_t=20261113T2220Z');
  assert.equal(p2.url, URL_GRANIZO + '&_t=20261113T2230Z');
  assert.deepEqual(p1.cabeceras, { age: '958', 'cache-status': '"Netlify Durable"; hit' }, 'age y cache-status, para medir la caché');
  assert.equal((await pedirGranizo({ fetchFn: s2.fetchFn, ahora: () => T0, saltearCache: false })).url, URL_GRANIZO);
  const e = await pedirGranizo({ fetchFn: satchiFalso({ error: Object.assign(new Error('x'), { name: 'TimeoutError' }) }).fetchFn });
  assert.match(e.error, /tiempo agotado/);
  const g = await pedirGranizo({ fetchFn: satchiFalso({ cuerpo: 'x'.repeat(TOPE_BYTES + 1) }).fetchFn });
  assert.equal(g.cuerpo, null); assert.match(g.error, /no se guarda/);
});

test('URL: la misma function pública que usa SATCHI (satchi-publico?que=granizo en app.hnagroapp.com)', () => {
  assert.equal(URL_GRANIZO, 'https://app.hnagroapp.com/.netlify/functions/satchi-publico?que=granizo');
});

// ── la corrida ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('buena: crea el release (sin «Latest»), sube el barrido ENTERO con las horas y el HTTP, y el índice', async () => {
  const { gh, cliente, sello } = armar();
  const texto = JSON.stringify(respuestaGranizo()).replace('{', '{  ');   // espacios raros: tiene que quedar TAL CUAL
  const r = await archivar({ cliente: cliente(), pedido: pedido(texto), colector: { run_id: '77' }, sello });
  assert.deepEqual([r.estado, r.nuevo, r.indice], ['buena', true, 'ok']);
  assert.equal(gh.rels.get(TAG).pedido.make_latest, 'false');
  const b = barridoDe(gh, '20261113T2210Z.buena.json.gz');
  assert.equal(b.cuerpo, texto, 'el cuerpo, byte a byte');
  assert.equal(b.pedido_utc, '2026-11-13T22:23:05.000Z');
  assert.equal(b.pedido_art, '2026-11-13T19:23:05-03:00');
  assert.equal(b.http, 200);
  assert.equal(b.scan_art, '2026-11-13T19:10:20-03:00');
  assert.equal(b.colector.run_id, '77');
  const ind = indiceDe(gh);
  assert.equal(ind.length, 1);
  assert.equal(ind[0].pedidos.length, 1);
  assert.equal(ind[0].pedidos[0].nuevo, true);
});

test('parcial y falla se guardan IGUAL, marcados en el nombre y en el sobre', async () => {
  const { gh, cliente, sello, reloj } = armar();
  const c = cliente();
  await archivar({ cliente: c, pedido: pedido(respuestaGranizo({ parcial: true, faltantes: ['glm'] })), sello });
  reloj.t += 600000;
  await archivar({ cliente: c, pedido: pedido('Bad gateway', { ms: reloj.t, http: 502 }), sello });
  assert.deepEqual(gh.nombres(TAG).filter((n) => !RE_INDICE.test(n)), ['20261113T2210Z.parcial.json.gz', 'pedido-20261113T2230Z.falla.json.gz']);
  const f = barridoDe(gh, 'pedido-20261113T2230Z.falla.json.gz');
  assert.deepEqual([f.estado, f.http, f.cuerpo], ['falla', 502, 'Bad gateway']);
  assert.equal(barridoDe(gh, '20261113T2210Z.parcial.json.gz').estado, 'parcial');
});

test('REPETIDA (mismo scan, mismo estado): no se sube otra vez; el índice anota el pedido como repetido', async () => {
  const { gh, cliente, sello, reloj } = armar();
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello });
  reloj.t += 9 * 60000;   // la corrida siguiente: SATCHI todavía da el mismo scan
  const r = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo(), { ms: reloj.t }), sello });
  assert.deepEqual([r.repetido, r.nuevo], [true, false]);
  assert.equal(gh.llamadas.filter((l) => l.metodo === 'POST' && l.nombre === '20261113T2210Z.buena.json.gz').length, 1, 'el cuerpo se subió UNA vez');
  const ind = indiceDe(gh);
  assert.equal(ind.length, 1, 'un solo índice');
  assert.deepEqual(ind[0].pedidos.map((p) => p.nuevo), [true, false]);
  // control: el mismo scan con OTRO estado es otro dato y se guarda
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo({ parcial: true }), { ms: reloj.t + 1 }), sello });
  assert.ok(gh.nombres(TAG).includes('20261113T2210Z.parcial.json.gz'));
});

test('cron atrasado o doble en el mismo turno: la falla sin scan no se duplica', async () => {
  const { gh, cliente, sello } = armar();
  await archivar({ cliente: cliente(), pedido: pedido(null, { ms: T0, error: 'red: x' }), sello });
  await archivar({ cliente: cliente(), pedido: pedido(null, { ms: T0 + 4 * 60000, error: 'red: x' }), sello });   // 22:27, mismo turno 22:20
  assert.equal(gh.nombres(TAG).filter((n) => n.endsWith('.falla.json.gz')).length, 1);
  // control: el turno siguiente sí es otro barrido
  await archivar({ cliente: cliente(), pedido: pedido(null, { ms: T0 + 8 * 60000, error: 'red: x' }), sello });
  assert.equal(gh.nombres(TAG).filter((n) => n.endsWith('.falla.json.gz')).length, 2);
});

test('el NUEVO antes que el VIEJO: el índice nuevo se sube antes de borrar el viejo', async () => {
  const { gh, cliente, sello } = armar();
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello });
  const viejo = gh.rels.get(TAG).assets.find((a) => RE_INDICE.test(a.name));
  gh.llamadas.length = 0;
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo({ scan_t: '2026-11-13T22:20:20Z' }), { ms: T0 + 600000 }), sello });
  const i = gh.llamadas.findIndex((l) => l.metodo === 'POST' && l.nombre && RE_INDICE.test(l.nombre));
  const j = gh.llamadas.findIndex((l) => l.metodo === 'DELETE' && l.ruta.endsWith('/' + viejo.id));
  assert.ok(i >= 0 && j > i, `subida ${i} antes que borrado ${j}`);
  assert.equal(indiceDe(gh).length, 1);
  assert.equal(indiceDe(gh)[0].pedidos.length, 2);
});

test('si la subida del índice nuevo falla, el viejo QUEDA (y el barrido ya está); la corrida avisa', async () => {
  const fallar = {};
  const { gh, cliente, sello } = armar({ fallar });
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello });
  fallar.subir = (n) => RE_INDICE.test(n);
  const r = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo({ scan_t: '2026-11-13T22:20:20Z' }), { ms: T0 + 600000 }), sello });
  assert.equal(r.indice, 'falló');
  assert.equal(indiceDe(gh).length, 1, 'el viejo sigue');
  assert.equal(indiceDe(gh)[0].pedidos.length, 1);
  assert.ok(gh.nombres(TAG).includes('20261113T2220Z.buena.json.gz'), 'el barrido quedó');
});

test('UNIR LOS REPETIDOS: dos índices (un borrado cortado) se unen sin perder líneas y queda uno', async () => {
  const fallar = {};
  const { gh, cliente, sello, reloj } = armar({ fallar });
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello });
  fallar.borrar = (n) => RE_INDICE.test(n);    // el borrado del viejo falla → quedan dos
  reloj.t += 600000;
  const r2 = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo({ scan_t: '2026-11-13T22:20:20Z' }), { ms: reloj.t }), sello });
  assert.equal(r2.indice, 'falló');
  assert.equal(indiceDe(gh).length, 2);
  delete fallar.borrar;
  reloj.t += 600000;
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo({ scan_t: '2026-11-13T22:30:20Z' }), { ms: reloj.t }), sello });
  const ind = indiceDe(gh);
  assert.equal(ind.length, 1, 'queda uno');
  assert.equal(ind[0].pedidos.length, 3, 'con las tres líneas');
});

test('unirIndices: dos índices con líneas DISTINTAS se unen todas; la misma hora de pedido, una sola vez', () => {
  const a = JSON.stringify({ pedidos: [{ pedido_utc: '2026-11-13T22:00:00.000Z', estado: 'buena' }, { pedido_utc: '2026-11-13T22:10:00.000Z', estado: 'falla' }] });
  const b = JSON.stringify({ pedidos: [{ pedido_utc: '2026-11-13T22:20:00.000Z', estado: 'buena' }, { pedido_utc: '2026-11-13T22:10:00.000Z', estado: 'falla' }] });
  const u = unirIndices([a, b, 'roto'], TAG);
  assert.deepEqual(u.pedidos.map((p) => p.pedido_utc.slice(11, 16)), ['22:00', '22:10', '22:20']);
});

test('un asset a medio subir (starter) con el mismo nombre se borra y se vuelve a subir', async () => {
  const { gh, cliente, sello } = armar();
  gh.poner(TAG, '20261113T2210Z.buena.json.gz', 'roto', { state: 'starter' });
  const r = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello });
  assert.equal(r.nuevo, true);
  const as = gh.rels.get(TAG).assets.filter((a) => a.name === '20261113T2210Z.buena.json.gz');
  assert.deepEqual(as.map((a) => a.state), ['uploaded']);
  assert.equal(desempaquetar(as[0].data).estado, 'buena');
});

test('O1 · un 422 que NO es already_exists: la corrida falla (rojo) y el barrido se reintenta en la próxima', async () => {
  const fallar = { subir422: (n) => n.endsWith('.buena.json.gz') };
  const { gh, cliente, sello } = armar({ fallar });
  await assert.rejects(archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello }), /422/);
  assert.ok(!gh.nombres(TAG).includes('20261113T2210Z.buena.json.gz'));
  assert.equal(indiceDe(gh).length, 0, 'no se anotó como repetido');
  delete fallar.subir422;
  const r = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo(), { ms: T0 + 60000 }), sello });
  assert.equal(r.nuevo, true, 'la próxima corrida lo sube');
  assert.equal(yaExiste(JSON.stringify({ errors: [{ code: 'already_exists' }] })), true);
  assert.equal(yaExiste(JSON.stringify({ errors: [{ code: 'custom' }] })), false);
  assert.equal(yaExiste('no json'), false);
});

test('422 al subir (otra corrida lo subió recién): repetido, no error', async () => {
  const { gh, cliente } = armar();
  const c = cliente();
  const rel = await c.release(TAG, { crear: true });
  await c.assets(rel);                                  // listado viejo, sin el asset
  gh.poner(TAG, 'x.json.gz', 'ya');                     // aparece por otro lado
  assert.deepEqual(await c.subir(rel, 'x.json.gz', 'nuevo'), { yaEstaba: true });
});

test('el release lo creó otra corrida entre el GET y el POST (422): se vuelve a leer', async () => {
  const { gh, cliente, sello } = armar({ fallar: { crear422: true } });
  const r = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello });
  assert.equal(r.nuevo, true);
  assert.ok(gh.nombres(TAG).includes('20261113T2210Z.buena.json.gz'));
});

test('listado PAGINADO: un repetido en la página 2 se reconoce (más de 100 assets en el día)', async () => {
  const { gh, cliente, sello } = armar();
  for (let k = 0; k < 120; k++) gh.poner(TAG, `relleno-${String(k).padStart(3, '0')}.bin`, 'x');
  gh.poner(TAG, '20261113T2210Z.buena.json.gz', 'ya');
  const r = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), sello });
  assert.equal(r.repetido, true);
  assert.equal(gh.llamadas.filter((l) => l.metodo === 'POST' && l.nombre === '20261113T2210Z.buena.json.gz').length, 0);
});

test('SECO: no crea release ni sube ni borra nada', async () => {
  const { gh, cliente, sello } = armar();
  const r = await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo()), seco: true, sello });
  assert.equal(r.seco, true);
  assert.equal(gh.llamadas.filter((l) => l.metodo !== 'GET').length, 0);
  assert.equal(gh.rels.size, 0);
});

test('reemplazar con un nombre que ya existe no borra nada (el nuevo tiene que estar antes)', async () => {
  const { gh, cliente } = armar();
  const c = cliente();
  const a = gh.poner(TAG, 'indice__20261113T000000.json', '{"pedidos":[]}');
  const rel = await c.release(TAG);
  await assert.rejects(c.reemplazar(rel, { nombre: a.name, cuerpo: '{}', viejos: [a] }));
  assert.ok(gh.nombres(TAG).includes(a.name));
});

test('el token no sale en los errores', async () => {
  const c = clienteReleases({ token: TOK, repo: REPO, fetchFn: async () => ({ status: 500, ok: false, text: async () => TOK }) });
  await assert.rejects(c.release(TAG), (e) => !String(e.message).includes(TOK) && /HTTP 500/.test(e.message));
});

// ── el vigía de frescura ───────────────────────────────────────────────────────────────────────────────────────────
const iso = (ms) => new Date(ms).toISOString();
test('vigía: ok si hay un barrido nuevo en 40 min', () => {
  const v = evaluarFrescura({ ahoraMs: T0, barridos: [{ name: '20261113T2210Z.buena.json.gz', created_at: iso(T0 - 39 * 60000) }], pedidos: [] });
  assert.deepEqual([v.tipo, v.avisar], ['ok', false]);
  assert.equal(VENTANA_MIN, 40);
});

test('vigía: PARADO si no hay nada nuevo ni pedidos en 40 min; la clave no cambia mientras dura', () => {
  const b = [{ name: '20261113T2130Z.buena.json.gz', created_at: iso(T0 - 41 * 60000) }];
  const v = evaluarFrescura({ ahoraMs: T0, barridos: b, pedidos: [] });
  assert.deepEqual([v.tipo, v.avisar], ['parado', true]);
  assert.equal(v.clave, 'granizo-archivo-parado-tras-20261113T2130Z.buena.json.gz');
  assert.equal(evaluarFrescura({ ahoraMs: T0 + 3600000, barridos: b, pedidos: [] }).clave, v.clave, 'una hora después, la misma clave: no repite');
  assert.equal(evaluarFrescura({ ahoraMs: T0, barridos: [], pedidos: [] }).clave, 'granizo-archivo-parado-tras-sin-registro');
});

test('vigía: REPITE si corre pero todo es el mismo scan; FALLANDO si lo nuevo es todo falla', () => {
  const viejo = { name: '20261113T2130Z.buena.json.gz', created_at: iso(T0 - 50 * 60000) };
  const ped = [{ pedido_utc: iso(T0 - 10 * 60000), scan_t: '2026-11-13T21:30:20.000Z', nuevo: false }];
  const r = evaluarFrescura({ ahoraMs: T0, barridos: [viejo], pedidos: ped });
  assert.deepEqual([r.tipo, r.clave], ['repite', 'granizo-archivo-repite-2026-11-13T213020.000Z']);
  const f = evaluarFrescura({ ahoraMs: T0, barridos: [viejo, { name: 'pedido-20261113T2220Z.falla.json.gz', created_at: iso(T0 - 2 * 60000) }], pedidos: ped });
  assert.deepEqual([f.tipo, f.clave], ['fallando', 'granizo-archivo-fallando-tras-20261113T2130Z.buena.json.gz']);
  // O5: todo parcial (o parcial + falla) → «parciales»; con una buena → ok (control)
  const pa = evaluarFrescura({ ahoraMs: T0, barridos: [viejo, { name: '20261113T2210Z.parcial.json.gz', created_at: iso(T0 - 2 * 60000) }, { name: 'pedido-20261113T2220Z.falla.json.gz', created_at: iso(T0 - 1 * 60000) }], pedidos: ped });
  assert.deepEqual([pa.tipo, pa.avisar, pa.clave], ['parciales', true, 'granizo-archivo-parciales-tras-20261113T2130Z.buena.json.gz']);
  assert.equal(evaluarFrescura({ ahoraMs: T0, barridos: [viejo, { name: '20261113T2210Z.parcial.json.gz', created_at: iso(T0 - 2 * 60000) }, { name: '20261113T2220Z.buena.json.gz', created_at: iso(T0 - 1 * 60000) }], pedidos: ped }).tipo, 'ok');
});

test('vigía: a las 00:10 ART mira también el release de AYER; con el archivo real lee bien', async () => {
  const ahora = Date.parse('2026-11-14T03:10:00Z');   // 00:10 ART del 14
  assert.deepEqual(tagsAMirar(ahora), ['granizo-2026-11-13', 'granizo-2026-11-14']);
  const reloj = { t: Date.parse('2026-11-14T02:55:00Z') };
  const { cliente, sello } = armar({ reloj });
  await archivar({ cliente: cliente(), pedido: pedido(respuestaGranizo({ scan_t: '2026-11-14T02:40:20Z' }), { ms: reloj.t }), sello });
  const est = await leerEstado(cliente(), ahora);
  assert.equal(est.barridos.length, 1);
  assert.equal(est.pedidos.length, 1);
  assert.equal(evaluarFrescura({ ahoraMs: ahora, ...est }).tipo, 'ok');
});

test('vigía: SIN-LECTURA si hn-radar no contesta (un aviso por día)', async () => {
  const c = clienteReleases({ token: TOK, repo: REPO, fetchFn: async () => ({ status: 401, ok: false, text: async () => '' }) });
  const v = await evaluarAhora({ cliente: c, ahoraMs: T0 });
  assert.deepEqual([v.tipo, v.clave], ['sin-lectura', 'granizo-archivo-sin-lectura-2026-11-13']);
  assert.equal((await evaluarAhora({ cliente: null, ahoraMs: T0 })).tipo, 'sin-lectura');
  // O2: el REPO da 404 (token sin permiso sobre un privado) → sin-lectura, no «parado»; con el repo visible y sin releases → parado (control)
  const g404 = githubFalso({ fallar: { repo404: true } });
  const v404 = await evaluarAhora({ cliente: clienteReleases({ token: TOK, repo: REPO, fetchFn: g404.fetchFn }), ahoraMs: T0 });
  assert.equal(v404.tipo, 'sin-lectura');
  const gok = githubFalso();
  assert.equal((await evaluarAhora({ cliente: clienteReleases({ token: TOK, repo: REPO, fetchFn: gok.fetchFn }), ahoraMs: T0 })).tipo, 'parado');
});

test('vigía: la marca para la caché queda SÓLO si el mail salió', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'granizo-marca-'));
  const ev = { avisar: true, clave: 'granizo-archivo-parado-tras-x', asunto: 'a', detalle: 'b' };
  await assert.rejects(ejecutarMandar(ev, { enviar: async () => { throw new Error('smtp'); }, cfg: {}, marcaDir: path.join(d, 'm1') }));
  assert.equal(fs.existsSync(path.join(d, 'm1', 'clave')), false);
  const r = await ejecutarMandar(ev, { enviar: async () => ({ destinatarios: 1 }), cfg: {}, marcaDir: path.join(d, 'm2') });
  assert.equal(r.enviado, true);
  assert.equal(fs.readFileSync(path.join(d, 'm2', 'clave'), 'utf8').trim(), ev.clave);
  assert.equal((await ejecutarMandar({ avisar: false }, { enviar: async () => { throw new Error('no'); }, cfg: {} })).enviado, false);
  fs.rmSync(d, { recursive: true, force: true });
});
