// Tests del colector de GREMLIN (311). Sin red: SLIDER de mentira y almacén en carpeta temporal (ver falsos.mjs).
// Correr: npm test (dentro de gremlin/). El control negativo está en control-negativo.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, C, ALM, carpetaTemporal, sliderFalso, tiemposHasta, pngFalso, idatCorrupto, crcMal, trozos, armar, ihdr, idat, plte, iend, leerDato, sinEspera, callado } from './falsos.mjs';

const AHORA = Date.UTC(2026, 10, 17, 0, 55);                 // 17/11/2026 00:55 UTC
const ULT = Date.UTC(2026, 10, 17, 0, 30);                   // último tiempo de SLIDER: 00:30 UTC
const T = '20261117003000';
const ARGENTINA = ['005_003', '005_004', '005_005', '006_003', '006_004', '006_005', '007_003', '007_004', '007_005'];

const nuevo = () => ALM.almacenCarpeta(carpetaTemporal());
const leerJ = async (alm, k) => JSON.parse((await alm.leer(k)).toString('utf8'));
const correr = (o) => C.correr({ llave: 'si', ahoraMs: AHORA, esperar: sinEspera, log: callado, ...o });

// ---------- nombres, URLs y claves ----------
test('URLs de SLIDER: las mismas que se probaron a mano el 16/11', () => {
  assert.equal(S.urlTiempos(), 'https://slider.cira.colostate.edu/data/json/goes-19/full_disk/gremlin/latest_times.json');
  assert.equal(S.urlTesela(T, 6, 4), 'https://slider.cira.colostate.edu/data/imagery/2026/11/17/goes-19---full_disk/gremlin/20261117003000/03/006_004.png');
  assert.equal(S.ZOOM, 3, 'zoom nativo de GREMLIN: max_zoom_level 5 − zoom_level_adjust 2 = 3 (2 km)');
  assert.equal(S.UA, 'hn-colector/1.0');
});

test('claves: una carpeta por tiempo (día UTC del propio tiempo), la tesela con zoom y fila_col, el sobre y el índice del día', () => {
  assert.equal(C.claveTesela(T, { fila: 6, col: 4 }), 'gremlin/2026/11/17/20261117003000/03/006_004.png');
  assert.equal(C.claveSobre(T), 'gremlin/2026/11/17/20261117003000/sobre.json');
  assert.equal(C.claveIndiceDia(T), 'gremlin/2026/11/17/indice.json');
  // control negativo: las 23:50 UTC del 16 van al 16 (no al día argentino ni al de la corrida), y fila ≠ columna
  assert.equal(C.claveIndiceDia('20261116235000'), 'gremlin/2026/11/16/indice.json');
  assert.notEqual(C.claveTesela(T, { fila: 4, col: 6 }), C.claveTesela(T, { fila: 6, col: 4 }));
  assert.notEqual(C.claveTesela('20261117002000', { fila: 6, col: 4 }), C.claveTesela(T, { fila: 6, col: 4 }));
  assert.throws(() => C.claveTesela('2026111700300', { fila: 6, col: 4 }), /tiempo inválido/);
  assert.throws(() => C.claveSobre('20261317003000'), /tiempo inválido/, 'mes 13');
});

test('latest_times.json real (17/11 00:30): 100 tiempos válidos, del más viejo al más nuevo; basura afuera', () => {
  const t = S.parsearTiempos(JSON.parse(leerDato('latest_times_20261117T0030Z.json').toString('utf8')));
  assert.equal(t.length, 100);
  assert.equal(t[0], '20261116060000');
  assert.equal(t.at(-1), T);
  assert.deepEqual(t, [...t].sort());
  // control negativo: repetidos, cortos, fechas imposibles y texto no pasan
  assert.deepEqual(S.parsearTiempos({ timestamps_int: [T, Number(T), 2026111700, 20261117256000, 'hola', null] }), [T]);
  assert.throws(() => S.parsearTiempos({ times: [] }), /timestamps_int/);
});

// ---------- el recorte ----------
test('recorte: la caja Argentina toca exactamente 9 teselas al zoom 3 (filas 5-7, columnas 3-5)', () => {
  assert.deepEqual(S.teselasCaja().map(C.nombreTesela), ARGENTINA);
  const en = (lat, lon) => { const t = S.teselaDe(lat, lon); return t && C.nombreTesela(t); };
  assert.equal(en(-31.4, -64.2), '006_004', 'Córdoba');
  assert.equal(en(-54.8, -68.3), '007_004', 'Ushuaia');
  assert.equal(en(-22.1, -65.6), '005_004', 'La Quiaca');
  assert.equal(en(-25.6, -54.6), '005_005', 'Iguazú');
  assert.equal(en(-27.08, -61.08), '006_004', 'Las Breñas');
  // control negativo: lo de afuera de la caja cae en otras teselas, y del otro lado de la Tierra no hay tesela
  assert.ok(!ARGENTINA.includes(en(-12.0, -77.0)), 'Lima');
  assert.ok(!ARGENTINA.includes(en(25.8, -80.2)), 'Miami');
  assert.equal(S.teselaDe(40.4, -3.7 + 180), null, 'antípoda: fuera del disco');
  // [311b · Codex] el horizonte de verdad: a ~81,3° del subsatélite (lon0 −75) sobre el ecuador
  assert.equal(S.pixel(0, 6.4), null, '81,4° al este de lon0: detrás del horizonte');
  assert.equal(S.pixel(0, -156.4), null, '81,4° al oeste');
  assert.ok(S.pixel(0, -75 + 81.2), '81,2°: todavía se ve');
  assert.ok(S.pixel(-54.8, -68.3), 'Ushuaia se ve');
  assert.ok(S.teselasCaja({ lat_min: -35, lat_max: -34, lon_min: -59, lon_max: -58 }).length < 9, 'una caja chica toca menos');
});

