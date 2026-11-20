// HN AGRO · estaciones-parseo · arma las fixtures SINTÉTICAS (node test/fixtures/generar.mjs).
// La FORMA es la de cada crudo que guarda estaciones-privadas/ronda.mjs en R2; los VALORES son inventados: nombres
// «Prueba N», ids 9001…9999 o «prueba-…», coordenadas redondas alrededor de (−34,5; −60,5), 20 °C, 50 %. Nada real:
// ni nombres, ni ids, ni coordenadas de ninguna estación (lo controla test/sin-datos-reales.test.mjs).
// Las rondas son del 10/01/2026: 15:11 UTC (12:11 en Argentina) y 16:11 UTC.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'r2', 'estaciones-internas');
const escribir = (rel, cuerpo) => { const p = path.join(DIR, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, cuerpo); };
const ronda = (leido, partes) => JSON.stringify({ leido, partes: Object.fromEntries(Object.entries(partes).map(([k, v]) =>
  [k, typeof v === 'string' ? { status: 200, tipo: 'text/plain; charset=UTF-8', cuerpo: v } : v])) }, null, 1) + '\n';
const L1 = '2026-01-10T15:11:30.000Z', L2 = '2026-01-10T16:11:30.000Z';
const NO = { status: 404, tipo: 'text/html', cuerpo: 'no' };

// ── EEAOC: services/estaciones.php
const eeaoc = (x) => ({ id: x.id, Identificacion: 'P' + x.id, nombre: x.nombre, lat: x.lat, lon: x.lon, alt: '50', foto: '', ultregrecibido: '',
  habilitada: '1', fecha_I: x.fecha, temp_af: x.temp, hum_af: x.hum, RR_dia: x.rr, rr_mes: '10.0', presion: x.presion ?? '1013.0',
  viento_medio: '10.0', viento_max: '20.0', rr_15: '0.0', pronostico: '', scada: '', gprs: '', zona: 'Prueba', desde: '2020-01-01',
  direc: 'S', rafaga24: '20.0', tiempo: '15', Localidad: 'Prueba', departamento: 'Prueba', provincia: 'Prueba', marca: 'Prueba',
  SMN: '0', isSoil: '0', isRadiation: '0', valles: '0', modem: '' });
escribir('eeaoc/2026-01-10/1511.json', ronda(L1, { estaciones: JSON.stringify([
  eeaoc({ id: '9001', nombre: 'Prueba 1', lat: '-34.5', lon: '-60.5', fecha: '2026-01-10 12:00:00', temp: '20.0', hum: '50', rr: '0.0' }),
  eeaoc({ id: '9002', nombre: 'Prueba 2', lat: '-34.9', lon: '-60.9', fecha: '2026-01-10 12:00:00', temp: '55.0', hum: '255', rr: '', presion: '1010.0' }),
  eeaoc({ id: '9003', nombre: 'Prueba 3', lat: '-35.0', lon: '-61.0', fecha: '2025-12-01 10:00:00', temp: '20.0', hum: '50', rr: '0.0' }),
  eeaoc({ id: '9004', nombre: 'Prueba 4', lat: '-35.1', lon: '-61.1', fecha: '2026-01-10 13:00:00', temp: '20.0', hum: '50', rr: '0.0', presion: '10000.0' }),
]) }));
escribir('eeaoc/2026-01-10/1611.json', ronda(L2, { estaciones: JSON.stringify([
  eeaoc({ id: '9001', nombre: 'Prueba 1', lat: '-34.5', lon: '-60.5', fecha: '2026-01-10 13:00:00', temp: '21.0', hum: '48', rr: '2.5' }),
  eeaoc({ id: '9002', nombre: 'Prueba 2', lat: '-34.9', lon: '-60.9', fecha: '2026-01-10 12:00:00', temp: '55.0', hum: '255', rr: '', presion: '10000.0' }),
]) }));

// ── Mendoza: api/todas_instantaneas.json
const mza = (x) => ({ estacion: x.id, lat: x.lat, lng: x.lon, Nombre: x.nombre, fecha: '10/01/2026 12:00', tempAire: x.temp, humedad: x.hum,
  direccionViento: x.dir, velocidadViento: x.vel, precipitacion: '0.0', fechaIngles: '2026-01-10 12:00:00', Latitud: x.lat, Longitud: x.lon,
  Altura: '50', Correccion_Viento: '0', web: '1', atraso_max: '60', atraso: '5', bateria: '12.5', puntoRocio: '9.3', direccionVientoTexto: 'S' });
escribir('mendoza/2026-01-10/1511.json', ronda(L1, { instantaneas: JSON.stringify([
  mza({ id: '9201', nombre: 'Prueba 21', lat: '-35.5', lon: '-61.5', temp: '20.0', hum: '50', dir: '180', vel: '5.0' }),
  mza({ id: '9202', nombre: 'Prueba 22', lat: '-35.6', lon: '-61.6', temp: '', hum: '', dir: '999.9', vel: '999.9' }),
]) }));

