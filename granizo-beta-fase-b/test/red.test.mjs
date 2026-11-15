// node --test test/red.test.mjs · el fetch del job contra un S3 FALSO: de a poco, reintentos con espera, caché, modos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearRed, CONCURRENCIA, ESPERAS_MS } from '../lib/red.mjs';
import { s3Falso } from './falsos.mjs';

const B19 = 'https://noaa-goes19.s3.amazonaws.com/';
const sinEspera = (lista) => async (ms) => { lista.push(ms); };

test('como mucho 4 pedidos a la vez aunque la lib pida 24', async () => {
  const s3 = s3Falso();
  const red = crearRed({ fetchReal: s3.fetch, esperar: sinEspera([]) });
  await Promise.all(Array.from({ length: 24 }, (_, i) => red.fetch(B19 + 'GLM-L2-LCFA/2026/001/10/f' + i + '_s20260011000000.nc').then((r) => r.arrayBuffer())));
  assert.equal(CONCURRENCIA, 4);
  assert.ok(s3.max <= 4, 'máximo ' + s3.max);
  assert.ok(red.stats.max_a_la_vez <= 4);
  assert.equal(red.stats.pedidos, 24);
});

test('reintento con espera ante 503 y 429 (Retry-After), y se rinde a los 5', async () => {
  const esperas = [];
  const s3 = s3Falso({ falla: (u, n) => (u.includes('uno') && n <= 2 ? 503 : u.includes('dos') && n === 1 ? 429 : u.includes('siempre') ? 500 : null) });
  const red = crearRed({ fetchReal: s3.fetch, esperar: sinEspera(esperas) });
  assert.equal((await red.fetch(B19 + 'ABI-L2-ACHAF/uno')).status, 200);
  assert.deepEqual(esperas, [2000, 4000]);
  esperas.length = 0;
  assert.equal((await red.fetch(B19 + 'ABI-L2-ACHAF/dos')).status, 200);
  assert.deepEqual(esperas, [7000], 'el Retry-After de 7 s manda si es mayor');
  esperas.length = 0;
  assert.equal((await red.fetch(B19 + 'ABI-L2-ACHAF/siempre')).status, 500);
  assert.deepEqual(esperas, ESPERAS_MS, '5 esperas: 2, 4, 8, 16, 32 s');
  assert.equal(s3.porUrl.get(B19 + 'ABI-L2-ACHAF/siempre'), 6);
});

test('error de red: reintenta; un 404 no se reintenta', async () => {
  let n = 0;
  const red = crearRed({ fetchReal: async (u) => { n++; if (n < 3) throw new Error('ECONNRESET'); return new Response('x', { status: u.endsWith('no') ? 404 : 200 }); }, esperar: sinEspera([]) });
  assert.equal((await red.fetch(B19 + 'a')).status, 200);
  assert.equal(n, 3);
  n = 10;
  assert.equal((await red.fetch(B19 + 'no')).status, 404);
  assert.equal(n, 11);
});

test('goes16 antes del cambio; la fase da 404 en como_19 y se baja en con_fase', async () => {
  const s3 = s3Falso();
  const red = crearRed({ fetchReal: s3.fetch, esperar: sinEspera([]) });
  red.ponerSat('goes16');
  await red.fetch(B19 + 'ABI-L2-ACHAF/x');
  assert.ok(s3.log.at(-1).startsWith('https://noaa-goes16.s3.amazonaws.com/'));
  red.ponerModo('como_19');
  const n = s3.log.length;
  assert.equal((await red.fetch(B19 + '?list-type=2&prefix=ABI-L2-ACTPF%2F2025%2F001%2F10%2F')).status, 404);
  assert.equal((await red.fetch(B19 + 'ABI-L2-ACTPF/y')).status, 404);
  assert.equal(s3.log.length, n, 'en como_19 la fase ni se pide');
  red.ponerModo('con_fase');
  assert.equal((await red.fetch(B19 + 'ABI-L2-ACTPF/y')).status, 200);
  assert.throws(() => red.ponerModo('otro'));
});

test('caché en memoria: el segundo modo no vuelve a pedir; se va lo de hace más de 2 instantes', async () => {
  const s3 = s3Falso();
  const red = crearRed({ fetchReal: s3.fetch, esperar: sinEspera([]) });
  const u = B19 + 'ABI-L2-ACHAF/t';
  red.nuevoInstante();
  const a = new Uint8Array(await (await red.fetch(u)).arrayBuffer());
  const r2 = await red.fetch(u);
  assert.equal(r2.headers.get('content-length'), String(a.length), 'conserva el largo (la lib lo verifica)');
  assert.equal(s3.porUrl.get(u), 1);
  red.nuevoInstante(); red.nuevoInstante();
  await red.fetch(u);
  assert.equal(s3.porUrl.get(u), 1, 'el t−20 sale del caché dos instantes después');
  red.nuevoInstante(); red.nuevoInstante(); red.nuevoInstante();
  await red.fetch(u);
  assert.equal(s3.porUrl.get(u), 2, 'más viejo: se fue');
});

test('el H0: del archivo del colector; si falta, se baja una vez con pausa; ningún otro host', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-h0-'));
  const dia = (v) => [{ hourly: { freezing_level_height: Array.from({ length: 24 }, (_, h) => v + h) } }, { hourly: { freezing_level_height: Array.from({ length: 24 }, () => v) } }];
  fs.writeFileSync(path.join(dir, '2026-04-01.json'), JSON.stringify(dia(4000)));
  const pedidos = [], esperas = [];
  const red = crearRed({ fetchReal: async (u) => { pedidos.push(String(u)); return new Response(JSON.stringify(dia(3000)), { status: 200 }); }, esperar: sinEspera(esperas), ahora: () => 1e12,
    h0Dir: dir, h0Lats: [-38, -22], h0Lons: [-66] });
  const j = await (await red.fetch('https://api.open-meteo.com/v1/forecast?latitude=1&start_hour=2026-04-01T05:00&end_hour=2026-04-01T05:00')).json();
  assert.deepEqual(j.map((x) => x.hourly.freezing_level_height[0]), [4005, 4000]);
  assert.equal(pedidos.length, 0);
  await red.fetch('https://api.open-meteo.com/v1/forecast?start_hour=2024-12-05T23:00');
  await red.fetch('https://api.open-meteo.com/v1/forecast?start_hour=2024-12-05T22:00');
  assert.equal(pedidos.length, 1, 'un pedido por día');
  assert.ok(pedidos[0].startsWith('https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=-38,-22&longitude=-66,-66&hourly=freezing_level_height&start_date=2024-12-05&end_date=2024-12-05'));
  assert.deepEqual(red.stats.h0, { '2026-04-01': 'colector', '2024-12-05': 'bajado' });
  await assert.rejects(() => red.fetch('https://ssl.smn.gob.ar/CAP/AR.php'), /host no permitido/);
  fs.rmSync(dir, { recursive: true, force: true });
});
