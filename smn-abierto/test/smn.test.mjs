// node --test smn-abierto/test/smn.test.mjs   (sin red ni base)
// Con el fixture real: SMN_FIXTURES=<carpeta con smn-datohorario.zip> (en pc-nanci: hn-cortex/docs/red-nacional-139/fixtures).
// Cada bloque trae su control negativo: el mismo caso con la condición al revés tiene que dar lo contrario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { leerZip } from '../lib/zip.mjs';
import { leerDatoHorario, numero, idDeNombre } from '../lib/datohorario.mjs';
import { controlar, resumenDia, resumenNoche, unir } from '../lib/resumen.mjs';
import { metaLicencia, LICENCIA_SMN } from '../lib/licencia.mjs';
import { crearPedidor, procesarArchivo, abrirArchivo, filaEstacion, estadoDe, correr, URL_SMN, USER_AGENT, INACTIVA_DIAS } from '../smn.mjs';
import { zipDelDia, zip, texto, dia, fila, ENCABEZADO, UNIDADES, hora } from './sintetico.mjs';

const POR_DEFECTO = 'C:/HN-AGRO/hn-cortex/docs/red-nacional-139/fixtures';
const DIR = process.env.SMN_FIXTURES || (fs.existsSync(path.join(POR_DEFECTO, 'smn-datohorario.zip')) ? POR_DEFECTO : null);
const F = '2026-11-13';
const AHORA = Date.parse('2026-11-14T13:17:00Z');          // 10:17 de Argentina del 14/11
const zipOk = (filas = dia(F, 'AEROPARQUE AERO')) => zipDelDia(F, filas);

// ───────────── 1 · el fixture REAL (el único pedido: 14/11/2026 03:29, vino con el .txt vacío) ─────────────
test('fixture real: el ZIP abre, trae datohorario20261113.txt con 0 bytes → «vacío», sin filas (nunca ceros)', { skip: !DIR && 'sin SMN_FIXTURES' }, () => {
  const buf = fs.readFileSync(path.join(DIR, 'smn-datohorario.zip'));
  const z = leerZip(buf);
  assert.equal(z.ok, true);
  assert.deepEqual(z.entradas.map((e) => [e.nombre, e.datos.length]), [['datohorario20261113.txt', 0]]);
  const x = procesarArchivo({ buf, ahoraMs: AHORA });
  assert.equal(x.estado, 'vacio');
  assert.equal(x.aviso, null);                                                  // primer intento: no es novedad
  assert.equal(x.filasObs, undefined);
  assert.equal(procesarArchivo({ buf, ahoraMs: AHORA, ultimo: true }).aviso.tipo, 'archivo_vacio');   // último intento: avisa
  /* las cabeceras del pedido: Cloudflare delante, pero 200 y un ZIP (sin desafío) */
  const h = fs.readFileSync(path.join(DIR, 'smn-datohorario.headers.txt'), 'latin1');
  assert.match(h, /^HTTP\/1\.1 200/);
  assert.match(h, /filename=DatosHorarios-20261113\.zip/);
});
test('fixture real · control negativo: el mismo nombre de archivo con filas SÍ carga', () => {
  const x = procesarArchivo({ buf: zipOk(), ahoraMs: AHORA });
  assert.equal(x.estado, 'ok');
  assert.ok(x.filasObs.length > 0);
});

