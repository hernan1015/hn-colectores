// De punta a punta y sin red: R2 falso que verifica las firmas (r2-falso.mjs) + PGlite con 0129 y 0141, como firmador_r2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { r2Firmador } from '../lib/r2.mjs';
import { upsertEnlaces } from '../lib/base.mjs';
import { correr, resumenMd, horasVentana, claveHora, diasEntre, emitidoDe, TORMENTAS, ESCENARIOS } from '../lib/firmador.mjs';
import { r2Falso, depositoTipico } from './r2-falso.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const AHORA = new Date('2026-11-07T23:14:05.500Z');

async function baseNueva() {
  const db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin;');
  await db.exec(fs.readFileSync(new URL('0129_r2_enlaces.sql', FIX), 'utf8'));
  await db.exec(fs.readFileSync(new URL('0141_firmador_r2_rol.sql', FIX), 'utf8'));
  const q = async (s, p) => { await db.exec('set role firmador_r2'); try { return await db.query(s, p); } finally { await db.exec('reset role'); } };
  return { db, upsert: (filas) => upsertEnlaces(q, filas) };
}
function armar({ objetos, porPagina = 1000, secretoCliente, ahoraR2 = AHORA.getTime(), fallar = {} } = {}) {
  const r2 = r2Falso({ objetos: objetos || depositoTipico(AHORA.getTime()), porPagina, ahora: () => ahoraR2, fallar });
  const cli = r2Firmador({ cuenta: r2.cuenta, clave: r2.clave, secreto: secretoCliente || r2.secreto, deposito: r2.deposito, fetchFn: r2.fetchFn });
  return { r2, cli };
}
const dep = (cli, r2, upsert) => ({ listar: (p) => cli.listar(p), presignar: (k, f) => cli.presignar(k, f), fetchFn: r2.fetchFn, upsert });
const filas = async (db) => (await db.query('select clave, url, vence, emitido::text as emitido, bytes from public.r2_enlaces order by clave')).rows;

// Las claves que buscan las functions de hn-agro, escritas acá de nuevo A MANO (no se importan de firmador.mjs):
const CLAVES_FUNCTIONS = {
  tormentas: ['tormentas/proyeccion_tormentas.json'],                                                         // proyeccion-tormentas.js R2_CLAVE
  escenarios: ['indice', 'brasil', 'parana', 'paraguay'].map((a) => 'escenarios/' + a + '.json'),             // escenarios-rio.js ARCHIVOS
  operaIndice: 'opera/cog/pasadas.json',                                                                        // satchi-opera-fecha.js CLAVE_INDICE
  operaMosaico: (f) => 'opera/cog/cuenca-del-plata/' + f + '.tif',                                              // satchi-opera-fecha.js clavMosaico
  rayos: (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return 'rayos-hora/' + d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate()) + '/' + p(d.getUTCHours()) + '.json'; }, // rayos-previos.mjs claveDe
};

test('puras · ventana de rayos, días de OPERA, emitido', () => {
  const v = horasVentana(AHORA.getTime(), 3);
  assert.equal(v.length, 72);
  assert.equal(v[v.length - 1], 'rayos-hora/2026/11/07/22.json');   // la hora 23 todavía no cerró
  assert.equal(v[0], 'rayos-hora/2026/11/04/23.json');
  for (let h = 0; h < 50; h++) { const ms = Date.UTC(2026, 0, 1) + h * 7 * 3600e3; assert.equal(claveHora(ms), CLAVES_FUNCTIONS.rayos(ms)); }
  assert.equal(diasEntre('2026-07-27', '2026-10-25').length, 91);
  assert.deepEqual(diasEntre('2026-10-25', '2026-07-27'), []);
  assert.equal(emitidoDe('escenarios/indice.json', [{ emitido: '2026-10-26' }, { emitido: '2026-11-01' }]), '2026-11-01');
  assert.equal(emitidoDe('escenarios/indice.json', { cuencas: [{ emitido: '2026-10-02' }] }), '2026-10-02');
  assert.equal(emitidoDe('tormentas/proyeccion_tormentas.json', { emitido: 'ayer' }), null);
  assert.deepEqual(TORMENTAS, CLAVES_FUNCTIONS.tormentas);
  assert.deepEqual(ESCENARIOS, CLAVES_FUNCTIONS.escenarios);
});