// ── San Luis: InfoEstaciones.aspx (el literal vEstaciones)
const ms = Date.UTC(2026, 0, 10, 15, 0);
escribir('sanluis/2026-01-10/1511.json', ronda(L1, { mapa: `<html><head><script type="text/javascript">
var vEstaciones =[[9301,"Prueba 31",-34.4,-60.4,new Date(${ms}),20.0,0.0,"REM",0,0,0,0,0],[9302,"Prueba 32",-35.2,-61.2,new Date(${ms}),null,0.0,"SLA",0,0,0,0,0],[9399,"Prueba 39",-35.3,-61.3,new Date(946684800000),20.0,0.0,"PRONO",0,0,0,0,0]];
</script></head><body>Prueba</body></html>` }));

// ── BCP: MapaG_NvoBCP.asp
const C = { iEstacionLat: 0, iEstacionLong: 1, iEstacionDesact: 2, iEstacionNoOper: 3, iEstacionInstal: 4, iSensorTemp: 5, iSensorTpMin: 6,
  iSensorTpMax: 7, iSensorPpDia: 10, iSensorHum_Rel: 14, iSensorPresion: 16, iSensorDir_Vto: 18, iSensorVel_Vto: 19, iSensorRaf_Vto: 20, iEstacionUltAct: 25 };
const bcpEst = (i, x) => [
  `    htmlEstacion[${i}] = 'Estaci&oacute;n ${i + 1} - ${x.nombre} (Prueba)'`, `    habilEstacion[${i}] =  ${x.habil}`, `    sitioEstacion[${i}] =  ${x.id}`,
  `    jsDatos[${i}][0][0] = ${x.lat}`, `    jsDatos[${i}][1][0] = ${x.lon}`, `    jsDatos[${i}][25][0] = '10/01/2026 12:00:00'`,
  `    jsDatos[${i}][5][0] = '${x.temp} &ordm;C'`, `    jsDatos[${i}][6][0] = '15.0 &ordm;C'`, `    jsDatos[${i}][6][1] = '10/01/2026 6:00:00'`,
  `    jsDatos[${i}][10][0] = '${x.pp} mm'`, `    jsDatos[${i}][14][0] = '50 %'`, `    jsDatos[${i}][16][0] = '${x.pres}'`,
  `    jsDatos[${i}][18][0] = '180 &ordm;'`, `    jsDatos[${i}][19][0] = '18 km/h'`, `    jsDatos[${i}][20][0] = '36 km/h'`].join('\n');
escribir('bcp/2026-01-10/1511.json', ronda(L1, { mapa: `<html><script>
/* casilleros */
${Object.entries(C).map(([k, v]) => `    ${k.padEnd(16)} = ${v}`).join('\n')}
${bcpEst(0, { nombre: 'Prueba 41', habil: 1, id: 9401, lat: -34.6, lon: -60.4, temp: '20.0', pp: '0.0', pres: '1013.0 hPa' })}
${bcpEst(1, { nombre: 'Prueba 42', habil: 0, id: 9402, lat: -34.7, lon: -60.3, temp: '20.0', pp: '0.0', pres: 'N/D' })}
</script></html>` }));

// ── Entre Ríos: un downld08.txt por EMA (columnas alineadas a la derecha, cabecera de dos renglones y guiones)
const COLS = [['', 'Fecha', 8], ['', 'Hora', 7], ['Temp.', 'Ext.', 7], ['Temp.', 'M�x.', 7], ['Hum.', 'Ext.', 6], ['Bar', '', 8],
  ['', 'Lluvia', 7], ['Hum.', 'Int.', 6], ['Int.', 'Arc.', 6]];
const der = (t, w) => t.padStart(w);
const renglon = (vals) => vals.map((v, k) => der(String(v), COLS[k][2])).join('');
const filas = [];
for (let k = 0; k < 12; k++) {
  const h = 10 + Math.floor(k / 6), mi = (k % 6) * 10;
  filas.push(renglon(['10/01/26', `${h}:${String(mi).padStart(2, '0')}`, (20 + k * 0.1).toFixed(1), (20.2 + k * 0.1).toFixed(1),
    k === 5 ? '0' : '50', '1013.0', k === 3 ? '0.20' : '0.00', '45', '10']));
}
filas.push(renglon(['25/12/25', '9:00', '20.0', '20.1', '50', '1013.0', '0.00', '45', '10']));
// [19/11] un campo VACÍO (la humedad) y una hora con «a» (am/pm): los dos se leen; un renglón cortado, no
filas.push(renglon(['10/01/26', '9:00', '19.0', '19.1', '', '1013.0', '0.00', '45', '10']));
filas.push(renglon(['10/01/26', '9:10a', '19.1', '19.2', '50', '1013.0', '0.00', '45', '10']));
filas.push('10/01/26 9:20 19.2 50 1013.0');
const davis = [renglon(COLS.map((c) => c[0])), renglon(COLS.map((c) => c[1])), '-'.repeat(70), ...filas].join('\r\n') + '\r\n';
escribir('entrerios/2026-01-10/1511.json', ronda(L1, { prueba1: davis, prueba2: NO }));