test('recorte en la corrida: se piden sólo las 9 teselas de la caja, al zoom 3', async () => {
  const sl = sliderFalso({ tiempos: [T] });
  await correr({ almacen: nuevo(), fetchFn: sl.fetchFn });
  const pedidas = sl.teselasPedidas().map((p) => p.url.match(/\/(\d{2})\/(\d{3}_\d{3})\.png$/));
  assert.deepEqual(pedidas.map((m) => m[2]).sort(), ARGENTINA);
  assert.ok(pedidas.every((m) => m[1] === '03'));
});

// ---------- el sobre y el índice ----------
test('sobre: producto, tiempo, caja, zoom, teselas (con bytes y sha256), faltantes y fuente con cita; índice del día', async () => {
  const alm = nuevo();
  const sl = sliderFalso({ tiempos: [T] });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn });
  assert.equal(r.completos, 1);
  const s = await leerJ(alm, C.claveSobre(T));
  assert.equal(s.producto, 'gremlin');
  assert.equal(s.titulo, 'GREMLIN (CIRA)');
  assert.equal(s.satelite, 'goes-19');
  assert.equal(s.sector, 'full_disk');
  assert.equal(s.tiempo, '2026-11-17T00:30:00Z');
  assert.equal(s.tiempo_slider, T);
  assert.deepEqual(s.caja, { lat_min: -56.5, lat_max: -20, lon_min: -76.5, lon_max: -52 });
  assert.equal(s.zoom, 3);
  assert.equal(s.resolucion, '2 km');
  assert.equal(s.estado, 'completo');
  assert.deepEqual(s.faltantes, []);
  assert.deepEqual(s.teselas.map(C.nombreTesela), ARGENTINA);
  for (const x of s.teselas) {
    const b = await alm.leer(x.clave);
    assert.ok(b, `existe ${x.clave}`);
    assert.equal(x.bytes, b.length);
    assert.match(x.sha256, /^[0-9a-f]{64}$/);
  }
  assert.match(s.fuente.cita, /GOES-19 · NOAA · imágenes CIRA\/RAMMB SLIDER/);
  assert.match(s.fuente.cita, /GREMLIN \(CIRA\)/);
  assert.match(s.fuente.aclaracion, /no es radar/);
  assert.match(s.fuente.url_teselas, /goes-19---full_disk\/gremlin\/AAAAMMDDhhmmss\/03\/FFF_CCC\.png$/);
  const ind = await leerJ(alm, C.claveIndiceDia(T));
  assert.equal(ind.producto, 'gremlin');
  assert.deepEqual(ind.teselas_esperadas, ARGENTINA);
  assert.deepEqual(ind.tiempos[T], { estado: 'completo', n: 9, faltantes: [], intentos: 1, sobre: C.claveSobre(T) });
});

// ---------- idempotencia ----------
test('idempotencia: la segunda corrida con los mismos tiempos sólo pide latest_times y no escribe nada', async () => {
  const alm = nuevo();
  const tiempos = tiemposHasta(ULT, 3);
  const sl1 = sliderFalso({ tiempos });
  const r1 = await correr({ almacen: alm, fetchFn: sl1.fetchFn });
  assert.equal(r1.guardados, 3);
  assert.equal(sl1.teselasPedidas().length, 27);
  const antes = await alm.listar('gremlin/');
  const sl2 = sliderFalso({ tiempos });
  const r2 = await correr({ almacen: alm, fetchFn: sl2.fetchFn, ahoraMs: AHORA + 600000 });
  assert.equal(r2.pedidos, 1);
  assert.equal(r2.guardados, 0);
  assert.equal(sl2.teselasPedidas().length, 0);
  assert.deepEqual(await alm.listar('gremlin/'), antes);
  // y con un tiempo nuevo, se baja sólo ése
  const sl3 = sliderFalso({ tiempos: [...tiempos, '20261117004000'] });
  const r3 = await correr({ almacen: alm, fetchFn: sl3.fetchFn, ahoraMs: AHORA + 1200000 });
  assert.equal(r3.guardados, 1);
  assert.ok(sl3.teselasPedidas().every((p) => p.url.includes('/20261117004000/')));
});

