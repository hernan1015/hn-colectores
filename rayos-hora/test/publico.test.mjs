// [_v1815 · la 262] El derivado público de rayos para SATCHI (lib/publico.mjs). Carpetas temporales, sin red.
// Correr: node --test test/publico.test.mjs (dentro de rayos-hora/). Control negativo: test/control-publico.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { almacenCarpeta, almacenR2 } from '../lib/almacen.mjs';
import * as P from '../lib/publico.mjs';

const H = 3600000;
const carpeta = () => almacenCarpeta(fs.mkdtempSync(path.join(os.tmpdir(), 'rayos-pub-')));
const iso = (h) => new Date(h).toISOString().slice(0, 13) + ':00Z';
const p2 = (n) => String(n).padStart(2, '0');
const clavePriv = (h) => { const d = new Date(h); return 'rayos-hora/' + d.getUTCFullYear() + '/' + p2(d.getUTCMonth() + 1) + '/' + p2(d.getUTCDate()) + '/' + p2(d.getUTCHours()) + '.json'; };
function docPriv(h, { faltantes = [], flashes = [[1000, -31.4, -64.5, 50.5, 66.7, 0]] } = {}) {
  return { v: 1, hora: iso(h), estado: faltantes.length ? 'incompleta' : 'completa', satelite: 'GOES-19', producto: 'x', caja: {}, archivos: {},
    faltantes, intentos: 1, n: flashes.length, columnas: ['t_ms', 'lat', 'lon', 'energia_fJ', 'area_km2', 'calidad'], flashes, nota: '', generado: '', bytes_bajados: 1, flashes_disco: 1 };
}
const H0 = Date.UTC(2026, 10, 13, 5);
const leerJ = async (alm, k) => JSON.parse((await alm.leer(k)).toString('utf8'));

test('las claves son las que lee hn-agro (lib/rayos-vs-foco.mjs): rayos/AAAA-MM-DD/HH.json y AAAA-MM-DDTHHZ', () => {
  assert.equal(P.clavePublica(H0), 'rayos/2026-11-13/05.json');
  assert.equal(P.marcaIndice(H0), '2026-11-13T05Z');
  assert.equal(P.INDICE_PUB, 'rayos/indice.json');
  assert.equal(P.DEPOSITO_PUB, 'satchi-mapas');
  assert.equal(P.horaDeClavePrivada(clavePriv(H0)), H0);
});

test('derivar: lat, lon, hora, energía y calidad; sin área; conserva estado y faltantes', () => {
  const d = P.derivar(docPriv(H0, { faltantes: ['10:00'] }));
  assert.deepEqual(d.columnas, ['t_ms', 'lat', 'lon', 'energia_fJ', 'calidad']);
  assert.deepEqual(d.flashes[0], [1000, -31.4, -64.5, 50.5, 0]);
  assert.equal(d.estado, 'incompleta'); assert.deepEqual(d.faltantes, ['10:00']);
  assert.equal(d.hora, iso(H0)); assert.equal(d.n, 1);
  assert.equal(P.derivar({ v: 2 }), null);
});

test('copia las horas que hay, arma el índice y NO inventa las que faltan (hueco)', async () => {
  const priv = carpeta(), pub = carpeta();
  await priv.escribir(clavePriv(H0), JSON.stringify(docPriv(H0)));
  await priv.escribir(clavePriv(H0 + 2 * H), JSON.stringify(docPriv(H0 + 2 * H, { faltantes: ['00:00'] })));   // H0 + 1 h: hueco
  const r = await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0 - H, hastaMs: H0 + 3 * H });
  assert.equal(r.copiadas, 2);
  const idx = await leerJ(pub, 'rayos/indice.json');
  assert.deepEqual(idx.horas, { '2026-11-13T05Z': 'completa', '2026-11-13T07Z': 'incompleta' });
  assert.equal(idx.horas['2026-11-13T06Z'], undefined, 'el hueco queda fuera del índice: «sin dato» para esa hora');
  assert.equal(await pub.leer('rayos/2026-11-13/06.json'), null);
  assert.equal((await leerJ(pub, 'rayos/2026-11-13/07.json')).estado, 'incompleta');
});

test('idempotente, y una incompleta que se completó se vuelve a copiar', async () => {
  const priv = carpeta(), pub = carpeta();
  await priv.escribir(clavePriv(H0), JSON.stringify(docPriv(H0, { faltantes: ['00:00'] })));
  await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 });
  const r2 = await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 });
  assert.equal(r2.copiadas, 0); assert.equal(r2.ya, 1);
  await priv.escribir(clavePriv(H0), JSON.stringify(docPriv(H0)));
  const r3 = await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 });
  assert.equal(r3.copiadas, 1);
  assert.equal((await leerJ(pub, 'rayos/indice.json')).horas['2026-11-13T05Z'], 'completa');
});

