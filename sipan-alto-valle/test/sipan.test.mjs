// node --test sipan-alto-valle/test/sipan.test.mjs   (sin red ni base)
// Con los fixtures reales: SIPAN_FIXTURES=<carpeta con 10_20260214.txt, 40_20200125.txt, 45_20201009.txt>
// Cada bloque trae su control negativo: el mismo caso con la condición al revés tiene que dar lo contrario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leerDavis, numero, fechaHora } from '../lib/davis.mjs';
import { controlar, resumenDia, resumenNoche, unir, fechasDe } from '../lib/resumen.mjs';
import { metricas, minimasDiarias, localidadMasCercana } from '../lib/medicion.mjs';
import { almacenCarpeta } from '../lib/almacen.mjs';
import { idsDePagina, ESTACIONES } from '../lib/estaciones.mjs';
import { crearPedidor, procesarEstacion, correr, filaObs } from '../sipan.mjs';
import { armarPares } from '../medir.mjs';
import { armar, serie, ENC_40 } from './sintetico.mjs';

const E10 = ESTACIONES.find((e) => e.id === '10');
const DIR = process.env.SIPAN_FIXTURES;

// ───────────── 1 · fixtures reales (si están) ─────────────
test('fixtures reales: los tres formatos se leen enteros, sin filas descartadas', { skip: !DIR && 'sin SIPAN_FIXTURES' }, () => {
  const casos = [['10_20260214.txt', 40, 185, '2026-02-13T00:10'], ['40_20200125.txt', 33, 269, '2020-01-23T00:10'], ['45_20201009.txt', 40, 203, '2020-10-08T00:10']];
  for (const [f, ncol, nreg, primero] of casos) {
    const p = leerDavis(fs.readFileSync(path.join(DIR, f), 'latin1'));
    assert.equal(p.ok, true, f);
    assert.equal(p.columnas.length, ncol, f);
    assert.equal(p.desconocidas.length, 0, f + ': ' + p.desconocidas);
    assert.equal(p.registros.length, nreg, f);
    assert.equal(p.descartadas.length, 0, f);
    assert.equal(p.registros[0].local, primero, f);
  }
  /* el reloj de 12 h («12:10a», «8:50p») del 40 */
  const p40 = leerDavis(fs.readFileSync(path.join(DIR, '40_20200125.txt'), 'latin1'));
  assert.equal(p40.registros.at(-1).local, '2020-01-24T20:50');
  /* la noche del 9/10/2020 en Cinco Saltos está completa (90 de 90) */
  const p45 = leerDavis(fs.readFileSync(path.join(DIR, '45_20201009.txt'), 'latin1'));
  const n = resumenNoche(controlar(p45.registros), '2020-10-09');
  assert.equal(n.registros_validos, 90);
  assert.ok(n.tmin_noche_c != null);
});
test('fixtures reales · control negativo: con el encabezado de otra estación, no se carga', { skip: !DIR && 'sin SIPAN_FIXTURES' }, () => {
  const t40 = fs.readFileSync(path.join(DIR, '40_20200125.txt'), 'latin1').replace(/\r/g, '').split('\n');
  const t10 = fs.readFileSync(path.join(DIR, '10_20260214.txt'), 'latin1').replace(/\r/g, '').split('\n');
  const mezclado = [t10[0], t10[1], ...t40.slice(2)].join('\n');   // 40 columnas en el encabezado, 33 en las filas
  const p = leerDavis(mezclado);
  assert.equal(p.ok, false);
  assert.equal(p.motivo, 'filas_rotas');
});

// ───────────── 2 · formato ─────────────
test('lee el formato de 40 columnas (24 h) y el de 33 (12 h a/p)', () => {
  const rs = serie('2026-09-10T00:10', '2026-09-10T02:00', (i) => 5 - i * 0.1);
  for (const [formato, doce] of [[40, false], [33, true]]) {
    const p = leerDavis(armar(rs, { formato, doce }));
    assert.equal(p.ok, true);
    assert.equal(p.registros.length, rs.length);
    assert.equal(p.registros[0].local, '2026-09-10T00:10');
    assert.equal(p.registros[0].v.temp, 5);
  }
  assert.deepEqual(fechaHora('23/01/20', '12:10a'), { fecha: '2020-01-23', hm: '00:10' });
  assert.deepEqual(fechaHora('23/01/20', '12:10p'), { fecha: '2020-01-23', hm: '12:10' });
  assert.deepEqual(fechaHora('8/10/20', '8:50p'), { fecha: '2020-10-08', hm: '20:50' });
  assert.equal(fechaHora('31/02/26', '0:10'), null);
});