test('típico · 1 + 4 + 92 + 72 horas, con las claves exactas de las functions; cada URL guardada abre en el R2 falso', async () => {
  const { db, upsert } = await baseNueva();
  const { r2, cli } = armar({ porPagina: 7 });   // páginas chicas: prueba el continuation-token
  const r = await correr(dep(cli, r2, upsert), { ahora: AHORA });
  assert.equal(r.ok, true, resumenMd(r));
  assert.equal(r.codigo, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(r.grupos).map(([k, g]) => [k, g.firmados])), { tormentas: 1, escenarios: 4, opera: 92, rayos: 72 });
  assert.equal(r.grupos.tormentas.ignorados, 1);    // tormentas/viejo/otra.json
  assert.equal(r.grupos.escenarios.ignorados, 1);   // el .zip
  assert.equal(r.grupos.opera.ignorados, 1);        // _subida/lista-subida.txt (crudo/ no está bajo opera/cog/)
  assert.equal(r.grupos.rayos.ignorados, 0);        // candado y alertas no están bajo los prefijos de día
  assert.equal(r.base.nuevas, 169);
  const F = await filas(db);
  const claves = F.map((f) => f.clave);
  const esperadas = [...CLAVES_FUNCTIONS.tormentas, ...CLAVES_FUNCTIONS.escenarios, CLAVES_FUNCTIONS.operaIndice,
    ...diasEntre('2026-07-27', '2026-10-25').map(CLAVES_FUNCTIONS.operaMosaico)];
  const fin = Math.floor(AHORA.getTime() / 3600e3) * 3600e3;
  for (let i = 1; i <= 72; i++) esperadas.push(CLAVES_FUNCTIONS.rayos(fin - i * 3600e3));
  assert.deepEqual(claves, esperadas.sort());
  const por = Object.fromEntries(F.map((f) => [f.clave, f]));
  assert.equal(por['tormentas/proyeccion_tormentas.json'].emitido, '2026-11-06');
  assert.equal(por['escenarios/indice.json'].emitido, '2026-11-06');
  assert.equal(por['opera/cog/pasadas.json'].emitido, '2026-10-25');
  assert.equal(por['opera/cog/cuenca-del-plata/2026-08-01.tif'].emitido, '2026-08-01');
  assert.equal(por['opera/cog/cuenca-del-plata/2026-08-01.tif'].bytes, 40);
  assert.equal(por['rayos-hora/2026/11/07/22.json'].emitido, '2026-11-07');
  for (const f of F) {
    assert.equal(new Date(f.vence).toISOString(), '2026-11-14T23:14:05.000Z');
    const u = new URL(f.url);
    assert.equal(u.searchParams.get('X-Amz-Expires'), '604800');
    const g = await r2.fetchFn(f.url, { method: 'GET' });
    assert.equal(g.status, 200, f.clave);
  }
  // y como lo leen las functions (select url, vence … where clave = $1 / = any($1))
  const una = (await db.query('select url, vence from public.r2_enlaces where clave = $1', ['escenarios/parana.json'])).rows[0];
  assert.ok(una.url && new Date(una.vence) > AHORA);
  const varias = (await db.query('select clave, url, vence from public.r2_enlaces where clave = any($1)', [[CLAVES_FUNCTIONS.rayos(fin - 3600e3), CLAVES_FUNCTIONS.rayos(fin - 2 * 3600e3)]])).rows;
  assert.equal(varias.length, 2);
  // el resumen no lleva URL firmadas ni secretos
  const md = resumenMd(r);
  assert.doesNotMatch(md, /X-Amz-Signature|secreto-falso|r2\.cloudflarestorage/);
  await db.close();
});

test('idempotente · dos corridas iguales dejan la misma tabla y ninguna fila nueva', async () => {
  const { db, upsert } = await baseNueva();
  const { r2, cli } = armar();
  await correr(dep(cli, r2, upsert), { ahora: AHORA });
  const antes = await filas(db);
  const r = await correr(dep(cli, r2, upsert), { ahora: AHORA });
  assert.equal(r.base.nuevas, 0);
  assert.deepEqual(await filas(db), antes);
  await db.close();
});