// ───────────── 2 · el formato ─────────────
test('lee el formato documentado: 8 columnas, HOA, la firma, nombres con números («25 DE MAYO»)', () => {
  const p = leerDatoHorario(texto([...dia(F, 'AEROPARQUE AERO'), { fecha: F, hora: 5, nombre: '25 DE MAYO', v: { temp: 12.5, hum: 60, pnm: 1010, dd: 90, ff: 5 } }]));
  assert.equal(p.ok, true);
  assert.equal(p.registros.length, 25);
  assert.equal(p.hora, 'HOA');
  assert.equal(p.fecha_archivo, F);
  const m = p.registros.find((r) => r.nombre === '25 DE MAYO');
  assert.equal(m.id, '25_DE_MAYO');
  assert.deepEqual(m.v, { temp: 12.5, hum: 60, pnm: 1010, dd: 90, ff: 5 });
  assert.equal(idDeNombre('Río Cuarto Aero'), 'RIO_CUARTO_AERO');
});
test('formato distinto → NO se carga: faltan columnas, otro orden, hora UTC, filas rotas, otra entrada en el ZIP', () => {
  const filas = dia(F, 'AEROPARQUE AERO');
  const casos = [
    [texto(filas, { encabezado: ENCABEZADO.replace('PNM', 'PRES') }), 'faltan_columnas'],
    [texto(filas, { encabezado: ENCABEZADO.replace('HUM     PNM', 'PNM     HUM') }), 'columnas_en_otro_orden'],
    [texto(filas, { unidades: UNIDADES.replace('[HOA]', '[UTC]') }), 'hora_no_es_hoa'],
    [texto([...filas.slice(0, 20), 'xx', 'yy', 'zz', '13/11/2026 1 2 3']), 'filas_rotas'],
    ['hola\nmundo\n', 'sin_encabezado'],
  ];
  for (const [t, motivo] of casos) {
    const x = procesarArchivo({ buf: zip([[`datohorario20261113.txt`, t]]), ahoraMs: AHORA });
    assert.equal(x.estado, 'formato', motivo);
    assert.equal(x.aviso.tipo, 'formato_no_se_entiende', motivo);
    assert.equal(x.aviso.motivo, motivo);
  }
  assert.equal(procesarArchivo({ buf: zip([['otro.txt', texto(filas)]]), ahoraMs: AHORA }).aviso.motivo, 'zip_con_otras_entradas');
  assert.equal(procesarArchivo({ buf: zip([['datohorario20261113.txt', texto(filas)], ['LEAME.txt', 'x']]), ahoraMs: AHORA }).aviso.motivo, 'zip_con_otras_entradas');
  assert.equal(procesarArchivo({ buf: Buffer.from('<html>Just a moment...</html>'), ahoraMs: AHORA }).aviso.motivo, 'no_es_zip');
  assert.equal(procesarArchivo({ buf: zip([['datohorario20261112.txt', texto(filas)]]), ahoraMs: AHORA }).aviso.motivo, 'fecha_distinta_del_nombre');
  /* control negativo: 2 filas rotas de 26 (< 10 %) se descartan y el resto entra */
  const p = leerDatoHorario(texto([...filas, 'xx', 'yy']));
  assert.equal(p.ok, true);
  assert.equal(p.descartadas.length, 2);
});
test('formato CAMBIADO (firma distinta de la guardada) → aviso y no carga; aceptada a mano → carga', () => {
  const estado = new Map([['AEROPARQUE_AERO', { formato_firma: 'FECHA HORA TEMP HUM PNM DD FF NOMBRE | [HOA] [°C] [%] [hPa] [gr] [km/h]' }]]);
  const x = procesarArchivo({ buf: zipOk(), estado, ahoraMs: AHORA });
  assert.equal(x.estado, 'formato');
  assert.equal(x.aviso.tipo, 'formato_cambiado');
  const firma = leerDatoHorario(texto(dia(F, 'X'))).firma;
  assert.equal(procesarArchivo({ buf: zipOk(), estado, aceptar: firma, ahoraMs: AHORA }).estado, 'ok');
  /* control negativo: con la MISMA firma guardada carga sin pedir nada */
  assert.equal(procesarArchivo({ buf: zipOk(), estado: new Map([['A', { formato_firma: firma }]]), ahoraMs: AHORA }).estado, 'ok');
});