test('formato cambiado (falta una columna obligatoria): NO se carga y avisa', async () => {
  const txt = armar(serie('2026-09-10T00:10', '2026-09-10T06:00'));
  const roto = txt.replace('  Date    Time     Out', '  Date    Time    Tout');
  const x = await procesarEstacion({ e: E10, texto: roto });
  assert.equal(x.estado, 'formato');
  assert.equal(x.aviso.tipo, 'formato_no_se_entiende');
  assert.equal(x.filas, undefined);
  /* control negativo: el mismo archivo sin tocar se carga */
  const ok = await procesarEstacion({ e: E10, texto: txt });
  assert.equal(ok.estado, 'ok');
  assert.ok(ok.filas.length > 0);
});

test('formato cambiado (otra firma que la guardada): NO se carga hasta que se acepta', async () => {
  const txt40 = armar(serie('2026-09-10T00:10', '2026-09-10T06:00'), { formato: 40 });
  const txt33 = armar(serie('2026-09-10T00:10', '2026-09-10T06:00'), { formato: 33 });
  const firma40 = leerDavis(txt40).firma, firma33 = leerDavis(txt33).firma;
  assert.notEqual(firma40, firma33);
  const x = await procesarEstacion({ e: E10, texto: txt33, meta: { formato_firma: firma40 } });
  assert.equal(x.estado, 'formato');
  assert.equal(x.aviso.tipo, 'formato_cambiado');
  /* aceptado a mano (la firma exacta): se carga */
  const y = await procesarEstacion({ e: E10, texto: txt33, meta: { formato_firma: firma40 }, aceptar: { 10: firma33 } });
  assert.equal(y.estado, 'ok');
  /* control negativo: con la misma firma que la guardada, se carga sin aceptar nada */
  const z = await procesarEstacion({ e: E10, texto: txt40, meta: { formato_firma: firma40 } });
  assert.equal(z.estado, 'ok');
});

test('unidades: en °F o inHg es otro formato y no se carga', () => {
  const f = leerDavis(armar(serie('2026-01-10T00:10', '2026-01-10T06:00', () => 86)));
  assert.equal(f.ok, false);
  assert.equal(f.motivo, 'unidades');
  const inhg = leerDavis(armar(serie('2026-01-10T00:10', '2026-01-10T06:00', () => 20)).replace(/1012\.0/g, '29.90'));
  assert.equal(inhg.motivo, 'unidades');
  /* control negativo */
  assert.equal(leerDavis(armar(serie('2026-01-10T00:10', '2026-01-10T06:00', () => 20))).ok, true);
});

test('una página HTML o un archivo vacío no se cargan', () => {
  assert.equal(leerDavis('<html><body>mantenimiento</body></html>').ok, false);
  assert.equal(leerDavis('').ok, false);
});

// ───────────── 3 · huecos ≠ 0 ─────────────
test('huecos: «---» es null y el día sin lluvia medida tiene lluvia NULL, nunca 0', () => {
  assert.equal(numero('---'), null);
  assert.equal(numero('------'), null);
  assert.equal(numero('0.00'), 0);           // control negativo: un 0 medido sigue siendo 0
  const rs = serie('2026-09-10T00:10', '2026-09-11T00:00', () => 4, () => ({ lluvia: null }));
  const p = leerDavis(armar(rs));
  const d = resumenDia(controlar(p.registros), '2026-09-10');
  assert.equal(d.lluvia_mm, null);
  assert.equal(d.horas_validas, 0);
  /* control negativo: con la lluvia medida en 0, es 0 y las 24 horas son válidas */
  const rs0 = serie('2026-09-10T00:10', '2026-09-11T00:00', () => 4, () => ({ lluvia: 0 }));
  const d0 = resumenDia(controlar(leerDavis(armar(rs0)).registros), '2026-09-10');
  assert.equal(d0.lluvia_mm, 0);
  assert.equal(d0.horas_validas, 24);
});

