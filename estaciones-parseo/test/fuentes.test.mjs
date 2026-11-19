// HN AGRO · estaciones-parseo · cada fuente contra su fixture SINTÉTICA (la forma de R2, valores inventados).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ronda } from './ayuda.mjs';
import weatherlink from '../fuentes/weatherlink.mjs';
import weathercloud, { crear as crearWC, FORMATO } from '../fuentes/weathercloud.mjs';
import siga from '../fuentes/siga.mjs';
import eeaoc from '../fuentes/eeaoc.mjs';
import mendoza from '../fuentes/mendoza.mjs';
import sanluis from '../fuentes/sanluis.mjs';
import bcp from '../fuentes/bcp.mjs';
import entrerios, { parsearDavis } from '../fuentes/entrerios.mjs';
import ina from '../fuentes/ina.mjs';
import { FUENTES, REDES } from '../fuentes/index.mjs';

const de = (res, id) => res.lecturas.filter((l) => l.estacion_id === id);

test('las 9 fuentes, cada una con su red y sin repetir', () => {
  assert.deepEqual(FUENTES.map((f) => f.id), ['weatherlink', 'weathercloud', 'siga', 'eeaoc', 'mendoza', 'sanluis', 'bcp', 'entrerios', 'ina']);
  assert.equal(new Set(REDES).size, 9);
});

test('EEAOC: hora argentina, RR_dia al acumulado del día, 0 mm sigue siendo 0, el viento sin unidad va a crudo', () => {
  const r = eeaoc.leer(ronda('eeaoc/2026-01-10/1511.json'));
  assert.equal(r.estaciones.length, 4);
  const [l] = de(r, '9001');
  assert.equal(l.instante, Date.parse('2026-01-10T15:00:00Z'));
  assert.equal(l.temp_c, 20);
  assert.equal(l.lluvia_dia_mm, 0);              // un 0 medido no es «sin dato»
  assert.equal(l.viento_ms, undefined);
  assert.deepEqual(l.crudo, { viento_medio: 10, viento_max: 20 });
  assert.equal(de(r, '9004')[0].presion_hpa, null);   // 10000 = sin dato
  assert.equal(de(r, '9002')[0].lluvia_dia_mm, null);  // vacío = sin dato, nunca 0
});

test('EEAOC: si cambia la forma, no se guarda nada', () => {
  const o = { leido: 'x', partes: { estaciones: { status: 200, cuerpo: JSON.stringify([{ id: 1, nombre: 'Prueba' }]) } } };
  assert.deepEqual(eeaoc.leer(o).descartadas, { formato_cambiado: 1 });
  assert.equal(eeaoc.leer({ partes: { estaciones: { status: 500, cuerpo: '' } } }).lecturas.length, 0);
});

test('Mendoza: 999.9 es sin dato; la precipitación y la velocidad (sin unidad) van a crudo', () => {
  const r = mendoza.leer(ronda('mendoza/2026-01-10/1511.json'));
  const [a] = de(r, '9201'), [b] = de(r, '9202');
  assert.equal(a.viento_dir_gr, 180);
  assert.deepEqual(a.crudo, { velocidadViento: 5, precipitacion: 0 });
  assert.equal(a.lluvia_mm, undefined);
  assert.equal(b.viento_dir_gr, null);
  assert.equal(b.temp_c, null);
});

test('San Luis: el literal se lee como datos, los PRONO quedan afuera, la lluvia va a crudo', () => {
  const r = sanluis.leer(ronda('sanluis/2026-01-10/1511.json'));
  assert.deepEqual(r.estaciones.map((e) => e.estacion_id), ['9301', '9302']);
  assert.equal(r.descartadas.pronostico, 1);
  const [l] = de(r, '9301');
  assert.equal(l.temp_c, 20);
  assert.deepEqual(l.crudo, { lluvia: 0 });
  assert.deepEqual(sanluis.leer({ partes: { mapa: { status: 200, cuerpo: '<html>desafío</html>' } } }).descartadas, { formato_cambiado: 1 });
});

test('BCP: los casilleros por sus constantes, km/h → m/s, la humedad no se usa, la deshabilitada no entra', () => {
  const r = bcp.leer(ronda('bcp/2026-01-10/1511.json'));
  assert.deepEqual(r.estaciones.map((e) => [e.estacion_id, e.nombre]), [['9401', 'Prueba 41']]);
  const [l] = r.lecturas;
  assert.equal(l.instante, Date.parse('2026-01-10T15:00:00Z'));
  assert.equal(l.temp_c, 20);
  assert.equal(l.lluvia_dia_mm, 0);
  assert.equal(l.presion_hpa, 1013);
  assert.equal(l.viento_ms, 5);
  assert.equal(l.racha_ms, 10);
  assert.equal(l.viento_dir_gr, 180);
  assert.equal(l.hum_pct, undefined);
  assert.equal(r.descartadas.deshabilitada, 1);
});