// ───────────── 3 · los huecos (faltante = null, nunca 0) ─────────────
test('huecos: campo en blanco o «---» → null; la columna se respeta (falta HUM: la PNM no corre a HUM)', () => {
  const p = leerDatoHorario(texto([
    { fecha: F, hora: 1, nombre: 'A', v: { temp: null, hum: 70, pnm: 1000, dd: 10, ff: 5 } },
    { fecha: F, hora: 2, nombre: 'A', v: { temp: 8.5, hum: null, pnm: 1001.5, dd: 10, ff: 5 } },
    { fecha: F, hora: 3, nombre: 'A', v: { temp: '---', hum: 'N/D', pnm: 1002, dd: 10, ff: 5 } },
  ]));
  assert.equal(p.ok, true);
  assert.deepEqual(p.registros.map((r) => r.v), [
    { temp: null, hum: 70, pnm: 1000, dd: 10, ff: 5 },
    { temp: 8.5, hum: null, pnm: 1001.5, dd: 10, ff: 5 },
    { temp: null, hum: null, pnm: 1002, dd: 10, ff: 5 },
  ]);
  assert.equal(numero(''), null); assert.equal(numero('---'), null);
  /* control negativo: un 0 medido es 0 (no null) */
  assert.equal(numero('0'), 0); assert.equal(numero('0.0'), 0);
  assert.equal(leerDatoHorario(texto([{ fecha: F, hora: 1, nombre: 'A', v: { temp: 0, hum: 70, pnm: 1000, dd: 0, ff: 0 } }])).registros[0].v.temp, 0);
});
test('huecos: un día sin ninguna temperatura → tmin/tmax null, 0 válidas de 24; la lluvia SIEMPRE null', () => {
  const sin = dia(F, 'A', () => null);
  const x = procesarArchivo({ buf: zipOk(sin), ahoraMs: AHORA });
  assert.equal(x.estado, 'ok');
  const fF = x.filasObs.find((f) => f.fecha === F);
  assert.equal(fF.tmin_c, null); assert.equal(fF.tmax_c, null);
  assert.equal(fF.registros_validos, 0); assert.equal(fF.registros_esperados, 24);
  assert.equal(fF.lluvia_mm, null); assert.equal(fF.horas_validas, null); assert.equal(fF.muestreo_min, 60);
  assert.equal(fF.noche_registros, 0); assert.equal(fF.tmin_noche_c, null);
  /* control negativo: con temperaturas, hay mínima y máxima (y la lluvia sigue null) */
  const con = procesarArchivo({ buf: zipOk(), ahoraMs: AHORA }).filasObs.find((f) => f.fecha === F);
  assert.equal(con.tmin_c, 10.5); assert.equal(con.tmax_c, 21.5); assert.equal(con.registros_validos, 23);
  assert.equal(con.lluvia_mm, null);
});