test('huecos: sin temperatura en toda la noche, la mínima de la noche es null (no 0)', () => {
  const rs = serie('2026-09-09T18:10', '2026-09-10T09:00', () => null);
  const n = resumenNoche(controlar(leerDavis(armar(rs)).registros), '2026-09-10');
  assert.equal(n.tmin_noche_c, null);
  assert.equal(n.registros_validos, 0);
  /* control negativo: con temperatura, hay mínima */
  const n2 = resumenNoche(controlar(leerDavis(armar(serie('2026-09-09T18:10', '2026-09-10T09:00', () => 3))).registros), '2026-09-10');
  assert.equal(n2.tmin_noche_c, 3);
  assert.equal(n2.registros_validos, 90);
});

test('la fila de la base: un día con huecos no pisa uno más completo', () => {
  const ctrl = controlar(leerDavis(armar(serie('2026-09-10T00:10', '2026-09-10T12:00', () => 4))).registros);
  const dia = resumenDia(ctrl, '2026-09-10'), noche = resumenNoche(ctrl, '2026-09-10');
  const viejo = { registros_validos: 144, tmin_c: -1.5, tmax_c: 20, lluvia_mm: 0, horas_validas: 24, eto_mm: 3, registros_esperados: 144, noche_registros: 10, tmin_noche_c: 9, crudo: {} };
  const f = filaObs({ id: '10', fecha: '2026-09-10', dia, noche, firma: 'x', viejo, intervalo: 10 });
  assert.equal(f.tmin_c, -1.5);                 // el viejo tenía el día completo
  assert.equal(f.tmin_noche_c, 4);              // la noche nueva tiene más registros que la vieja
  /* control negativo: sin fila vieja, va lo nuevo */
  assert.equal(filaObs({ id: '10', fecha: '2026-09-10', dia, noche, firma: 'x', viejo: null, intervalo: 10 }).tmin_c, 4);
});

// ───────────── 4 · dedup por estación y hora ─────────────
test('dedup: dos bajadas que se pisan dejan un solo registro por hora', () => {
  const a = leerDavis(armar(serie('2026-09-10T00:10', '2026-09-11T16:00'))).registros;
  const b = leerDavis(armar(serie('2026-09-11T04:10', '2026-09-12T22:00'))).registros;
  const u = unir(a, b);
  const horas = new Set(u.map((r) => r.local));
  assert.equal(u.length, horas.size);
  /* control negativo: sin unir, los 12 h que se pisan aparecen dos veces */
  assert.equal(a.length + b.length - u.length, 6 * 12);
});

test('dedup con lo guardado (R2): la segunda bajada solapada no duplica y completa el día', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipan-'));
  const almacen = almacenCarpeta(dir);
  const p1 = leerDavis(armar(serie('2026-09-10T00:10', '2026-09-10T16:00', () => 6)));
  const x1 = await procesarEstacion({ e: E10, texto: armar(serie('2026-09-10T00:10', '2026-09-10T16:00', () => 6)), almacen });
  /* se guardan los crudos como lo hace correr() */
  const zlib = await import('node:zlib');
  fs.mkdirSync(path.join(dir, 'sipan-alto-valle/10/2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sipan-alto-valle/10/2026/2026-09-10.json.gz'), zlib.gzipSync(JSON.stringify({ registros: x1.todos.map((r) => ({ local: r.local, v: r.v, texto: r.texto })) })));
  const x2 = await procesarEstacion({ e: E10, texto: armar(serie('2026-09-10T08:10', '2026-09-11T00:00', () => 6)), almacen });
  const dia = x2.filas.find((f) => f.fecha === '2026-09-10');
  assert.equal(dia.registros_validos, 144);                         // el día quedó completo, sin contar dos veces
  assert.equal(new Set(x2.todos.map((r) => r.local)).size, x2.todos.length);
  /* control negativo: sin lo guardado, el día queda con lo de la segunda bajada sola */
  const x3 = await procesarEstacion({ e: E10, texto: armar(serie('2026-09-10T08:10', '2026-09-11T00:00', () => 6)) });
  assert.equal(x3.filas.find((f) => f.fecha === '2026-09-10').registros_validos, 96);
  assert.ok(p1.ok);
});