test('lo que falta se dice, no se inventa (y lo que hay se escribe igual)', async () => {
  const { db, upsert } = await baseNueva();
  const objetos = depositoTipico(AHORA.getTime(), { horasRayos: 0, quitar: ['escenarios/parana.json', 'opera/cog/cuenca-del-plata/2026-09-10.tif'] });
  const { r2, cli } = armar({ objetos });
  const r = await correr(dep(cli, r2, upsert), { ahora: AHORA });
  assert.equal(r.codigo, 1);
  assert.deepEqual(r.grupos.escenarios.faltan, ['escenarios/parana.json']);
  assert.deepEqual(r.grupos.opera.faltan, ['opera/cog/cuenca-del-plata/2026-09-10.tif']);
  assert.ok(r.grupos.opera.avisos.some((a) => /90 \(se esperaban 91\)/.test(a)));
  // 2.ª vuelta (arreglo 5): las horas de rayos que faltan SON faltantes, no un aviso
  assert.equal(r.grupos.rayos.faltan.length, 72);
  assert.equal(r.faltan, 1 + 1 + 72);
  const claves = (await filas(db)).map((f) => f.clave);
  assert.equal(claves.length, 1 + 3 + 1 + 90);
  assert.ok(!claves.includes('escenarios/parana.json'));
  const md = resumenMd(r);
  assert.match(md, /\*\*falta\*\* escenarios\/parana\.json/);
  assert.match(md, /\*\*faltan 72 de 72 horas\*\* de rayos-hora/);
  assert.match(md, /CON PROBLEMAS \(74 faltan, 0 errores\)/);
  await db.close();
});