// ---------- faltantes ----------
test('una tesela que falla queda como faltante, no se guarda nada en su clave y se reintenta (sólo ella) en la corrida siguiente', async () => {
  const alm = nuevo();
  const sl1 = sliderFalso({ tiempos: [T], tesela: (t, f, c) => (f === 6 && c === 4 ? { status: 404 } : null) });
  const r1 = await correr({ almacen: alm, fetchFn: sl1.fetchFn });
  assert.equal(r1.incompletos, 1);
  let s = await leerJ(alm, C.claveSobre(T));
  assert.equal(s.estado, 'incompleto');
  assert.deepEqual(s.faltantes, [{ fila: 6, col: 4, motivo: 'HTTP 404' }]);
  assert.equal(s.teselas.length, 8);
  assert.equal(await alm.leer(C.claveTesela(T, { fila: 6, col: 4 })), null, 'sin basura en la clave');
  assert.deepEqual((await leerJ(alm, C.claveIndiceDia(T))).tiempos[T].faltantes, ['006_004']);

  const sl2 = sliderFalso({ tiempos: [T] });
  let lecturasPng = 0;
  const espia = { ...alm, leer: async (k) => { if (k.endsWith('.png')) lecturasPng++; return alm.leer(k); } };
  const r2 = await correr({ almacen: espia, fetchFn: sl2.fetchFn, ahoraMs: AHORA + 600000 });
  assert.equal(r2.completos, 1);
  assert.equal(lecturasPng, 0, 'las 8 del sobre se toman del sobre: no se releen de R2');
  assert.equal(r2.recuperadas, 0);
  assert.deepEqual(sl2.teselasPedidas().map((p) => p.url.slice(-11)), ['006_004.png'], 'no vuelve a bajar las 8 que ya estaban');
  s = await leerJ(alm, C.claveSobre(T));
  assert.equal(s.estado, 'completo');
  assert.equal(s.intentos, 2);
  assert.deepEqual(s.teselas.map(C.nombreTesela), ARGENTINA);
  assert.ok(await alm.leer(C.claveTesela(T, { fila: 6, col: 4 })));
});

test('sin basura: un 200 que no es PNG, un PNG cortado, uno de otro tamaño o uno más corto que lo anunciado quedan faltantes', async () => {
  const alm = nuevo();
  const real = leerDato('tesela_20261117003000_005_005.png');
  assert.equal(S.motivoTeselaMala(real), null, 'la tesela real de SLIDER pasa');
  const malas = {
    '005_003': { cuerpo: '<html><body>SLIDER en mantenimiento, vuelva más tarde</body></html>', tipo: 'text/html' },
    '005_004': { cuerpo: real.subarray(0, real.length - 100) },
    '005_005': pngFalso(256, 256),
    '006_003': { cuerpo: real, largo: real.length + 10 },
  };
  const sl = sliderFalso({ tiempos: [T], tesela: (t, f, c) => malas[C.nombreTesela({ fila: f, col: c })] ?? real });
  await correr({ almacen: alm, fetchFn: sl.fetchFn });
  const s = await leerJ(alm, C.claveSobre(T));
  assert.deepEqual(s.faltantes.map((x) => `${C.nombreTesela(x)} ${x.motivo}`), [
    '005_003 no es PNG', '005_004 PNG cortado (sin IEND)', '005_005 PNG de 256×256', '006_003 tamaño distinto del anunciado',
  ]);
  for (const n of Object.keys(malas)) {
    const [f, c] = n.split('_').map(Number);
    assert.equal(await alm.leer(C.claveTesela(T, { fila: f, col: c })), null, `nada guardado en ${n}`);
  }
  assert.equal(s.teselas.length, 5);
  // control negativo: el validador sí rechaza cada una por separado
  assert.equal(S.motivoTeselaMala(Buffer.from('<html>')), 'muy corta');
  assert.equal(S.motivoTeselaMala(pngFalso()), null);
});

test(`un tiempo incompleto se deja de reintentar a los ${4} intentos (y uno que SLIDER ya no lista no se pide más)`, async () => {
  const alm = nuevo();
  const siempre404 = (t, f, c) => (f === 7 && c === 3 ? { status: 404 } : null);
  for (let i = 0; i < C.MAX_INTENTOS; i++) {
    const sl = sliderFalso({ tiempos: [T], tesela: siempre404 });
    await correr({ almacen: alm, fetchFn: sl.fetchFn, ahoraMs: AHORA + i * 600000 });
    assert.equal(sl.teselasPedidas().length, i === 0 ? 9 : 1);
  }
  assert.equal((await leerJ(alm, C.claveSobre(T))).intentos, C.MAX_INTENTOS);
  const sl = sliderFalso({ tiempos: [T], tesela: siempre404 });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn, ahoraMs: AHORA + 9 * 600000 });
  assert.equal(r.pendientes, 0);
  assert.equal(sl.teselasPedidas().length, 0);
});

test('ventana: no pide tiempos de más de 18 h ni del futuro', () => {
  const viejo = '20261116063000';            // 18 h 25 min antes de AHORA
  const borde = '20261116070000';            // 17 h 55 min
  const futuro = '20261117020000';
  assert.deepEqual(C.pendientes([viejo, borde, T, futuro], new Map(), AHORA), [borde, T]);
});

