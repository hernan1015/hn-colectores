// Tests de la caché horaria de rayos. Almacenamiento en carpeta temporal y archivos GLM sintéticos (ver sintetico.mjs).
// Correr: npm test (dentro de rayos-hora/). El control negativo está en control-negativo.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GLM, CACHE, ALM, archivoGLM, noaaFalso, todos, carpetaTemporal, nombre } from './sintetico.mjs';

const H = 3600000;
const AHORA = Date.UTC(2026, 10, 6, 22, 40);           // 6/11/2026 22:40 UTC
const ULT = Date.UTC(2026, 10, 6, 21);                 // última hora cerrada: 21 UTC
const leerHora = async (alm, h) => JSON.parse((await alm.leer(CACHE.claveHora(h))).toString('utf8'));

// flashes de prueba: 2 adentro, 3 afuera de la caja (Brasil, Pacífico, sur de Malvinas) y 1 en el borde
const MEZCLA = [
  { dt_s: 3.25, lat: -34.6, lon: -58.4, energia_J: 2.5e-14, area_m2: 1.2e8, calidad: 0 },      // Buenos Aires
  { dt_s: 15.5, lat: -41.4, lon: -71.95, energia_J: 8.9e-14, area_m2: 6.6e7, calidad: null },  // offset crudo > 32767 (sin signo) y calidad de relleno
  { dt_s: 1, lat: -10.0, lon: -50.0, energia_J: 1e-14, area_m2: 1e8, calidad: 0 },             // Brasil: afuera
  { dt_s: 1, lat: -33.0, lon: -80.0, energia_J: 1e-14, area_m2: 1e8, calidad: 0 },             // Pacífico: afuera
  { dt_s: 1, lat: -58.0, lon: -60.0, energia_J: 1e-14, area_m2: 1e8, calidad: 0 },             // muy al sur: afuera
  { dt_s: 2, lat: -20.0, lon: -52.0, energia_J: 1e-14, area_m2: 1e8, calidad: 3 },             // esquina de la caja: adentro
];

test('decodifica un archivo con la estructura real (_Unsigned, scale/offset, relleno) y recorta a la caja', async () => {
  const t0 = Date.UTC(2026, 10, 6, 21, 0, 20);
  const buf = await archivoGLM(t0, MEZCLA);
  const r = await GLM.leerArchivo(buf, `x/${nombre(t0)}`);
  assert.equal(r.n_disco, 6);
  assert.equal(r.flashes.length, 3, 'sólo 3 de 6 caen en la caja');
  const ba = r.flashes.find((f) => f.lat < -34);
  assert.ok(Math.abs(ba.t - (t0 + 3250)) <= 1, 'hora del flash');
  assert.ok(Math.abs(ba.energia_J - 2.5e-14) < 1e-15);
  assert.ok(Math.abs(ba.area_m2 - 1.2e8) < 2e5);
  const pat = r.flashes.find((f) => f.lat < -41);
  assert.ok(Math.abs(pat.t - (t0 + 15500)) <= 1, 'offset > 32767 en crudo: sin corregir _Unsigned saldría ~25 s antes');
  assert.equal(pat.calidad, -1, 'relleno = −1, nunca 0 («bueno»)');
});

test('recorte a la caja dentro de una hora entera', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm } = noaaFalso({ porHora: () => ({ slots: todos(), flashes: (s) => (s === 7 ? MEZCLA : []) }) });
  const r = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, desdeMs: ULT, hastaMs: ULT, glm });
  assert.equal(r.procesadas, 1);
  const d = await leerHora(alm, ULT);
  assert.equal(d.estado, 'completa');
  assert.equal(d.n, 3);
  for (const f of d.flashes) {
    assert.ok(f[1] >= -56.5 && f[1] <= -20 && f[2] >= -76.5 && f[2] <= -52);
    assert.ok(f[0] >= 7 * 20000 && f[0] < 8 * 20000, 't_ms relativo al inicio de la hora');
  }
  assert.deepEqual(d.columnas, ['t_ms', 'lat', 'lon', 'energia_fJ', 'area_km2', 'calidad']);
  assert.equal(d.satelite, 'GOES-19');
});

