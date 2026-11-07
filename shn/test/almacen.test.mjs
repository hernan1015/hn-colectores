import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { firmarSigV4, almacenR2, almacenCarpeta, almacenDesdeEntorno } from '../lib/almacen.mjs';
import { carpetaTemporal, leer } from './ayuda.mjs';
import { subir, fusionarTexto } from '../subir-historia.mjs';

// Vectores públicos de la documentación de AWS (claves de EJEMPLO, no son de nadie).
const EJ = { clave: 'AKIAIOSFODNN7EXAMPLE', secreto: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', fecha: new Date('2013-05-24T00:00:00Z') };
const VACIO = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('SigV4: GET Object del ejemplo de AWS', () => {
  const h = firmarSigV4({ ...EJ, metodo: 'GET', host: 'examplebucket.s3.amazonaws.com', ruta: '/test.txt', headers: { Range: 'bytes=0-9' } });
  assert.equal(h['x-amz-content-sha256'], VACIO);
  assert.equal(h._firma, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('SigV4: PUT Object del ejemplo de AWS (clave con $)', () => {
  const h = firmarSigV4({ ...EJ, metodo: 'PUT', host: 'examplebucket.s3.amazonaws.com', ruta: '/test$file.text', cuerpo: 'Welcome to Amazon S3.',
    headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' } });
  assert.equal(h._firma, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('SigV4: ListObjects del ejemplo de AWS (query ordenada)', () => {
  const h = firmarSigV4({ ...EJ, metodo: 'GET', host: 'examplebucket.s3.amazonaws.com', ruta: '/', query: { prefix: 'J', 'max-keys': '2' } });
  assert.equal(h._firma, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

// R2 falso en memoria: verifica la URL, la firma presente, If-None-Match y la paginación de la lista.
function r2Falso() {
  const objetos = new Map();
  const f = async (url, o) => {
    const u = new URL(url);
    f.urls.push(u);
    assert.match(o.headers.authorization, /^AWS4-HMAC-SHA256 Credential=ID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*host.*x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(u.host, 'cuenta.r2.cloudflarestorage.com');
    const [, dep, ...resto] = u.pathname.split('/');
    assert.equal(dep, 'deposito');
    const clave = decodeURIComponent(resto.join('/'));
    if (o.method === 'PUT') {
      if (o.headers['if-none-match'] === '*' && objetos.has(clave)) return new Response(null, { status: 412 });
      objetos.set(clave, Buffer.from(o.body)); return new Response(null, { status: 200 });
    }
    if (o.method === 'DELETE') { objetos.delete(clave); return new Response(null, { status: 204 }); }
    if (o.method === 'HEAD') return new Response(null, { status: objetos.has(clave) ? 200 : 404 });
    if (!clave) { // lista, de a 2 para probar la paginación
      const pre = u.searchParams.get('prefix');
      const todas = [...objetos.keys()].filter((k) => k.startsWith(pre)).sort();
      const desde = Number(u.searchParams.get('continuation-token') || 0);
      const pag = todas.slice(desde, desde + 2);
      const mas = desde + 2 < todas.length;
      return new Response(`<ListBucketResult>${pag.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${mas}</IsTruncated>${mas ? `<NextContinuationToken>${desde + 2}</NextContinuationToken>` : ''}</ListBucketResult>`, { status: 200 });
    }
    return objetos.has(clave) ? new Response(objetos.get(clave), { status: 200 }) : new Response('NoSuchKey', { status: 404 });
  };
  f.urls = []; f.objetos = objetos;
  return f;
}

test('R2: leer/escribir/existe/borrar/listar con prefijo shn/ y escritura condicional', async () => {
  const f = r2Falso();
  const a = almacenR2({ cuenta: 'cuenta', clave: 'ID', secreto: 'S', deposito: 'deposito', fetchFn: f });
  assert.equal(await a.leer('horario/SFER.csv'), null);
  assert.equal(await a.escribir('horario/SFER.csv', 'x'), true);
  assert.ok(f.objetos.has('shn/horario/SFER.csv'));
  assert.equal((await a.leer('horario/SFER.csv')).toString(), 'x');
  assert.equal(await a.existe('horario/SFER.csv'), true);
  assert.equal(await a.escribir('horario/SFER.csv', 'y', { soloSiNoExiste: true }), false, '412 = ya existía');
  assert.equal((await a.leer('horario/SFER.csv')).toString(), 'x', 'no se pisó');
  for (const k of ['a.txt', 'b.txt', 'c/d.txt', 'e&f.txt']) await a.escribir(k, k);
  assert.deepEqual(await a.listar(''), ['a.txt', 'b.txt', 'c/d.txt', 'e&f.txt', 'horario/SFER.csv']);
  await a.borrar('a.txt');
  assert.equal(await a.existe('a.txt'), false);
});

test('R2: sin variables no arranca (y no muestra valores)', () => {
  assert.throws(() => almacenDesdeEntorno({ env: {} }), /faltan las variables R2_ACCOUNT_ID/);
});

test('carpeta: escritura condicional y claves fuera de la carpeta', async () => {
  const dir = carpetaTemporal();
  const a = almacenCarpeta(dir);
  assert.equal(await a.escribir('x/y.txt', '1', { soloSiNoExiste: true }), true);
  assert.equal(await a.escribir('x/y.txt', '2', { soloSiNoExiste: true }), false);
  assert.equal(leer(dir, 'x/y.txt'), '1');
  await assert.rejects(a.leer('../afuera.txt'), /fuera de la carpeta/);
});

// ---------- subir-historia ----------
function historiaMuestra() {
  const o = carpetaTemporal();
  const w = (rel, t) => { const p = path.join(o, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
  w('horario/SFER.csv', 'hora_local;medida_m;astronomica_m;diferencia_m\n2026-11-05T10:45;1;0.5;0.500\n2026-11-05T11:45;1.1;;\n');
  w('crudos/horario/SFER/202611.jsonl', '{"pedido":"1"}\n');
  w('alertas/alertas.txt', '2026-11-05T10:00:00Z  vieja\n');
  w('.candado', '123');
  w('modelo/svg/Palermo_20261105_1101Z.svg', '<svg/>');
  return o;
}

test('subir-historia: sube todo sin pisar, alertas a shn/alertas.txt, sin candado', async () => {
  const origen = historiaMuestra();
  const dir = carpetaTemporal();
  const dest = almacenCarpeta(dir);
  await dest.escribir('modelo/svg/Palermo_20261105_1101Z.svg', '<svg>de la nube</svg>');
  const r = await subir({ origen, almacen: dest, salida: () => {} });
  assert.deepEqual(r.subidos.sort(), ['alertas.txt', 'crudos/horario/SFER/202611.jsonl', 'horario/SFER.csv']);
  assert.deepEqual(r.omitidos, ['modelo/svg/Palermo_20261105_1101Z.svg']);
  assert.deepEqual(r.ignorados, ['.candado']);
  assert.equal(leer(dir, 'modelo/svg/Palermo_20261105_1101Z.svg'), '<svg>de la nube</svg>');
  assert.equal(leer(dir, '.candado'), null);
});

test('subir-historia --probar no escribe nada', async () => {
  const dir = carpetaTemporal();
  const r = await subir({ origen: historiaMuestra(), almacen: almacenCarpeta(dir), probar: true, salida: () => {} });
  assert.equal(r.subidos.length, 4);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('subir-historia --fusionar une el horario por hora (manda R2) y los renglones', async () => {
  const origen = historiaMuestra();
  const dir = carpetaTemporal();
  const dest = almacenCarpeta(dir);
  await dest.escribir('horario/SFER.csv', 'hora_local;medida_m;astronomica_m;diferencia_m\n2026-11-05T11:45;1.2;0.6;0.600\n2026-11-06T14:45;2;1;1.000\n');
  await dest.escribir('crudos/horario/SFER/202611.jsonl', '{"pedido":"2"}\n');
  const sin = await subir({ origen, almacen: dest, salida: () => {} });
  assert.ok(sin.omitidos.includes('horario/SFER.csv'));
  const r = await subir({ origen, almacen: dest, fusionar: true, salida: () => {} });
  assert.ok(r.fusionados.includes('horario/SFER.csv'));
  assert.equal(leer(dir, 'horario/SFER.csv'), 'hora_local;medida_m;astronomica_m;diferencia_m\n2026-11-05T10:45;1;0.5;0.500\n2026-11-05T11:45;1.2;0.6;0.600\n2026-11-06T14:45;2;1;1.000\n');
  assert.equal(leer(dir, 'crudos/horario/SFER/202611.jsonl'), '{"pedido":"2"}\n{"pedido":"1"}\n');
  // repetir la fusión no cambia nada
  const r2 = await subir({ origen, almacen: dest, fusionar: true, salida: () => {} });
  assert.equal(r2.fusionados.length, 0);
});

test('fusionarTexto: csv con encabezado y archivos no fusionables', () => {
  assert.equal(fusionarTexto('pronostico/indice.csv', 'cab\nb\n', 'cab\na\nb\n'), 'cab\na\nb\n');
  assert.equal(fusionarTexto('modelo/svg/x.svg', '<a/>', '<b/>'), null);
});
