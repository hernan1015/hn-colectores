// node --test · la conexión: el rol, el pooler, la CA y el TLS que AUTENTICA al servidor (como la 257 v2), y los errores
// que nunca sacan el texto del driver. Con una fábrica de postgres.js falsa: nunca hay red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conectar, opcionesPg, leerCa, errorLimpio, hostDeUrl } from '../lib/base.mjs';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQUJDREVGR0hJSktMTU5PUFFSU1RVVjAKBggqhkjOPQQDAjAA\n-----END CERTIFICATE-----\n';
const URL_OK = 'postgresql://medicion_app.abcdefgh:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres';
const fabrica = (usuario = 'medicion_app') => {
  const f = (url, opciones) => { f.opciones = opciones; return { unsafe: async () => [{ u: usuario, s: usuario }], end: async () => {} }; };
  return f;
};

test('TLS: rejectUnauthorized true, la CA y el nombre del host; nunca ssl:"require"', async () => {
  const o = opcionesPg('aws-0-sa-east-1.pooler.supabase.com', CA);
  assert.deepEqual(o.ssl, { rejectUnauthorized: true, ca: CA, servername: 'aws-0-sa-east-1.pooler.supabase.com', minVersion: 'TLSv1.2' });
  assert.equal(o.prepare, false); assert.equal(o.max, 1);
  const pg = fabrica();
  await conectar(URL_OK, { pg, ca: CA });
  assert.equal(pg.opciones.ssl.rejectUnauthorized, true);
  assert.equal(pg.opciones.ssl.ca, CA);
  assert.equal(pg.opciones.ssl.servername, hostDeUrl(URL_OK));
});

test('sin CA no conecta; la CA tiene que ser PEM', async () => {
  const viejo = { a: process.env.MEDICION_PG_CA, b: process.env.MEDICION_PG_CA_FILE };
  delete process.env.MEDICION_PG_CA; delete process.env.MEDICION_PG_CA_FILE;
  try {
    const pg = fabrica();
    await assert.rejects(conectar(URL_OK, { pg }), /falta la CA/);
    assert.equal(pg.opciones, undefined, 'ni siquiera se intentó conectar');
    assert.throws(() => leerCa({ texto: 'no soy un certificado' }), /no es un certificado PEM/);
    assert.equal(leerCa({ texto: CA }), CA);
  } finally { if (viejo.a != null) process.env.MEDICION_PG_CA = viejo.a; if (viejo.b != null) process.env.MEDICION_PG_CA_FILE = viejo.b; }
});

test('sólo el rol medicion_app, sólo el pooler, y si entra como otro usuario se aborta', async () => {
  await assert.rejects(conectar(URL_OK.replace('medicion_app', 'postgres'), { pg: fabrica(), ca: CA }), /no es del rol medicion_app/);
  await assert.rejects(conectar(URL_OK.replace('medicion_app', 'colector_estaciones'), { pg: fabrica(), ca: CA }), /no es del rol/);
  await assert.rejects(conectar('postgresql://medicion_app.x:y@db.abc.supabase.co:5432/postgres', { pg: fabrica(), ca: CA }), /pooler/);
  await assert.rejects(conectar('postgresql://medicion_app.x:a@b@evil.pooler.supabase.com:6543/postgres', { pg: fabrica(), ca: CA }), /pooler/, 'dos «@»');
  await assert.rejects(conectar(URL_OK, { pg: fabrica('postgres'), ca: CA }), /no es el rol/);
});

test('los errores salen como códigos, sin el texto del driver', () => {
  const e = errorLimpio(Object.assign(new Error('password authentication failed for user medicion_app.abc at host x.pooler'), { code: '28P01' }), 'conectar');
  assert.equal(e.message, 'conectar: 28P01 (usuario o clave)');
  assert.equal(errorLimpio(new Error('postgres://u:clave@h')).message, 'base: sin_codigo');
  assert.equal(errorLimpio({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }).message, 'base: SELF_SIGNED_CERT_IN_CHAIN (certificado no confiable)');
});