// ───────────── 4 · el dedup ─────────────
test('dedup: la misma estación y hora dos veces en el archivo cuenta una; volver a procesar con lo guardado no duplica', () => {
  const filas = dia(F, 'A');
  const x = procesarArchivo({ buf: zipOk([...filas, filas[5]]), ahoraMs: AHORA });
  assert.equal(x.cuentas.repetidas_en_archivo, 1);
  const fF = x.filasObs.find((f) => f.fecha === F);
  assert.equal(fF.registros_validos, 23);                                        // 01..23 de F (la de las 00 es del 12)
  assert.equal(Object.keys(fF.crudo.temp_horaria).length, 23);
  /* la segunda corrida con el mismo archivo: lee lo guardado, une, y da las MISMAS filas */
  const y = procesarArchivo({ buf: zipOk([...filas, filas[5]]), ahoraMs: AHORA, viejas: x.filasObs, estado: new Map([['A', x.estaciones[0].meta]]) });
  assert.equal(y.cuentas.repetidas_con_lo_guardado, 24);
  for (const f of y.filasObs) {
    const v = x.filasObs.find((g) => g.fecha === f.fecha);
    assert.deepEqual([f.tmin_c, f.tmax_c, f.registros_validos, f.noche_registros], [v.tmin_c, v.tmax_c, v.registros_validos, v.noche_registros]);
    assert.ok(f.registros_validos <= f.registros_esperados);
  }
  /* control negativo: horas distintas NO se juntan */
  assert.equal(unir([{ local: hora(F, 1), v: { temp: 1 } }], [{ local: hora(F, 2), v: { temp: 2 } }]).lecturas.length, 2);
  /* gana la lectura más completa */
  assert.equal(unir([{ local: hora(F, 1), v: { temp: 1, hum: 50 } }], [{ local: hora(F, 1), v: { temp: null, hum: null } }]).lecturas[0].v.temp, 1);
  /* un día con huecos NO pisa uno guardado más completo (p. ej. uno cargado antes sin las lecturas en el crudo) */
  const viejo = { estacion_id: 'A', fecha: F, tmin_c: 3, tmax_c: 30, registros_validos: 24, registros_esperados: 24, noche_registros: 15, noche_esperados: 15, tmin_noche_c: 2, crudo: {} };
  const z = procesarArchivo({ buf: zipOk(dia(F, 'A').slice(0, 6)), ahoraMs: AHORA, viejas: [viejo] }).filasObs.find((f) => f.fecha === F);
  assert.deepEqual([z.tmin_c, z.tmax_c, z.registros_validos, z.tmin_noche_c, z.noche_registros], [3, 30, 24, 2, 15]);
});
test('la noche (D−1 18 h, D 9 h] se arma con el archivo de ayer guardado + el de hoy: 15 de 15', () => {
  const D0 = '2026-11-12';
  const x0 = procesarArchivo({ buf: zipDelDia(D0, dia(D0, 'A', (h) => (h >= 19 ? 22 - h : 10 + h / 10))), ahoraMs: AHORA - 864e5 });
  const x1 = procesarArchivo({ buf: zipOk(dia(F, 'A', (h) => (h <= 9 ? h - 3 : 15 + h / 10))), ahoraMs: AHORA, viejas: x0.filasObs, estado: new Map([['A', x0.estaciones[0].meta]]) });
  const fF = x1.filasObs.find((f) => f.fecha === F);
  assert.equal(fF.noche_registros, 15); assert.equal(fF.noche_esperados, 15);
  assert.equal(fF.tmin_noche_c, -3);                                              // F 00:00
  assert.equal(fF.tmin_noche_en, '2026-11-13T03:00:00.000Z');
  /* el día D0 se completó con la lectura de las 00 de F: 24 de 24 */
  assert.equal(x1.filasObs.find((f) => f.fecha === D0).registros_validos, 24);
  /* control negativo: sin lo guardado de ayer, la noche queda incompleta (10 de 15) */
  const solo = procesarArchivo({ buf: zipOk(dia(F, 'A', (h) => (h <= 9 ? h - 3 : 15 + h / 10))), ahoraMs: AHORA }).filasObs.find((f) => f.fecha === F);
  assert.equal(solo.noche_registros, 10);
});

// ───────────── 5 · valores imposibles ─────────────
test('imposibles: se MARCAN y no entran en la mínima ni en la máxima', () => {
  const filas = dia(F, 'A');
  filas[10].v.temp = 99.9; filas[11].v.hum = 150; filas[12].v.temp = -60;
  filas[23].v.temp = 55;                                                         // la última: no es pico (no hay siguiente)
  const x = procesarArchivo({ buf: zipOk(filas), ahoraMs: AHORA });
  const fF = x.filasObs.find((f) => f.fecha === F);
  assert.equal(fF.tmax_c, 21); assert.equal(fF.tmin_c, 10.5);
  assert.equal(fF.registros_validos, 20);
  assert.equal(x.marcas.temp_fuera_de_rango, 3); assert.equal(x.marcas.hum_fuera_de_rango, 1);
  assert.equal(fF.crudo.temp_horaria[hora(F, 10)], 99.9);                         // el crudo queda como vino
  /* pico aislado de una hora y sensor trabado */
  const c = controlar([10, 10.5, 30, 11, 11.5].map((t, h) => ({ local: hora(F, h + 1), v: { temp: t } })));
  assert.deepEqual(c.map((r) => r.marcas.join()), ['', '', 'pico_aislado', '', '']);
  const tr = controlar(Array.from({ length: 12 }, (_, h) => ({ local: hora(F, h + 1), v: { temp: 7 } })));
  assert.ok(tr.every((r) => r.marcas.includes('temp_trabada')));
  /* control negativo: 49 °C y −35 °C son posibles en el país; 11 horas iguales no es trabado */
  const ok = controlar([{ local: hora(F, 1), v: { temp: 49 } }, { local: hora(F, 2), v: { temp: -35 } }]);
  assert.ok(ok.every((r) => r.marcas.length === 0));
  assert.ok(controlar(Array.from({ length: 11 }, (_, h) => ({ local: hora(F, h + 1), v: { temp: 7 } }))).every((r) => !r.marcas.length));
});