// ───────────── 5 · la mínima de la noche cruza la medianoche ─────────────
test('la noche: la mínima de las 23:40 cuenta para la mañana SIGUIENTE, con su hora', () => {
  /* 17:50 hace −5 (antes de las 18: fuera), a las 23:40 −1,2, a las 9:10 −4 (después de las 9: fuera) */
  const rs = serie('2026-09-09T12:00', '2026-09-10T12:00', (i, local) => (local === '2026-09-09T17:50' ? [-5] : local === '2026-09-09T23:40' ? [-1.2] : local === '2026-09-10T09:10' ? [-4] : 2));
  const ctrl = controlar(leerDavis(armar(rs)).registros);
  const n = resumenNoche(ctrl, '2026-09-10');
  assert.equal(n.tmin_noche_c, -1.2);
  assert.equal(n.tmin_noche_local, '2026-09-09T23:40');
  assert.equal(n.tmin_noche_en, '2026-09-10T02:40:00.000Z');       // UTC−3
  assert.equal(n.registros_esperados, 90);
  /* control negativo: el DÍA calendario 10/09 (0-24 h) no ve la helada de las 23:40 del 9 y sí la de las 9:10 */
  const d = resumenDia(ctrl, '2026-09-10');
  assert.equal(d.tmin_c, -4);
  assert.equal(resumenDia(ctrl, '2026-09-09').tmin_c, -5);
  /* y las fechas que toca el archivo incluyen la noche del 10 */
  assert.ok(fechasDe(ctrl).noches.includes('2026-09-10'));
});

test('la noche: el registro de las 18:00 es de la tarde (fuera) y el de las 9:00 es de la noche (dentro)', () => {
  const rs = serie('2026-09-09T17:00', '2026-09-10T10:00', (i, l) => (l === '2026-09-09T18:00' ? [-3] : l === '2026-09-10T09:00' ? [-2] : 3));
  const n = resumenNoche(controlar(leerDavis(armar(rs)).registros), '2026-09-10');
  assert.equal(n.tmin_noche_c, -2);
  /* control negativo: corriendo la ventana una hora antes, el de las 18:00 entra */
  const n2 = resumenNoche(controlar(leerDavis(armar(rs)).registros), '2026-09-10', 10, { desde: '17:00' });
  assert.equal(n2.tmin_noche_c, -3);
});

// ───────────── 6 · valores imposibles ─────────────
test('imposibles: se marcan y no entran en la mínima', () => {
  const rs = serie('2026-09-09T18:10', '2026-09-10T09:00', (i) => (i >= 30 && i < 34 ? [-45] : i === 50 ? 99 : 2));   // 4 seguidos: no es un pico aislado
  const ctrl = controlar(leerDavis(armar(rs)).registros);
  assert.ok(ctrl[30].marcas.includes('temp_fuera_de_rango'));
  assert.ok(ctrl[50].marcas.includes('temp_fuera_de_rango'));
  const n = resumenNoche(ctrl, '2026-09-10');
  assert.equal(n.tmin_noche_c, 2);
  assert.equal(n.registros_validos, 85);
  /* control negativo: una bajada real de 6 °C repartida en 1 h no se marca */
  const ok = controlar(leerDavis(armar(serie('2026-09-09T18:10', '2026-09-09T20:00', (i) => 8 - Math.min(i, 6)))).registros);
  assert.equal(ok.filter((r) => r.marcas.length).length, 0);
});