// ---------- tope y cortesía ----------
test('tope: nunca más pedidos que el tope, y un tiempo entra entero o queda para la próxima', async () => {
  const alm = nuevo();
  const sl = sliderFalso({ tiempos: tiemposHasta(ULT, 20) });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn, tope: 30 });
  assert.ok(sl.pedidos.length <= 30, `pidió ${sl.pedidos.length}`);
  assert.equal(r.pedidos, 28, '1 + 3 tiempos × 9');
  assert.equal(r.guardados, 3);
  const sobres = (await alm.listar('gremlin/')).filter((k) => k.endsWith('sobre.json'));
  assert.equal(sobres.length, 3);
  assert.ok(sobres[0].includes(tiemposHasta(ULT, 20)[0]), 'empieza por el más viejo (el primero que SLIDER borra)');
  // el tope se acota: ni menos de 10 (un tiempo entero) ni más de 300
  assert.equal(C.acotarTope('5'), 10);
  assert.equal(C.acotarTope('5000'), 300);
  assert.equal(C.acotarTope(''), C.TOPE_DEFECTO);
  assert.equal(C.TOPE_DEFECTO, 60);
});

test('cortesía: UA hn-colector/1.0 en cada pedido y una pausa de 1 s entre pedidos', async () => {
  const pausas = [];
  const sl = sliderFalso({ tiempos: [T] });
  await C.correr({ almacen: nuevo(), fetchFn: sl.fetchFn, llave: 'si', ahoraMs: AHORA, log: callado, esperar: async (ms) => { pausas.push(ms); } });
  assert.equal(sl.pedidos.length, 10);
  assert.ok(sl.pedidos.every((p) => p.ua === 'hn-colector/1.0'));
  assert.deepEqual(pausas, Array(9).fill(1000));
});

test('un 429 de SLIDER corta la corrida en el acto; lo no pedido queda faltante y la alerta anotada', async () => {
  const alm = nuevo();
  const sl = sliderFalso({ tiempos: tiemposHasta(ULT, 3), tesela: (t, f, c) => (f === 5 && c === 5 ? { status: 429 } : null) });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn });
  assert.equal(r.estado, 'cortada');
  assert.equal(sl.teselasPedidas().length, 3, '005_003, 005_004 y la del 429');
  assert.equal(r.guardados, 1);
  const s = await leerJ(alm, C.claveSobre(tiemposHasta(ULT, 3)[0]));
  assert.equal(s.faltantes.length, 7);
  assert.match((await alm.leer(C.CLAVE_ALERTAS)).toString(), /SLIDER respondió 429/);
});

test('tres fallas de red seguidas cortan la corrida', async () => {
  const alm = nuevo();
  const sl = sliderFalso({ tiempos: [T], tesela: () => 'red' });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn });
  assert.equal(r.estado, 'cortada');
  assert.equal(sl.teselasPedidas().length, C.FALLAS_SEGUIDAS_CORTE);
  assert.equal((await leerJ(alm, C.claveSobre(T))).faltantes.length, 9);
});

test('SLIDER caído (latest_times 503 o sin red): no se guarda ningún tiempo, sólo la alerta', async () => {
  for (const tiempoStatus of [503, 'red']) {
    const alm = nuevo();
    const sl = sliderFalso({ tiempos: [T], tiempoStatus });
    const r = await correr({ almacen: alm, fetchFn: sl.fetchFn });
    assert.equal(r.estado, 'slider-caido');
    assert.equal(sl.pedidos.length, 1, 'un pedido, sin reintentos');
    assert.deepEqual(await alm.listar('gremlin/'), [C.CLAVE_ALERTAS]);
  }
});

// ---------- la llave ----------
test('llave apagada: no pide nada a SLIDER ni toca el almacén', async () => {
  for (const llave of [undefined, '', 'no', 'SI', 'true']) {
    const sl = sliderFalso({ tiempos: [T] });
    const alm = nuevo();
    let tocado = 0;
    const espia = { leer: async (k) => { tocado++; return alm.leer(k); }, escribir: async (...a) => { tocado++; return alm.escribir(...a); }, listar: alm.listar };
    const r = await C.correr({ almacen: espia, fetchFn: sl.fetchFn, llave, ahoraMs: AHORA, esperar: sinEspera, log: callado });
    assert.equal(r.estado, 'apagado', `llave ${JSON.stringify(llave)}`);
    assert.equal(sl.pedidos.length, 0);
    assert.equal(tocado, 0);
  }
  // control negativo: con «si» sí pide
  const sl = sliderFalso({ tiempos: [T] });
  await correr({ almacen: nuevo(), fetchFn: sl.fetchFn, llave: 'si' });
  assert.equal(sl.pedidos.length, 10);
});

