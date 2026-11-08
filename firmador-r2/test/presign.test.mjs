// El GET firmado por query contra el ejemplo oficial de AWS (S3 · «Authenticating Requests: Using Query Parameters»,
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html), con sus llaves de ejemplo públicas.
// Sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { presignGet, amzFecha, deAmzFecha, MAX_EXPIRA } from '../lib/presign.mjs';

const AWS = {
  host: 'examplebucket.s3.amazonaws.com', ruta: '/test.txt', region: 'us-east-1', expira: 86400,
  clave: 'AKIAIOSFODNN7EXAMPLE', secreto: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  fecha: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
};
// Los valores publicados en esa página
const CANONICA = [
  'GET', '/test.txt',
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
  'host:examplebucket.s3.amazonaws.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
const HASH_CANONICA = '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04';
const A_FIRMAR = 'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n' + HASH_CANONICA;
const FIRMA = 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';
const URL_AWS = 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=' + FIRMA;

test('AWS · pedido canónico, cadena a firmar, firma y URL del ejemplo oficial', () => {
  const r = presignGet(AWS);
  assert.equal(r.canonica, CANONICA);
  assert.equal(crypto.createHash('sha256').update(r.canonica).digest('hex'), HASH_CANONICA);
  assert.equal(r.aFirmar, A_FIRMAR);
  assert.equal(r.firma, FIRMA);
  assert.equal(r.url, URL_AWS);
  assert.equal(r.vence.toISOString(), '2013-05-25T00:00:00.000Z');
});

test('R2 · 7 días, región auto, ruta de estilo «depósito/clave» codificada por segmento', () => {
  const r = presignGet({ host: 'c.r2.cloudflarestorage.com', ruta: '/satchi-mapas/opera/cog/cuenca-del-plata/2026-10-25.tif', clave: 'K', secreto: 'S', fecha: new Date('2026-11-07T23:14:05.987Z') });
  const u = new URL(r.url);
  assert.equal(u.pathname, '/satchi-mapas/opera/cog/cuenca-del-plata/2026-10-25.tif');
  assert.equal(u.searchParams.get('X-Amz-Expires'), String(MAX_EXPIRA));
  assert.equal(u.searchParams.get('X-Amz-Credential'), 'K/20261107/auto/s3/aws4_request');
  assert.equal(u.searchParams.get('X-Amz-Date'), '20261107T231405Z');
  assert.equal(r.vence.toISOString(), '2026-11-14T23:14:05.000Z');   // sin los milisegundos: lo que R2 cuenta
  const r2 = presignGet({ host: 'c.r2.cloudflarestorage.com', ruta: '/d/a b(1).json', clave: 'K', secreto: 'S', fecha: new Date(0) });
  assert.ok(r2.url.includes('/d/a%20b%281%29.json?'));
});

test('fechas amz ida y vuelta', () => {
  assert.equal(amzFecha(AWS.fecha), '20130524T000000Z');
  assert.equal(deAmzFecha('20130524T000000Z').getTime(), AWS.fecha.getTime());
  assert.equal(deAmzFecha('2013-05-24'), null);
});

// ── control negativo: cada cambio tiene que mover la firma (si no, el test de arriba no prueba nada) ──
test('control negativo · romper la firma (secreto, clave, ruta, host, región, expira) cambia el resultado', () => {
  const cambios = {
    secreto: { secreto: AWS.secreto.slice(0, -1) + 'X' },
    clave: { clave: AWS.clave.slice(0, -1) + 'F' },   // armada en tiempo de ejecución (no es una llave)
    ruta: { ruta: '/test.txT' },
    host: { host: 'examplebucket.s3.amazonaws.co' },
    region: { region: 'us-east-2' },
    expira: { expira: 86401 },
  };
  let movidas = 0;
  for (const [, c] of Object.entries(cambios)) if (presignGet({ ...AWS, ...c }).firma !== FIRMA) movidas++;
  assert.equal(movidas, Object.keys(cambios).length);
});

test('control negativo · romper la fecha (un segundo, un día) cambia firma y vencimiento', () => {
  const s = presignGet({ ...AWS, fecha: new Date(AWS.fecha.getTime() + 1000) });
  const d = presignGet({ ...AWS, fecha: new Date(AWS.fecha.getTime() + 864e5) });
  assert.notEqual(s.firma, FIRMA);
  assert.notEqual(d.firma, FIRMA);
  assert.notEqual(s.vence.getTime(), presignGet(AWS).vence.getTime());
});

test('rechaza lo que R2 no acepta', () => {
  assert.throws(() => presignGet({ ...AWS, expira: MAX_EXPIRA + 1 }), /X-Amz-Expires/);
  assert.throws(() => presignGet({ ...AWS, expira: 0 }), /X-Amz-Expires/);
  assert.throws(() => presignGet({ ...AWS, fecha: new Date('nada') }), /fecha/);
  assert.throws(() => presignGet({ ...AWS, secreto: '' }), /llaves/);
  assert.throws(() => presignGet({ ...AWS, ruta: 'test.txt' }), /ruta/);
});
