// node --test sipan-alto-valle/test/inactivas.test.mjs   (sin red ni base)
// Estación inactiva automática: quieta más de 30 días → inactiva, UN aviso al cambiar de estado, vuelve sola si revive,
// y la corrida no da rojo por inactivas. Más las inactivas conocidas del barrido (20, 48, 68), de pedido mensual.
// Cada bloque con su control negativo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correr, estadoDe, INACTIVA_DIAS } from '../sipan.mjs';
import { ESTACIONES, filaEstacion } from '../lib/estaciones.mjs';
import { armar, serie } from './sintetico.mjs';

const DIA = 864e5;
/** «ahora» en UTC para que el último registro (hora local de fin) quede `dias` atrás */
const ahoraTras = (ultimoLocal, dias) => Date.parse(ultimoLocal + ':00Z') + 3 * 3600e3 + dias * DIA;
const archivoHasta = (ultimoLocal) => {
  const fin = Date.parse(ultimoLocal + ':00Z');
  const ini = new Date(fin - 40 * 3600e3).toISOString().slice(0, 16);
  return armar(serie(ini, ultimoLocal, (i) => 5 + (i % 30) * 0.2));
};

/** Una base falsa que guarda metadatos (como `estaciones`) y respeta la FK de estaciones_obs. */
function baseFalsa() {
  const s = { estaciones: new Map(), obs: [], registro: [] };
  return {
    s,
    async estaciones() { return [...s.estaciones.values()].map((f) => ({ estacion_id: f.estacion_id, metadatos: f.metadatos, activa: f.activa })); },
    async guardarEstaciones(filas) { for (const f of filas) s.estaciones.set(f.estacion_id, f); },
    async obs() { return []; },
    async guardarObs(filas) { let ok = 0; for (const f of filas) { if (s.estaciones.has(f.estacion_id)) { s.obs.push(f); ok++; } } return { ok, errores: [] }; },
    async registrar(proceso, ok, resumen) { s.registro.push({ proceso, ok, resumen }); },
  };
}
const corrida = (base, archivos, ahoraMs, extra = {}) => correr({ seco: false, ids: Object.keys(archivos), archivos, base, almacen: null, ahoraMs, log: () => {}, ...extra });

test('estadoDe: 29 días quieta sigue ACTIVA; 31 días pasa a INACTIVA (un cambio); revive → activa (un cambio)', () => {
  const u = '2026-10-01T12:00';
  const a29 = estadoDe({ ultimoLocal: u, metaPrevia: {}, ahoraMs: ahoraTras(u, 29) });
  assert.deepEqual([a29.estado, a29.cambio], ['activa', null]);
  const a31 = estadoDe({ ultimoLocal: u, metaPrevia: {}, ahoraMs: ahoraTras(u, 31) });
  assert.deepEqual([a31.estado, a31.cambio], ['inactiva', 'estacion_inactiva']);
  /* ya inactiva: sin cambio (no avisa de nuevo) */
  const otra = estadoDe({ ultimoLocal: u, metaPrevia: { estado: 'inactiva' }, ahoraMs: ahoraTras(u, 60) });
  assert.deepEqual([otra.estado, otra.cambio], ['inactiva', null]);
  /* revive: un registro de hace 1 hora con el estado guardado inactiva */
  const rev = estadoDe({ ultimoLocal: u, metaPrevia: { estado: 'inactiva' }, ahoraMs: ahoraTras(u, 1 / 24) });
  assert.deepEqual([rev.estado, rev.cambio], ['activa', 'estacion_revivio']);
  assert.equal(INACTIVA_DIAS, 30);
});

test('corrida: quieta 29 días → sigue activa, con el aviso de quieta y sus datos guardados', async () => {
  const u = '2026-10-01T12:00';
  const base = baseFalsa();
  const r = await corrida(base, { 10: archivoHasta(u) }, ahoraTras(u, 29));
  assert.deepEqual(r.avisos.map((a) => a.tipo), ['estacion_quieta']);
  assert.equal(base.s.estaciones.get('10').metadatos.estado, 'activa');
  assert.equal(base.s.estaciones.get('10').activa, true);
  assert.ok(base.s.obs.length > 0);
});

test('corrida: quieta 31 días → inactiva con UN solo aviso; la corrida siguiente sale OK (sin avisos, no rojo)', async () => {
  const u = '2026-06-24T10:00';                                               // como Guerrico
  const base = baseFalsa();
  const r1 = await corrida(base, { 10: archivoHasta(u) }, ahoraTras(u, 142));
  assert.deepEqual(r1.avisos.map((a) => a.tipo), ['estacion_inactiva']);
  const f = base.s.estaciones.get('10');
  assert.equal(f.metadatos.estado, 'inactiva'); assert.equal(f.metadatos.activa, false); assert.equal(f.activa, false);
  assert.equal(f.metadatos.ultimo_registro, u);
  assert.equal(base.s.obs.length, 0);                                         // los datos viejos no se escriben
  const desde = f.metadatos.estado_desde;
  /* 2.ª y 3.ª corrida (6 y 12 h después): sin avisos, registro ok, ni una fila */
  for (const h of [6, 12]) {
    const r = await corrida(base, { 10: archivoHasta(u) }, ahoraTras(u, 142) + h * 3600e3);
    assert.equal(r.avisos.length, 0, JSON.stringify(r.avisos));
    assert.equal(base.s.registro.at(-1).ok, true);
    assert.equal(base.s.estaciones.get('10').metadatos.estado_desde, desde);   // el «desde» no se pisa
  }
  assert.equal(base.s.obs.length, 0);
  /* control negativo: con 31 días pero SIN el estado guardado (base nueva), vuelve a avisar: el aviso depende del cambio */
  const otra = baseFalsa();
  const r4 = await corrida(otra, { 10: archivoHasta(u) }, ahoraTras(u, 142) + 12 * 3600e3);
  assert.deepEqual(r4.avisos.map((a) => a.tipo), ['estacion_inactiva']);
});

