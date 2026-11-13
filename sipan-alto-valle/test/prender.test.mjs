// node --test sipan-alto-valle/test/prender.test.mjs   (sin red ni base)
// Los arreglos de la revisión sustituta antes de prender: la FK estaciones → estaciones_obs desde la PRIMERA corrida,
// la pausa de 30 s también entre el último downld02 y el barrido, la apikey que no sea la de servicio y que una falla
// en una estación no corte la corrida. Cada uno con su control negativo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correr } from '../sipan.mjs';
import { crearBase } from '../lib/base.mjs';
import { firmar } from '../migracion/firmar-jwt.mjs';
import { armar, serie } from './sintetico.mjs';

const AHORA = Date.parse('2026-09-10T09:10:00Z');   // 06:10 de Argentina
const txt = () => armar(serie('2026-09-09T08:10', '2026-09-10T06:00', () => 5));

/** Una base falsa que RESPETA la FK de la 0110: estaciones_obs sólo entra si ya existe la fila de estaciones. */
function baseConFk() {
  const s = { estaciones: new Map(), obs: [], registro: [], orden: [], intentos: [] };
  return {
    s,
    async estaciones() { return [...s.estaciones.values()].map((f) => ({ estacion_id: f.estacion_id, metadatos: f.metadatos })); },
    async guardarEstaciones(filas) { for (const f of filas) { s.estaciones.set(f.estacion_id, f); s.orden.push('est ' + f.estacion_id); } },
    async obs() { return []; },
    async guardarObs(filas) {
      let ok = 0; const errores = [];
      for (const f of filas) {
        s.intentos.push(f.estacion_id);
        if (!s.estaciones.has(f.estacion_id)) { errores.push(`${f.estacion_id} ${f.fecha}: Supabase POST estaciones_obs: HTTP 409`); continue; }
        s.obs.push(f); s.orden.push('obs ' + f.estacion_id); ok++;
      }
      return { ok, errores };
    },
    async registrar(proceso, ok, resumen) { s.registro.push({ proceso, ok, resumen }); },
  };
}

test('FK: la PRIMERA corrida real, con la base vacía, ya guarda las filas de estaciones_obs', async () => {
  const base = baseConFk();
  const r = await correr({ seco: false, ids: ['10', '40'], archivos: { 10: txt(), 40: txt() }, base, almacen: null, ahoraMs: AHORA, log: () => {} });
  assert.equal(r.errores.length, 0, r.errores.join(' | '));
  assert.ok(base.s.obs.length >= 4);
  /* la fila de cada estación va antes que sus datos */
  for (const id of ['10', '40']) assert.ok(base.s.orden.indexOf('est ' + id) < base.s.orden.indexOf('obs ' + id), base.s.orden.join(','));
  assert.equal(base.s.registro[0].ok, true);
  /* control negativo: la misma base sin la fila de estaciones (como antes del arreglo) da 409 */
  const sola = baseConFk();
  const g = await sola.guardarObs([{ estacion_id: '10', fecha: '2026-09-10' }]);
  assert.equal(g.ok, 0);
  assert.match(g.errores[0], /409/);
});

test('FK: si no se pudo guardar la estación, no se intentan sus datos y queda el error (la corrida sigue con las otras)', async () => {
  const base = baseConFk();
  const guardar = base.guardarEstaciones;
  base.guardarEstaciones = async (filas) => { if (filas[0].estacion_id === '10') throw new Error('Supabase POST estaciones: HTTP 500'); return guardar(filas); };
  const r = await correr({ seco: false, ids: ['10', '40'], archivos: { 10: txt(), 40: txt() }, base, almacen: null, ahoraMs: AHORA, log: () => {} });
  assert.ok(r.errores.some((e) => /^10 estaciones/.test(e)));
  assert.equal(base.s.obs.filter((f) => f.estacion_id === '10').length, 0);
  assert.equal(base.s.intentos.filter((id) => id === '10').length, 0);        // ni siquiera se intentaron (darían 409)
  assert.ok(base.s.obs.filter((f) => f.estacion_id === '40').length > 0);   // control negativo: la otra sí
});