test('respeta el rango (el relleno desde el 08/11 01 UTC no toca lo de antes)', async () => {
  const priv = carpeta(), pub = carpeta(), D = Date.UTC(2026, 10, 8, 1);
  await priv.escribir(clavePriv(D - H), JSON.stringify(docPriv(D - H)));
  await priv.escribir(clavePriv(D), JSON.stringify(docPriv(D)));
  const r = await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: D, hastaMs: D + H });
  assert.equal(r.copiadas, 1);
  assert.deepEqual(Object.keys((await leerJ(pub, 'rayos/indice.json')).horas), ['2026-11-08T01Z']);
});

test('una hora privada ilegible o de otra hora no se copia ni entra al índice', async () => {
  const priv = carpeta(), pub = carpeta();
  await priv.escribir(clavePriv(H0), '{roto');
  await priv.escribir(clavePriv(H0 + H), JSON.stringify(docPriv(H0)));   // dice ser de H0 pero está en la clave de H0 + 1 h
  const r = await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 + H });
  assert.equal(r.ilegibles, 2); assert.equal(r.copiadas, 0);
  assert.equal(await pub.leer('rayos/indice.json'), null);
});

test('R2: el objeto público lleva Cache-Control (1 día la completa, 15 min la incompleta, 5 min el índice)', async () => {
  const vistos = [];
  const fetchFn = async (url, o) => { vistos.push({ url, h: o.headers, m: o.method }); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '<ListBucketResult></ListBucketResult>' }; };
  const pub = almacenR2({ cuenta: 'a'.repeat(32), clave: 'k', secreto: 's', deposito: 'satchi-mapas', fetchFn });
  pub.leer = async () => null;
  const priv = carpeta();
  await priv.escribir(clavePriv(H0), JSON.stringify(docPriv(H0)));
  await priv.escribir(clavePriv(H0 + H), JSON.stringify(docPriv(H0 + H, { faltantes: ['00:00'] })));
  await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 + H });
  const put = vistos.filter((v) => v.m === 'PUT');
  assert.equal(put.length, 3);
  assert.match(put[0].url, /\/satchi-mapas\/rayos\/2026-11-13\/05\.json$/); assert.equal(put[0].h['cache-control'], 'public, max-age=86400');
  assert.equal(put[1].h['cache-control'], 'public, max-age=900');
  assert.match(put[2].url, /\/rayos\/indice\.json$/); assert.equal(put[2].h['cache-control'], 'public, max-age=300');
});

/* ── [2.ª vuelta · Codex n3-262-1511] el derivador NUNCA escribe `faltantes: []` cuando no sabe qué falta ── */
const sinFaltantes = (h, extra = {}) => { const d = docPriv(h, { faltantes: ['00:00'] }); delete d.faltantes; return Object.assign(d, extra); };

test('2.ª vuelta · la reproducción de Codex: incompleta SIN faltantes → «desconocido», faltantes null (antes salía [])', () => {
  const d = P.derivar(sinFaltantes(H0));
  assert.equal(d.estado, 'desconocido');
  assert.equal(d.faltantes, null);
  assert.notDeepEqual(d.faltantes, []);
  assert.match(d.nota, /DESCONOCIDA/);
});

test('2.ª vuelta · faltantes mal formados, vacíos en una incompleta o presentes en una completa → «desconocido»', () => {
  const casos = [
    Object.assign(docPriv(H0, { faltantes: ['00:00'] }), { faltantes: [] }),          // incompleta con lista vacía
    Object.assign(docPriv(H0, { faltantes: ['00:00'] }), { faltantes: '00:00' }),     // no es lista
    Object.assign(docPriv(H0, { faltantes: ['00:00'] }), { faltantes: [600] }),       // número
    docPriv(H0, { faltantes: ['1:5'] }),                                              // mal escrito
    docPriv(H0, { faltantes: ['10:10'] }),                                            // no es un casillero de 20 s
    docPriv(H0, { faltantes: ['60:00'] }),                                            // fuera de la hora
    Object.assign(docPriv(H0), { faltantes: ['10:00'] }),                             // completa CON faltantes
    Object.assign(docPriv(H0), { faltantes: undefined }),                             // completa sin lista
  ];
  for (const c of casos) {
    const d = P.derivar(c);
    assert.equal(d.estado, 'desconocido', JSON.stringify(c.faltantes) + ' / ' + c.estado);
    assert.equal(d.faltantes, null);
  }
  /* control: las buenas pasan como están */
  assert.equal(P.derivar(docPriv(H0)).estado, 'completa'); assert.deepEqual(P.derivar(docPriv(H0)).faltantes, []);
  assert.deepEqual(P.derivar(docPriv(H0, { faltantes: ['59:40', '00:20'] })).faltantes, ['59:40', '00:20']);
});

