// [r79 · 10] Tests de la subida del Litoral precocido (lib/subir.mjs y subir.mjs). Sin red: almacén FALSO en memoria que anota el orden.
// LITORAL_LIB apunta a la copia mutada de lib/ cuando corre el control negativo (test/control-negativo.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIB = process.env.LITORAL_LIB || new URL('../lib/', import.meta.url).href;
const S = await import(LIB + 'subir.mjs');
const AHORA = Date.parse('2026-11-19T20:00:00Z');
const sinEspera = async () => {};

function almacenFalso({ fallar = () => null } = {}) {
  const datos = new Map(), orden = [];
  return {
    datos, orden,
    async leer(k) { orden.push('leer ' + k); const f = fallar('leer', k); if (f) throw f; return datos.has(k) ? datos.get(k) : null; },
    async escribir(k, c, o) { orden.push('escribir ' + k); const f = fallar('escribir', k); if (f) throw f; datos.set(k, Buffer.from(c)); return true; },
    async borrar(k) { orden.push('borrar ' + k); datos.delete(k); },
    async listar(p) { return [...datos.keys()].filter((k) => k.startsWith(p)).sort(); },
  };
}
const INDICE = { v: 1, z_min: 6, z_max: 11, generado: '2026-11-19T19:00:00Z', firma: 'abc', fechas: [
  { fecha: '2026-11-18', tipo: 'medido', sin_dato: [] }, { fecha: '2026-11-19', tipo: 'pronostico', sin_dato: ['caseros'] }] };
const ARCH = ['2026-11-18/6/21/36.png', '2026-11-18/7/42/73.png', '2026-11-19/6/21/36.png', '2026-11-19/7/42/73.png']
  .map((ruta) => ({ ruta, leer: () => Buffer.from('png:' + ruta) }));
const sub = (o) => S.subir({ indice: INDICE, archivos: ARCH, ahoraMs: AHORA, esperar: sinEspera, concurrencia: 2, ...o });

test('primero TODAS las teselas (bajo su versión) y recién después el índice', async () => {
  const A = almacenFalso();
  const r = await sub({ almacen: A });
  assert.equal(r.version, 'v20261119T2000Z');
  const esc = A.orden.filter((x) => x.startsWith('escribir'));
  assert.equal(esc.length, 5);
  assert.equal(esc[esc.length - 1], 'escribir crecidas-litoral/indice.json', 'el índice al final');
  for (const a of ARCH) assert.ok(A.datos.has('crecidas-litoral/v20261119T2000Z/' + a.ruta), a.ruta);
  const I = JSON.parse(A.datos.get('crecidas-litoral/indice.json'));
  assert.equal(I.version, 'v20261119T2000Z'); assert.equal(I.firma, 'abc'); assert.deepEqual(I.borrar_despues, []);
});

test('una tesela que falla corta ANTES del índice: el publicado sigue apuntando a la versión vieja, completa', async () => {
  const A = almacenFalso({ fallar: (op, k) => (op === 'escribir' && k.endsWith('2026-11-19/7/42/73.png') ? new Error('R2 escribir: HTTP 403') : null) });
  A.datos.set('crecidas-litoral/indice.json', Buffer.from(JSON.stringify({ ...INDICE, version: 'v20261118T2000Z' })));
  await assert.rejects(sub({ almacen: A }), (e) => e.almacen === true);
  assert.equal(JSON.parse(A.datos.get('crecidas-litoral/indice.json')).version, 'v20261118T2000Z');
  assert.ok(!A.orden.includes('escribir crecidas-litoral/indice.json'));
});

test('los 5xx se reintentan (con espera); un 4xx no', async () => {
  let n = 0;
  const A = almacenFalso({ fallar: (op, k) => (op === 'escribir' && k.endsWith('2026-11-18/6/21/36.png') && n++ < 2 ? new Error('R2 escribir: HTTP 500') : null) });
  await sub({ almacen: A });
  assert.equal(n, 3, 'dos 500 y el tercero sale');
  let m = 0;
  const B = almacenFalso({ fallar: (op, k) => (op === 'escribir' && k.endsWith('2026-11-18/6/21/36.png') ? (m++, new Error('R2 escribir: HTTP 403')) : null) });
  await assert.rejects(sub({ almacen: B }));
  assert.equal(m, 1, 'un 403 no se reintenta');
});

