// node --test lib/test/pg-tls.test.mjs   (sin red: el único socket es un servidor TLS propio en 127.0.0.1)
// La 264: el helper común que arma el `ssl` VERIFICADO de postgres.js. Certificados de prueba generados acá (openssl).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { pgTls, conTls, leerCa, huellas, hostDeUrl, CA_COMUN } from '../pg-tls.mjs';
import { armarCerts } from './certs.mjs';

let C;
before(() => { C = armarCerts(); });
after(() => C && C.borrar());

const HOST = 'aws-0-sa-east-1.pooler.supabase.com';
const URL_OK = `postgresql://colector_x.ref:Cl4ve-De-Prueba-NoEsReal@${HOST}:6543/postgres`;

test('pgTls: rejectUnauthorized true, la CA dada, servername = host de la URL, TLS ≥ 1.2, congelado', () => {
  const s = pgTls(URL_OK, { ca: C.ca });
  assert.equal(s.rejectUnauthorized, true);
  assert.equal(s.ca.trim(), C.ca.trim());
  assert.equal(s.servername, HOST);
  assert.equal(s.minVersion, 'TLSv1.2');
  assert.equal(typeof s.checkServerIdentity, 'function');
  assert.ok(Object.isFrozen(s));
  assert.throws(() => { 'use strict'; s.rejectUnauthorized = false; });
  /* el host solo también sirve; una IP no va como SNI (RFC 6066) pero se controla igual */
  assert.equal(pgTls(HOST, { ca: C.ca }).servername, HOST);
  assert.equal(pgTls('127.0.0.1', { ca: C.ca }).servername, undefined);
});

test('pgTls: el host sale como lo lee postgres.js (primer «@»); sin host entendible no se arma nada', () => {
  assert.equal(hostDeUrl(URL_OK), HOST);
  assert.equal(hostDeUrl(`postgresql://u:cl@ve@${HOST}:6543/postgres`), null);   // «@» sin codificar en la clave
  for (const malo of ['', null, undefined, 'https://x.supabase.co', 'postgresql://sin-arroba/postgres', 'host con espacios'])
    assert.throws(() => pgTls(malo, { ca: C.ca }), /no se entiende el host/);
});

test('sin CA → error claro y NO se conecta (archivo que no está, texto basura, PEM roto, no-CA, vencida)', () => {
  assert.throws(() => pgTls(URL_OK, { archivo: C.archivo('no-existe.crt') }), (e) => e.propio && /no se puede leer la CA.*NO se conecta/.test(e.message));
  assert.throws(() => pgTls(URL_OK, { ca: 'hola' }), /no es un certificado PEM/);
  assert.throws(() => pgTls(URL_OK, { ca: C.ca + '\nbasura' }), /no es un certificado PEM/);
  const lineas = C.ca.trim().split('\n');                                      // un PEM cortado (falta una línea del medio)
  assert.throws(() => pgTls(URL_OK, { ca: [...lineas.slice(0, 2), ...lineas.slice(3)].join('\n') }), /X\.509/);
  assert.throws(() => pgTls(URL_OK, { ca: C.hoja }), /no es de una CA/);
  assert.throws(() => pgTls(URL_OK, { ca: C.ca, ahora: new Date('2200-01-01') }), /no está vigente/);
  assert.throws(() => pgTls(URL_OK, { ca: C.ca, ahora: new Date('2000-01-01') }), /no está vigente/);
  /* un texto vacío como override no cuenta: cae al archivo (y si el archivo no está, error) */
  assert.throws(() => pgTls(URL_OK, { ca: '   ', archivo: C.archivo('no-existe.crt') }), /no se puede leer la CA/);
  /* control: la CA buena y el archivo bueno sí pasan */
  assert.ok(pgTls(URL_OK, { archivo: C.archivo('ca.crt') }).ca.includes('BEGIN CERTIFICATE'));
  assert.equal(leerCa({ texto: C.ca + C.otra }).match(/BEGIN CERTIFICATE/g).length, 2);
});

test('rejectUnauthorized nunca false: conTls pisa cualquier ssl que traigan las opciones', () => {
  for (const ssl of [false, 'require', 'prefer', 'allow', 'disable', { rejectUnauthorized: false }, { ca: 'x', rejectUnauthorized: 0 }]) {
    const o = conTls(URL_OK, { max: 1, ssl }, { ca: C.ca });
    assert.equal(o.ssl.rejectUnauthorized, true, `con ssl=${JSON.stringify(ssl)}`);
    assert.equal(o.max, 1);
  }
  /* y el resultado no se puede «aflojar» después */
  const o = conTls(URL_OK, {}, { ca: C.ca });
  assert.throws(() => { 'use strict'; o.ssl.rejectUnauthorized = false; });
  assert.equal(o.ssl.rejectUnauthorized, true);
});

test('huellas: SHA-256 igual a la de openssl x509 -fingerprint -sha256', () => {
  assert.deepEqual(huellas(C.ca), [C.huellaOpenssl('ca.crt')]);
});

/** Un handshake TLS de verdad contra un servidor propio en 127.0.0.1 con el certificado de prueba. */
async function handshake(ssl) {
  const srv = tls.createServer({ cert: C.srvCrt, key: C.srvKey }, (s) => s.end());
  srv.on('tlsClientError', () => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: srv.address().port, ...ssl }, () => { s.destroy(); resolve('ok'); });
      s.on('error', (e) => resolve(e.code || e.message));
    });
  } finally { srv.close(); }
}

test('handshake real: la CA que firmó pasa; otra CA, otro nombre o la CA del sistema NO', async () => {
  assert.equal(await handshake(pgTls('localhost', { ca: C.ca })), 'ok');
  assert.equal(await handshake(pgTls('127.0.0.1', { ca: C.ca })), 'ok');            // la IP contra el SAN de IP
  assert.notEqual(await handshake(pgTls('localhost', { ca: C.otra })), 'ok');        // suplantación: firmado por otra CA
  assert.equal(await handshake(pgTls('otro.example.com', { ca: C.ca })), 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(await handshake(pgTls('10.0.0.1', { ca: C.ca })), 'ERR_TLS_CERT_ALTNAME_INVALID');
  /* control negativo: lo que hace hoy `ssl: 'require'` (rejectUnauthorized: false) acepta al impostor */
  assert.equal(await handshake({ rejectUnauthorized: false, servername: 'localhost', ca: C.otra }), 'ok');
});

const CA_EN_REPO = fs.existsSync(CA_COMUN);
test('la CA común del repo (lib/ca/supabase-prod-ca-2021.crt): CA vigente y con la huella anotada en lib/ca/HUELLA-SHA256', {
  skip: !CA_EN_REPO && 'todavía no está lib/ca/supabase-prod-ca-2021.crt (la agrega local; sin ella los colectores NO se conectan)',
}, () => {
  const pem = leerCa();
  const anotada = fs.readFileSync(new URL('../ca/HUELLA-SHA256', import.meta.url), 'utf8').match(/([0-9A-F]{2}:){31}[0-9A-F]{2}/g) || [];
  assert.deepEqual(huellas(pem), anotada);
  for (const h of huellas(pem)) assert.match(h, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(new X509Certificate(pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]).ca);
});
