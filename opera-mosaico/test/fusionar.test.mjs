// Tests del mosaico diario OPERA (opera-mosaico/fusionar.mjs): sin red ni llaves. «hoy» fijo.
// CONTROL NEGATIVO: OPERA_DIARIO_MUTAR=indice (el índice nuevo pisa la historia) o =conservar (se re-arma aunque falten
// pasadas) carga una copia rota del módulo → los tests de esa parte dan rojo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(AQUI, '..', 'fusionar.mjs');
const MUT = { indice: ["filter((p) => !S.has(p.fecha))", 'filter(() => false)'], conservar: ["return 'conservar';", "return 'rearmar';"] }[process.env.OPERA_DIARIO_MUTAR || ''];
let ruta = SRC;
if (MUT) {
  const s = fs.readFileSync(SRC, 'utf8'), m = s.split(MUT[0]).join(MUT[1]);
  assert.notEqual(m, s, 'la mutación tiene que tocar algo');
  ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opera_diario_')), 'fusionar.mjs'); fs.writeFileSync(ruta, m);
}
const F = await import(pathToFileURL(ruta).href);

// nombres reales (T20JPN 19/10 procesada el 05/11 y el 10/11; T19LGC 07/11 a las 09:58 y 22:59)
const V0511 = 'OPERA_L3_DSWx-S1_T20JPN_20261019T092139Z_20261105T050022Z_S1D_30_v1.0_B01_WTR.tif';
const V1011 = 'OPERA_L3_DSWx-S1_T20JPN_20261019T092139Z_20261110T000322Z_S1D_30_v1.0_B01_WTR.tif';
const LGC_M = 'OPERA_L3_DSWx-S1_T19LGC_20261107T095831Z_20261109T020638Z_S1C_30_v1.0_B01_WTR.tif';
const LGC_N = 'OPERA_L3_DSWx-S1_T19LGC_20261107T225926Z_20261108T075222Z_S1D_30_v1.0_B01_WTR.tif';

test('decidirFecha: la regla de opera_a_cog.py (más pasadas o versión nueva → rearmar; menos o más vieja → conservar)', () => {
  assert.equal(F.decidirFecha([V0511], [V1011]), 'rearmar');
  assert.equal(F.decidirFecha([V1011], [V0511]), 'conservar');
  assert.equal(F.decidirFecha([LGC_M, LGC_N], [LGC_M]), 'conservar');
  assert.equal(F.decidirFecha([LGC_M], [LGC_M, LGC_N]), 'rearmar');
  assert.equal(F.decidirFecha([LGC_N, LGC_M], [LGC_M, LGC_N]), 'igual');
  assert.equal(F.decidirFecha(null, [LGC_M]), 'rearmar');
});

test('fechasARearmar: fecha nueva, igual, con una pasada menos y sin «granulos» en R2', () => {
  const previo = { mosaicos: [{ fecha: '2026-10-19', granulos: [V0511] }, { fecha: '2026-11-07', granulos: [LGC_M, LGC_N] }, { fecha: '2026-11-06' }] };
  const cmr = F.porFecha(['https://x/a/' + V1011, LGC_M, 'OPERA_L3_DSWx-S1_T19LGC_20261106T095831Z_20261108T020638Z_S1C_30_v1.0_B01_WTR.tif',
    'OPERA_L3_DSWx-S1_T19LGC_20261108T095000Z_20261109T020638Z_S1C_30_v1.0_B01_WTR.tif']);
  assert.deepEqual(F.fechasARearmar(cmr, previo), { rearmar: ['2026-10-19', '2026-11-06', '2026-11-08'], igual: [], conservar: ['2026-11-07'] });
});

const sha = (c) => c.repeat(64), ok = { cog_valido: true, errores: [], avisos: [] };
const mos = (f, s, extra) => Object.assign({ r2: 'opera/cog/cuenca-del-plata/' + f + '.tif', fecha: f, sha256: sha(s), bytes: 10 }, ok, extra || {});
const tes = (f, t, s) => Object.assign({ r2: 'opera/cog/teselas/' + f + '/' + t + '.tif', fecha: f, tesela: t, sha256: sha(s), bytes: 5 }, ok);
const PREVIO = { doi: '10.5067/OPDSWS1-L3V1', prefijo_r2: 'opera/cog', ventana: ['2026-07-27', '2026-11-09'],
  teselas: [tes('2026-11-07', 'T19LGC', 'a'), tes('2026-11-08', 'T19LGC', 'b'), tes('2026-11-09', 'T19LGC', 'c')],
  mosaicos: [mos('2026-11-07', '1'), mos('2026-11-08', '2'), mos('2026-11-09', '3', { provisional: true })] };

