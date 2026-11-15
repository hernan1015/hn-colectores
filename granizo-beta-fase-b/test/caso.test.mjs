// node --test test/caso.test.mjs · un caso entero con la lib FALSA y el S3 FALSO: sin red, sin la lib privada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { correrCaso, verificarLib } from '../medir-caso.mjs';
import { s3Falso, ZONA_A } from './falsos.mjs';

const LIB_FALSA = process.env.GBF_LIB_FALSA || path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib-falsa');
const T_SALTO = Date.UTC(2026, 3, 1, 20, 30, 20);     // desde este scan, la celda A tiene 45 flashes (antes 20, ya con la pata RAYOS): salto
const flashes = (t) => Array.from({ length: t >= T_SALTO ? 45 : 20 }, (_, i) => [ZONA_A.lat + (i % 5) * 0.01, ZONA_A.lon + 0.01]).concat([[-29.0, -57.0]]);
const P = {
  confirmados: [{ episodio: '2026-04-01', eventos: [{ id: 'C-1', lat: -32.904, lon: -60.785, t: '2026-04-01T21:00Z', ini: '2026-04-01T21:00Z', fin: '2026-04-01T21:00Z', localidad: 'falsa' }] }],
  controles: [{ episodio: '2022-03-01', horas: [{ id: 'A-1', estacion: 'Río Cuarto Aero', lat: -33.085, lon: -64.261, ini: '2022-03-01T18:00Z', fin: '2022-03-01T19:00Z' }] }]
};
function dirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-caso-'));
  const h0 = path.join(base, 'h0'); fs.mkdirSync(h0);
  const dia = [{ hourly: { freezing_level_height: Array(24).fill(4000) } }];
  for (const d of ['2026-04-01', '2022-03-01']) fs.writeFileSync(path.join(h0, d + '.json'), JSON.stringify(dia));
  return { base, h0, salida: path.join(base, 'salida'), tmp: path.join(base, 'tmp-hn-goes') };
}
const leer = (f) => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('un caso: los dos modos, N(t) y N(t−10), el t−10 extra, y nada crudo en la salida', async () => {
  const d = dirs(), s3 = s3Falso({ flashesPorVentana: flashes });
  fs.mkdirSync(d.tmp); fs.writeFileSync(path.join(d.tmp, 'sobra.h5'), 'x');
  const r = await correrCaso({ P, caso: '2026-04-01', salida: d.salida, libDir: LIB_FALSA, verificar: false, fetchReal: s3.fetch, esperar: async () => {}, h0Dir: d.h0, tmpDir: d.tmp, log: () => {} });
  assert.deepEqual(fs.readdirSync(d.salida).sort(), ['flashes_cerca.jsonl.gz', 'instantes.jsonl.gz', 'plan.json', 'resumen.json']);
  const F = leer(path.join(d.salida, 'instantes.jsonl.gz'));
  // ventana real [19:00, 21:00]: 12 scans (19:00:20 … 20:50:20); −6 h: 12; más un t−10 por tramo
  assert.equal(F.filter((f) => !f.extra_t10).length, 24);
  assert.equal(F.filter((f) => f.extra_t10).length, 2);
  assert.equal(r.hechos, 26);
  for (const f of F) {
    assert.ok(f.como_19 && f.con_fase);
    assert.ok(f.como_19.faltantes.includes('actp_t'), 'como_19 sin fase');
    assert.equal(f.como_19.valido, true);
    assert.equal(f.con_fase.valido, true, 'con_fase completo');
    assert.equal(f.como_19.destacadas.length, 1);
    const A = f.con_fase.celdas.find((c) => c.lat === ZONA_A.lat);
    assert.ok(A && !A.incompleta, 'la celda A completa con la fase');
    assert.ok(f.con_fase.celdas.every((c) => c.patas >= 2 || c.patas_min >= 2), 'sólo se guardan las de ≥ 2 patas');
    assert.equal(A.n25_t, Date.parse(f.t) >= T_SALTO ? 45 : 20);
  }
  const salto = F.find((f) => f.t === new Date(T_SALTO).toISOString()).con_fase.celdas.find((c) => c.lat === ZONA_A.lat);
  assert.deepEqual([salto.n25_t, salto.n25_t10], [45, 20], 'el salto se ve con el barrido de 10 min antes');
  const primero = F.find((f) => !f.extra_t10);
  assert.ok(primero.con_fase.t10_disponible, 'el primero de la ventana tiene su t−10 (el instante extra)');
  assert.equal(F[0].con_fase.t10_disponible, false, 'el extra no tiene t−10');
  // de a poco y sin pedir dos veces lo mismo
  assert.ok(s3.max <= 4, 'simultáneos ' + s3.max);
  const repetidos = [...s3.porUrl.entries()].filter(([u, n]) => n > 1 && !u.includes('list-type'));
  assert.deepEqual(repetidos, [], 'el segundo modo y el t−20 salen del caché');
  assert.ok(r.tmp_borrados >= 1, 'vacía /tmp/hn-goes');
  const cerca = leer(path.join(d.salida, 'flashes_cerca.jsonl.gz'));
  assert.ok(cerca.every((x) => x.f.every(([la]) => la > -34)), 'el flash lejano (−29, −57) no se guarda');
  const res = JSON.parse(fs.readFileSync(path.join(d.salida, 'resumen.json'), 'utf8'));
  assert.equal(res.caso, '2026-04-01'); assert.equal(res.red.h0['2026-04-01'], 'colector');
  fs.rmSync(d.base, { recursive: true, force: true });
});

