// node --test test/fuentes.test.mjs · los módulos de WeatherLink y Weathercloud sobre una carpeta-R2 con el formato de
// ronda.mjs. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as WL from '../fuentes/weatherlink.mjs';
import * as WC from '../fuentes/weathercloud.mjs';
import { carpeta, rondaWL, indiceWL, rondaWC, detalleWL, WC_PRUEBA, devWC } from './fixtures.mjs';

const T = Date.parse('2026-11-15T15:00:00Z');
const leidoMs = T + 60e3;

test('WL: el detalle se convierte (°F, mph, in, inHg) y el nombre se arregla', () => {
  const r = WL.leerDetalle('501', detalleWL({ t: '2026-11-15T15:00:00Z', f: 50, mph: 10, rainIn: 0.1, nombre: 'NeuquÃ©n', windGust: '20 mph' }), leidoMs);
  assert.equal(r.ok, true);
  const l = r.lectura;
  assert.deepEqual([l.temp_c, l.hum_pct, l.viento_ms, l.racha_ms, l.viento_dir_gr, l.presion_hpa, l.lluvia_dia_mm], [10, 60, 4.47, 8.94, 22.5, 1013.2, 2.54]);
  assert.equal(l.nombre, 'Neuquén'); assert.equal(l.instante, T); assert.equal(l.edad_s, 120);
});

test('WL: la unidad escrita manda, anidado un nivel, imposibles marcados', () => {
  const c = WL.leerDetalle('1', { temperature: '10 °C', windSpeed: '36 km/h', rainDay: '2.5 mm', barometer: '1013 hPa', lastTimestamp: 1794754800 }, leidoMs);
  assert.deepEqual([c.lectura.temp_c, c.lectura.viento_ms, c.lectura.lluvia_dia_mm, c.lectura.presion_hpa], [10, 10, 2.5, 1013]);
  assert.equal(WL.leerDetalle('1', { data: { temperature: 32, lastTimestamp: 1794754800 } }, leidoMs).lectura.temp_c, 0);
  const i = WL.leerDetalle('1', { temperature: 200, humidity: 140, lastTimestamp: 1794754800 }, leidoMs).lectura;
  assert.equal(i.temp_c, null); assert.equal(i.hum_pct, null);
});

test('WL: lo que no se entiende se descarta con motivo y sólo los NOMBRES de las claves', () => {
  assert.equal(WL.leerDetalle('1', { temperature: 50 }, NaN).motivo, 'sin_instante');
  const s = WL.leerDetalle('1', { secreto: 'valor', lastTimestamp: 1794754800 }, leidoMs);
  assert.equal(s.motivo, 'sin_variables'); assert.deepEqual(s.claves, ['lastTimestamp', 'secreto']);
  assert.equal(WL.leerDetalle('1', { temperature: 50, lastTimestamp: 1794754800 + 3600 }, leidoMs).motivo, 'instante_futuro');
  assert.equal(WL.leerDetalle('1', [1], leidoMs).motivo, 'no_es_objeto');
  // sin instante pero con edad: leído − edad
  const pe = WL.leerDetalle('1', { temperature: 50, ageInSeconds: 600 }, leidoMs);
  assert.equal(pe.lectura.instante, leidoMs - 600e3); assert.ok(pe.lectura.marcas.includes('instante_por_edad'));
  // vieja (> 2 h): no cuenta
  assert.equal(WL.leerDetalle('1', detalleWL({ t: '2026-11-15T12:00:00Z', edad: 10800 }), leidoMs).motivo, 'vieja');
  assert.equal(WL.leerDetalle('1', detalleWL({ t: '2026-11-15T14:00:00Z', edad: 3600 }), leidoMs).ok, true);
});

test('WL: leer de R2 (índice + rondas): estaciones con coordenadas del índice, tb −1 inactiva, descartes contados', async () => {
  const { r2 } = carpeta();
  await indiceWL(r2, '2026-11-15', [{ id: '501', lat: -39.03, lng: -67.58, tb: 1 }, { id: '502', lat: -34.6, lng: -58.4, tb: -1 }]);
  await rondaWL(r2, T, [{ id: '501', d: detalleWL({ t: '2026-11-15T14:58:00Z', nombre: 'Chacra 03 Ã±' }) }, { id: '503', d: { raro: 1, lastTimestamp: 1794754680 } }]);
  await r2.escribir('estaciones-internas/weatherlink/2026-11-15/1600.jsonl', 'no json\n{"sin":"id"}\n');
  await r2.escribir('estaciones-internas/weatherlink/2026-11-15/notas.txt', 'x');
  const r = await WL.leer({ r2, dias: ['2026-11-14', '2026-11-15'] });
  assert.equal(r.cuentas.archivos, 2); assert.equal(r.cuentas.renglones, 4); assert.equal(r.cuentas.lecturas, 1);
  assert.deepEqual(r.cuentas.descartadas, { sin_variables: 1, no_es_json: 1, sin_id: 1 });
  assert.deepEqual(r.claves_descartadas.sin_variables, ['lastTimestamp', 'raro']);
  const e = Object.fromEntries(r.estaciones.map((x) => [x.estacion_id, x]));
  assert.equal(e['501'].nombre, 'Chacra 03 ñ'); assert.equal(e['501'].lat, -39.03); assert.equal(e['501'].activa, true);
  assert.equal(e['502'].activa, false);
  for (const x of r.estaciones) { assert.equal(x.metadatos.mostrar, false); assert.equal(x.metadatos.permiso, 'interno'); assert.equal(x.red, 'WEATHERLINK_PUB'); }
  assert.equal(r.presentes, null, 'con < 100 en el índice no se marca ninguna ausente');
});

test('WC SIN verificar (como nace): no guarda nada, sólo cuenta', async () => {
  const { r2 } = carpeta();
  await rondaWC(r2, T, [devWC('c1'), devWC('c2', { estado: 1 })]);
  const r = await WC.leer({ r2, dias: ['2026-11-15'] });
  assert.equal(r.cuentas.devices, 2); assert.equal(r.cuentas.en_linea, 1); assert.equal(r.cuentas.verificado, false);
  assert.equal(r.lecturas.length, 0); assert.equal(r.estaciones.length, 0); assert.equal(r.presentes, null);
  assert.match(r.avisos[0], /sin_verificar/);
});

test('WC verificado (posiciones de prueba): décimas, km/h → m/s, sólo en línea, instante = la lectura del archivo', async () => {
  const d = WC.leerDevice(devWC('c1'), T, WC_PRUEBA);
  assert.equal(d.nombre, 'Córdoba Centro');
  assert.deepEqual([d.lectura.temp_c, d.lectura.hum_pct, d.lectura.viento_ms, d.lectura.lluvia_dia_mm], [21.5, 40, 10, 1.2]);
  assert.equal(d.lectura.instante, T); assert.ok(d.lectura.marcas.includes('instante_de_lectura'));
  assert.equal(WC.leerDevice(devWC('c2', { estado: 1 }), T, WC_PRUEBA).lectura, null);
  assert.equal(WC.leerDevice(['../x', 'n', 1, 2, 2], T, WC_PRUEBA), null);
  const { r2 } = carpeta();
  await rondaWC(r2, T, [devWC('c1'), devWC('c2', { estado: 1 })]);
  const r = await WC.leer({ r2, dias: ['2026-11-15'], formato: WC_PRUEBA });
  assert.equal(r.lecturas.length, 1); assert.equal(r.estaciones.length, 2);
  assert.equal(r.estaciones[0].red, 'WEATHERCLOUD_PUB'); assert.equal(r.estaciones[0].metadatos.mostrar, false);
});
