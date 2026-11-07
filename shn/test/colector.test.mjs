import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contexto, shnFalso, svgMuestra, leer, carpetaTemporal, AHORA } from './ayuda.mjs';
import { correr, parseSvg, parseHorario, tomarCandado, soltarCandado, K } from '../lib/colector.mjs';

const medidas = (csv) => [...parseHorario(csv).entries()].filter(([, v]) => v.med != null).map(([h]) => h);

test('horario: dos corridas seguidas no duplican horas (idempotencia)', async () => {
  const dir = carpetaTemporal();
  const a = contexto({ dir });
  assert.equal(await correr(a, 'horario', { estacion: 'SFER', maxatras: 12 }), 0);
  const csv1 = leer(dir, K.horario('SFER'));
  const h1 = medidas(csv1);
  assert.equal(h1.length, 13);
  assert.equal(h1.at(-1), '2026-11-06T14:45');
  assert.equal(new Set(h1).size, h1.length);

  const b = contexto({ dir });
  assert.equal(await correr(b, 'horario', { estacion: 'SFER', maxatras: 12 }), 0);
  assert.equal(b.fetchFn.pedidos.length, 1, 'al día: un solo pedido');
  assert.equal(leer(dir, K.horario('SFER')), csv1, 'el CSV queda igual');
  // el crudo guarda un renglón por pedido (dos corridas = dos renglones)
  assert.equal(leer(dir, 'crudos/horario/SFER/202611.jsonl').trim().split('\n').length, 2);
  const est = JSON.parse(leer(dir, K.estado));
  assert.equal(est.ultima.SFER, '2026-11-06T14:45');
});

test('horario: el estado sale del almacén y rellena el hueco desde la última medida', async () => {
  const dir = carpetaTemporal();
  await correr(contexto({ dir }), 'horario', { estacion: 'SFER', maxatras: 12 });
  // 30 h después: hay que retroceder 3 ventanas (13 h c/u) para cubrir el hueco
  const c = contexto({ dir, ahora: AHORA + 30 * 3600e3 });
  assert.equal(await correr(c, 'horario', { estacion: 'SFER' }), 0);
  assert.equal(c.fetchFn.pedidos.length, 3);
  const h = medidas(leer(dir, K.horario('SFER')));
  assert.equal(new Set(h).size, h.length);
  for (let i = 1; i < h.length; i++) assert.equal(Date.parse(h[i] + ':00Z') - Date.parse(h[i - 1] + ':00Z'), 3600e3, `hueco entre ${h[i - 1]} y ${h[i]}`);
  assert.equal(h.at(-1), '2026-11-07T20:45');
});

test('candado: una segunda corrida no entra; vencido, se toma', async () => {
  const dir = carpetaTemporal();
  const a = contexto({ dir });
  assert.equal((await tomarCandado(a)).ok, true);
  const b = contexto({ dir });
  assert.equal(await correr(b, 'horario', { estacion: 'SFER' }), 3);
  assert.equal(b.fetchFn.pedidos.length, 0, 'con el candado tomado no se pide nada');
  // tres horas después el candado (vence a las 2 h) ya no vale
  const c = contexto({ dir, ahora: AHORA + 3 * 3600e3 });
  const r = await tomarCandado(c);
  assert.equal(r.ok, true); assert.equal(r.vencido, true);
  await soltarCandado(a); // el dueño viejo no puede soltar el candado nuevo
  assert.ok(leer(dir, K.candado), 'el candado nuevo sigue');
  await soltarCandado(c);
  assert.equal(leer(dir, K.candado), null);
});

test('candado: se suelta al terminar, también si hubo error', async () => {
  const dir = carpetaTemporal();
  await correr(contexto({ dir, fetchFn: shnFalso({ guion: () => 500 }) }), 'modelo');
  assert.equal(leer(dir, K.candado), null);
});

test('429: alerta en alertas.txt, un solo reintento y corte; las corridas siguientes no piden nada', async () => {
  const dir = carpetaTemporal();
  const f = shnFalso({ guion: () => 429 });
  const a = contexto({ dir, fetchFn: f });
  assert.equal(await correr(a, 'horario'), 1);
  assert.equal(f.pedidos.length, 2, 'un pedido + un reintento, sin bucle ni otras estaciones');
  assert.match(leer(dir, K.alertas), /BLOQUEO: el SHN contestó HTTP 429/);
  assert.ok(JSON.parse(leer(dir, K.bloqueo)).hasta);
  assert.equal(leer(dir, K.candado), null, 'el candado se suelta');
  assert.match(leer(dir, K.log), /429 en https/);

  const f2 = shnFalso();
  const b = contexto({ dir, fetchFn: f2, ahora: AHORA + 6 * 3600e3 });
  assert.equal(await correr(b, 'horario'), 0);
  assert.equal(f2.pedidos.length, 0, 'con bloqueo vigente no se pide nada');
  assert.equal(leer(dir, K.alertas).trim().split('\n').length, 1, 'no repite la alerta');

  const c = contexto({ dir, fetchFn: f2, ahora: AHORA + 6 * 3600e3 });
  assert.equal(await correr(c, 'horario', { estacion: 'SFER', maxatras: 12, forzar: true }), 0);
  assert.equal(f2.pedidos.length, 1, 'forzado a mano sí pide');
  assert.equal(leer(dir, K.bloqueo), null, 'forzar borra el bloqueo');
});

test('429 aislado: el único reintento alcanza y no queda alerta', async () => {
  const dir = carpetaTemporal();
  const f = shnFalso({ guion: (url, n) => (n === 1 ? 429 : null) });
  const a = contexto({ dir, fetchFn: f });
  assert.equal(await correr(a, 'horario', { estacion: 'SFER', maxatras: 12 }), 0);
  assert.equal(f.pedidos.length, 2);
  assert.equal(leer(dir, K.alertas), null);
  assert.equal(leer(dir, K.bloqueo), null);
});