test('corrida: la inactiva revive → activa, con UN aviso, y sus datos se vuelven a guardar', async () => {
  const viejo = '2026-06-24T10:00';
  const base = baseFalsa();
  await corrida(base, { 10: archivoHasta(viejo) }, ahoraTras(viejo, 142));
  const nuevo = '2026-11-13T21:50';
  const r = await corrida(base, { 10: archivoHasta(nuevo) }, ahoraTras(nuevo, 0.02));
  assert.deepEqual(r.avisos.map((a) => a.tipo), ['estacion_revivio']);
  assert.equal(base.s.estaciones.get('10').metadatos.estado, 'activa');
  assert.equal(base.s.estaciones.get('10').activa, true);
  assert.ok(base.s.obs.length > 0);
  /* y la siguiente, normal: sin avisos */
  const r2 = await corrida(base, { 10: archivoHasta(nuevo) }, ahoraTras(nuevo, 0.2));
  assert.equal(r2.avisos.length, 0);
});

test('corrida: una inactiva que además no se pudo leer (404 o corte) no avisa; una activa que no responde, sí', async () => {
  const u = '2026-02-01T10:00';
  const base = baseFalsa();
  await corrida(base, { 41: archivoHasta(u) }, ahoraTras(u, 285));             // queda inactiva
  const no404 = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const r = await correr({ seco: false, ids: ['41'], base, almacen: null, fetchFn: no404, dormir: async () => {}, ahoraMs: ahoraTras(u, 286), log: () => {} });
  assert.equal(r.avisos.length, 0, JSON.stringify(r.avisos));
  /* control negativo: la 40, activa, con 404 → aviso no_responde */
  const r2 = await correr({ seco: false, ids: ['40'], base: baseFalsa(), almacen: null, fetchFn: no404, dormir: async () => {}, ahoraMs: ahoraTras(u, 286), log: () => {} });
  assert.deepEqual(r2.avisos.map((a) => a.tipo), ['no_responde']);
});

test('corrida: una que no se pudo leer y lleva > 30 días según lo guardado pasa a inactiva (un aviso) y queda guardada', async () => {
  const u = '2026-03-01T10:00';
  const base = baseFalsa();
  await base.guardarEstaciones([filaEstacion(ESTACIONES.find((e) => e.id === '42'), { ultimo_registro: u })]);
  const corte = async () => { throw new Error('ECONNRESET'); };
  const r = await correr({ seco: false, ids: ['42'], base, almacen: null, fetchFn: corte, dormir: async () => {}, ahoraMs: ahoraTras(u, 250), log: () => {} });
  assert.deepEqual(r.avisos.map((a) => a.tipo).sort(), ['estacion_inactiva', 'sipan_corto']);
  assert.equal(base.s.estaciones.get('42').metadatos.estado, 'inactiva');
  /* la siguiente (ya inactiva): sólo el corte, sin el aviso de la estación */
  const r2 = await correr({ seco: false, ids: ['42'], base, almacen: null, fetchFn: corte, dormir: async () => {}, ahoraMs: ahoraTras(u, 251), log: () => {} });
  assert.deepEqual(r2.avisos.map((a) => a.tipo), ['sipan_corto']);
});

test('las del barrido (20, 48, 68): inactivas en el catálogo, sin pedirles nada salvo el día 1 de cada mes', async () => {
  const pedidos = [];
  const fetchFn = async (u) => { pedidos.push(u); return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; };
  const base = baseFalsa();
  const dia10 = Date.parse('2026-11-10T12:23:00Z');
  const r = await correr({ seco: false, base, almacen: null, fetchFn, dormir: async () => {}, ahoraMs: dia10, log: () => {} });
  assert.ok(!pedidos.some((u) => /\/(20|48|68)\//.test(u)), pedidos.join(' '));
  for (const id of ['20', '48', '68']) {
    const f = base.s.estaciones.get(id);
    assert.equal(f.activa, false); assert.equal(f.metadatos.estado, 'inactiva'); assert.ok(f.metadatos.ultimo_conocido);
  }
  assert.ok(!r.avisos.some((a) => ['20', '48', '68'].includes(a.id)));
  /* control negativo: el día 1 (corrida de las 00:23 UTC) se les pide, y un 404 de una inactiva no avisa */
  pedidos.length = 0;
  const r1 = await correr({ seco: false, base, almacen: null, fetchFn, dormir: async () => {}, ahoraMs: Date.parse('2026-12-01T00:23:00Z'), log: () => {} });
  for (const id of ['20', '48', '68']) assert.ok(pedidos.some((u) => u.includes(`/${id}/`)), id);
  assert.ok(!r1.avisos.some((a) => ['20', '48', '68'].includes(a.id)));
});