test('seco: un solo pedido (latest_times), cuenta lo pendiente y no guarda nada', async () => {
  const alm = nuevo();
  const sl = sliderFalso({ tiempos: tiemposHasta(ULT, 5) });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn, modo: 'seco' });
  assert.equal(r.estado, 'seco');
  assert.equal(r.pendientes, 5);
  assert.equal(sl.pedidos.length, 1);
  assert.deepEqual(await alm.listar(''), []);
});

test('el workflow nace apagado: schedule sólo con vars.GREMLIN_ON == «si», a mano en seco, y los secretos R2 de siempre', async () => {
  const fs = await import('node:fs');
  const y = fs.readFileSync(new URL('../gremlin.workflow.yml.txt', import.meta.url), 'utf8');
  assert.match(y, /if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| vars\.GREMLIN_ON == 'si' \}\}/);
  assert.match(y, /default: seco/);
  for (const s of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) assert.match(y, new RegExp(`${s}: \\$\\{\\{ secrets\\.${s} \\}\\}`));
  assert.match(y, /cron: '4,14,24,34,44,54 \* \* \* \*'/);
  assert.match(y, /timeout-minutes: 9/);
});

// ---------- 311b · la revisión de Codex ----------
test('[311b] PNG de verdad: un IDAT corrupto con el mismo largo e IEND, o un CRC mal, quedan faltantes y no se guardan', async () => {
  const real = leerDato('tesela_20261117003000_005_005.png');
  const corrupto = idatCorrupto(real);
  assert.equal(corrupto.length, real.length, 'mismo largo');
  assert.ok(corrupto.subarray(-8).equals(real.subarray(-8)), 'mismo IEND');
  assert.equal(S.motivoTeselaMala(corrupto), 'PNG con el IDAT corrupto');
  assert.equal(S.motivoTeselaMala(crcMal(real)), 'PNG con el CRC de IDAT mal');
  assert.equal(S.motivoTeselaMala(real), null, 'control: la real pasa');
  assert.equal(S.motivoTeselaMala(pngFalso()), null, 'control: la sintética pasa');
  const alm = nuevo();
  const sl = sliderFalso({ tiempos: [T], tesela: (t, f, c) => (f === 6 && c === 4 ? corrupto : f === 6 && c === 5 ? crcMal(real) : real) });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn });
  assert.equal(r.incompletos, 1);
  const s = await leerJ(alm, C.claveSobre(T));
  assert.equal(s.estado, 'incompleto', 'nunca «completo» con una tesela rota');
  assert.deepEqual(s.faltantes.map((x) => `${C.nombreTesela(x)} ${x.motivo}`), ['006_004 PNG con el IDAT corrupto', '006_005 PNG con el CRC de IDAT mal']);
  assert.equal(await alm.leer(C.claveTesela(T, { fila: 6, col: 4 })), null);
  assert.equal(await alm.leer(C.claveTesela(T, { fila: 6, col: 5 })), null);
});

test('[311b] una corrida que se corta a mitad (R2 falla después de 4 teselas): la siguiente baja sólo las 5 que faltan', async () => {
  const alm = nuevo();
  let pngs = 0;
  const fragil = { ...alm, escribir: async (k, ...a) => { if (k.endsWith('.png') && ++pngs > 4) throw new Error('R2 escribir: HTTP 500'); return alm.escribir(k, ...a); } };
  const sl1 = sliderFalso({ tiempos: [T] });
  await assert.rejects(correr({ almacen: fragil, fetchFn: sl1.fetchFn }), /R2 escribir/);
  assert.equal(await alm.leer(C.claveSobre(T)), null, 'no llegó a escribir el sobre');
  assert.equal((await alm.listar('gremlin/')).filter((k) => k.endsWith('.png')).length, 4);
  const sl2 = sliderFalso({ tiempos: [T] });
  const r = await correr({ almacen: alm, fetchFn: sl2.fetchFn, ahoraMs: AHORA + 600000 });
  assert.equal(r.recuperadas, 4);
  assert.deepEqual(sl2.teselasPedidas().map((p) => p.url.slice(-11)), ['006_004.png', '006_005.png', '007_003.png', '007_004.png', '007_005.png']);
  const s = await leerJ(alm, C.claveSobre(T));
  assert.equal(s.estado, 'completo');
  assert.deepEqual(s.teselas.map(C.nombreTesela), ARGENTINA);
  for (const x of s.teselas) assert.match(x.sha256, /^[0-9a-f]{64}$/);
});

test('[311b] una tesela rota que quedó en R2 sin sobre no se adopta: se vuelve a pedir', async () => {
  const alm = nuevo();
  await alm.escribir(C.claveTesela(T, { fila: 5, col: 3 }), idatCorrupto(leerDato('tesela_20261117003000_005_005.png')));
  await alm.escribir(C.claveTesela(T, { fila: 5, col: 4 }), pngFalso());
  const sl = sliderFalso({ tiempos: [T] });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn });
  assert.equal(r.recuperadas, 1);
  assert.equal(sl.teselasPedidas().length, 8);
  assert.ok(sl.teselasPedidas().some((p) => p.url.endsWith('005_003.png')));
  assert.equal(S.motivoTeselaMala(await alm.leer(C.claveTesela(T, { fila: 5, col: 3 }))), null, 'quedó la buena');
});