test('seco: lista S3 y arma el plan, sin bajar ningún archivo', async () => {
  const d = dirs(), s3 = s3Falso();
  const r = await correrCaso({ P, caso: '2026-04-01', seco: true, salida: d.salida, libDir: LIB_FALSA, verificar: false, fetchReal: s3.fetch, esperar: async () => {}, h0Dir: d.h0, log: () => {} });
  assert.equal(s3.objetos().length, 0);
  assert.equal(r.instantes_plan, 26);
  assert.deepEqual(fs.readdirSync(d.salida).sort(), ['plan.json', 'resumen.json']);
  fs.rmSync(d.base, { recursive: true, force: true });
});

test('control con fecha anterior al 7/4/2025: va a goes16', async () => {
  const d = dirs(), s3 = s3Falso();
  await correrCaso({ P, caso: '2022-03-01', salida: d.salida, libDir: LIB_FALSA, verificar: false, fetchReal: s3.fetch, esperar: async () => {}, h0Dir: d.h0, tmpDir: d.tmp, log: () => {} });
  assert.ok(s3.log.length > 0 && s3.log.every((u) => u.startsWith('https://noaa-goes16.')));
  fs.rmSync(d.base, { recursive: true, force: true });
});

test('presupuesto: corta limpio y dice desde dónde seguir; partes', async () => {
  const d = dirs(), s3 = s3Falso();
  let reloj = 0;
  const r = await correrCaso({ P, caso: '2026-04-01', salida: d.salida, libDir: LIB_FALSA, verificar: false, fetchReal: s3.fetch, esperar: async () => {}, h0Dir: d.h0, tmpDir: d.tmp, log: () => {},
    ahora: () => (reloj += 60000), presupuestoMs: 10 * 60000, topeEstimadoMs: 1e15 });
  assert.equal(r.cortado, 'presupuesto_5h30');
  assert.ok(r.hechos > 0 && r.hechos < 26);
  assert.match(r.siguiente_desde, /^2026-04-01T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(fs.existsSync(path.join(d.salida, 'instantes.jsonl.gz')), 'lo hecho queda');
  const r2 = await correrCaso({ P, caso: '2026-04-01', parte: '2/2', seco: true, salida: d.salida + '2', libDir: LIB_FALSA, verificar: false, fetchReal: s3.fetch, esperar: async () => {}, h0Dir: d.h0, log: () => {} });
  assert.equal(r2.instantes_plan, 13, 'la segunda mitad empieza en el t−10 de la ventana real: no hace falta otro');
  fs.rmSync(d.base, { recursive: true, force: true });
});

test('estimado > 5 h a los 10 instantes: corta y sugiere partes', async () => {
  const d = dirs(), s3 = s3Falso();
  let reloj = 0;
  const r = await correrCaso({ P, caso: '2026-04-01', salida: d.salida, libDir: LIB_FALSA, verificar: false, fetchReal: s3.fetch, esperar: async () => {}, h0Dir: d.h0, tmpDir: d.tmp, log: () => {},
    ahora: () => (reloj += 30 * 60000), presupuestoMs: 1e15 });
  assert.equal(r.cortado, 'estimado_mayor_a_5h');
  assert.equal(r.hechos, 10);
  assert.ok(r.partes_sugeridas >= 2);
  fs.rmSync(d.base, { recursive: true, force: true });
});

test('la lib se verifica por sha y un caso fuera de la partición no corre', async () => {
  assert.throws(() => verificarLib(LIB_FALSA), /la lib cambió/);
  await assert.rejects(() => correrCaso({ P, caso: '2026-04-02', salida: os.tmpdir(), libDir: LIB_FALSA, verificar: false }), /no está en la partición/);
  await assert.rejects(() => correrCaso({ P, caso: '../x', salida: os.tmpdir(), libDir: LIB_FALSA, verificar: false }), /caso inválido/);
});

test('N del salto: flashes a ≤ 25 km del centro de la celda (haversine)', async () => {
  const { cuentaCerca, dist } = await import('../lib/celdas.mjs');
  const a = { lat: -33, lon: -61 };
  const f = [[a.lat + 24 / 111.195, a.lon], [a.lat + 26 / 111.195, a.lon], [a.lat, a.lon + 0.2]];
  assert.ok(Math.abs(dist(a.lat, a.lon, f[0][0], f[0][1]) - 24) < 0.05);
  assert.equal(cuentaCerca(f, a.lat, a.lon), 2, '24 km y 18,7 km sí; 26 km no');
});
