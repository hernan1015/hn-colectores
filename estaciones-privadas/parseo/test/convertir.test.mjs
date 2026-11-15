// node --test test/convertir.test.mjs · conversiones, números, rumbos, instantes, encoding de los nombres y rangos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fAc, mphAms, kmhAms, inAmm, inhgAhpa, num, unidadEnValor, dir, instante, arreglarNombre, controlar, local, sumarDias } from '../lib/convertir.mjs';

test('conversiones: °F→°C, mph→m/s, km/h→m/s, in→mm, inHg→hPa (y el control negativo)', () => {
  assert.equal(fAc(32), 0); assert.equal(fAc(212), 100); assert.equal(fAc(-40), -40); assert.equal(fAc(28.4), -2);
  assert.equal(mphAms(10), 4.47); assert.equal(kmhAms(36), 10); assert.equal(inAmm(1), 25.4); assert.equal(inAmm(0.01), 0.25);
  assert.equal(inhgAhpa(29.92), 1013.2);
  assert.notEqual(fAc(50), 50); assert.notEqual(mphAms(10), 10); assert.notEqual(inAmm(2), 2);
});

test('números y unidades escritas', () => {
  assert.equal(num('12,5 °F'), 12.5); assert.equal(num('-3'), -3); assert.equal(num(7.25), 7.25);
  for (const v of ['--', '', null, undefined, {}, NaN]) assert.equal(num(v), null);
  assert.equal(unidadEnValor('12 °C'), 'C'); assert.equal(unidadEnValor('5 km/h'), 'kmh'); assert.equal(unidadEnValor('29.9 inHg'), 'inHg');
  assert.equal(unidadEnValor('1013 hPa'), 'hPa'); assert.equal(unidadEnValor('0.2 in'), 'in'); assert.equal(unidadEnValor('3 m/s'), 'ms');
  assert.equal(unidadEnValor(12), null);
});

test('rumbos e instantes', () => {
  assert.equal(dir('N'), 0); assert.equal(dir('NNE'), 22.5); assert.equal(dir('SO'), 225); assert.equal(dir(270), 270); assert.equal(dir('calma'), null);
  assert.equal(instante(1794744000), Date.parse('2026-11-15T12:00:00Z'));
  assert.equal(instante('1794744000000'), Date.parse('2026-11-15T12:00:00Z'));
  assert.equal(instante('2026-11-15T09:00:00-03:00'), Date.parse('2026-11-15T12:00:00Z'));
  assert.equal(instante('ayer'), null); assert.equal(instante(12345), null);
});

test('encoding: arregla la doble (y triple) codificación y no toca lo que ya está bien', () => {
  assert.equal(arreglarNombre('GualeguaychÃº'), 'Gualeguaychú');
  assert.equal(arreglarNombre('Chacra NeuquÃ©n Ã±andÃº'), 'Chacra Neuquén ñandú');
  assert.equal(arreglarNombre('Donâ€™t'), 'Don’t');
  assert.equal(arreglarNombre('GualeguaychÃƒÂº'), 'Gualeguaychú');
  assert.equal(arreglarNombre('Neuquén'), 'Neuquén');
  assert.equal(arreglarNombre('Ñandú  del   Valle '), 'Ñandú del Valle');
  assert.equal(arreglarNombre('Âº grado'), 'º grado');
  assert.equal(arreglarNombre('Âº raro€'), 'Âº raro€');       // un 0x80 suelto no es UTF-8: queda
  assert.equal(arreglarNombre('Ã('), 'Ã(');
  assert.equal(arreglarNombre('Ã 東京'), 'Ã 東京');
  assert.equal(arreglarNombre(null), null);
});

test('rangos: lo imposible queda null y marcado; lo posible, igual', () => {
  const l = controlar({ temp_c: 200, hum_pct: 140, viento_ms: -3, presion_hpa: 700, lluvia_dia_mm: 12, viento_dir_gr: 360, marcas: [] });
  assert.deepEqual([l.temp_c, l.hum_pct, l.viento_ms, l.presion_hpa, l.lluvia_dia_mm, l.viento_dir_gr], [null, null, null, null, 12, 360]);
  assert.deepEqual(l.marcas.sort(), ['hum_pct_fuera_de_rango', 'presion_hpa_fuera_de_rango', 'temp_c_fuera_de_rango', 'viento_ms_fuera_de_rango']);
  assert.equal(controlar({ temp_c: -39.9, marcas: [] }).temp_c, -39.9);
  assert.equal(controlar({ temp_c: -40, marcas: [] }).temp_c, null);
});

test('el día local (UTC−3) y sumar días', () => {
  assert.deepEqual(local(Date.parse('2026-11-16T02:30:00Z')), { fecha: '2026-11-15', min: 23 * 60 + 30, seg: 0 });
  assert.equal(local(Date.parse('2026-11-16T03:00:00Z')).fecha, '2026-11-16');
  assert.equal(sumarDias('2026-12-31', 1), '2027-01-01'); assert.equal(sumarDias('2026-03-01', -1), '2026-02-28');
});