// ---------- 311b, 3.ª vuelta (n3-311b-v2): el PNG según la especificación, para paleta (tipo 3) ----------
const REAL = leerDato('tesela_20261117003000_005_005.png');
const conReemplazo = (tipo, nuevos) => armar(trozos(REAL).flatMap((x) => (x.tipo === tipo ? nuevos : [x])));
const INVALIDOS = [
  ['la de Codex: PLTE vacía (CRC bien, IDAT que descomprime)', () => conReemplazo('PLTE', [{ tipo: 'PLTE', datos: Buffer.alloc(0) }]), 'PNG con una PLTE de largo inválido'],
  ['PLTE de largo no múltiplo de 3', () => conReemplazo('PLTE', [{ tipo: 'PLTE', datos: Buffer.alloc(10) }]), 'PNG con una PLTE de largo inválido'],
  ['PLTE de 257 entradas', () => armar([ihdr(), plte(257), idat(), iend()]), 'PNG con una PLTE de 257 entradas (de más)'],
  ['PLTE de 5 entradas con profundidad 2 (máximo 4)', () => armar([ihdr(2), plte(5), idat(undefined, 2), iend()]), 'PNG con una PLTE de 5 entradas (de más)'],
  ['PLTE después del IDAT', () => armar([ihdr(), idat(), plte(4), iend()]), 'PNG con paleta sin PLTE antes del IDAT'],
  ['sin PLTE', () => armar([ihdr(), idat(), iend()]), 'PNG con paleta sin PLTE antes del IDAT'],
  ['dos PLTE', () => armar([ihdr(), plte(4), plte(4), idat(), iend()]), 'PNG con dos PLTE'],
  ['tRNS con más entradas que la PLTE', () => armar([ihdr(), plte(4), { tipo: 'tRNS', datos: Buffer.alloc(5) }, idat(), iend()]), 'PNG con más tRNS que entradas de PLTE'],
  ['tRNS antes de la PLTE', () => armar([ihdr(), { tipo: 'tRNS', datos: Buffer.alloc(2) }, plte(4), idat(), iend()]), 'PNG con tRNS antes de la PLTE'],
  ['tRNS después del IDAT', () => armar([ihdr(), plte(4), idat(), { tipo: 'tRNS', datos: Buffer.alloc(2) }, iend()]), 'PNG con tRNS después del IDAT'],
  ['profundidad 16 con paleta', () => armar([ihdr(16), plte(4), idat(), iend()]), 'PNG con profundidad 16 inválida para el tipo 3'],
  ['profundidad 3', () => armar([ihdr(3), plte(4), idat(), iend()]), 'PNG con profundidad 3 inválida para el tipo 3'],
  ['color verdadero (tipo 2) en vez de paleta', () => armar([ihdr(8, 2), idat(), iend()]), 'PNG de tipo de color 2 (se espera paleta, tipo 3)'],
  ['índice fuera de la PLTE (la real con una PLTE de 1 entrada)', () => conReemplazo('PLTE', [plte(1)]), /^PNG con un índice de píxel \(\d+\) fuera de la PLTE de 1$/],
  ['índice fuera de la PLTE sólo después de deshacer el filtro Sub', () => armar([ihdr(), plte(4), idat((f) => (f === 300 ? [1, 2, 2] : [0])), iend()]), 'PNG con un índice de píxel (4) fuera de la PLTE de 4'],
  ['índice fuera de la PLTE con filtro Up', () => armar([ihdr(), plte(4), idat((f) => (f === 0 ? [0, 3] : f === 1 ? [2, 1] : [0])), iend()]), 'PNG con un índice de píxel (4) fuera de la PLTE de 4'],
  ['índice fuera de la PLTE con profundidad 2 (el 3 con 3 entradas)', () => armar([ihdr(2), plte(3), idat(() => [0, 0b11100100], 2), iend()]), 'PNG con un índice de píxel (3) fuera de la PLTE de 3'],
  // Paeth con empate pb = pc (a=0, b=3, c=1): la especificación elige b → 1 + 3 = 4, fuera de una PLTE de 4
  ['índice fuera de la PLTE con filtro Paeth (empate entre b y c)', () => armar([ihdr(), plte(4), idat((f) => (f === 0 ? [0, 1, 3] : f === 1 ? [4, 255, 1] : [0])), iend()]), 'PNG con un índice de píxel (4) fuera de la PLTE de 4'],
  ['un chunk crítico desconocido', () => armar([ihdr(), plte(4), { tipo: 'ABCD', datos: Buffer.alloc(1) }, idat(), iend()]), 'PNG con un chunk crítico desconocido (ABCD)'],
  ['IDAT no consecutivos', () => { const d = idat().datos; return armar([ihdr(), plte(4), { tipo: 'IDAT', datos: d.subarray(0, 10) }, { tipo: 'tEXt', datos: Buffer.from('a\0b') }, { tipo: 'IDAT', datos: d.subarray(10) }, iend()]); }, 'PNG con IDAT no consecutivos'],
];
for (const [nombre, armarlo, motivo] of INVALIDOS) {
  test(`[311b v3] inválido: ${nombre}`, () => {
    const m = S.motivoTeselaMala(armarlo());
    if (motivo instanceof RegExp) assert.match(String(m), motivo); else assert.equal(m, motivo);
  });
}

