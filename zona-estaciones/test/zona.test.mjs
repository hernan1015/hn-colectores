// 257 · tests de la zona por WorldCover. Sin red por defecto (node --test test/).
// La prueba contra el COG real corre sólo con ZONA_RED=1 (3 lecturas de rango, ~0,5 MB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clasificar, porcentajes } from '../lib/regla.mjs';
import { tileDe, pixelGlobal, centroPixel, ventana, tileDePixel } from '../lib/grilla.mjs';
import { leerVentanas, contarVentana } from '../lib/worldcover.mjs';
import { detalle, leerCsv, CITA } from '../clasificar-zona.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/ventanas-regla.json', import.meta.url), 'utf8'));

// ── La regla, con fixtures de ventanas ──────────────────────────────────────────────────────────────────────────
for (const c of fx.casos) {
  test(`regla r1: ${c.nombre} → ${c.zona}`, () => {
    assert.equal(clasificar(c.conteos).zona, c.zona);
  });
}

test('porcentajes: suman ~100 y excluyen el 0', () => {
  const { total, pct } = porcentajes({ 0: 50, 40: 30, 50: 10 });
  assert.equal(total, 40);
  assert.equal(pct[40], 75);
  assert.equal(pct[50], 25);
});

// ── La grilla ───────────────────────────────────────────────────────────────────────────────────────────────────
test('grilla: nombres de tile (esquina suroeste)', () => {
  assert.equal(tileDe(-34.6037, -58.3816), 'S36W060');   // CABA
  assert.equal(tileDe(-41.05, -71.45), 'S42W072');       // Nahuel Huapi
  assert.equal(tileDe(-33.0001, -60.0001), 'S36W063');
  assert.equal(tileDe(-32.9999, -59.9999), 'S33W060');
  assert.equal(tileDe(10.5, 5.5), 'N09E003');
});

test('grilla: el centro del píxel vuelve al mismo píxel', () => {
  const { gx, gy } = pixelGlobal(-38.123456, -67.654321);
  const c = centroPixel(gx, gy);
  assert.deepEqual(pixelGlobal(c.lat, c.lon), { gx, gy });
  assert.ok(Math.abs(c.lat + 38.123456) < 1 / 12000 && Math.abs(c.lon + 67.654321) < 1 / 12000);
});

test('grilla: una ventana en el borde de dos tiles se parte en dos', () => {
  const v = ventana(-34.5, -60.00005, 250);
  assert.deepEqual(v.partes.map((p) => p.nombre).sort(), ['S36W060', 'S36W063']);
  const ancho = v.partes.reduce((s, p) => s + (p.x1 - p.x0), 0);
  assert.equal(ancho, v.caja.gx1 - v.caja.gx0);
});

// ── La lectura del píxel: tiles sintéticos con valores conocidos ────────────────────────────────────────────────
/** Un «tile» falso: el valor de cada píxel sale de f(gx, gy). Registra los pedidos. */
function tilesFalsos(f, { faltan = [], roto = [] } = {}) {
  const pedidos = [];
  const abrir = async (nombre) => {
    pedidos.push(nombre);
    if (faltan.includes(nombre)) throw new Error('Request failed with status code 404 Not Found');
    if (roto.includes(nombre)) throw new Error('Request failed with status code 503');
    // el origen del tile en píxeles globales, a partir del nombre
    const lat = (nombre[0] === 'S' ? -1 : 1) * Number(nombre.slice(1, 3)) + 1.5, lon = (nombre[3] === 'W' ? -1 : 1) * Number(nombre.slice(4, 7)) + 1.5;
    const { gx, gy } = pixelGlobal(lat, lon);
    const t = tileDePixel(gx, gy);
    assert.equal(t.nombre, nombre);
    return {
      async leer(x0, y0, x1, y1) {
        const out = new Uint8Array((x1 - x0) * (y1 - y0));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[(y - y0) * (x1 - x0) + (x - x0)] = f(t.gx0 + x, t.gy0 + y);
        return out;
      },
    };
  };
  return { abrir, pedidos };
}

test('lectura: el píxel del punto es exactamente el que tiene el valor conocido', async () => {
  const lat = -36.2, lon = -61.3;
  const blanco = pixelGlobal(lat, lon);
  const { abrir } = tilesFalsos((gx, gy) => (gx === blanco.gx && gy === blanco.gy ? 50 : (gx === blanco.gx + 1 ? 30 : 40)));
  const m = await leerVentanas([{ clave: 'a', lat, lon }], { abrir, pausaTileMs: 0, pausaLecturaMs: 0 });
  const v = m.get('a');
  assert.equal(v.pixel, 50);
  assert.equal(v.conteos[250][50], 1);
  assert.ok(v.conteos[250][30] > 40 && v.conteos[250][30] < 70, 'una columna de 30 cruza el círculo (≈ 55 px)');
  assert.ok(v.conteos[250][40] > 2500);
});

test('lectura: en el borde entre tiles se leen los dos y se juntan bien', async () => {
  const lat = -34.5, lon = -60.00005;
  const { abrir, pedidos } = tilesFalsos((gx) => (gx < pixelGlobal(0, -60).gx ? 30 : 40));
  const m = await leerVentanas([{ clave: 'b', lat, lon }], { abrir, pausaTileMs: 0, pausaLecturaMs: 0 });
  const c = m.get('b').conteos[250];
  assert.deepEqual(pedidos.sort(), ['S36W060', 'S36W063']);
  assert.ok(Math.abs(c[30] - c[40]) / (c[30] + c[40]) < 0.05, 'mitad y mitad');
  assert.equal(m.get('b').pixel, 30); // −60,00005 cae del lado oeste
});