test('imposibles: un pico aislado de 10 °C en 10 min y la lluvia negativa se marcan', () => {
  const rs = serie('2026-09-10T00:10', '2026-09-10T03:00', (i) => (i === 5 ? -8 : 3), (i) => ({ lluvia: i === 7 ? -1 : 0 }));
  const ctrl = controlar(leerDavis(armar(rs)).registros);
  assert.ok(ctrl[5].marcas.includes('pico_aislado'));
  assert.ok(ctrl[7].marcas.includes('lluvia_fuera_de_rango'));
  assert.equal(resumenDia(ctrl, '2026-09-10').tmin_c, 3);
  /* control negativo: el mismo descenso sostenido (no vuelve) no es un pico */
  const ctrl2 = controlar(leerDavis(armar(serie('2026-09-10T00:10', '2026-09-10T03:00', (i) => (i >= 5 ? -8 : 3)))).registros);
  assert.equal(ctrl2[5].marcas.includes('pico_aislado'), false);
});

test('imposibles: la temperatura trabada 6 h se marca', () => {
  const ctrl = controlar(leerDavis(armar(serie('2026-09-10T00:10', '2026-09-10T08:00', () => 4.4, undefined, { plano: true }))).registros);
  assert.ok(ctrl.every((r) => r.marcas.includes('temp_trabada')));
  const ctrl2 = controlar(leerDavis(armar(serie('2026-09-10T00:10', '2026-09-10T05:00', () => 4.4, undefined, { plano: true }))).registros);
  assert.equal(ctrl2.some((r) => r.marcas.includes('temp_trabada')), false);   // control negativo: 5 h no
});

// ───────────── 7 · no saturar al INTA ─────────────
test('el pedidor: de a uno, ≥ 30 s entre pedidos, y se corta ante 429', async () => {
  const esperas = []; let reloj = 0;
  const llamadas = [];
  const fetchFn = async (u) => { llamadas.push(u); return { ok: true, status: llamadas.length === 2 ? 429 : 200, arrayBuffer: async () => new ArrayBuffer(0) }; };
  const p = crearPedidor({ fetchFn, dormir: async (ms) => { esperas.push(ms); reloj += ms; }, ahora: () => reloj });
  assert.equal((await p.pedir('a')).estado, 'ok');
  assert.equal((await p.pedir('b')).estado, 'cortado');
  assert.equal((await p.pedir('c')).estado, 'cortado');
  assert.equal(llamadas.length, 2);                 // después del 429 no se pide más
  assert.deepEqual(esperas, [30000]);
  /* control negativo: con 200 sigue pidiendo, siempre con su pausa, hasta el tope */
  const ll2 = []; let r2 = 0; const esp2 = [];
  const q = crearPedidor({ fetchFn: async (u) => { ll2.push(u); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }; }, dormir: async (ms) => { esp2.push(ms); r2 += ms; }, ahora: () => r2, tope: 3 });
  for (const u of ['a', 'b', 'c', 'd']) await q.pedir(u);
  assert.equal(ll2.length, 3);
  assert.ok(esp2.every((ms) => ms >= 30000));
});

test('el User-Agent es genérico', async () => {
  let ua = null;
  const p = crearPedidor({ fetchFn: async (u, o) => { ua = o.headers['User-Agent']; return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }; } });
  await p.pedir('x');
  assert.match(ua, /^Mozilla\/5\.0 \(compatible; colector-agrometeorologico\/1\.0\)$/);
  assert.doesNotMatch(ua, /@|hn[-_ ]?agro|satchi|jeshe|nanci|hernan/i);
});

// ───────────── 8 · estación quieta ─────────────
test('estación quieta: más de 24 h sin registros nuevos avisa', async () => {
  const txt = armar(serie('2026-09-10T00:10', '2026-09-10T12:00'));
  const lejos = Date.parse('2026-09-11T15:10:00Z') + 3 * 3600e3;   // 27 h después (hora local)
  const x = await procesarEstacion({ e: E10, texto: txt, ahoraMs: lejos });
  assert.equal(x.aviso && x.aviso.tipo, 'estacion_quieta');
  /* control negativo: 2 h después, no */
  const y = await procesarEstacion({ e: E10, texto: txt, ahoraMs: Date.parse('2026-09-10T14:00:00Z') + 3 * 3600e3 });
  assert.equal(y.aviso, null);
});

