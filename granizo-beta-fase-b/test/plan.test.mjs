// node --test test/plan.test.mjs · el plan de un caso, con la partición sellada de la 19 (copia en datos/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casos, lugares, leerListado, instantesDe, parte, desde, horasAListar, prefijoHora, H, K10 } from '../lib/plan.mjs';
import { leerParticion } from '../medir-caso.mjs';

const P = leerParticion();

test('los 29 casos del sello: 15 confirmados (con su ventana −6 h) y 14 controles', () => {
  const C = casos(P);
  assert.equal(C.length, 29);
  assert.equal(C.filter((c) => c.tipo === 'confirmado').length, 15);
  assert.equal(C.filter((c) => c.tipo === 'control').length, 14);
  for (const c of C.filter((x) => x.tipo === 'confirmado')) {
    const r = c.ventanas.filter((v) => v.rol === 'real'), m = c.ventanas.filter((v) => v.rol === 'menos6h');
    assert.equal(r.length, m.length);
    r.forEach((v, i) => { assert.equal(v.desde - m[i].desde, 6 * H); assert.equal(v.hasta - m[i].hasta, 6 * H); });
  }
  const ev = P.confirmados[0].eventos[0], v0 = C[0].ventanas[0];
  assert.equal(v0.desde, Date.parse(ev.ini) - 2 * H, 'ventana de la 19: [ini − 2 h, fin]');
  assert.equal(v0.hasta, Date.parse(ev.fin));
  assert.ok(C.filter((c) => c.tipo === 'control').every((c) => c.ventanas.every((v) => v.rol === 'real')), 'los controles no llevan −6 h');
});

test('satélite: goes16 antes del 7/4/2025, goes19 después (como la 19)', () => {
  const C = new Map(casos(P).map((c) => [c.caso, c]));
  assert.equal(C.get('2025-02-24').sat, 'goes16');
  assert.equal(C.get('2022-02-27').sat, 'goes16');
  assert.equal(C.get('2025-05-17').sat, 'goes19');
  assert.equal(C.get('2026-04-01').sat, 'goes19');
});

test('lugares: los 6 distintos de la muestra (5 aeródromos de los eventos y Río Cuarto Aero)', () => {
  assert.equal(lugares(P).length, 6);
});

test('listado de S3: clave, inicio, creación y LastModified', () => {
  const xml = '<ListBucketResult><Contents><Key>ABI-L2-ACHAF/2025/137/19/OR_ABI-L2-ACHAF-M6_G19_s20251371920213_e20251371929521_c20251371933183.nc</Key><LastModified>2025-05-17T19:33:30.000Z</LastModified><Size>1534000</Size></Contents></ListBucketResult>';
  const [s] = leerListado(xml);
  assert.equal(new Date(s.t).toISOString(), '2025-05-17T19:20:21.000Z');
  assert.equal(new Date(s.creado).toISOString(), '2025-05-17T19:33:18.000Z');
  assert.equal(s.publicado, '2025-05-17T19:33:30.000Z');
  assert.equal(s.bytes, 1534000);
  assert.equal(prefijoHora(Date.UTC(2025, 4, 17, 19)), 'ABI-L2-ACHAF/2025/137/19/');
});

test('instantes: los de la ventana más el t−10 del primero de cada tramo', () => {
  const c = { caso: 'x', ventanas: [{ id: 'a', rol: 'real', desde: Date.UTC(2026, 0, 1, 10), hasta: Date.UTC(2026, 0, 1, 11) }, { id: 'a', rol: 'menos6h', desde: Date.UTC(2026, 0, 1, 4), hasta: Date.UTC(2026, 0, 1, 4, 30) }] };
  const scans = []; for (let m = 0; m < 24 * 60; m += 10) { const t = Date.UTC(2026, 0, 1, 0, m, 20); scans.push({ clave: 'k' + m, t }); }
  const I = instantesDe(c, scans);
  const extra = I.filter((x) => x.extra_t10);
  assert.equal(extra.length, 2, 'uno por tramo');
  assert.equal(new Date(extra[0].t).toISOString(), '2026-01-01T03:50:20.000Z');
  assert.equal(new Date(extra[1].t).toISOString(), '2026-01-01T09:50:20.000Z');
  assert.equal(I.length - 2, 6 + 3, '10:00:20…10:50:20 y 04:00:20…04:20:20');
  for (let i = 1; i < I.length; i++) assert.ok(I[i].t > I[i - 1].t, 'en orden');
  const horas = horasAListar(c);
  assert.ok(horas.includes(Date.UTC(2026, 0, 1, 3)), 'lista la hora del t−10');
});

test('partes: contiguas, sin perder ninguno, y cada una con su t−10', () => {
  const inst = Array.from({ length: 25 }, (_, i) => ({ k10: 1000 + i, t: (1000 + i) * 600000, ventanas: ['real:a'], extra_t10: false }));
  const p = [1, 2, 3].map((i) => parte(inst, i, 3));
  const sinExtra = p.flatMap((x) => x.filter((y) => !y.extra_t10).map((y) => y.k10));
  assert.deepEqual(sinExtra, inst.map((x) => x.k10));
  assert.ok(p[1][0].extra_t10 && p[2][0].extra_t10 && !p[0][0].extra_t10);
  assert.throws(() => parte(inst, 4, 3));
  const d = desde(inst, new Date(1010 * 600000).toISOString());
  assert.equal(d[0].k10, 1009); assert.ok(d[0].extra_t10); assert.equal(d.length, 16);
  assert.equal(K10(Date.UTC(2026, 0, 1, 0, 10, 20)) - K10(Date.UTC(2026, 0, 1, 0, 0, 20)), 1);
});