test('hora incompleta ≠ hora sin rayos', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const h1 = ULT, h2 = ULT - H, h3 = ULT - 2 * H;
  const { glm } = noaaFalso({
    porHora: (h) => h === h1 ? { slots: todos() }                                   // completa y sin rayos
      : h === h2 ? { slots: todos().filter((s) => s < 170) }                        // NOAA publicó 170 de 180
      : { slots: todos(), falla: (s) => s === 42 },                                 // un archivo no se pudo bajar
  });
  await CACHE.correr({ almacen: alm, ahoraMs: AHORA, desdeMs: h3, hastaMs: h1, glm });
  const vacia = await leerHora(alm, h1), corta = await leerHora(alm, h2), fallo = await leerHora(alm, h3);
  assert.equal(vacia.estado, 'completa'); assert.equal(vacia.n, 0); assert.deepEqual(vacia.faltantes, []);
  assert.equal(corta.estado, 'incompleta'); assert.equal(corta.n, 0);
  assert.equal(corta.archivos.leidos, 170); assert.equal(corta.faltantes.length, 10);
  assert.equal(corta.faltantes[0], '56:40');
  assert.match(corta.nota, /INCOMPLETA/);
  assert.equal(fallo.estado, 'incompleta'); assert.equal(fallo.archivos.fallidos, 1);
  assert.deepEqual(fallo.faltantes, ['14:00']);
  const al = (await alm.leer(CACHE.ALERTAS)).toString('utf8');
  assert.equal((al.match(/incompleta/g) || []).length, 2);
});

test('una hora sin NINGÚN archivo queda incompleta (180 faltantes), no «sin rayos»', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm } = noaaFalso({ porHora: () => ({ slots: [] }) });
  await CACHE.correr({ almacen: alm, ahoraMs: AHORA, desdeMs: ULT, hastaMs: ULT, glm });
  const d = await leerHora(alm, ULT);
  assert.equal(d.estado, 'incompleta');
  assert.equal(d.faltantes.length, 180);
});

test('idempotencia: la segunda corrida no baja nada ni reescribe', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm, cuenta } = noaaFalso({ porHora: () => ({ slots: todos(), flashes: (s) => (s % 60 === 0 ? MEZCLA.slice(0, 2) : []) }) });
  const a = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, desdeMs: ULT - 2 * H, hastaMs: ULT, glm });
  assert.equal(a.procesadas, 3);
  const antes = (await alm.leer(CACHE.claveHora(ULT))).toString('utf8');
  const bajadas = cuenta.bajadas;
  const b = await CACHE.correr({ almacen: alm, ahoraMs: AHORA + 60000, desdeMs: ULT - 2 * H, hastaMs: ULT, glm });
  assert.equal(b.pendientes, 0); assert.equal(b.procesadas, 0);
  assert.equal(cuenta.bajadas, bajadas, 'no volvió a bajar');
  assert.equal((await alm.leer(CACHE.claveHora(ULT))).toString('utf8'), antes);
  // rehacer la misma hora da los mismos flashes
  const { doc } = await CACHE.procesarHora(ULT, { glm, ahoraMs: AHORA });
  assert.deepEqual(doc.flashes, JSON.parse(antes).flashes);
  assert.equal(JSON.parse(antes).n, 6);
});

test('ponerse al día: exactamente las 48 horas cerradas, ni la abierta ni la de hace 49 h', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const vistas = [];
  const { glm } = noaaFalso({ porHora: (h) => (vistas.push(h), { slots: todos() }) });
  const r = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm, maxHoras: 100 });
  assert.equal(r.procesadas, 48);
  assert.equal(Math.max(...vistas), ULT, 'la hora 22 UTC (abierta) no se toca');
  assert.equal(Math.min(...vistas), ULT - 47 * H);
  const claves = (await alm.listar(CACHE.PREFIJO)).filter((k) => /\d\d\.json$/.test(k));
  assert.equal(claves.length, 48);
  // se borran 3 horas: la corrida siguiente hace sólo esas 3
  for (const h of [ULT, ULT - 10 * H, ULT - 47 * H]) await alm.borrar(CACHE.claveHora(h));
  vistas.length = 0;
  const r2 = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm, maxHoras: 100 });
  assert.equal(r2.procesadas, 3);
  assert.deepEqual(vistas.sort((a, b) => a - b), [ULT - 47 * H, ULT - 10 * H, ULT]);
  // 15 min después de cerrar la hora 22 entra ésa y sale nada más de 48 h
  const r3 = await CACHE.correr({ almacen: alm, ahoraMs: Date.UTC(2026, 10, 6, 23, 16), glm, maxHoras: 100 });
  assert.equal(r3.procesadas, 1);
  assert.ok(await alm.leer(CACHE.claveHora(ULT + H)));
});

test('ponerse al día respeta el tope por corrida y empieza por lo más nuevo', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm } = noaaFalso({ porHora: () => ({ slots: todos() }) });
  const r = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm, maxHoras: 5 });
  assert.equal(r.pendientes, 48); assert.equal(r.procesadas, 5);
  assert.ok(await alm.leer(CACHE.claveHora(ULT)));
  assert.equal(await alm.leer(CACHE.claveHora(ULT - 5 * H)), null);
});