test('2.ª vuelta · ninguna incompleta ni desconocida sale con faltantes: [] (barrido)', () => {
  const listas = [undefined, null, [], ['00:00'], ['x'], [1], ['00:00', '00:00'], {}, 'a'];
  for (const estado of ['completa', 'incompleta']) for (const f of listas) {
    const doc = Object.assign(docPriv(H0), { estado, faltantes: f });
    const d = P.derivar(doc);
    if (d.estado !== 'completa') assert.ok(!(Array.isArray(d.faltantes) && d.faltantes.length === 0), estado + ' ' + JSON.stringify(f));
  }
});

test('2.ª vuelta · una hora desconocida entra al índice como «desconocido» (no como completa ni incompleta)', async () => {
  const priv = carpeta(), pub = carpeta();
  await priv.escribir(clavePriv(H0), JSON.stringify(sinFaltantes(H0)));
  const r = await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 });
  assert.equal(r.copiadas, 1); assert.equal(r.desconocidas, 1);
  assert.equal((await leerJ(pub, 'rayos/indice.json')).horas['2026-11-13T05Z'], 'desconocido');
  const d = await leerJ(pub, 'rayos/2026-11-13/05.json');
  assert.equal(d.estado, 'desconocido'); assert.equal(d.faltantes, null);
});

test('2.ª vuelta · n3 §3: una incompleta que suma flashes SIN cambiar de estado se vuelve a copiar (firma)', async () => {
  const priv = carpeta(), pub = carpeta();
  await priv.escribir(clavePriv(H0), JSON.stringify(docPriv(H0, { faltantes: ['00:00', '00:20'], flashes: [] })));
  await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 });
  const i1 = await leerJ(pub, 'rayos/indice.json');
  await priv.escribir(clavePriv(H0), JSON.stringify(docPriv(H0, { faltantes: ['00:00'], flashes: [[1000, -31.4, -64.5, 50.5, 66.7, 0]] })));
  const r = await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 });
  assert.equal(r.copiadas, 1, 'misma «incompleta», contenido nuevo: se copia');
  const i2 = await leerJ(pub, 'rayos/indice.json');
  assert.equal(i2.horas['2026-11-13T05Z'], 'incompleta');
  assert.ok(i1.firmas['2026-11-13T05Z'] && i2.firmas['2026-11-13T05Z'] && i1.firmas['2026-11-13T05Z'] !== i2.firmas['2026-11-13T05Z']);
  const d = await leerJ(pub, 'rayos/2026-11-13/05.json');
  assert.equal(d.n, 1); assert.deepEqual(d.faltantes, ['00:00']); assert.equal(d.firma, i2.firmas['2026-11-13T05Z']);
  /* y sin cambios, sigue siendo idempotente */
  assert.equal((await P.copiarAPublico({ privado: priv, publico: pub, desdeMs: H0, hastaMs: H0 })).copiadas, 0);
});

test('2.ª vuelta · una fila de flashes que no es lista no rompe la copia: queda null (el lector no acredita esa hora)', () => {
  const d = P.derivar(docPriv(H0, { flashes: [[1000, -31.4, -64.5, 50.5, 66.7, 0], 'roto'] }));
  assert.equal(d.flashes[1], null); assert.equal(d.n, 2); assert.equal(d.estado, 'completa');
});

test('2.ª vuelta · n3: el error que se imprime no lleva URLs ni tiras largas', () => {
  const e = new Error('PUT https://abc.r2.cloudflarestorage.com/satchi-mapas/rayos/x.json?X-Amz-Signature=deadbeef falló · token AKIAABCDEFGHIJKLMNOPQRSTUV0123');
  const t = P.textoError(e);
  assert.doesNotMatch(t, /https?:|cloudflarestorage|Signature|AKIAABCDEFGHIJ/);
  assert.match(t, /^PUT \[url\] falló · token \[…\]$/);
  assert.ok(P.textoError('x'.repeat(10) + ' ' + 'y '.repeat(300)).length <= 200);
});
