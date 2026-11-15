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