test('una falla de los crudos (GitHub) en una estación no corta la corrida: el diario se guarda igual', async () => {
  const base = baseConFk();
  const almacen = { tipo: 'releases', async leer() { return null; }, async escribir() { throw new Error('GitHub POST: HTTP 502'); } };
  const r = await correr({ seco: false, ids: ['10'], archivos: { 10: txt() }, base, almacen, ahoraMs: AHORA, log: () => {} });
  assert.ok(r.errores.some((e) => /crudos/.test(e)));
  assert.ok(base.s.obs.length > 0);
  assert.equal(base.s.registro.length, 1);                                    // y se anotó en registro_procesos
  /* control negativo: con los crudos andando, no hay errores */
  const ok = { tipo: 'releases', async leer() { return null; }, async escribir() { return true; } };
  const r2 = await correr({ seco: false, ids: ['10'], archivos: { 10: txt() }, base: baseConFk(), almacen: ok, ahoraMs: AHORA, log: () => {} });
  assert.equal(r2.errores.length, 0);
});

test('barrido: clima.htm sale ≥ 30 s DESPUÉS del último downld02 (mismo reloj, misma pausa)', async () => {
  let t = 0; const pedidos = [];
  const reloj = () => t;
  const dormir = async (ms) => { t += ms; };
  const html = '<a href="met/10/downld02.txt">Guerrico</a> <a href="met/47/downld02.txt">Vista Alegre</a>';
  const fetchFn = async (u) => {
    pedidos.push({ u, t }); t += 500;                                          // cada pedido tarda 0,5 s
    const cuerpo = /clima\.htm$/.test(u) ? html : txt();
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(cuerpo, 'latin1') };
  };
  const r = await correr({ seco: true, barrer: true, fetchFn, dormir, reloj, ahoraMs: AHORA, log: () => {} });
  const urls = pedidos.map((p) => p.u.split('/met/')[1]);
  assert.deepEqual(urls, ['10/downld02.txt', '40/downld02.txt', '41/downld02.txt', '42/downld02.txt', '45/downld02.txt', 'clima.htm', '47/downld02.txt']);
  for (let i = 1; i < pedidos.length; i++) assert.ok(pedidos[i].t - pedidos[i - 1].t >= 30000, `${urls[i]}: ${pedidos[i].t - pedidos[i - 1].t} ms`);
  assert.equal(r.resumen.pedidos, 5);
  assert.equal(r.resumen.pedidos_barrido, 2);
  /* control negativo: sin barrido, son sólo los 5 */
  pedidos.length = 0; t = 0;
  await correr({ seco: true, fetchFn, dormir, reloj, ahoraMs: AHORA, log: () => {} });
  assert.equal(pedidos.length, 5);
});

test('apikey: si SIPAN_SUPABASE_ANON_KEY es la clave de servicio, no arranca', () => {
  const jwt = firmar({ secreto: 'z'.repeat(40) });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const servicioLegado = b64({ alg: 'HS256' }) + '.' + b64({ role: 'service_role' }) + '.f';
  assert.throws(() => crearBase({ url: 'https://p.supabase.co', apikey: servicioLegado, jwt }), /clave de servicio/);
  assert.throws(() => crearBase({ url: 'https://p.supabase.co', apikey: 'sb_secret_abc123', jwt }), /clave de servicio/);
  /* control negativo: la anon legada (role anon) y la publishable nueva sí */
  const anonLegada = b64({ alg: 'HS256' }) + '.' + b64({ role: 'anon' }) + '.f';
  assert.ok(crearBase({ url: 'https://p.supabase.co', apikey: anonLegada, jwt }));
  assert.ok(crearBase({ url: 'https://p.supabase.co', apikey: 'sb_publishable_abc123', jwt }));
});