test('[311b v3] controles válidos: la real, la sintética, tRNS justo, un chunk auxiliar, filtros 1 a 4 dentro de la PLTE, profundidad 2', () => {
  assert.equal(S.motivoTeselaMala(REAL), null);
  assert.equal(S.motivoTeselaMala(pngFalso()), null);
  assert.equal(S.motivoTeselaMala(armar([ihdr(), plte(4), { tipo: 'tRNS', datos: Buffer.alloc(4) }, idat(), iend()])), null);
  assert.equal(S.motivoTeselaMala(armar([ihdr(), plte(4), { tipo: 'tEXt', datos: Buffer.from('a\0b') }, idat(), iend()])), null);
  for (const filtro of [1, 2, 3, 4]) assert.equal(S.motivoTeselaMala(armar([ihdr(), plte(4), idat((f) => (f === 0 ? [0, 1, 2] : f === 1 ? [filtro, 1, 0] : [0])), iend()])), null, `filtro ${filtro}`);
  assert.equal(S.motivoTeselaMala(armar([ihdr(2), plte(4), idat(() => [0, 0b11100100], 2), iend()])), null, 'profundidad 2: 4 índices (3,2,1,0) en un byte');
  // profundidad 2: 678 px = 169,5 bytes; la mitad baja del último byte es relleno y no es un píxel (se ignora)
  const relleno = Array(171).fill(0); relleno[170] = 0b00000011;
  assert.equal(S.motivoTeselaMala(armar([ihdr(2), plte(3), idat(() => relleno, 2), iend()])), null, 'el relleno del final de la fila no cuenta');
});

test('[311b v3] en la corrida: una PLTE vacía (la de Codex) queda faltante, no se guarda ni se adopta, y el tiempo no queda completo', async () => {
  const mala = conReemplazo('PLTE', [{ tipo: 'PLTE', datos: Buffer.alloc(0) }]);
  const alm = nuevo();
  const sl = sliderFalso({ tiempos: [T], tesela: () => mala });
  const r = await correr({ almacen: alm, fetchFn: sl.fetchFn });
  assert.equal(r.teselas, 0);
  const s = await leerJ(alm, C.claveSobre(T));
  assert.equal(s.estado, 'incompleto');
  assert.equal(s.faltantes.length, 9);
  assert.ok(s.faltantes.every((x) => x.motivo === 'PNG con una PLTE de largo inválido'));
  const alm2 = nuevo();
  await alm2.escribir(C.claveTesela(T, { fila: 5, col: 3 }), mala);
  const sl2 = sliderFalso({ tiempos: [T] });
  const r2 = await correr({ almacen: alm2, fetchFn: sl2.fetchFn });
  assert.equal(r2.recuperadas, 0);
  assert.equal(sl2.teselasPedidas().length, 9);
});

// ---------- retención (local, 17/11): 90 días, salvo los días con casos ----------
const R = await import((process.env.GREMLIN_LIB || new URL('../lib/', import.meta.url).href) + 'retencion.mjs');
const DIA_MS = 86400000;
const llenarDia = async (alm, d, n = 3) => {
  const t = d.replace(/-/g, '') + '120000';
  for (let i = 0; i < n; i++) await alm.escribir(`${R.prefijoDia(d)}${t}/03/00${i}_000.png`, pngFalso());
  await alm.escribir(`${R.prefijoDia(d)}${t}/sobre.json`, '{}');
  await alm.escribir(`${R.prefijoDia(d)}indice.json`, '{}');
};
const hay = async (alm, d) => (await alm.listar(R.prefijoDia(d))).length;
const CASOS = { dias: ['2026-11-20'] };            // día argentino: se guardan los UTC 20 y 21
const HOY = Date.UTC(2027, 1, 20, 12);             // 20/02/2027: el último borrable es el 21/11/2026 (91 días antes)

test('retención: borra lo de más de 90 días, deja los 90 días y los días con casos (D y D+1 UTC), y avanza la marca', async () => {
  assert.equal(R.ultimoBorrable(HOY), '2026-11-21');
  const alm = nuevo();
  for (const d of ['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2027-02-19']) await llenarDia(alm, d);
  const r = await R.limpiar({ almacen: alm, casos: CASOS, ahoraMs: HOY, log: callado });
  assert.equal(r.estado, 'ok');
  assert.equal(await hay(alm, '2026-11-16'), 0);
  assert.equal(await hay(alm, '2026-11-17'), 0);
  assert.equal(await hay(alm, '2026-11-19'), 0);
  assert.equal(await hay(alm, '2026-11-20'), 5, 'día del caso');
  assert.equal(await hay(alm, '2026-11-21'), 5, 'D+1 UTC del caso (la noche argentina)');
  assert.equal(await hay(alm, '2026-11-22'), 5, '90 días justos: todavía no');
  assert.equal(await hay(alm, '2027-02-19'), 5);
  assert.equal(r.marca, '2026-11-21');
  assert.equal(JSON.parse((await alm.leer(R.CLAVE_MARCA)).toString()).hasta, '2026-11-21');
  // al día siguiente cae el 22, y nada más
  const r2 = await R.limpiar({ almacen: alm, casos: CASOS, ahoraMs: HOY + DIA_MS, log: callado });
  assert.equal(r2.marca, '2026-11-22');
  assert.equal(await hay(alm, '2026-11-22'), 0);
  assert.equal(await hay(alm, '2026-11-20'), 5, 'el caso sigue');
});