// ── INA: series + observaciones
const est = (id, nombre, lon, lat, pais = 'Argentina') => ({ id, nombre, id_externo: 'P', geom: { type: 'Point', coordinates: [lon, lat] }, tabla: 'prueba',
  pais, rio: null, has_obs: true, tipo: 'A', automatica: true, propietario: 'Prueba', public: true, red: { id: 1, nombre: 'Prueba', public: true } });
const serie = (id, v, e) => ({ tipo: 'puntual', id, estacion: e, var: { id: v, nombre: 'Prueba' }, procedimiento: { id: 1 }, unidades: { id: 1 } });
const E1 = est(9501, 'Prueba 51', -60.45, -34.45), E2 = est(9502, 'Prueba 52', -57.0, -33.0, 'Uruguay');
const obs = (s, ini, fin, valor) => ({ id: 1, tipo: 'puntual', series_id: s, timestart: ini, timeend: fin, nombre: 'Prueba', valor });
escribir('ina/2026-01-10/1511.json', ronda(L1, {
  series: JSON.stringify({ rows: [serie(99001, 53, E1), serie(99002, 58, E1), serie(99003, 1, E1), serie(99004, 53, E2)] }),
  obs_0: JSON.stringify([obs(99001, '2026-01-10T15:00:00.000Z', '2026-01-10T15:00:00.000Z', 20.5), obs(99002, '2026-01-10T15:00:00.000Z', '2026-01-10T15:00:00.000Z', 60),
    obs(99003, '2026-01-09T12:00:00.000Z', '2026-01-10T12:00:00.000Z', 0), obs(99004, '2026-01-10T15:00:00.000Z', '2026-01-10T15:00:00.000Z', 20)]),
}));

// ── SIGA: la respuesta de URL_MYSQL_ESTACION_AUTOMATICA
escribir('siga/2026-01-10/1511.json', ronda(L1, { estaciones: JSON.stringify([
  { altura: 50, id: 9101, idInterno: 'P9101', idTipo: 2, latitud: -34.6, localidad: 'Prueba', longitud: -60.6, nombre: 'Prueba 11', provincia: 'Prueba',
    tipo: 'Prueba THP', visible: true, fecha: '2026-01-10T15:00:00Z[UTC]', temperatura: 20.0, humedad: 50.0, precipitacion: 0.0 },
  { altura: 50, id: 9102, idInterno: 'P9102', idTipo: 1, latitud: -34.7, localidad: 'Prueba', longitud: -60.7, nombre: 'Prueba 12', provincia: 'Prueba',
    tipo: 'Prueba manual', visible: true },
  { altura: 50, id: 9103, idInterno: 'P9103', idTipo: 2, latitud: -34.8, localidad: 'loc_prueba', longitud: -60.8, nombre: 'Prueba 13', provincia: 'Prueba',
    tipo: 'Prueba THP', visible: false },
]) }));

// ── WeatherLink: <día>/<HHMM>.jsonl + indices/<día>.json
const s = (iso) => Math.floor(Date.parse(iso) / 1000);
escribir('weatherlink/indices/2026-01-10.json', JSON.stringify([
  { id: 'prueba-wl-1', lat: -34.505, lng: -60.505, tb: 1 }, { id: 'prueba-wl-2', lat: -34.3, lng: -60.3, tb: 1 },
  { id: 'prueba-wl-3', lat: -34.2, lng: -60.2, tb: 1 }, { id: 'prueba-wl-4', lat: -34.1, lng: -60.1, tb: -1 }]));
escribir('weatherlink/2026-01-10/1511.jsonl', [
  { id: 'prueba-wl-1', leido: '2026-01-10T15:20:00.000Z', d: { stationName: 'Prueba 61', lastTimestamp: s('2026-01-10T15:00:00Z'), temperature: '68.0',
    humidity: '50', windSpeed: '10', windGust: '20', windDirection: 'S', barometer: '29.92', rainDay: '0.00' } },
  { id: 'prueba-wl-2', leido: '2026-01-10T15:21:00.000Z', d: { stationName: 'Prueba 62', ageInSeconds: 50000, temperature: '68.0' } },
  { id: 'prueba-wl-3', leido: '2026-01-10T15:22:00.000Z', d: { otraCosa: 1 } },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

// ── Weathercloud: { leido, devices: [[…]] } (sólo se sabe [2] lat, [3] lon, [4] estado)
escribir('weathercloud/2026-01-10/1511.json', JSON.stringify({ leido: L1, devices: [
  ['prueba-wc-1', 'Prueba 71', -34.5, -60.5, 2, 200, 50], ['prueba-wc-2', 'Prueba 72', -34.6, -60.6, 1, 200, 50]] }) + '\n');

console.log('fixtures sintéticas en', DIR);