test('borrado DIFERIDO: la versión vieja queda anotada; recién una corrida posterior, pasadas 6 h, la borra (después del índice)', async () => {
  const A = almacenFalso();
  A.datos.set('crecidas-litoral/v20261118T2000Z/2026-11-17/6/21/36.png', Buffer.from('x'));
  A.datos.set('crecidas-litoral/indice.json', Buffer.from(JSON.stringify({ ...INDICE, version: 'v20261118T2000Z', borrar_despues: [] })));
  const r1 = await sub({ almacen: A });
  assert.ok(A.datos.has('crecidas-litoral/v20261118T2000Z/2026-11-17/6/21/36.png'), 'no se borra en la misma corrida');
  assert.deepEqual(JSON.parse(A.datos.get('crecidas-litoral/indice.json')).borrar_despues, [{ version: 'v20261118T2000Z', desde: AHORA }]);
  assert.equal(r1.borradas, 0);
  /* 2 h después: todavía no */
  await sub({ almacen: A, ahoraMs: AHORA + 2 * 3600e3 });
  assert.ok(A.datos.has('crecidas-litoral/v20261118T2000Z/2026-11-17/6/21/36.png'), 'a las 2 h sigue');
  /* 7 h después: se borra, y después de escribir el índice */
  A.orden.length = 0;
  const r3 = await sub({ almacen: A, ahoraMs: AHORA + 7 * 3600e3 });
  assert.ok(!A.datos.has('crecidas-litoral/v20261118T2000Z/2026-11-17/6/21/36.png'), 'a las 7 h se borra');
  assert.ok(r3.borradas >= 1);
  const iI = A.orden.indexOf('escribir crecidas-litoral/indice.json'), iB = A.orden.findIndex((x) => x.startsWith('borrar'));
  assert.ok(iI >= 0 && iB > iI, 'el borrado va después del índice');
  /* nunca la versión publicada */
  const pub = JSON.parse(A.datos.get('crecidas-litoral/indice.json')).version;
  assert.ok([...A.datos.keys()].some((k) => k.startsWith('crecidas-litoral/' + pub + '/')), 'la versión publicada sigue entera');
});

test('índice local inválido o sin teselas: no escribe nada', async () => {
  const A = almacenFalso();
  await assert.rejects(S.subir({ almacen: A, indice: { v: 2, fechas: [] }, archivos: ARCH, ahoraMs: AHORA }));
  await assert.rejects(S.subir({ almacen: A, indice: INDICE, archivos: [], ahoraMs: AHORA }));
  await assert.rejects(S.subir({ almacen: A, indice: { ...INDICE, fechas: [{ fecha: '2026-11-18', tipo: 'inventado' }] }, archivos: ARCH, ahoraMs: AHORA }), 'una fecha que no es medida ni pronóstico');
  await assert.rejects(S.subir({ almacen: A, indice: INDICE, archivos: [{ ruta: '../x.png', leer: () => Buffer.from('x') }], ahoraMs: AHORA }));
  assert.equal(A.orden.filter((x) => x.startsWith('escribir')).length, 0);
});

test('la categoría de una falla nunca lleva el mensaje', () => {
  const e = Object.assign(new Error('https://x.r2.cloudflarestorage.com/?X-Amz-Signature=SECRETO HTTP 500'), { almacen: true, http: 500 });
  assert.equal(S.categoriaError(e), 'error:almacen http 500');
  assert.equal(S.categoriaError(new Error('algo SECRETO')), 'error:interno');
});

test('subir.mjs: llave apagada no hace nada; seco escribe en la carpeta; el log no lleva rutas ni secretos', async () => {
  const P = await import(new URL('../subir.mjs', import.meta.url).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'litoral-')), sal = path.join(tmp, 'salida'), dep = path.join(tmp, 'deposito');
  for (const a of ARCH) { const p = path.join(sal, ...a.ruta.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, a.leer()); }
  fs.writeFileSync(path.join(sal, 'indice.json'), JSON.stringify(INDICE));
  const msgs = [];
  assert.equal(await P.principal({ env: { CRECIDAS_LITORAL_ON: 'no', LITORAL_SALIDA: sal, LITORAL_CARPETA: dep }, log: (m) => msgs.push(m), logError: (m) => msgs.push(m) }), 0);
  assert.ok(!fs.existsSync(dep), 'apagada: nada');
  assert.equal(await P.principal({ env: { CRECIDAS_LITORAL_ON: 'si', MODO: 'seco', LITORAL_SALIDA: sal, LITORAL_CARPETA: dep, R2_OPERA_SECRET_ACCESS_KEY: 'SECRETO' }, log: (m) => msgs.push(m), logError: (m) => msgs.push(m), ahoraMs: AHORA }), 0);
  assert.ok(fs.existsSync(path.join(dep, 'crecidas-litoral', 'indice.json')));
  assert.ok(fs.existsSync(path.join(dep, 'crecidas-litoral', 'v20261119T2000Z', '2026-11-19', '7', '42', '73.png')));
  assert.ok(!msgs.join('\n').includes('SECRETO') && !msgs.join('\n').includes(tmp), 'el log no lleva secretos ni rutas');
  fs.rmSync(tmp, { recursive: true, force: true });
});
