// 257 · 2.ª vuelta: las reproducciones de Codex (n3-257-1511) como tests, cada una con su control negativo.
// Sin red ni base: fetch, geotiff y postgres.js se inyectan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificar } from '../lib/regla.mjs';
import { pixelGlobal, tileDePixel } from '../lib/grilla.mjs';
import { leerVentanas, abrirRemoto, TileInexistente } from '../lib/worldcover.mjs';
import { detalle, mensajeError } from '../clasificar-zona.mjs';
import { conectar, opcionesPg, leerCa } from '../lib/base.mjs';

const SIN_PAUSA = { pausaTileMs: 0, pausaLecturaMs: 0 };
const NOMBRE_TILE = /[NS]\d{2}[EW]\d{3}/;

/** Tiles falsos: valor por píxel = f(gx, gy); los de `faltan` dan 404. */
function tilesFalsos(f, { faltan = [] } = {}) {
  const pedidos = [];
  const abrir = async (nombre) => {
    pedidos.push(nombre);
    if (faltan.includes(nombre)) throw new TileInexistente();
    const lat = (nombre[0] === 'S' ? -1 : 1) * Number(nombre.slice(1, 3)) + 1.5, lon = (nombre[3] === 'W' ? -1 : 1) * Number(nombre.slice(4, 7)) + 1.5;
    const t = tileDePixel(pixelGlobal(lat, lon).gx, pixelGlobal(lat, lon).gy);
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

// ── 1. Un faltante parcial no se presenta como certeza ──────────────────────────────────────────────────────────
test('Codex 1: media ventana en un tile 404 → sin_dato, con la cobertura guardada (no 100 % cultivo y margen 100)', async () => {
  const lat = -34.5, lon = -60.00005; // sobre el borde S36W063 | S36W060
  const { abrir } = tilesFalsos(() => 40, { faltan: ['S36W063'] });
  const m = await leerVentanas([{ clave: 'b', lat, lon }], { abrir, ...SIN_PAUSA });
  const z = detalle(m.get('b'), lat, lon);
  assert.equal(z.zona, 'sin_dato');
  assert.equal(z.detalle.margen, null);
  assert.ok(z.detalle.cobertura['250'] > 40 && z.detalle.cobertura['250'] < 60, `cobertura ≈ 50 (${z.detalle.cobertura['250']})`);
  assert.ok(z.detalle.pixeles < z.detalle.pixeles_circulo);
  assert.equal(m.get('b').faltantes, 1);
  assert.equal(m.get('b').pixel, null, 'el píxel del punto cae en el tile que no existe');
});

test('Codex 1 (control): con los dos tiles, el mismo punto da agricola con cobertura 100 y sin duda', async () => {
  const lat = -34.5, lon = -60.00005;
  const { abrir } = tilesFalsos(() => 40);
  const m = await leerVentanas([{ clave: 'b', lat, lon }], { abrir, ...SIN_PAUSA });
  const z = detalle(m.get('b'), lat, lon);
  assert.equal(z.zona, 'agricola');
  assert.equal(z.detalle.cobertura['250'], 100);
  assert.equal(z.detalle.dudosa, false);
  assert.deepEqual(z.detalle.dudosa_motivo, []);
});

test('Codex 1: con ~5 % de la ventana en un tile 404 → se clasifica, pero DUDOSA por cobertura', async () => {
  const lat = -34.5, lon = -60 + 200 / (111320 * Math.cos(34.5 * Math.PI / 180)); // 200 m al este del borde
  const { abrir } = tilesFalsos(() => 40, { faltan: ['S36W063'] });
  const m = await leerVentanas([{ clave: 'c', lat, lon }], { abrir, ...SIN_PAUSA });
  const z = detalle(m.get('c'), lat, lon);
  assert.equal(z.zona, 'agricola');
  assert.equal(z.detalle.dudosa, true);
  assert.deepEqual(z.detalle.dudosa_motivo, ['cobertura']);
  assert.ok(z.detalle.cobertura['250'] >= 90 && z.detalle.cobertura['250'] < 100, `cobertura ${z.detalle.cobertura['250']}`);
});

test('Codex 1: la regla con conteos — 89,9 % cubierto es sin_dato, 90 % se clasifica (dudosa), 100 % sin duda', () => {
  assert.equal(clasificar({ 40: 899, 255: 101 }).zona, 'sin_dato');
  const r90 = clasificar({ 40: 900, 255: 100 });
  assert.equal(r90.zona, 'agricola');
  assert.deepEqual(r90.motivos, ['cobertura']);
  const r100 = clasificar({ 40: 1000 });
  assert.equal(r100.dudosa, false);
  // el 0 de WorldCover (sin dato dentro de un tile) cuenta igual que un tile faltante
  assert.equal(clasificar({ 40: 899, 0: 101 }).zona, 'sin_dato');
});

// ── 2. Un 403 no es ausencia ────────────────────────────────────────────────────────────────────────────────────
const respuesta = (status) => ({ status, ok: status >= 200 && status < 300, arrayBuffer: async () => new ArrayBuffer(0) });
const fromUrlProhibido = async () => { throw new Error('geotiff no se tenía que llamar'); };

test('Codex 2: un 403 de S3 corta con un error explícito (no da sin_dato) y no lleva el nombre del tile', async () => {
  const abrir = (n) => abrirRemoto(n, { fetch: async () => respuesta(403), fromUrl: fromUrlProhibido });
  const lineas = [];
  await assert.rejects(leerVentanas([{ clave: 'x', lat: -34.2, lon: -61.2 }], { abrir, ...SIN_PAUSA, log: (s) => lineas.push(s) }), (e) => {
    assert.match(e.message, /HTTP 403/);
    assert.doesNotMatch(e.message, NOMBRE_TILE);
    return true;
  });
  for (const l of lineas) assert.doesNotMatch(l, NOMBRE_TILE);
});

test('Codex 2: 401, 500, 503, 301 y una falla de red también cortan', async () => {
  for (const st of [401, 500, 503, 301]) {
    const abrir = (n) => abrirRemoto(n, { fetch: async () => respuesta(st), fromUrl: fromUrlProhibido });
    await assert.rejects(leerVentanas([{ clave: 'x', lat: -34.2, lon: -61.2 }], { abrir, ...SIN_PAUSA }), new RegExp(`HTTP ${st}`));
  }
  const abrir = (n) => abrirRemoto(n, { fetch: async () => { throw new Error('getaddrinfo ENOTFOUND esa-worldcover…S36W063'); }, fromUrl: fromUrlProhibido });
  await assert.rejects(leerVentanas([{ clave: 'x', lat: -34.2, lon: -61.2 }], { abrir, ...SIN_PAUSA }), (e) => {
    assert.doesNotMatch(e.message, NOMBRE_TILE); assert.doesNotMatch(e.message, /ENOTFOUND/); return true;
  });
});

test('Codex 2 (control): sólo el 404 es «el tile no existe» → sin_dato, sin llamar a geotiff', async () => {
  const abrir = (n) => abrirRemoto(n, { fetch: async () => respuesta(404), fromUrl: fromUrlProhibido });
  const lineas = [];
  const m = await leerVentanas([{ clave: 'mar', lat: -52.5, lon: -58.5 }], { abrir, ...SIN_PAUSA, log: (s) => lineas.push(s) });
  assert.equal(detalle(m.get('mar'), -52.5, -58.5).zona, 'sin_dato');
  assert.ok(lineas.some((l) => /inexistentes \(404\): 1/.test(l)));
  for (const l of lineas) assert.doesNotMatch(l, NOMBRE_TILE, 'el log sólo con cantidades');
});

test('log y errores: un error ajeno al abrir o leer no se copia (ni el nombre del tile ni su texto)', async () => {
  const abrir1 = async (n) => { throw new Error(`Request failed ${n} https://bucket/secreto`); };
  await assert.rejects(leerVentanas([{ clave: 'x', lat: -34.2, lon: -61.2 }], { abrir: abrir1, ...SIN_PAUSA }), (e) => {
    assert.equal(e.message, 'un tile no se pudo abrir'); return true;
  });
  const abrir2 = async () => ({ async leer() { throw new Error('S36W063 bloque 17 roto'); } });
  await assert.rejects(leerVentanas([{ clave: 'x', lat: -34.2, lon: -61.2 }], { abrir: abrir2, ...SIN_PAUSA }), (e) => {
    assert.equal(e.message, 'una ventana no se pudo leer'); return true;
  });
  // en el CLI: de un error que no es nuestro sale sólo el tipo
  assert.equal(mensajeError(new TypeError('fetch failed host=…S36W063')), 'error inesperado (TypeError)');
  assert.equal(mensajeError(Object.assign(new Error('base: falta la CA'), { propio: true })), 'base: falta la CA');
});

// ── 3. El redondeo no cambia la regla ───────────────────────────────────────────────────────────────────────────
test('Codex 3: 749 construidos y 1.751 de cultivo (29,96 %) NO es urbana', () => {
  const r = clasificar({ 50: 749, 40: 1751 });
  assert.equal(r.zona, 'agricola');
  assert.equal(r.pct[50], 30, 'para mostrar se redondea a 30,0, pero no se decide con eso');
});

test('Codex 3 (control): 750 de 2.500 (30 % exacto) SÍ es urbana', () => {
  assert.equal(clasificar({ 50: 750, 40: 1750 }).zona, 'urbana');
});

test('Codex 3: el ganador se decide con conteos (pastizal 10.001 > cultivo 10.000, aunque los dos redondeen a 33,3)', () => {
  const r = clasificar({ 40: 10000, 30: 10001, 10: 9999 });
  assert.equal(r.grupos.agricola, r.grupos.pastizal, 'redondeados son iguales');
  assert.equal(r.zona, 'pastizal');
  assert.equal(clasificar({ 40: 10001, 30: 10000, 10: 9999 }).zona, 'agricola', 'control');
  assert.equal(clasificar({ 40: 10000, 30: 10000, 10: 9999 }).zona, 'agricola', 'empate exacto: agricola');
});

test('Codex 3: la duda por margen también con conteos (199 de 2.000 = 9,95 → dudosa, aunque se muestre 10)', () => {
  const r = clasificar({ 40: 1000, 30: 801, 10: 199 });
  assert.equal(r.margen, 10);
  assert.equal(r.dudosa, true);
  assert.deepEqual(r.motivos, ['margen']);
  const c = clasificar({ 40: 1000, 30: 800, 10: 200 });
  assert.equal(c.dudosa, false, 'control: 200 de 2.000 = 10 justo, no es dudosa');
});

// ── Lo dudoso, con su marca ─────────────────────────────────────────────────────────────────────────────────────
test('dudosa: margen y cobertura juntos llevan los dos motivos; el detalle trae la marca', () => {
  const v = { pixel: 40, conteos: { 100: { 40: 300 }, 250: { 40: 1300, 30: 1200, 255: 100 }, 500: { 40: 5000 } } };
  const z = detalle(v, -34, -60, new Date('2026-11-15T12:00:00Z'));
  assert.equal(z.zona, 'agricola');
  assert.equal(z.detalle.dudosa, true);
  assert.deepEqual(z.detalle.dudosa_motivo, ['margen', 'cobertura']);
});

// ── 5. TLS que autentica al servidor ────────────────────────────────────────────────────────────────────────────
const CA = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZm9vYmFy\nZm9vYmFyZm9vYmFy\n-----END CERTIFICATE-----\n';
const URL_OK = 'postgresql://clasificador_zona.abc:clave@aws-0-sa-east-1.pooler.supabase.com:6543/postgres';

/** Un postgres.js falso: guarda las opciones y contesta el chequeo del rol. */
function pgFalso(usuario = 'clasificador_zona') {
  const visto = {};
  const pg = (url, op) => {
    visto.op = op;
    const sql = async () => [{ u: usuario, s: usuario }];
    sql.end = async () => {};
    return sql;
  };
  return { pg, visto };
}

test('Codex 5: la conexión va con rejectUnauthorized:true, la CA y el host (nunca ssl:"require")', async () => {
  const { pg, visto } = pgFalso();
  const b = await conectar(URL_OK, { pg, ca: CA });
  assert.equal(typeof visto.op.ssl, 'object');
  assert.equal(visto.op.ssl.rejectUnauthorized, true);
  assert.equal(visto.op.ssl.ca, CA);
  assert.equal(visto.op.ssl.servername, 'aws-0-sa-east-1.pooler.supabase.com');
  await b.cerrar();
});

test('Codex 5 (control): sin CA no se conecta (ni se llama a postgres.js); una CA que no es PEM, tampoco', async () => {
  const { pg, visto } = pgFalso();
  await assert.rejects(conectar(URL_OK, { pg, ca: undefined }).catch((e) => { throw e; }), /falta la CA/);
  assert.equal(visto.op, undefined);
  assert.throws(() => leerCa({ texto: '', archivo: '' }), /falta la CA/);
  assert.throws(() => leerCa({ texto: 'hola' }), /no es un certificado PEM/);
  assert.equal(leerCa({ texto: CA + CA }), CA + CA, 'una cadena de dos certificados vale');
});

test('Codex 5: con el postgres.js instalado (3.4.4), un ?sslmode=disable o =require en la URL no baja el TLS', async () => {
  const { default: postgres } = await import('postgres');
  for (const modo of ['disable', 'require', 'prefer']) {
    const sql = postgres(`${URL_OK}?sslmode=${modo}`, opcionesPg('aws-0-sa-east-1.pooler.supabase.com', CA)); // perezoso: no conecta
    assert.equal(typeof sql.options.ssl, 'object', modo);
    assert.equal(sql.options.ssl.rejectUnauthorized, true, modo);
    await sql.end({ timeout: 0 });
  }
});

test('Codex 5: entra como otro usuario → se aborta', async () => {
  const { pg } = pgFalso('postgres');
  await assert.rejects(conectar(URL_OK, { pg, ca: CA }), /no es el rol/);
});