test('403 también corta la corrida (bloqueo de IP)', async () => {
  const dir = carpetaTemporal();
  const f = shnFalso({ guion: () => 403 });
  assert.equal(await correr(contexto({ dir, fetchFn: f }), 'modelo'), 1);
  assert.equal(f.pedidos.length, 2);
  assert.match(leer(dir, K.alertas), /HTTP 403/);
});

test('error común (500): un reintento y sigue con la próxima estación', async () => {
  const dir = carpetaTemporal();
  const f = shnFalso({ guion: (url) => (url.includes('/SFER/') ? 500 : null) });
  assert.equal(await correr(contexto({ dir, fetchFn: f }), 'horario', { estacion: 'SFER,MAGA', maxatras: 12 }), 0);
  assert.equal(f.pedidos.filter((p) => p.url.includes('/SFER/')).length, 2);
  assert.ok(leer(dir, K.horario('MAGA')));
  assert.match(leer(dir, K.alertas), /horario SFER: no se pudo bajar/);
});

test('pausa base de 6 s entre pedidos', async () => {
  const dir = carpetaTemporal();
  const marcas = [];
  const base = shnFalso();
  let ctx;
  const f = async (u, o) => { marcas.push(ctx.reloj.t); return base(u, o); };
  ctx = contexto({ dir, fetchFn: f });
  await correr(ctx, 'modelo');
  assert.equal(marcas.length, 5);
  for (let i = 1; i < marcas.length; i++) assert.ok(marcas[i] - marcas[i - 1] >= 6000, `pausa ${marcas[i] - marcas[i - 1]} ms`);
});

test('parseSvg: 97 valores y 97 etiquetas', () => {
  const { valores, etiquetas } = parseSvg(svgMuestra(97));
  assert.equal(valores.length, 97);
  assert.equal(etiquetas.length, 97);
  assert.equal(valores[0], '1.00');
  assert.equal(etiquetas[0], '01-11| 00:00');
});

test('modelo: guarda 5 puertos con 97 valores y no duplica la misma corrida', async () => {
  const dir = carpetaTemporal();
  await correr(contexto({ dir }), 'modelo');
  const svgs = fs.readdirSync(path.join(dir, 'modelo', 'svg'));
  assert.equal(svgs.length, 5);
  assert.ok(svgs.includes('Palermo_20261106_1702Z.svg'));
  const v = JSON.parse(leer(dir, 'modelo/valores/Palermo.jsonl').trim());
  assert.equal(v.n, 97); assert.equal(v.valores.length, 97); assert.equal(v.valores[96], 1.96);
  await correr(contexto({ dir }), 'modelo');
  assert.equal(leer(dir, 'modelo/valores/Palermo.jsonl').trim().split('\n').length, 1);
  assert.equal(leer(dir, K.alertas), null);
});

test('modelo: un SVG con otra cantidad de valores deja alerta', async () => {
  const dir = carpetaTemporal();
  await correr(contexto({ dir, fetchFn: shnFalso({ svgN: 96 }) }), 'modelo');
  assert.match(leer(dir, K.alertas), /trae 96 valores en vez de 97/);
});

test('pronóstico: el índice marca si el texto cambió', async () => {
  const dir = carpetaTemporal();
  await correr(contexto({ dir }), 'pronostico');
  await correr(contexto({ dir, ahora: AHORA + 8 * 3600e3 }), 'pronostico');
  const filas = leer(dir, 'pronostico/indice.csv').trim().split('\n').slice(1).map((l) => l.split(';'));
  assert.equal(filas.length, 4);
  assert.deepEqual(filas.map((f) => f[4]), ['si', 'si', 'no', 'no']);
});

test('referencia: registra nivel medio y plano de las 7 estaciones', async () => {
  const dir = carpetaTemporal();
  await correr(contexto({ dir }), 'referencia');
  const filas = leer(dir, 'referencia/nivel_cero.csv').trim().split('\n').slice(1);
  assert.equal(filas.length, 7);
  assert.equal(filas[0].split(';')[3], '0.50');
  assert.equal(filas[0].split(';')[4], '0.50');
});

test('chequeo: detecta horas faltantes sin pedir nada al SHN y no repite la alerta', async () => {
  const dir = carpetaTemporal();
  await correr(contexto({ dir }), 'horario', { estacion: 'SFER', maxatras: 12 });
  const c = contexto({ dir, ahora: AHORA + 24 * 3600e3 });
  await correr(c, 'chequeo');
  assert.equal(c.fetchFn.pedidos.length, 0);
  const al = leer(dir, K.alertas);
  assert.match(al, /SFER San Fernando: sin medidas desde 2026-11-06T14:45/);
  assert.match(al, /SFER San Fernando 2026-11-06: faltan/);
  await correr(contexto({ dir, ahora: AHORA + 24 * 3600e3 }), 'chequeo');
  assert.equal(leer(dir, K.alertas), al);
});

test('la consola (pública en Actions) no muestra valores del SHN', async () => {
  const dir = carpetaTemporal();
  const salida = [];
  const s = (m) => salida.push(m);
  await correr(contexto({ dir, salida: s }), 'horario', { estacion: 'SFER', maxatras: 12 });
  await correr(contexto({ dir, salida: s }), 'modelo');
  await correr(contexto({ dir, salida: s }), 'referencia');
  const todo = salida.join('\n');
  assert.doesNotMatch(todo, /\d\.\d\d/, 'ninguna altura en la consola');
  assert.doesNotMatch(todo, /14:45/, 'ni horas de medida');
});