test('retención: el tope de borrados por corrida; un día a medias sigue en la próxima y el índice del día va último', async () => {
  const alm = nuevo();
  await llenarDia(alm, '2026-11-16', 20);                 // 22 objetos
  const r1 = await R.limpiar({ almacen: alm, casos: CASOS, ahoraMs: HOY, tope: 10, log: callado });
  assert.equal(r1.borrados, 10);
  assert.equal(await hay(alm, '2026-11-16'), 12);
  assert.ok(await alm.leer(`${R.prefijoDia('2026-11-16')}indice.json`), 'el índice se borra al final');
  assert.equal(await alm.leer(R.CLAVE_MARCA), null, 'la marca no avanza con el día a medias');
  await R.limpiar({ almacen: alm, casos: CASOS, ahoraMs: HOY, tope: 10, log: callado });
  const r3 = await R.limpiar({ almacen: alm, casos: CASOS, ahoraMs: HOY, tope: 10, log: callado });
  assert.equal(await hay(alm, '2026-11-16'), 0);
  assert.equal(r3.borrados, 2 + 0);
  assert.equal(R.TOPE_BORRADOS, 300);
});

test('retención: sin lista válida de casos (o con la marca ilegible) no borra nada', async () => {
  for (const casos of [null, {}, { dias: '2026-11-20' }, { dias: ['2026-11-20', '20/11/2026'] }, { dias: ['2026-02-30'] }]) {
    const alm = nuevo();
    await llenarDia(alm, '2026-11-16');
    const r = await R.limpiar({ almacen: alm, casos, ahoraMs: HOY, log: callado });
    assert.equal(r.estado, 'sin-lista', JSON.stringify(casos));
    assert.equal(await hay(alm, '2026-11-16'), 5);
  }
  const alm = nuevo();
  await llenarDia(alm, '2026-11-16');
  await alm.escribir(R.CLAVE_MARCA, 'basura');
  assert.equal((await R.limpiar({ almacen: alm, casos: CASOS, ahoraMs: HOY, log: callado })).estado, 'sin-marca');
  assert.equal(await hay(alm, '2026-11-16'), 5);
  // control: con lista válida, sí borra
  const alm2 = nuevo();
  await llenarDia(alm2, '2026-11-16');
  await R.limpiar({ almacen: alm2, casos: { dias: [] }, ahoraMs: HOY, log: callado });
  assert.equal(await hay(alm2, '2026-11-16'), 0);
});

test('retención en la corrida: sólo en real, con la lista; ni en seco, ni con la llave apagada, ni sin lista', async () => {
  const preparar = async () => { const alm = nuevo(); await llenarDia(alm, '2026-11-16'); return alm; };
  const ahora = HOY;
  const t = new Date(ahora - 30 * 60000).toISOString().replace(/[-:T]/g, '').slice(0, 12).replace(/\d$/, '0') + '00';
  let alm = await preparar();
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: [t] }).fetchFn, ahoraMs: ahora, casos: CASOS });
  assert.equal(await hay(alm, '2026-11-16'), 0, 'real con lista: limpia');
  alm = await preparar();
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: [t] }).fetchFn, ahoraMs: ahora, casos: CASOS, modo: 'seco' });
  assert.equal(await hay(alm, '2026-11-16'), 5, 'seco: no');
  alm = await preparar();
  await C.correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: [t] }).fetchFn, ahoraMs: ahora, casos: CASOS, llave: 'no', log: callado });
  assert.equal(await hay(alm, '2026-11-16'), 5, 'llave apagada: no');
  alm = await preparar();
  await correr({ almacen: alm, fetchFn: sliderFalso({ tiempos: [t] }).fetchFn, ahoraMs: ahora, casos: null });
  assert.equal(await hay(alm, '2026-11-16'), 5, 'lista ilegible: no');
});

test('dias-casos.json del repo: válido, con el caso de Cuyo del 16/11', async () => {
  const fs = await import('node:fs');
  const j = JSON.parse(fs.readFileSync(new URL('../dias-casos.json', import.meta.url), 'utf8'));
  const p = R.diasProtegidos(j);
  assert.ok(p, 'lista válida');
  assert.ok(j.dias.includes('2026-11-16'));
  assert.ok(p.has('2026-11-17'), 'D+1 UTC');
});