test('fusionarCatalogo: re-armado el 09 y nuevo el 10 (hoy 12/11) → el 09 deja de ser provisional y es latest; la historia queda', () => {
  const nuevo = { ventana: ['2026-11-09', '2026-11-10'], generado_utc: '2026-11-12T04:20:00Z',
    teselas: [tes('2026-11-09', 'T19LGC', 'd'), tes('2026-11-10', 'T19LGC', 'e')], mosaicos: [mos('2026-11-09', '4'), mos('2026-11-10', '5')] };
  const R = F.fusionarCatalogo(PREVIO, nuevo, '2026-11-12');
  assert.deepEqual(R.completo.mosaicos.map((m) => [m.fecha, m.sha256[0], m.provisional]), [['2026-11-07', '1', false], ['2026-11-08', '2', false], ['2026-11-09', '4', false], ['2026-11-10', '5', true]]);
  assert.deepEqual(R.completo.teselas.map((t) => t.sha256[0]), ['a', 'b', 'd', 'e']);
  assert.deepEqual(R.completo.ventana, ['2026-07-27', '2026-11-10']);
  assert.equal(R.latest.es, 'opera/cog/cuenca-del-plata/2026-11-09.tif'); assert.equal(R.latest.sha256, sha('4')); assert.equal(R.latestNuevo, true);
  assert.deepEqual(R.subida.mosaicos.map((m) => m.fecha), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(R.subida.ventana, ['2026-11-09', '2026-11-10']);
});

test('fusionarCatalogo: sólo el 10 nuevo (hoy 12/11) → latest es el 09 de R2, que va en la subida para que revisar() pase', () => {
  const nuevo = { ventana: ['2026-11-10', '2026-11-10'], teselas: [tes('2026-11-10', 'T19LGC', 'e')], mosaicos: [mos('2026-11-10', '5')] };
  const R = F.fusionarCatalogo(PREVIO, nuevo, '2026-11-12');
  assert.equal(R.latest.fecha, '2026-11-09'); assert.equal(R.latest.sha256, sha('3')); assert.equal(R.latestNuevo, false);
  assert.deepEqual(R.subida.mosaicos.map((m) => m.fecha), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(R.subida.teselas.map((t) => t.fecha), ['2026-11-10']);
  assert.equal(R.completo.mosaicos.length, 4);
});

test('fusionarIndice: las fechas de hoy salen del nuevo; las demás quedan como estaban (cobertura medida), sin pisar', () => {
  const previo = { desde: '2026-07-27', hasta: '2026-11-09', fuente: 'x', zonas: {
    corrientes: [{ fecha: '2026-11-01', hora_utc: '09:12', cobertura_pct: 43, cobertura: 'medida' }, { fecha: '2026-11-06', hora_utc: '09:20', cobertura_pct: 100, cobertura: 'medida' }] } };
  const nuevo = { desde: '2026-07-27', hasta: '2026-11-10', generado_utc: '2026-11-12T04:30:00Z', zonas: {
    corrientes: [{ fecha: '2026-11-01', hora_utc: '09:12', cobertura_pct: 61, cobertura: 'cajas' }, { fecha: '2026-11-06', hora_utc: '09:20', cobertura_pct: 80, cobertura: 'cajas' },
      { fecha: '2026-11-10', hora_utc: '09:12', cobertura_pct: 40, cobertura: 'medida' }],
    goya: [{ fecha: '2026-11-10', hora_utc: '09:12', cobertura_pct: 90, cobertura: 'medida' }] } };
  const I = F.fusionarIndice(previo, nuevo, ['2026-11-10']);
  assert.deepEqual(I.zonas.corrientes.map((p) => [p.fecha, p.cobertura_pct, p.cobertura]), [['2026-11-01', 43, 'medida'], ['2026-11-06', 100, 'medida'], ['2026-11-10', 40, 'medida']]);
  assert.deepEqual(I.zonas.goya.map((p) => p.fecha), ['2026-11-10']);
  assert.equal(I.desde, '2026-07-27'); assert.equal(I.hasta, '2026-11-10');
});

test('el CLI «decidir» escribe las fechas y sólo las URL de esas fechas (sin red)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opera_diario_cli_'));
  fs.writeFileSync(path.join(d, 'urls.txt'), ['https://archive.podaac.earthdata.nasa.gov/x/' + LGC_M, 'https://archive.podaac.earthdata.nasa.gov/x/' + LGC_N,
    'https://archive.podaac.earthdata.nasa.gov/x/OPERA_L3_DSWx-S1_T19LGC_20261108T095000Z_20261109T020638Z_S1C_30_v1.0_B01_WTR.tif'].join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'previo.json'), JSON.stringify({ mosaicos: [{ fecha: '2026-11-07', granulos: [LGC_M, LGC_N] }] }));
  const { execFileSync } = await import('node:child_process');
  const out = path.join(d, 'gh.txt');
  execFileSync(process.execPath, [ruta, 'decidir', '--cmr', path.join(d, 'urls.txt'), '--previo', path.join(d, 'previo.json'), '--salida', path.join(d, 's')], { env: Object.assign({}, process.env, { GITHUB_OUTPUT: out }) });
  assert.equal(fs.readFileSync(path.join(d, 's', 'fechas.txt'), 'utf8'), '2026-11-08\n');
  assert.match(fs.readFileSync(path.join(d, 's', 'urls-a-bajar.txt'), 'utf8'), /T19LGC_20261108T095000Z/);
  assert.equal(fs.readFileSync(path.join(d, 's', 'urls-a-bajar.txt'), 'utf8').trim().split('\n').length, 1);
  assert.match(fs.readFileSync(out, 'utf8'), /hay=si\nhasta=2026-11-08\ndias=0\ngranulos=1/);
});