test('candado: si otra corrida lo tiene vigente no se hace nada; vencido se toma; siempre se suelta', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm, cuenta } = noaaFalso({ porHora: () => ({ slots: todos() }) });
  await alm.escribir(CACHE.CANDADO, JSON.stringify({ dueno: 'otra', vence: new Date(AHORA + 10 * 60000).toISOString() }));
  const a = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm, dueno: 'yo' });
  assert.equal(a.candado, false); assert.equal(a.procesadas, 0); assert.equal(cuenta.listados, 0);
  assert.equal(JSON.parse((await alm.leer(CACHE.CANDADO)).toString()).dueno, 'otra', 'no pisa el candado ajeno');
  // vencido (corrida muerta): se toma, se trabaja y se suelta
  const b = await CACHE.correr({ almacen: alm, ahoraMs: AHORA + 61 * 60000, glm, dueno: 'yo', maxHoras: 2 });
  assert.equal(b.candado, true); assert.equal(b.procesadas, 2);
  assert.equal(await alm.leer(CACHE.CANDADO), null);
  // si la corrida revienta (R2 no deja escribir la hora), el candado se suelta igual
  const almRoto = { ...alm, async escribir(k, c, o) { if (/\d\d\.json$/.test(k)) throw new Error('R2 HTTP 500'); return alm.escribir(k, c, o); } };
  const { glm: g2 } = noaaFalso({ porHora: () => ({ slots: todos() }) });
  await assert.rejects(CACHE.correr({ almacen: almRoto, ahoraMs: AHORA + 2 * H, glm: g2, dueno: 'yo' }), /R2 HTTP 500/);
  assert.equal(await alm.leer(CACHE.CANDADO), null);
});

test('candado: dos corridas a la vez, sólo una trabaja', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm } = noaaFalso({ porHora: () => ({ slots: todos() }) });
  const [a, b] = await Promise.all([
    CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm, dueno: 'A', maxHoras: 2 }),
    CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm, dueno: 'B', maxHoras: 2 }),
  ]);
  assert.equal([a.candado, b.candado].filter(Boolean).length, 1);
});

test('error de NOAA: se anota en alertas y se corta, sin reintentar en bucle; la próxima corrida vuelve a probar', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  let caido = true;
  const { glm, cuenta } = noaaFalso({ porHora: () => (caido ? { errorListado: 'listado NOAA HTTP 503' } : { slots: todos() }) });
  const r = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm });
  assert.equal(cuenta.listados, 1, 'un solo intento de listado');
  assert.equal(r.procesadas, 0); assert.equal(r.cortada, 'error de NOAA');
  assert.match((await alm.leer(CACHE.ALERTAS)).toString(), /NOAA: listado GOES-19 2026-11-06T21:00Z: listado NOAA HTTP 503/);
  assert.equal(await alm.leer(CACHE.claveHora(ULT)), null, 'no se escribe una hora vacía por un error');
  caido = false;
  const r2 = await CACHE.correr({ almacen: alm, ahoraMs: AHORA + H, glm, maxHoras: 3 });
  assert.equal(r2.procesadas, 3);
});

test('NOAA que no entrega archivos: corta después de la primera hora', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm, cuenta } = noaaFalso({ porHora: () => ({ slots: todos(), falla: () => true }) });
  const r = await CACHE.correr({ almacen: alm, ahoraMs: AHORA, glm, maxHoras: 48 });
  assert.equal(r.procesadas, 1); assert.equal(cuenta.listados, 1);
  assert.equal(cuenta.bajadas, 180, 'cada archivo una vez (el reintento único está adentro de bajarEntero)');
});

test('bajarEntero: un reintento como mucho y rechaza archivos cortados (nunca por rangos)', async () => {
  let n = 0;
  await assert.rejects(GLM.bajarEntero('u', 'k', 10, { esperaMs: 0, fetchFn: async () => (n++, new Response('', { status: 503 })) }), /HTTP 503/);
  assert.equal(n, 2);
  const pedidos = [];
  const corto = async (url, o) => (pedidos.push(o.headers || {}), new Response(new Uint8Array(5)));
  await assert.rejects(GLM.bajarEntero('u', 'k', 10, { esperaMs: 0, fetchFn: corto }), /cortado/);
  assert.ok(pedidos.every((h) => !('range' in h) && !('Range' in h)));
  const bien = await GLM.bajarEntero('u', 'k', 10, { esperaMs: 0, fetchFn: async () => new Response(new Uint8Array(10)) });
  assert.equal(bien.length, 10);
});