// ───────────── 6 · la licencia (MOSTRAR) ─────────────
test('licencia: cada estación SMN_ABIERTO va MOSTRAR con CC BY 2.5 AR, la cita, el link y la nota de cambios', () => {
  const x = procesarArchivo({ buf: zipOk(), ahoraMs: AHORA });
  for (const e of x.estaciones) {
    const f = filaEstacion(e, { ...e.meta, mostrar: false, licencia: 'otra', cita: '' });   // lo guardado NO pisa la licencia
    assert.equal(f.red, 'SMN_ABIERTO');
    assert.equal(f.metadatos.mostrar, true);
    assert.equal(f.metadatos.licencia, 'CC BY 2.5 AR');
    assert.equal(f.metadatos.licencia_url, 'https://creativecommons.org/licenses/by/2.5/ar/');
    assert.match(f.metadatos.cita, /Servicio Meteorológico Nacional/);
    assert.equal(f.metadatos.politica_url, 'https://argentina.gob.ar/normativa/361173_disp25_pdf/archivo');
    assert.match(f.metadatos.cita_textual, /Creative Commons Atribución 2\.5 Argentina/);
    assert.ok(f.metadatos.cambios.length > 20);
  }
  assert.equal(x.filasObs[0].crudo.licencia, 'CC BY 2.5 AR');
  /* control negativo: sin cita, sin link, con otra licencia o con link http → no se marca MOSTRAR (lanza) */
  assert.throws(() => metaLicencia({ ...LICENCIA_SMN, cita: '' }), /incompleta/);
  assert.throws(() => metaLicencia({ ...LICENCIA_SMN, licencia_url: '' }), /incompleta/);
  assert.throws(() => metaLicencia({ ...LICENCIA_SMN, licencia: 'sólo uso personal' }), /no está entre/);
  assert.throws(() => metaLicencia({ ...LICENCIA_SMN, licencia_url: 'http://creativecommons.org/licenses/by/2.5/ar/' }), /https/);
  assert.equal(metaLicencia({ ...LICENCIA_SMN, mostrar: false, licencia: 'otra' }).mostrar, false);   // INTERNO sí se puede
});

// ───────────── 7 · inactiva a los 30 días (como el PR #4 del SIPAN) ─────────────
test('inactiva: ausente del archivo hace > 30 días → UN aviso al cambiar; ya inactiva → sin aviso; revive → aviso', () => {
  const hace = (d) => new Date(AHORA - 3 * 3600e3 - d * 864e5).toISOString().slice(0, 16);
  const estado = new Map([
    ['VIEJA', { ultimo_registro: hace(31), nombre_smn: 'VIEJA' }],
    ['YA_INACTIVA', { ultimo_registro: hace(60), estado: 'inactiva' }],
    ['QUIETA', { ultimo_registro: hace(3) }],
    ['B', { ultimo_registro: hace(40), estado: 'inactiva' }],
  ]);
  const x = procesarArchivo({ buf: zipOk([...dia(F, 'A'), ...dia(F, 'B')]), estado, ahoraMs: AHORA });
  const tipos = x.avisos.map((a) => `${a.tipo} ${a.id}`).sort();
  assert.deepEqual(tipos, ['estacion_inactiva VIEJA', 'estacion_quieta QUIETA', 'estacion_revivio B']);
  assert.equal(x.ausentes.find((e) => e.id === 'VIEJA').meta.estado, 'inactiva');
  assert.equal(filaEstacion(x.ausentes[0], x.ausentes[0].meta).activa, false);
  assert.equal(x.estaciones.find((e) => e.id === 'B').estado, 'activa');
  /* una estación que viene en el archivo pero SÓLO con vacíos envejece: no se le renueva el último registro */
  const vacia = procesarArchivo({ buf: zipOk(dia(F, 'C', () => null).map((r) => ({ ...r, v: {} }))), estado: new Map([['C', { ultimo_registro: hace(31) }]]), ahoraMs: AHORA });
  assert.equal(vacia.avisos.find((a) => a.id === 'C').tipo, 'estacion_inactiva');
  /* control negativo: a los 29 días sigue activa (quieta, no inactiva) */
  assert.equal(estadoDe({ ultimoLocal: hace(29), ahoraMs: AHORA }).estado, 'activa');
  assert.equal(estadoDe({ ultimoLocal: hace(INACTIVA_DIAS + 1), ahoraMs: AHORA }).estado, 'inactiva');
});