// ── 2.ª vuelta · arreglo 5: dado vuelta. Antes exigía «sin rayos → OK»; ahora sin rayos NO es OK ──
test('sin rayos y todo lo demás bien → NO es OK: faltan 24 de 24 horas', async () => {
  const { db, upsert } = await baseNueva();
  const { r2, cli } = armar({ objetos: depositoTipico(AHORA.getTime(), { horasRayos: 0 }) });
  const r = await correr(dep(cli, r2, upsert), { ahora: AHORA, diasRayos: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, 1);
  assert.equal(r.grupos.rayos.ventana, 24);
  assert.equal(r.grupos.rayos.faltan.length, 24);
  assert.equal(r.faltan, 24);
  assert.doesNotMatch(resumenMd(r), / · OK$/m);
  await db.close();
});

test('control negativo · rayos: cada hora que falta se cuenta (contado)', async () => {
  const fin = Math.floor(AHORA.getTime() / 3600e3) * 3600e3;
  const sacar = [1, 5, 30, 72].map((i) => CLAVES_FUNCTIONS.rayos(fin - i * 3600e3));
  const { db, upsert } = await baseNueva();
  const { r2, cli } = armar({ objetos: depositoTipico(AHORA.getTime(), { quitar: sacar }) });
  const r = await correr(dep(cli, r2, upsert), { ahora: AHORA });
  assert.deepEqual([...r.grupos.rayos.faltan].sort(), [...sacar].sort());
  assert.equal(r.faltan, sacar.length);
  assert.equal(r.codigo, 1);
  assert.equal(r.grupos.rayos.verificados, 72 - sacar.length);
  await db.close();
});

// ── 2.ª vuelta · arreglo 4: cada objeto se verifica uno por uno; con UN solo objeto fallido ──
const PC = 'https://pc/bueno';
async function unoFalla(clave, modo, { objetos } = {}) {
  const { db, upsert } = await baseNueva();
  await db.query("insert into public.r2_enlaces (clave, url, vence) values ($1, $2, '2026-11-14T05:15:00Z')", [clave, PC]);
  const { r2, cli } = armar({ objetos, fallar: modo ? { [clave]: modo } : {} });
  const r = await correr(dep(cli, r2, upsert), { ahora: AHORA });
  const F = await filas(db);
  await db.close();
  return { r, F, por: Object.fromEntries(F.map((f) => [f.clave, f])) };
}
const NO_JSON = (k) => { const o = depositoTipico(AHORA.getTime()); o[k] = '{ esto no es json'; return o; };
const CASOS_UNO = [
  ['JSON inválido (escenarios/brasil.json)', 'escenarios/brasil.json', null, NO_JSON('escenarios/brasil.json')],
  ['JSON inválido (opera/cog/pasadas.json)', 'opera/cog/pasadas.json', null, NO_JSON('opera/cog/pasadas.json')],
  ['cuerpo cortado (tormentas)', 'tormentas/proyeccion_tormentas.json', 'cuerpo'],
  ['403 en un solo mosaico, no el primero', 'opera/cog/cuenca-del-plata/2026-09-10.tif', 'http403'],
  ['cuerpo cortado en un mosaico', 'opera/cog/cuenca-del-plata/2026-10-25.tif', 'cuerpo'],
  ['500 en una sola hora de rayos, no la primera', CLAVES_FUNCTIONS.rayos(Math.floor(AHORA.getTime() / 3600e3) * 3600e3 - 40 * 3600e3), 'http500'],
  ['red caída en una sola hora de rayos', CLAVES_FUNCTIONS.rayos(Math.floor(AHORA.getTime() / 3600e3) * 3600e3 - 3600e3), 'red'],
];

test('control negativo · un solo objeto que no pasa no reemplaza su enlace bueno; los demás sí se escriben (contado)', async () => {
  let detectados = 0;
  for (const [nombre, clave, modo, objetos] of CASOS_UNO) {
    const { r, F, por } = await unoFalla(clave, modo, { objetos });
    assert.equal(por[clave].url, PC, nombre + ': queda el enlace de la PC');
    assert.equal(F.length, 169, nombre + ': los otros 168 se escriben');
    assert.equal(F.filter((f) => f.url === PC).length, 1, nombre);
    assert.equal(r.codigo, 1, nombre);
    assert.equal(Object.values(r.grupos).reduce((n, g) => n + g.rechazados, 0), 1, nombre + ': un rechazo');
    assert.ok(Object.values(r.grupos).some((g) => g.errores.some((e) => e.startsWith(clave + ':'))), nombre);
    detectados++;
  }
  assert.equal(detectados, CASOS_UNO.length, `casos de un objeto: ${detectados}/${CASOS_UNO.length}`);
});

test('control de la prueba: sin falla, el mismo objeto sí se renueva (si no, el negativo de arriba no prueba nada)', async () => {
  const { r, por } = await unoFalla('opera/cog/cuenca-del-plata/2026-09-10.tif', null);
  assert.notEqual(por['opera/cog/cuenca-del-plata/2026-09-10.tif'].url, PC);
  assert.equal(r.codigo, 0);
});

// ── 2.ª vuelta · arreglo 3: ni URL firmada, ni host, ni llaves, ni contraseña en los caminos de error ──
const FIRMADA = 'https://cuentafalsa.r2.cloudflarestorage.com/satchi-mapas/tormentas/proyeccion_tormentas.json?X-Amz-Credential=CLAVEFALSA%2F20261107&X-Amz-Signature=abcdef0123456789';
const SECRETO_BASE = 'postgresql://firmador_r2.ref:clave-base-secreta@pooler.supabase.com:5432/postgres';
const PROHIBIDO = /X-Amz-|r2\.cloudflarestorage|CLAVEFALSA|secreto-falso|clave-base-secreta|pooler\.supabase|https?:\/\//;
const limpio = (r) => { const md = resumenMd(r); const js = JSON.stringify(r); return !PROHIBIDO.test(md) && !PROHIBIDO.test(js); };

test('control negativo · secretos en los caminos de error: nada crudo llega al resumen (contado)', async () => {
  const caminos = {
    'upsert: error de Postgres con la URL firmada y la conexión': async () => {
      const { r2, cli } = armar();
      return correr(dep(cli, r2, async () => { throw Object.assign(new Error(`duplicate key value (url)=(${FIRMADA}) en ${SECRETO_BASE}`), { code: '23505' }); }), { ahora: AHORA });
    },
    'upsert: error sin código, con la URL': async () => {
      const { r2, cli } = armar();
      return correr(dep(cli, r2, async () => { throw new Error('falló ' + FIRMADA); }), { ahora: AHORA });
    },
    'listar: error con la URL': async () => {
      const { r2, cli } = armar();
      return correr({ ...dep(cli, r2, async () => ({})), listar: async () => { throw new Error('GET ' + FIRMADA + ' 403'); } }, { ahora: AHORA });
    },
    'GET firmado: la red cae con la URL en el mensaje': async () => {
      const { r2, cli } = armar();
      return correr({ ...dep(cli, r2, async () => ({ nuevas: 0, actualizadas: 0, sinCambio: 0 })), fetchFn: async (u) => { throw new Error('fetch failed ' + u); } }, { ahora: AHORA });
    },
    'GET firmado: el cuerpo se corta con la URL en el mensaje': async () => {
      const { r2, cli } = armar({ fallar: { 'tormentas/proyeccion_tormentas.json': 'cuerpo', 'opera/cog/cuenca-del-plata/2026-08-01.tif': 'cuerpo' } });
      return correr(dep(cli, r2, async () => ({ nuevas: 0, actualizadas: 0, sinCambio: 0 })), { ahora: AHORA });
    },
    'presign: tira con el secreto en el mensaje': async () => {
      const { r2, cli } = armar();
      return correr({ ...dep(cli, r2, async () => ({})), presignar: () => { throw new Error('firma con secreto-falso para ' + FIRMADA); } }, { ahora: AHORA });
    },
  };
  let limpios = 0;
  for (const [nombre, fn] of Object.entries(caminos)) {
    const r = await fn();
    assert.equal(r.codigo, 1, nombre);
    assert.ok(r.errores > 0, nombre + ': el error se cuenta');
    assert.ok(limpio(r), nombre + ': ' + resumenMd(r).split('\n').find((l) => PROHIBIDO.test(l)));
    limpios++;
  }
  assert.equal(limpios, Object.keys(caminos).length, `caminos de error limpios: ${limpios}/${Object.keys(caminos).length}`);
  // y el chequeo detecta una filtración (si no, el test de arriba no prueba nada)
  assert.equal(limpio({ grupos: {}, base: { error: 'upsert: falló ' + FIRMADA }, fecha: '', ok: false, faltan: 0, errores: 1 }), false);
});

test('el código del upsert es el SQLSTATE, no el mensaje', async () => {
  const { r2, cli } = armar();
  const r = await correr(dep(cli, r2, async () => { throw Object.assign(new Error('permission denied ' + FIRMADA), { code: '42501' }); }), { ahora: AHORA });
  assert.equal(r.base.error, 'upsert: 42501');
});

// ── control negativo (1.ª vuelta, ajustado) ──
test('control negativo · firma rota, fecha rota, upsert roto, R2 que no lista: nada malo llega a la base', async () => {
  const casos = [];
  const caso = async (nombre, fn) => { casos.push(nombre); await fn(); };

  await caso('secreto equivocado (R2 no deja listar)', async () => {
    const { db, upsert } = await baseNueva();
    const { r2, cli } = armar({ secretoCliente: 'otro-secreto' });
    const r = await correr(dep(cli, r2, upsert), { ahora: AHORA });
    assert.equal(r.codigo, 1);
    assert.ok(r.grupos.tormentas.errores.some((e) => /r2_listar_http_403/.test(e)));
    assert.equal((await filas(db)).length, 0);
    await db.close();
  });

  await caso('firma del GET rota (lista bien, el enlace no abre)', async () => {
    const { db, upsert } = await baseNueva();
    const { r2, cli } = armar();
    const roto = { ...dep(cli, r2, upsert), presignar: (k, f) => { const x = cli.presignar(k, f); return { ...x, url: x.url.replace(/X-Amz-Signature=(.)/, (_, c) => 'X-Amz-Signature=' + (c === '0' ? '1' : '0')) }; } };
    const r = await correr(roto, { ahora: AHORA });
    assert.equal(r.codigo, 1);
    for (const g of Object.values(r.grupos)) assert.ok(g.errores.some((e) => /HTTP 403/.test(e)), g.nombre);
    assert.equal(Object.values(r.grupos).reduce((n, g) => n + g.rechazados, 0), 169, 'cada uno de los 169 rechazado');
    assert.equal((await filas(db)).length, 0, 'con la verificación caída no se escribe nada');
    await db.close();
  });

  await caso('fecha rota (el reloj del R2 va 8 días adelante: el enlace ya venció)', async () => {
    const { db, upsert } = await baseNueva();
    const { r2, cli } = armar({ ahoraR2: AHORA.getTime() + 8 * 864e5 });
    const r = await correr(dep(cli, r2, upsert), { ahora: AHORA });
    assert.equal(r.codigo, 1);
    assert.equal((await filas(db)).length, 0);
    await db.close();
  });

  await caso('fila buena de la PC no se pisa con una verificación caída', async () => {
    const { db, upsert } = await baseNueva();
    await db.query("insert into public.r2_enlaces (clave, url, vence) values ('tormentas/proyeccion_tormentas.json', 'https://pc/bueno', '2026-11-14T05:15:00Z')");
    const { r2, cli } = armar({ ahoraR2: AHORA.getTime() + 8 * 864e5 });
    await correr(dep(cli, r2, upsert), { ahora: AHORA });
    assert.equal((await filas(db))[0].url, 'https://pc/bueno');
    await db.close();
  });

  await caso('upsert roto (la base falla)', async () => {
    const { r2, cli } = armar();
    const r = await correr(dep(cli, r2, async () => { throw Object.assign(new Error('permission denied for table r2_enlaces'), { code: '42501' }); }), { ahora: AHORA });
    assert.equal(r.codigo, 1);
    assert.equal(r.base.error, 'upsert: 42501');
    assert.match(resumenMd(r), /\*\*upsert: 42501\*\*/);
  });

  await caso('upsert que pierde filas (devuelve menos) se ve en el resumen', async () => {
    const { r2, cli } = armar();
    const r = await correr(dep(cli, r2, async (f) => ({ nuevas: 0, actualizadas: 0, sinCambio: f.length })), { ahora: AHORA });
    assert.equal(r.base.sinCambio, 169);
    assert.match(resumenMd(r), /169 sin cambio/);
  });

  assert.equal(casos.length, 6, `casos negativos: ${casos.length}`);
});