test('una hora incompleta se reintenta en corridas siguientes, hasta 3 intentos', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm } = noaaFalso({ porHora: () => ({ slots: todos().slice(0, 179) }) });
  for (let i = 0; i < 5; i++) await CACHE.correr({ almacen: alm, ahoraMs: AHORA + i * 60000, desdeMs: ULT, hastaMs: ULT, glm });
  const d = await leerHora(alm, ULT);
  assert.equal(d.intentos, 3);
  assert.equal(CACHE.debeReintentar(d, AHORA), false);
  // ya no reciente y sin fallas de bajada: no se reintenta aunque queden intentos
  assert.equal(CACHE.debeReintentar({ ...d, intentos: 1 }, ULT + 8 * H), false);
  assert.equal(CACHE.debeReintentar({ ...d, intentos: 1, archivos: { ...d.archivos, fallidos: 2 } }, ULT + 8 * H), true);
});

test('satélite: GOES-16 antes del 7/4/2025, GOES-19 desde entonces', () => {
  assert.equal(GLM.satelitePara(Date.UTC(2025, 3, 6, 23)), 'goes16');
  assert.equal(GLM.satelitePara(Date.UTC(2025, 3, 7, 0)), 'goes19');
  assert.equal(GLM.prefijoHora(Date.UTC(2024, 11, 16, 18)), 'GLM-L2-LCFA/2024/351/18/');
  assert.equal(CACHE.claveHora(Date.UTC(2024, 11, 16, 8)), 'rayos-hora/2024/12/16/08.json');
});

test('relleno: fechas y tope en la última hora cerrada', async () => {
  assert.equal(CACHE.parsearHora('2025-12-26'), Date.UTC(2025, 11, 26, 0));
  assert.equal(CACHE.parsearHora('2025-12-26', true), Date.UTC(2025, 11, 26, 23));
  assert.equal(CACHE.parsearHora('2025-12-26T18'), Date.UTC(2025, 11, 26, 18));
  assert.throws(() => CACHE.parsearHora('26/12/2025'));
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const p = await CACHE.pendientes(alm, { ahoraMs: AHORA, desdeMs: ULT - H, hastaMs: ULT + 5 * H });
  assert.deepEqual(p.map((x) => x.hora), [ULT, ULT - H]);
});

test('firma SigV4: ejemplo publicado por AWS (GET Object con Range)', () => {
  const h = ALM.firmar({
    metodo: 'GET', host: 'examplebucket.s3.amazonaws.com', ruta: '/test.txt', headers: { range: 'bytes=0-9' },
    clave: 'AKIAIOSFODNN7EXAMPLE', secreto: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1',
    fecha: new Date(Date.UTC(2013, 4, 24)),
  });
  assert.equal(h._firma, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('almacén R2: arma los pedidos sin mostrar secretos y trata 404 y 412', async () => {
  const pedidos = [];
  const fetchFn = async (url, o) => {
    pedidos.push({ url, metodo: o.method, h: o.headers });
    if (o.method === 'GET' && url.includes('list-type')) return new Response('<ListBucketResult><Contents><Key>rayos-hora/2026/11/06/21.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>');
    if (o.method === 'GET') return new Response('no', { status: 404 });
    if (o.method === 'PUT' && o.headers['if-none-match']) return new Response('', { status: 412 });
    return new Response('');
  };
  const r2 = ALM.almacenR2({ cuenta: 'c', clave: 'k', secreto: 's', deposito: 'd', fetchFn });
  assert.equal(await r2.leer('rayos-hora/candado.json'), null);
  assert.equal(await r2.escribir('rayos-hora/candado.json', '{}', { soloSiNoExiste: true }), false);
  assert.equal(await r2.escribir('rayos-hora/x.json', '{}'), true);
  assert.deepEqual(await r2.listar('rayos-hora/2026/11/06/'), ['rayos-hora/2026/11/06/21.json']);
  assert.ok(pedidos.every((p) => p.url.startsWith('https://c.r2.cloudflarestorage.com/d')));
  assert.ok(pedidos.every((p) => !JSON.stringify(p).includes('"s"')));
  assert.throws(() => ALM.almacenR2({}), /faltan R2_/);
});

test('el JSON de una hora no trae rutas locales', async () => {
  const alm = ALM.almacenCarpeta(carpetaTemporal());
  const { glm } = noaaFalso({ porHora: () => ({ slots: todos() }) });
  await CACHE.correr({ almacen: alm, ahoraMs: AHORA, desdeMs: ULT, hastaMs: ULT, glm });
  const txt = (await alm.leer(CACHE.claveHora(ULT))).toString();
  assert.ok(!/[A-Z]:[\\/]|\/home\/|\/tmp\//.test(txt));
  void fs;
});