test('lectura: un tile se abre una sola vez aunque tenga muchas estaciones, y la caché evita pedirlo', async () => {
  const { abrir, pedidos } = tilesFalsos(() => 40);
  const guardado = new Map();
  const cache = { get: (k) => guardado.get(k), set: (k, v) => guardado.set(k, v) };
  const pts = [{ clave: '1', lat: -34.2, lon: -61.2 }, { clave: '2', lat: -34.8, lon: -61.9 }, { clave: '3', lat: -35.5, lon: -62.5 }];
  await leerVentanas(pts, { abrir, cache, pausaTileMs: 0, pausaLecturaMs: 0 });
  assert.deepEqual(pedidos, ['S36W063']);
  await leerVentanas(pts, { abrir, cache, pausaTileMs: 0, pausaLecturaMs: 0 });
  assert.deepEqual(pedidos, ['S36W063'], 'la segunda vez no pide nada');
});

test('contarVentana: rechaza datos de otro tamaño', () => {
  assert.throws(() => contarVentana(-34, -60, { gx0: 0, gy0: 0, gx1: 3, gy1: 3 }, new Uint8Array(8)));
});

// ── Controles negativos ─────────────────────────────────────────────────────────────────────────────────────────
test('control negativo: todo agua NUNCA da agricola ni urbana', () => {
  for (const cls of [80, 90, 10, 20, 60, 70, 95, 100]) {
    assert.equal(clasificar({ [cls]: 2750 }).zona, 'natural', `clase ${cls}`);
  }
});

test('control negativo: un tile inexistente (404) da sin_dato, no una zona inventada', async () => {
  const { abrir } = tilesFalsos(() => 40, { faltan: ['S54W060'] });
  const m = await leerVentanas([{ clave: 'mar', lat: -52.5, lon: -58.5 }], { abrir, pausaTileMs: 0, pausaLecturaMs: 0 });
  const z = detalle(m.get('mar'), -52.5, -58.5);
  assert.equal(z.zona, 'sin_dato');
  assert.deepEqual(m.get('mar').faltantes, ['S54W060']);
});

test('control negativo: un 503 de S3 corta (no se toma como «sin dato»)', async () => {
  const { abrir } = tilesFalsos(() => 40, { roto: ['S36W063'] });
  await assert.rejects(leerVentanas([{ clave: 'x', lat: -34.2, lon: -61.2 }], { abrir, pausaTileMs: 0, pausaLecturaMs: 0 }), /no se pudo abrir/);
});

test('control negativo: la regla mira la ventana, no sólo el píxel (galpón en medio del lote)', async () => {
  const lat = -33.9, lon = -61.6;
  const blanco = pixelGlobal(lat, lon);
  const { abrir } = tilesFalsos((gx, gy) => (Math.abs(gx - blanco.gx) <= 2 && Math.abs(gy - blanco.gy) <= 2 ? 50 : 40));
  const m = await leerVentanas([{ clave: 'g', lat, lon }], { abrir, pausaTileMs: 0, pausaLecturaMs: 0 });
  const z = detalle(m.get('g'), lat, lon);
  assert.equal(m.get('g').pixel, 50);
  assert.equal(z.zona, 'agricola');
});

// ── El detalle que va a metadatos ───────────────────────────────────────────────────────────────────────────────
test('detalle: trae la cita, la licencia, la regla y los porcentajes por radio', () => {
  const v = { pixel: 40, conteos: { 100: { 40: 300 }, 250: { 40: 2500, 50: 250 }, 500: { 40: 9000, 30: 2000 } } };
  const z = detalle(v, -34, -60, new Date('2026-11-15T12:00:00Z'));
  assert.equal(z.zona, 'agricola');
  assert.match(z.detalle.cita, /Zanaga.*10\.5281\/zenodo\.7254221/);
  assert.equal(z.detalle.licencia, 'CC BY 4.0');
  assert.equal(z.detalle.regla, 'r1');
  assert.deepEqual(Object.keys(z.detalle.pct), ['100', '250', '500']);
  assert.equal(z.detalle.pct['250'][40], 90.9);
  assert.ok(CITA.includes('Copernicus Sentinel'));
});

test('leerCsv: comillas, comas y saltos de línea', () => {
  const f = leerCsv('a,b\n"x, y","con ""comillas"""\r\n1,2\n');
  assert.deepEqual(f, [{ a: 'x, y', b: 'con "comillas"' }, { a: '1', b: '2' }]);
});

// ── Contra el COG real (opcional, con red) ──────────────────────────────────────────────────────────────────────
test('COG real: Obelisco = construido, Nahuel Huapi = agua, campo de Pergamino = cultivo', { skip: process.env.ZONA_RED !== '1' }, async () => {
  const pts = [
    { clave: 'obelisco', lat: -34.603722, lon: -58.381592, pixel: 50, zona: 'urbana' },
    { clave: 'nahuel', lat: -41.05, lon: -71.45, pixel: 80, zona: 'natural' },
    { clave: 'pampa', lat: -34.05, lon: -60.5, pixel: 40, zona: 'agricola' },
  ];
  const m = await leerVentanas(pts, { pausaTileMs: 1000 });
  for (const p of pts) {
    assert.equal(m.get(p.clave).pixel, p.pixel, p.clave);
    assert.equal(detalle(m.get(p.clave), p.lat, p.lon).zona, p.zona, p.clave);
  }
});