// ───────────── 8 · el pedido (uno solo, sin evadir nada) ─────────────
const resp = (status, cuerpo, tipo = 'application/octet-stream') => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (k === 'content-type' ? tipo : k === 'content-disposition' ? 'attachment; filename=DatosHorarios-20261113.zip' : null) }, arrayBuffer: async () => cuerpo });
test('pedido: UNO por corrida, User-Agent genérico, y ante 403/429/5xx o un desafío HTML se corta (no se evade)', async () => {
  const vistos = [];
  const f = async (url, op) => { vistos.push({ url, ua: op.headers['User-Agent'] }); return resp(200, zipOk()); };
  const p = crearPedidor({ fetchFn: f });
  assert.equal((await p.pedir(URL_SMN)).estado, 'ok');
  assert.equal((await p.pedir(URL_SMN)).estado, 'tope');
  assert.equal(vistos.length, 1);
  assert.equal(vistos[0].ua, USER_AGENT);
  assert.doesNotMatch(USER_AGENT, /@|hn ?agro|nanci|hernan/i);
  for (const [st, cuerpo, tipo] of [[403, Buffer.from('x')], [402, Buffer.from('x')], [429, Buffer.from('x')], [503, Buffer.from('x')], [200, Buffer.from('<!DOCTYPE html><title>Just a moment...</title>'), 'text/html']]) {
    let n = 0;
    const q = crearPedidor({ fetchFn: async () => { n++; return resp(st, cuerpo, tipo); } });
    assert.equal((await q.pedir(URL_SMN)).estado, 'cortado', String(st));
    assert.equal((await q.pedir(URL_SMN)).estado, 'cortado');
    assert.equal(n, 1);
  }
  /* control negativo: 404 no corta (es «no hay»), y un ZIP con 200 pasa */
  const r404 = await crearPedidor({ fetchFn: async () => resp(404, Buffer.from('')) }).pedir(URL_SMN);
  assert.equal(r404.estado, 'no');
});
test('frecuencia: si el archivo de ayer ya está cargado, la corrida NO pide nada', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return resp(200, zipOk()); };
  const base = baseFalsa(new Map([['A', { ultimo_archivo: F }]]));
  const r = await correr({ seco: false, base, fetchFn, ahoraMs: AHORA, log: () => {} });
  assert.equal(r.resumen.estado, 'ya_cargado');
  assert.equal(n, 0);
  /* control negativo: con el de anteayer cargado, pide UNA vez */
  const r2 = await correr({ seco: false, base: baseFalsa(new Map([['A', { ultimo_archivo: '2026-11-12' }]])), fetchFn, ahoraMs: AHORA, log: () => {} });
  assert.equal(r2.resumen.estado, 'ok');
  assert.equal(n, 1);
});

