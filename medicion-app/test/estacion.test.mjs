// node --test · el lado de la estación: la ventana 18-09 con el cambio de día, el mínimo de lecturas según el muestreo,
// la madrugada, los huecos, la HR media y las redes sin extremos. Fixtures sintéticos, sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladoEstacion, hueco, minimo } from '../lib/estacion.mjs';
import { msLocal } from '../../estaciones-privadas/parseo/lib/hora.mjs';
import { FECHA, SIG, fila, horarias, estacionCompleta } from './fixtures.mjs';

const lado = (dia, manana, red = 'SIGA_RT') => ladoEstacion({ red, fecha: FECHA, dia, manana });
const ms = (l) => msLocal(l);

test('el mínimo de lecturas: techo(0,8 × esperadas), según el muestreo (15 con 1 h, 90 con 10 min, 24 de día)', () => {
  assert.equal(minimo(15), 12);
  assert.equal(minimo(90), 72);
  assert.equal(minimo(24), 20);
  assert.equal(minimo(144), 116);
  const [d, m] = estacionCompleta();
  assert.equal(lado(d, { ...m, noche_registros: 12 }).noche.ok, true, '12 de 15 alcanza');
  const r = lado(d, { ...m, noche_registros: 11 });
  assert.equal(r.noche.ok, false, '11 de 15 no');
  assert.ok(r.motivos.includes('noche_pocas_lecturas'));
  // muestreo de 10 min (consola): 90 esperadas
  assert.equal(lado(null, fila(SIG, { muestreo_min: null, noche_esperados: 90, noche_registros: 72 })).noche.ok, true);
  assert.equal(lado(null, fila(SIG, { muestreo_min: null, noche_esperados: 90, noche_registros: 71 })).noche.ok, false);
  // de día
  assert.equal(lado({ ...d, registros_validos: 20 }, m).tmax.ok, true);
  assert.equal(lado({ ...d, registros_validos: 19 }, m).tmax.ok, false);
});

test('la ventana 18-09 cruza la medianoche: usa las lecturas de las DOS filas y deja afuera las 18:00 y las 09:01', () => {
  // hueco() con el cambio de día: 18:00 abierto, 09:00 cerrado
  const h = hueco([ms(`${FECHA}T18:00`), ms(`${FECHA}T19:00`), ms(`${FECHA}T22:00`), ms(`${SIG}T02:30`), ms(`${SIG}T06:00`), ms(`${SIG}T09:00`), ms(`${SIG}T09:01`)],
    `${FECHA}T18:00`, `${SIG}T09:00`);
  assert.equal(h.n, 5, '18:00 y 09:01 quedan afuera');
  assert.equal(h.hueco_min, 270, 'de 22:00 a 02:30 del día siguiente');
  // completa: vale
  const [d, m] = estacionCompleta();
  const r = lado(d, m);
  assert.equal(r.noche.ok, true, JSON.stringify(r.motivos));
  assert.equal(r.noche.est, 4.2, 'la mínima es la de la fila de la MAÑANA (fecha + 1)');
  // sin las lecturas de la noche de la víspera (18 a 24 de FECHA): hueco de 18:00 a 01:00 del día siguiente
  const dSinNoche = { ...d, lecturas: d.lecturas.filter((o) => o.l < `${FECHA}T18:01`) };
  const r2 = lado(dSinNoche, m);
  assert.equal(r2.noche.ok, false);
  assert.ok(r2.motivos.includes('noche_hueco'));
  // sin la fila de la mañana no hay noche (la mínima vive en fecha + 1)
  assert.ok(lado(d, null).motivos.includes('noche_sin_fila'));
});

test('la madrugada: sin lecturas en (03:00, 09:00] la noche no vale, aunque los conteos alcancen', () => {
  const [d, m] = estacionCompleta();
  const sinMad = { ...m, lecturas: horarias(SIG, { hasta: 3 }) };
  const r = lado(d, sinMad);
  assert.equal(r.noche.ok, false);
  assert.ok(r.motivos.includes('noche_sin_madrugada'));
  assert.ok(r.motivos.includes('noche_hueco'), 'de 03:00 a 09:00 son 360 min');
  // una sola a las 09:00 en punto cuenta como madrugada (la ventana es cerrada a las 09)
  const conNueve = { ...m, lecturas: horarias(SIG, { hasta: 9, sin: [4, 5, 6, 7, 8] }) };
  assert.ok(!lado(d, conNueve).motivos.includes('noche_sin_madrugada'));
});

test('el muestreo grueso y BCP (extremos sin hora de inicio) no valen; sin lecturas sólo los conteos, con la marca', () => {
  const [d, m] = estacionCompleta();
  const g = lado({ ...d, muestreo_min: 120 }, { ...m, muestreo_min: 120 });
  assert.equal(g.noche.ok, false); assert.equal(g.tmax.ok, false);
  assert.ok(g.motivos.includes('noche_muestreo_grueso'));
  const b = lado(d, m, 'BCP_RT');
  assert.equal(b.noche.ok, false); assert.equal(b.tmax.ok, false);
  assert.ok(b.motivos.includes('noche_red_sin_extremos'));
  // SIPAN / SMN: sin lecturas en el crudo
  const s = lado(fila(FECHA), fila(SIG));
  assert.equal(s.noche.ok, true);
  assert.ok(s.motivos.includes('noche_huecos_sin_verificar'));
  assert.equal(s.hr.ok, false);
  assert.ok(s.motivos.includes('hr_sin_lecturas'));
});

test('la HR media: promedio de las lecturas del día (00, 24], sin las marcadas ni las imposibles', () => {
  const [d, m] = estacionCompleta({ hum: 60 });
  const r = lado(d, m);
  assert.equal(r.hr.ok, true);
  assert.equal(r.hr.est, 60);
  assert.equal(r.hr.lecturas, 24);
  // una marcada por el parseo y una imposible (HR 0) no cuentan
  const lec = d.lecturas.map((o, i) => (i === 0 ? { ...o, hum: 100, m: ['futura'] } : i === 1 ? { ...o, hum: 0 } : o));
  const r2 = lado({ ...d, lecturas: lec }, m);
  assert.equal(r2.hr.lecturas, 22);
  assert.equal(r2.hr.est, 60);
  // las de la madrugada siguiente (fila de la mañana) NO entran en la HR del día
  assert.equal(lado(d, { ...m, lecturas: m.lecturas.map((o) => ({ ...o, hum: 5 })) }).hr.est, 60);
  // con 19 de 24 no alcanza
  const pocas = { ...d, lecturas: d.lecturas.slice(0, 19) };
  assert.ok(lado(pocas, m).motivos.includes('hr_pocas_lecturas'));
});

test('el hueco del día: más de 180 min sin lecturas invalida la máxima y la HR', () => {
  const [d, m] = estacionCompleta();
  const lec = d.lecturas.filter((o) => !/T1[2-5]:/.test(o.l));        // falta de 12 a 15 → hueco de 11:00 a 16:00
  const r = lado({ ...d, lecturas: lec }, m);
  assert.ok(r.motivos.includes('tmax_hueco'));
  assert.ok(r.motivos.includes('hr_hueco'));
  assert.equal(r.noche.ok, true, 'la noche no se toca');
});