test('Entre Ríos: columnas por la cabecera (con «�»), registros de 10 min, lluvia del registro con su período', () => {
  const r = entrerios.leer(ronda('entrerios/2026-01-10/1511.json'));
  assert.deepEqual(r.estaciones.map((e) => e.estacion_id), ['prueba1']);
  assert.equal(r.descartadas.sin_parte, 1);   // la EMA que dio 404
  const ls = de(r, 'prueba1');
  assert.equal(ls.length, 13);
  const a = ls.find((l) => l.instante === Date.parse('2026-01-10T13:30:00Z'));
  assert.equal(a.temp_c, 20.3);               // «Temp. Ext.», no «Temp. M�x.» (20.5)
  assert.equal(a.hum_pct, 50);                // «Hum. Ext.», no «Hum. Int.» (45)
  assert.equal(a.lluvia_mm, 0.2);
  assert.equal(a.lluvia_periodo_min, 10);
  assert.equal(a.tipo, 'registro');
  assert.equal(parsearDavis('sin cabecera'), null);
});

test('INA: temp y HR juntas por estación; la lluvia diaria con período 1440 en el fin (12Z); afuera lo que no es AR', () => {
  const r = ina.leer(ronda('ina/2026-01-10/1511.json'));
  assert.deepEqual(r.estaciones.map((e) => [e.estacion_id, e.lat, e.lon]), [['9501', -34.45, -60.45]]);
  const t = de(r, '9501').find((l) => l.tipo === 'instantanea');
  assert.equal(t.temp_c, 20.5);
  assert.equal(t.hum_pct, 60);
  const p = de(r, '9501').find((l) => l.tipo === 'registro');
  assert.equal(p.instante, Date.parse('2026-01-10T12:00:00Z'));
  assert.equal(p.lluvia_mm, 0);
  assert.equal(p.lluvia_periodo_min, 1440);
  assert.equal(r.descartadas.serie_desconocida, 1);
  // un total que no es de 24 h no es la lluvia diaria: no entra
  const o = ronda('ina/2026-01-10/1511.json');
  o.partes.obs_0.cuerpo = JSON.stringify([{ series_id: 99003, timestart: '2026-01-10T06:00:00.000Z', timeend: '2026-01-10T12:00:00.000Z', valor: 5 }]);
  const r2 = ina.leer(o);
  assert.equal(r2.lecturas.length, 0);
  assert.equal(r2.descartadas.lluvia_sin_dia, 1);
});

test('SIGA: la fecha con «Z[UTC]», la convencional sin lectura, la no visible afuera', () => {
  const r = siga.leer(ronda('siga/2026-01-10/1511.json'));
  assert.deepEqual(r.estaciones.map((e) => e.estacion_id), ['9101', '9102']);
  assert.equal(r.lecturas.length, 1);
  assert.equal(r.lecturas[0].instante, Date.parse('2026-01-10T15:00:00Z'));
  assert.deepEqual(r.lecturas[0].crudo, { precipitacion: 0 });
});

test('WeatherLink: °F → °C, mph → m/s, inHg → hPa, in → mm, rumbo → grados; coordenadas del índice', () => {
  const r = weatherlink.leer(ronda('weatherlink/2026-01-10/1511.jsonl', weatherlink.abrir),
    { indice: new Map([['prueba-wl-1', { lat: -34.505, lon: -60.505, tb: 1 }], ['prueba-wl-4', { lat: -34.1, lon: -60.1, tb: -1 }]]) });
  const [l] = de(r, 'prueba-wl-1');
  assert.equal(l.instante, Date.parse('2026-01-10T15:00:00Z'));
  assert.ok(Math.abs(l.temp_c - 20) < 1e-9);
  assert.ok(Math.abs(l.viento_ms - 4.4704) < 1e-9);
  assert.ok(Math.abs(l.presion_hpa - 1013.21) < 0.01);
  assert.equal(l.lluvia_dia_mm, 0);
  assert.equal(l.viento_dir_gr, 180);
  // la de ageInSeconds: el instante se calcula desde la edad (y la regla de las 12 h la saca después)
  assert.equal(de(r, 'prueba-wl-2')[0].instante, Date.parse('2026-01-10T15:21:00Z') - 50000e3);
  assert.equal(r.descartadas.sin_instante, 1);
  assert.deepEqual(r.claves_vistas, { otraCosa: 1 });
  const e4 = r.estaciones.find((e) => e.estacion_id === 'prueba-wl-4');
  assert.equal(e4.activa, false);
});

test('Weathercloud: con el formato SIN verificar no guarda nada, sólo cuenta', () => {
  const o = ronda('weathercloud/2026-01-10/1511.json');
  const r = weathercloud.leer(o);
  assert.equal(r.estaciones.length + r.lecturas.length, 0);
  assert.deepEqual(r.descartadas, { formato_sin_verificar: 2 });
  // con un formato completado (lo que haría local al mirar un device), sí: décimas → °C
  const f = { ...FORMATO, verificado: true, posiciones: { ...FORMATO.posiciones, id: 0, nombre: 1, temp_c: 5, hum_pct: 6 } };
  const r2 = crearWC(f).leer(o);
  assert.equal(r2.estaciones.length, 2);
  assert.equal(r2.lecturas.length, 1);
  assert.equal(r2.lecturas[0].temp_c, 20);
  assert.equal(r2.descartadas.fuera_de_linea, 1);
});