// ───────────── 9 · la corrida real contra una base falsa ─────────────
function baseFalsa(est = new Map()) {
  const s = { est: new Map([...est].map(([id, m]) => [id, { estacion_id: id, metadatos: m }])), obs: new Map(), registro: [], orden: [] };
  return {
    s,
    async estaciones() { return [...s.est.values()]; },
    async guardarEstaciones(filas) { for (const f of filas) { s.est.set(f.estacion_id, f); s.orden.push('est ' + f.estacion_id); } },
    async obsFechas(fechas) { return [...s.obs.values()].filter((f) => fechas.includes(f.fecha)); },
    async guardarObs(filas) {
      let ok = 0; const errores = [];
      for (const f of filas) {
        if (!s.est.has(f.estacion_id)) { errores.push(`${f.estacion_id} ${f.fecha}: FK`); continue; }
        s.obs.set(f.estacion_id + ' ' + f.fecha, f); s.orden.push('obs ' + f.estacion_id); ok++;
      }
      return { ok, errores };
    },
    async registrar(proceso, ok, resumen) { s.registro.push({ proceso, ok, resumen }); },
  };
}
test('corrida real: la estación ANTES que sus datos (FK), registra smn_abierto, y la segunda corrida no duplica', async () => {
  const base = baseFalsa();
  const fetchFn = async () => resp(200, zipOk([...dia(F, 'A'), ...dia(F, 'B')]));
  const logs = [];
  const r = await correr({ seco: false, base, fetchFn, ahoraMs: AHORA, log: (l) => logs.push(l) });
  assert.equal(r.errores.length, 0);
  assert.deepEqual(r.avisos, []);
  assert.equal(base.s.obs.size, 4);                                               // 2 estaciones × (F−1, F)
  assert.ok(base.s.orden.indexOf('est A') < base.s.orden.indexOf('obs A'));
  assert.equal(base.s.registro[0].proceso, 'smn_abierto');
  assert.equal(base.s.registro[0].ok, true);
  assert.equal(base.s.est.get('A').metadatos.mostrar, true);
  /* el registro público: sólo cantidades (ningún valor medido) */
  assert.doesNotMatch(logs.join('\n'), /21\.5|10\.5|1012/);
  /* otra corrida el mismo día: ya_cargado. Forzada con el archivo: mismas filas, sin duplicar */
  const r2 = await correr({ seco: false, base, fetchFn, ahoraMs: AHORA, log: () => {} });
  assert.equal(r2.resumen.estado, 'ya_cargado');
  const r3 = await correr({ seco: false, base, archivo: zipOk([...dia(F, 'A'), ...dia(F, 'B')]), ahoraMs: AHORA, log: () => {} });
  assert.equal(r3.resumen.estado, 'ok');
  assert.equal(base.s.obs.size, 4);
  /* si la fila de una estación no se pudo guardar, sus datos ni se intentan (darían FK) */
  const b3 = baseFalsa();
  const g0 = b3.guardarEstaciones;
  b3.guardarEstaciones = async (filas) => { if (filas[0].estacion_id === 'B') throw new Error('estaciones: 42501'); return g0(filas); };
  const r4 = await correr({ seco: false, base: b3, archivo: zipOk([...dia(F, 'A'), ...dia(F, 'B')]), ahoraMs: AHORA, log: () => {} });
  assert.equal(r4.errores.length, 1);
  assert.match(r4.errores[0], /^B estaciones/);
  assert.equal(b3.s.obs.size, 2);
  /* control negativo: en seco no escribe nada */
  const b2 = baseFalsa();
  await correr({ seco: true, base: b2, fetchFn, ahoraMs: AHORA, log: () => {} });
  assert.equal(b2.s.orden.length, 0);
});
test('corrida real: con un 403 se corta, avisa smn_corto y no escribe datos', async () => {
  const base = baseFalsa();
  const r = await correr({ seco: false, base, fetchFn: async () => resp(403, Buffer.from('')), ahoraMs: AHORA, log: () => {} });
  assert.equal(r.avisos[0].tipo, 'smn_corto');
  assert.equal(base.s.obs.size, 0);
  assert.equal(base.s.registro[0].ok, false);
});