// ───────────── 9 · la corrida entera, con base falsa ─────────────
function baseFalsa(est = []) {
  const s = { obs: [], estaciones: [], registro: [] };
  return { s, async estaciones() { return est; }, async guardarEstaciones(f) { s.estaciones.push(...f); }, async obs() { return []; },
    async guardarObs(f) { s.obs.push(...f); return { ok: f.length, errores: [] }; }, async registrar(proceso, ok, resumen) { s.registro.push({ proceso, ok, resumen }); } };
}
test('correr: formato cambiado → registro_procesos con aviso, ok=false, y NO se escribe estaciones_obs', async () => {
  const txt33 = armar(serie('2026-09-10T00:10', '2026-09-10T06:00'), { formato: 33 });
  const firma40 = leerDavis(armar(serie('2026-09-10T00:10', '2026-09-10T06:00'))).firma;
  const base = baseFalsa([{ estacion_id: '10', metadatos: { formato_firma: firma40 } }]);
  const logs = [];
  const r = await correr({ seco: false, ids: ['10'], archivos: { 10: txt33 }, base, almacen: null, log: (x) => logs.push(x), ahoraMs: Date.parse('2026-09-10T09:10:00Z') });
  assert.equal(base.s.obs.length, 0);
  assert.equal(base.s.registro.length, 1);
  assert.equal(base.s.registro[0].ok, false);
  assert.ok(base.s.registro[0].resumen.avisos.some((a) => a.tipo === 'formato_cambiado'));
  assert.equal(base.s.estaciones[0].metadatos.formato_firma, firma40);      // la firma aceptada no cambia sola
  assert.ok(r.avisos.length);
  assert.doesNotMatch(logs.join('\n'), /"tmin|-?\d+\.\d+ ?°/);              // al registro público no van valores
  /* control negativo: el formato de siempre se escribe y la corrida queda ok */
  const base2 = baseFalsa([{ estacion_id: '10', metadatos: { formato_firma: firma40 } }]);
  await correr({ seco: false, ids: ['10'], archivos: { 10: armar(serie('2026-09-10T00:10', '2026-09-10T06:00')) }, base: base2, almacen: null, log: () => {}, ahoraMs: Date.parse('2026-09-10T09:10:00Z') });
  assert.ok(base2.s.obs.length > 0);
  assert.equal(base2.s.registro[0].ok, true);
  assert.equal(base2.s.obs[0].red, 'INTA_SIPAN_AV');
  assert.equal(base2.s.obs[0].lluvia_origen, 'suma_registros');
});

test('correr: con el SIPAN cortado (corte de conexión) no sigue pidiendo y avisa', async () => {
  let n = 0;
  const r = await correr({ seco: true, fetchFn: async () => { n++; throw new Error('ECONNRESET'); }, dormir: async () => {}, log: () => {} });
  assert.equal(n, 1);
  assert.ok(r.avisos.some((a) => a.tipo === 'sipan_corto'));
});

// ───────────── 10 · la medición ─────────────
test('métricas: sesgo, MAE y la tabla de heladas', () => {
  const pares = [{ pron: 5, obs: -1 }, { pron: -1, obs: -3 }, { pron: 0, obs: 2 }, { pron: 6, obs: 6 }, { pron: null, obs: 1 }];
  const m = metricas(pares);
  assert.equal(m.n, 4);
  assert.equal(m.sesgo, (6 + 2 - 2 + 0) / 4);
  assert.equal(m.mae, (6 + 2 + 2 + 0) / 4);
  assert.deepEqual([m.umbrales['0'].aciertos, m.umbrales['0'].falsas_alarmas, m.umbrales['0'].perdidas, m.umbrales['0'].tranquilas], [1, 1, 1, 1]);
  assert.equal(m.umbrales['-2'].perdidas, 1);
  assert.equal(m.riesgo_satchi.vistas_como_riesgo, 1);
  /* control negativo: un pronóstico perfecto da sesgo 0 y ninguna perdida */
  const p = metricas(pares.filter((x) => x.pron != null).map((x) => ({ pron: x.obs, obs: x.obs })));
  assert.equal(p.sesgo, 0);
  assert.equal(p.umbrales['0'].perdidas + p.umbrales['0'].falsas_alarmas, 0);
});

test('pronóstico: la mínima del día local sale de las 24 horas; con una hora faltante es null', () => {
  const time = Array.from({ length: 48 }, (_, i) => `2026-09-${i < 24 ? '10' : '11'}T${String(i % 24).padStart(2, '0')}:00`);
  const v = time.map((_, i) => (i === 5 ? -2 : i === 30 ? null : 4));
  const m = minimasDiarias({ hourly: { time, temperature_2m_previous_day1: v } });
  assert.equal(m['2026-09-10'].d1, -2);
  assert.equal(m['2026-09-11'].d1, null);       // control negativo: no se inventa con 23 horas
});

test('medición: sólo noches con ≥ 90 % de registros', () => {
  const obs = [{ estacion_id: '10', fecha: '2026-09-10', tmin_noche_c: -2, noche_registros: 90, noche_esperados: 90 },
    { estacion_id: '10', fecha: '2026-09-11', tmin_noche_c: -9, noche_registros: 60, noche_esperados: 90 }];
  const pron = { 10: { p: { minimas: { '2026-09-10': { d1: 3, d2: 4 }, '2026-09-11': { d1: 1, d2: 1 } }, celda: {}, url: '' } } };
  const f = armarPares(obs, pron);
  assert.equal(f.length, 2);                    // una noche × 2 anticipaciones
  assert.ok(f.every((x) => x.noche === '2026-09-10'));
  assert.equal(localidadMasCercana(E10).nombre, 'Neuquén');
  assert.equal(localidadMasCercana(ESTACIONES.find((e) => e.id === '42')).nombre, 'Choele Choel');
});

test('clima.htm: saca los ids de los enlaces', () => {
  const html = '<a href="met/10/Current_Vantage.htm">Guerrico</a> <a href="https://sipan.inta.gob.ar/agrometeorologia/met/47/downld02.txt">Vista&nbsp;Alegre</a> <a href="otro.htm">x</a>';
  assert.deepEqual(idsDePagina(html), [{ id: '10', texto: 'Guerrico' }, { id: '47', texto: 'Vista Alegre' }]);
  assert.deepEqual(idsDePagina('<a href="clima.htm">nada</a>'), []);   // control negativo
  assert.ok(ENC_40[1].includes('Date'));
});

// ───────────── 11 · la radiación del día (138c: para el Q medido aparte) ─────────────
test('radiación: 144 registros de 500 W/m² dan 43,2 MJ/m²; con uno faltante, null (no un total corto)', () => {
  const txt = armar(serie('2026-09-10T00:10', '2026-09-11T00:00', () => 5)).replace(/(1012\.0   0\.00   0\.0)   0 /g, '$1   500 ');
  const d = resumenDia(controlar(leerDavis(txt).registros), '2026-09-10');
  assert.equal(d.rad_registros, 144);
  assert.equal(d.rad_mj_m2, 43.2);
  /* control negativo: sin un registro de radiación, el día no tiene total */
  const rs = leerDavis(txt).registros; rs[70].v.rad = null;
  const d2 = resumenDia(controlar(rs), '2026-09-10');
  assert.equal(d2.rad_registros, 143);
  assert.equal(d2.rad_mj_m2, null);
});

// ───────────── 12 · el histórico en PDF: sólo 2018 en adelante, sólo el SIPAN, sin repetir ─────────────
test('histórico: la lista acepta sólo PDF del SIPAN de 2018 en adelante y no repite lo bajado', async () => {
  const { filtrarLista } = await import('../historico-pdf.mjs');
  const txt = ['https://sipan.inta.gob.ar/agrometeorologia/met/resumen/2024/09_guerrico.pdf', 'https://sipan.inta.gob.ar/x/1975/01.pdf',
    'https://otro.sitio/2024/01.pdf', 'https://sipan.inta.gob.ar/2025/clima.htm', '# comentario', 'https://sipan.inta.gob.ar/a/2023/ya.pdf'].join('\n');
  const { lista, rechazos } = filtrarLista(txt, new Set(['ya.pdf']));
  assert.deepEqual(lista.map((x) => x.nombre), ['09_guerrico.pdf']);
  assert.equal(rechazos.length, 4);
  /* control negativo: sin «ya bajado», el de 2023 entra */
  assert.equal(filtrarLista(txt).lista.length, 2);
});
