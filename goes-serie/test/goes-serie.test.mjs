// HN AGRO · goes-serie · tests SIN RED (R2 y NOAA falsos; el R2 falso verifica cada firma SigV4).
// Correr: npm test --prefix goes-serie   ·   Control negativo contado: node goes-serie/test/control-negativo.mjs
// GOES_LIB (opcional) apunta a otra copia de lib/ (la usa el control negativo para correr con mutantes).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { r2Falso, noaaFalso, nombreFdcf, cuerpoFdcf } from './falsos.mjs';

const LIB = process.env.GOES_LIB || new URL('../lib/', import.meta.url).href;
const C = await import(LIB + 'claves.mjs');
const R = await import(LIB + 'r2.mjs');
const N = await import(LIB + 'noaa.mjs');
const S = await import(LIB + 'serie.mjs');
const E = await import(LIB + 'evento.mjs');

const MIN = 60e3, H = 3600e3, DIA = 864e5;
const T = (s) => Date.parse(s);
const AHORA = T('2026-11-08T03:47:00Z');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function armar({ objetos = {}, r2Opc = {}, noaaTurnos = [], noaaFallar = {}, listarFalla = [] } = {}) {
  const f = r2Falso({ objetos, ...r2Opc });
  const r2 = R.r2({ cuenta: f.cuenta, clave: f.clave, secreto: f.secreto, deposito: f.deposito, fetchFn: f.fetchFn });
  const nf = noaaFalso({ turnos: noaaTurnos, fallar: noaaFallar, listarFalla });
  const noaa = { listarHora: (ms) => N.listarHora(ms, nf.fetchFn), bajar: (o) => N.bajar(o, nf.fetchFn) };
  return { f, r2, nf, noaa };
}
const turnos = (desde, hasta) => C.turnosEntre(T(desde), T(hasta));
const serieCon = (ts) => Object.fromEntries(ts.map((t) => [C.claveImagen(t), cuerpoFdcf(t)]));
const leerJson = (f, k) => JSON.parse(f.objetos.get(k).toString('utf8'));

// ───────────────────────── 1 · el nombre de archivo ─────────────────────────
test('nombre: turno de 10 min UTC por el inicio del barrido, AAAA/MM/DD/HHMM.nc', () => {
  assert.equal(C.claveImagen(T('2026-11-07T18:10:21.5Z')), 'goes-serie/2026/11/07/1810.nc');
  assert.equal(C.claveImagen(T('2026-11-07T18:19:59Z')), 'goes-serie/2026/11/07/1810.nc');
  assert.equal(C.claveImagen(T('2026-12-31T23:50:20Z')), 'goes-serie/2026/12/31/2350.nc');
  assert.equal(C.claveImagen(T('2027-01-01T00:00:20Z')), 'goes-serie/2027/01/01/0000.nc');
  assert.equal(C.claveIndice(T('2026-11-07T18:10:21Z')), 'goes-serie/2026/11/07/indice.json');
  assert.equal(C.claveEventoImagen('incendio-x', T('2026-11-07T18:13:00Z')), 'goes-eventos/incendio-x/2026/11/07/1810.nc');
  assert.equal(C.claveManifiesto('incendio-x'), 'goes-eventos/incendio-x/manifiesto.json');
  // el nombre real de NOAA (listado del 7/11/2026, día juliano 311)
  assert.equal(C.instanteDe('OR_ABI-L2-FDCF-M6_G19_s20263111810215_e20263111819523_c20263111819599.nc'), T('2026-11-07T18:10:21Z'));
  assert.equal(C.instanteDe('OR_ABI-L2-FDCF-M6_G19_s20270010000205_e1_c1.nc'), T('2027-01-01T00:00:20Z'));
  assert.equal(C.instanteDe('sin-fecha.nc'), null);
  assert.equal(N.prefijoHora(T('2026-11-07T18:10:21Z')), 'ABI-L2-FDCF/2026/311/18/');
  assert.equal(C.tDeClave('goes-serie/2026/11/07/1810.nc'), T('2026-11-07T18:10:00Z'));
  assert.equal(C.tDeClave('goes-serie/2026/11/07/1815.nc'), null, 'un minuto fuera del paso no es un turno');
  assert.equal(C.tDeClave('goes-eventos/x/2026/11/07/1810.nc'), null);
});

test('nombre: la corrida guarda cada archivo de NOAA con la clave de su turno, entero y sin tocar', async () => {
  const ts = turnos('2026-11-08T00:40Z', '2026-11-08T03:30Z');
  const { f, r2, noaa } = armar({ noaaTurnos: ts });
  const res = await S.correrSerie({ r2, noaa }, { ahora: new Date(AHORA), horas: 3 });
  assert.equal(res.guardadas, ts.length);
  for (const t of ts) assert.deepEqual(f.objetos.get(C.claveImagen(t)), cuerpoFdcf(t), C.claveImagen(t));
  assert.ok(f.objetos.has('goes-serie/2026/11/08/0040.nc') && f.objetos.has('goes-serie/2026/11/08/0330.nc'));
  assert.equal([...f.objetos.keys()].filter((k) => k.endsWith('.nc')).length, ts.length);
  assert.equal(f.stats.rechazos, 0, 'el R2 falso aceptó todas las firmas');
});

// ───────────────────────── 2 · el índice ─────────────────────────
test('índice: uno por día, ordenado, con nombre de NOAA, hora del barrido, bytes y sha256', async () => {
  const ahora = T('2026-11-08T01:17:00Z');
  const ts = turnos('2026-11-07T22:10Z', '2026-11-08T00:40Z');       // cruza el día
  const { f, r2, noaa } = armar({ noaaTurnos: ts });
  const res = await S.correrSerie({ r2, noaa }, { ahora: new Date(ahora), horas: 3 });
  assert.equal(res.guardadas, ts.length);
  const a = leerJson(f, 'goes-serie/2026/11/07/indice.json'), b = leerJson(f, 'goes-serie/2026/11/08/indice.json');
  assert.equal(a.dia, '2026-11-07'); assert.equal(b.dia, '2026-11-08');
  assert.equal(a.imagenes.length + b.imagenes.length, ts.length);
  assert.deepEqual(a.imagenes.map((x) => x.hhmm), ['2210', '2220', '2230', '2240', '2250', '2300', '2310', '2320', '2330', '2340', '2350']);
  for (const x of [...a.imagenes, ...b.imagenes]) {
    const t = Date.parse(x.turno);
    assert.equal(x.clave, C.claveImagen(t));
    assert.equal(x.archivo, nombreFdcf(t));
    assert.equal(x.t_scan, new Date(t + 20000).toISOString());
    assert.equal(x.bytes, cuerpoFdcf(t).length);
    assert.equal(x.sha256, sha(cuerpoFdcf(t)));
  }
  assert.equal(a.retencion_dias, 30); assert.equal(a.paso_min, 10);
  assert.match(a.nota, /sin dato/);
  // 00:50, 01:00 y 01:10 no cerraron (01:17 < turno + 30 min) y NOAA no las publicó: pendientes, no faltantes
  assert.equal(res.pendientes, 3); assert.equal(res.faltantes.length, 0);
  assert.deepEqual(b.faltantes, []);
});

test('índice: idempotente y se FUSIONA (una corrida nueva no pierde lo anterior; un faltante que llega sale de faltantes)', async () => {
  const ts = turnos('2026-11-08T00:40Z', '2026-11-08T03:30Z');
  const sin = ts.filter((t) => t !== T('2026-11-08T02:00Z'));
  const x = armar({ noaaTurnos: sin });
  const r1 = await S.correrSerie({ r2: x.r2, noaa: x.noaa }, { ahora: new Date(AHORA), horas: 3 });
  assert.deepEqual(r1.faltantes, [{ turno: '2026-11-08T02:00Z', motivo: 'noaa_sin_archivo' }]);
  let idx = leerJson(x.f, 'goes-serie/2026/11/08/indice.json');
  assert.equal(idx.faltantes.length, 1); assert.equal(idx.faltantes[0].hhmm, '0200'); assert.equal(idx.faltantes[0].intentos, 1);
  // segunda corrida, sigue faltando: intentos 2, no se baja nada de nuevo
  const y = armar({ objetos: Object.fromEntries(x.f.objetos), noaaTurnos: sin });
  const r2_ = await S.correrSerie({ r2: y.r2, noaa: y.noaa }, { ahora: new Date(AHORA + 5 * MIN), horas: 3 });
  assert.equal(r2_.guardadas, 0); assert.equal(y.nf.stats.bajadas, 0);
  idx = leerJson(y.f, 'goes-serie/2026/11/08/indice.json');
  assert.equal(idx.faltantes[0].intentos, 2);
  assert.equal(idx.imagenes.length, sin.length);
  // tercera: NOAA la publicó tarde → se guarda, sale de faltantes y el resto del índice sigue igual
  const z = armar({ objetos: Object.fromEntries(y.f.objetos), noaaTurnos: ts });
  const r3 = await S.correrSerie({ r2: z.r2, noaa: z.noaa }, { ahora: new Date(AHORA + 10 * MIN), horas: 3 });
  assert.equal(r3.guardadas, 1); assert.equal(z.nf.stats.bajadas, 1);
  idx = leerJson(z.f, 'goes-serie/2026/11/08/indice.json');
  assert.deepEqual(idx.faltantes, []);
  assert.equal(idx.imagenes.length, ts.length);
  assert.ok(idx.imagenes.every((e) => e.sha256), 'ninguna entrada vieja perdió su sha256');
});

test('índice: si el índice se perdió, se rehace desde el listado de R2 (sin inventar sha256)', async () => {
  const viejos = turnos('2026-11-08T00:40Z', '2026-11-08T01:00Z');
  const { f, r2, noaa } = armar({ objetos: serieCon(viejos), noaaTurnos: [...viejos, T('2026-11-08T01:10Z')] });
  await S.correrSerie({ r2, noaa }, { ahora: new Date(T('2026-11-08T01:47Z')), horas: 1 });
  const idx = leerJson(f, 'goes-serie/2026/11/08/indice.json');
  const e = idx.imagenes.find((i) => i.hhmm === '0040');
  assert.ok(e); assert.equal(e.sha256, null); assert.match(e.nota, /listado/);
  assert.ok(idx.imagenes.find((i) => i.hhmm === '0110').sha256);
});

test('goesDesde: la imagen más vieja de la serie sin cortes que termina en la más nueva', () => {
  const ts = turnos('2026-11-08T00:00Z', '2026-11-08T03:00Z');
  assert.equal(C.goesDesde(ts), T('2026-11-08T00:00Z'));
  assert.equal(C.goesDesde(ts.filter((t) => t !== T('2026-11-08T01:30Z'))), T('2026-11-08T01:40Z'));
  assert.equal(C.goesDesde([T('2026-11-08T03:00Z')]), T('2026-11-08T03:00Z'));
  assert.equal(C.goesDesde([]), null);
});

// ───────────────────────── 3 · la rotación ─────────────────────────
test('rotación: borra a los 31 días (y a 30 d + 10 min), deja 29 d; nunca toca goes-eventos/ ni otros prefijos', async () => {
  const hace = (d, extra = 0) => C.turno(AHORA - d * DIA - extra);
  const viejo31 = hace(31), viejo30y10 = hace(30, 10 * MIN), joven29 = hace(29), justo = C.turno(AHORA - 30 * DIA + 10 * MIN);
  const objetos = {
    ...serieCon([viejo31, viejo30y10, joven29, justo]),
    [C.claveIndice(hace(32))]: '{}',                                   // día entero afuera: se borra
    [C.claveIndice(viejo30y10)]: '{}',                                 // día con turnos todavía dentro: queda
    [C.claveEventoImagen('incendio-viejo', viejo31)]: cuerpoFdcf(viejo31),
    [C.claveEventoImagen('incendio-viejo', hace(200))]: cuerpoFdcf(hace(200)),
    [C.claveManifiesto('incendio-viejo')]: '{}',
    'goes-serie/LEEME.txt': 'x', 'goes-serie/2026/09/01/basura.json': 'x',
    'rayos-hora/2026/09/01/00.json': '{}',
  };
  const ts = turnos('2026-11-08T00:40Z', '2026-11-08T03:30Z');
  const { f, r2, noaa } = armar({ objetos, noaaTurnos: ts });
  const res = await S.correrSerie({ r2, noaa }, { ahora: new Date(AHORA), horas: 3 });
  assert.deepEqual(f.stats.borrados.sort(), [C.claveImagen(viejo31), C.claveImagen(viejo30y10), C.claveIndice(hace(32))].sort());
  assert.equal(res.borradas, 3);
  for (const k of [C.claveImagen(joven29), C.claveImagen(justo), C.claveIndice(viejo30y10), C.claveManifiesto('incendio-viejo'),
    C.claveEventoImagen('incendio-viejo', viejo31), C.claveEventoImagen('incendio-viejo', hace(200)), 'goes-serie/LEEME.txt',
    'goes-serie/2026/09/01/basura.json', 'rayos-hora/2026/09/01/00.json']) assert.ok(f.objetos.has(k), 'quedó ' + k);
});

test('rotación (pura): sólo claves de imagen o índice bajo goes-serie/', () => {
  const v = C.turno(AHORA - 40 * DIA);
  const claves = [C.claveImagen(v), C.claveIndice(v), C.claveEventoImagen('ev-1', v), C.claveManifiesto('ev-1'),
    'x/' + C.claveImagen(v), C.claveImagen(v).replace('.nc', '.nc.tmp'), 'goes-serie/2026/09/29/0005.nc', 'goes-seriex/2026/09/29/0000.nc'];
  assert.deepEqual(C.aRotar(claves, AHORA), [C.claveImagen(v), C.claveIndice(v)]);
});

test('rotación: con la serie parada (nada nuevo ni de las últimas 24 h) NO se borra nada', async () => {
  const viejos = [C.turno(AHORA - 31 * DIA), C.turno(AHORA - 3 * DIA)];
  const { f, r2, noaa } = armar({ objetos: serieCon(viejos), noaaTurnos: [] });     // NOAA no publica nada
  const res = await S.correrSerie({ r2, noaa }, { ahora: new Date(AHORA), horas: 3 });
  assert.equal(res.borradas, 0); assert.deepEqual(f.stats.borrados, []);
  assert.ok(res.avisos.some((a) => /rotación frenada/.test(a)));
  assert.equal(res.codigo, 1, 'los turnos cerrados sin archivo son faltantes');
});

// ───────────────────────── 4 · una imagen que falla no corta la serie ─────────────────────────
test('fallos: cada imagen que falla es un faltante con su motivo y la serie sigue (de a 2 bajadas)', async () => {
  const ts = turnos('2026-11-08T00:40Z', '2026-11-08T03:30Z');
  const mal = { [T('2026-11-08T01:00Z')]: 'http500', [T('2026-11-08T01:30Z')]: 'corto', [T('2026-11-08T02:00Z')]: 'no_hdf5', [T('2026-11-08T02:30Z')]: 'red' };
  const { f, r2, noaa, nf } = armar({ noaaTurnos: ts, noaaFallar: mal, r2Opc: { fallar: { 'goes-serie/2026/11/08/0300.nc': 'put500' } } });
  const res = await S.correrSerie({ r2, noaa }, { ahora: new Date(AHORA), horas: 3 });
  const por = Object.fromEntries(res.faltantes.map((x) => [x.turno, x.motivo]));
  assert.deepEqual(por, {
    '2026-11-08T01:00Z': 'noaa_http_500', '2026-11-08T01:30Z': 'noaa_incompleto', '2026-11-08T02:00Z': 'noaa_no_hdf5',
    '2026-11-08T02:30Z': 'red', '2026-11-08T03:00Z': 'r2_escribir_http_500',
  });
  assert.equal(res.guardadas, ts.length - 5);
  assert.ok(f.objetos.has('goes-serie/2026/11/08/0330.nc'), 'las de después del fallo se guardaron');
  assert.ok(!f.objetos.has('goes-serie/2026/11/08/0130.nc'), 'la cortada no se guardó');
  assert.equal(res.codigo, 1);
  assert.ok(nf.stats.maxSimultaneas <= 2, 'de a 2 por vez');
  const idx = leerJson(f, 'goes-serie/2026/11/08/indice.json');
  assert.deepEqual(idx.faltantes.map((x) => x.hhmm), ['0100', '0130', '0200', '0230', '0300']);
  assert.equal(idx.imagenes.length, ts.length - 5);
});

test('fallos: turno cerrado sin archivo = faltante; sin cerrar = pendiente; listado de NOAA caído en una hora = faltan sus turnos cerrados', async () => {
  const ts = turnos('2026-11-08T00:40Z', '2026-11-08T03:10Z');           // NOAA todavía no publicó 03:20 en adelante
  const { r2, noaa } = armar({ noaaTurnos: ts.filter((t) => t !== T('2026-11-08T01:50Z')), listarFalla: [T('2026-11-08T02:00Z')] });
  const res = await S.correrSerie({ r2, noaa }, { ahora: new Date(AHORA), horas: 3 });
  const por = Object.fromEntries(res.faltantes.map((x) => [x.turno, x.motivo]));
  assert.equal(por['2026-11-08T01:50Z'], 'noaa_sin_archivo');
  for (const m of ['00', '10', '20', '30', '40', '50']) assert.equal(por[`2026-11-08T02:${m}Z`], 'noaa_listar_http_503');
  assert.equal(res.pendientes, 3, '03:20, 03:30 y 03:40 no cerraron');
  assert.ok(!('2026-11-08T03:20Z' in por));
  assert.equal(res.guardadas, ts.length - 1 - 6);
});

test('fallos: si no se puede listar R2, no se baja ni se rota nada (código 2) y el resumen no trae secretos', async () => {
  const f = r2Falso({ secreto: 'otro-secreto' });
  const r2 = R.r2({ cuenta: f.cuenta, clave: f.clave, secreto: 'secreto-que-no-va', deposito: f.deposito, fetchFn: f.fetchFn });
  const nf = noaaFalso({ turnos: turnos('2026-11-08T00:40Z', '2026-11-08T03:30Z') });
  const res = await S.correrSerie({ r2, noaa: { listarHora: (ms) => N.listarHora(ms, nf.fetchFn), bajar: (o) => N.bajar(o, nf.fetchFn) } }, { ahora: new Date(AHORA) });
  assert.equal(res.codigo, 2); assert.equal(nf.stats.bajadas, 0);
  assert.match(res.errores[0], /r2_listar_http_403/);
  assert.ok(!JSON.stringify(res).includes('secreto-que-no-va') && !JSON.stringify(res).includes('Signature='));
});

// ───────────────────────── 5 · la copia de un evento ─────────────────────────
const T0 = '2026-11-06T15:05:00Z';
const ventana = C.turnosEvento(T(T0));
function serieConIndice(ts) {
  const o = serieCon(ts);
  const dias = new Map();
  for (const t of ts) { const k = C.claveIndice(t); if (!dias.has(k)) dias.set(k, []); dias.get(k).push({ turno: C.isoTurno(t), hhmm: C.partes(t).hhmm, clave: C.claveImagen(t), archivo: nombreFdcf(t), t_scan: new Date(t + 20000).toISOString(), bytes: cuerpoFdcf(t).length, sha256: sha(cuerpoFdcf(t)) }); }
  for (const [k, im] of dias) o[k] = JSON.stringify({ imagenes: im, faltantes: [] });
  return o;
}

test('evento: copia t0 ± 6 h (73 turnos) del lado del servidor, con manifiesto, sin tocar la serie', async () => {
  assert.equal(ventana.length, 73);
  assert.equal(C.isoTurno(ventana[0]), '2026-11-06T09:00Z'); assert.equal(C.isoTurno(ventana[72]), '2026-11-06T21:00Z');
  const fuera = [ventana[0] - 10 * MIN, ventana[72] + 10 * MIN];
  const { f, r2 } = armar({ objetos: serieConIndice([...fuera, ...ventana]) });
  const antes = new Map(f.objetos);
  const res = await E.copiarEvento({ r2 }, { evento: 'incendio-prueba', lat: '-27.45123', lon: '-57.33781', t0: T0 }, { ahora: new Date(AHORA) });
  assert.equal(res.codigo, 0); assert.equal(res.copiadas, 73); assert.equal(res.metodo, 'servidor'); assert.ok(res.completo);
  assert.equal(f.stats.copias, 73);
  for (const t of ventana) assert.deepEqual(f.objetos.get(C.claveEventoImagen('incendio-prueba', t)), cuerpoFdcf(t));
  for (const t of fuera) assert.ok(!f.objetos.has(C.claveEventoImagen('incendio-prueba', t)), 'fuera de la ventana no se copia');
  for (const [k, v] of antes) assert.deepEqual(f.objetos.get(k), v, 'la serie quedó igual: ' + k);
  const m = leerJson(f, 'goes-eventos/incendio-prueba/manifiesto.json');
  assert.equal(m.evento, 'incendio-prueba'); assert.equal(m.lat, -27.4512); assert.equal(m.lon, -57.3378); assert.equal(m.t0, '2026-11-06T15:05:00.000Z');
  assert.deepEqual(m.ventana, { desde: '2026-11-06T09:00Z', hasta: '2026-11-06T21:00Z', horas: 6, turnos: 73 });
  assert.equal(m.imagenes.length, 73); assert.ok(m.completo); assert.match(m.rotacion, /ninguna/);
  assert.equal(m.imagenes[0].archivo, nombreFdcf(ventana[0])); assert.equal(m.imagenes[0].sha256, sha(cuerpoFdcf(ventana[0])));
  // otra vez con los mismos datos: no copia nada de nuevo
  const y = armar({ objetos: Object.fromEntries(f.objetos) });
  const r2_ = await E.copiarEvento({ r2: y.r2 }, { evento: 'incendio-prueba', lat: -27.45123, lon: -57.33781, t0: T0 }, { ahora: new Date(AHORA + H) });
  assert.equal(r2_.copiadas, 0); assert.equal(r2_.ya_estaban, 73); assert.equal(y.f.stats.copias, 0); assert.ok(r2_.completo);
  assert.equal(leerJson(y.f, 'goes-eventos/incendio-prueba/manifiesto.json').creado, m.creado);
});

test('evento: si R2 no acepta la copia, baja y sube, y controla el sha256 del índice', async () => {
  const objetos = serieConIndice(ventana);
  const malo = C.claveImagen(ventana[10]);
  objetos[malo] = Buffer.from(cuerpoFdcf(ventana[10])); objetos[malo][100] ^= 1;      // mismo tamaño, otro contenido
  const { f, r2 } = armar({ objetos, r2Opc: { copiaNoSoportada: true } });
  const res = await E.copiarEvento({ r2 }, { evento: 'ev-bajar', lat: -27, lon: -57, t0: T0 }, { ahora: new Date(AHORA) });
  assert.equal(res.metodo, 'bajar_y_subir'); assert.equal(f.stats.copias, 0);
  assert.equal(res.copiadas, 72);
  assert.deepEqual(res.faltan, [{ turno: C.isoTurno(ventana[10]), motivo: 'origen_sha256_distinto' }]);
  assert.ok(!f.objetos.has(C.claveEventoImagen('ev-bajar', ventana[10])));
  assert.equal(res.codigo, 1);
  assert.equal(leerJson(f, 'goes-eventos/ev-bajar/manifiesto.json').metodo_copia, 'bajar_y_subir');
});

test('evento: lo que falta va al manifiesto con su motivo (rotada, sin imagen, pendiente, error de copia) y nunca se rellena', async () => {
  // t0 hace 30 d: la primera parte de la ventana ya rotó
  const t0v = new Date(C.turno(AHORA - 30 * DIA)).toISOString().slice(0, 16) + 'Z';
  const v = C.turnosEvento(T(t0v));
  const presentes = v.filter((t) => t >= AHORA - 30 * DIA);
  const { f, r2 } = armar({ objetos: serieConIndice(presentes) });
  const res = await E.copiarEvento({ r2 }, { evento: 'ev-borde', lat: -30, lon: -60, t0: t0v }, { ahora: new Date(AHORA) });
  assert.ok(res.faltan.length > 0 && res.faltan.every((x) => x.motivo === 'rotada'));
  assert.equal(res.copiadas + res.faltan.length, 73);
  // t0 reciente: las horas que vienen quedan pendientes; un hueco de la serie es «sin_imagen_en_serie»; un 500 en una copia
  const t0r = '2026-11-08T01:00:00Z';
  const vr = C.turnosEvento(T(t0r));
  const hay = vr.filter((t) => t <= T('2026-11-08T03:10Z') && t !== T('2026-11-07T22:00Z'));
  const x = armar({ objetos: serieConIndice(hay), r2Opc: { fallar: { [C.claveEventoImagen('ev-reciente', T('2026-11-08T00:00Z'))]: 'copia500' } } });
  const rr = await E.copiarEvento({ r2: x.r2 }, { evento: 'ev-reciente', lat: -30, lon: -60, t0: t0r }, { ahora: new Date(AHORA) });
  const por = Object.fromEntries(rr.faltan.map((q) => [q.turno, q.motivo]));
  assert.equal(por['2026-11-07T22:00Z'], 'sin_imagen_en_serie');
  assert.equal(por['2026-11-08T00:00Z'], 'r2_copiar_http_500');
  assert.equal(rr.pendientes, vr.filter((t) => t > T('2026-11-08T03:10Z') && t + 30 * MIN > AHORA).length);
  assert.ok(!rr.completo);
  const m = leerJson(x.f, 'goes-eventos/ev-reciente/manifiesto.json');
  assert.equal(m.imagenes.length, hay.length - 1); assert.equal(m.completo, false);
  assert.ok(!x.f.objetos.has(C.claveEventoImagen('ev-reciente', T('2026-11-07T22:00Z'))));
});

test('evento: entradas inválidas y un evento que ya existe con otros datos no escriben nada', async () => {
  const malos = [
    { evento: '../serie', lat: -27, lon: -57, t0: T0 }, { evento: 'Mayus', lat: -27, lon: -57, t0: T0 }, { evento: 'ab', lat: -27, lon: -57, t0: T0 },
    { evento: 'ev-ok', lat: 'abc', lon: -57, t0: T0 }, { evento: 'ev-ok', lat: '', lon: -57, t0: T0 }, { evento: 'ev-ok', lat: -95, lon: -57, t0: T0 },
    { evento: 'ev-ok', lat: -27, lon: -57, t0: '2026-11-06 15:05' }, { evento: 'ev-ok', lat: -27, lon: -57, t0: '2026-11-09T15:05Z' },
    { evento: 'ev-ok', lat: -27, lon: -57, t0: '2026-09-01T00:00Z' },
  ];
  for (const e of malos) {
    const { f, r2 } = armar({ objetos: serieConIndice(ventana) });
    const n = f.objetos.size;
    const res = await E.copiarEvento({ r2 }, e, { ahora: new Date(AHORA) });
    assert.equal(res.codigo, 2, JSON.stringify(e)); assert.equal(f.objetos.size, n); assert.equal(f.stats.puts + f.stats.copias, 0);
  }
  const { f, r2 } = armar({ objetos: { ...serieConIndice(ventana), 'goes-eventos/ev-ya/manifiesto.json': JSON.stringify({ evento: 'ev-ya', lat: -27, lon: -57, t0: '2026-11-06T12:00:00.000Z' }) } });
  const res = await E.copiarEvento({ r2 }, { evento: 'ev-ya', lat: -27, lon: -57, t0: T0 }, { ahora: new Date(AHORA) });
  assert.deepEqual(res.errores, ['evento_ya_existe_con_otros_datos']); assert.equal(f.stats.puts + f.stats.copias, 0);
});

test('evento + rotación: 31 días después la serie rota y la ventana del evento queda entera', async () => {
  const { f, r2 } = armar({ objetos: serieConIndice(ventana) });
  await E.copiarEvento({ r2 }, { evento: 'ev-largo', lat: -27, lon: -57, t0: T0 }, { ahora: new Date(AHORA) });
  const luego = T(T0) + 31 * DIA + 7 * H;
  const nuevos = C.turnosEntre(luego - 3 * H, luego - 40 * MIN);
  const y = armar({ objetos: Object.fromEntries(f.objetos), noaaTurnos: nuevos });
  const res = await S.correrSerie({ r2: y.r2, noaa: y.noaa }, { ahora: new Date(luego), horas: 3 });
  assert.ok(res.borradas >= 73);
  for (const t of ventana) { assert.ok(!y.f.objetos.has(C.claveImagen(t))); assert.ok(y.f.objetos.has(C.claveEventoImagen('ev-largo', t))); }
  assert.ok(y.f.objetos.has('goes-eventos/ev-largo/manifiesto.json'));
  assert.ok(y.f.stats.borrados.every((k) => k.startsWith('goes-serie/')));
});

// ───────────────────────── 6 · el prefijo para el firmador ─────────────────────────
test('firmador (propuesta): índices de 30 días, imágenes de 24 h y todo goes-eventos/', () => {
  const lista = [
    C.claveIndice(AHORA), C.claveIndice(AHORA - 29 * DIA), C.claveIndice(AHORA - 30 * DIA),
    C.claveImagen(AHORA - 10 * MIN), C.claveImagen(AHORA - 23 * H), C.claveImagen(AHORA - 25 * H),
    C.claveManifiesto('ev-1'), C.claveEventoImagen('ev-1', AHORA - 90 * DIA), 'goes-eventos/ev-1/otra.txt', 'rayos-hora/2026/11/08/00.json',
  ].map((clave) => ({ clave, bytes: 1 }));
  const r = C.clavesAFirmar(lista, AHORA);
  assert.deepEqual(r.serie_indices.map((o) => o.clave), [C.claveIndice(AHORA), C.claveIndice(AHORA - 29 * DIA)]);
  assert.deepEqual(r.serie_imagenes.map((o) => o.clave), [C.claveImagen(AHORA - 10 * MIN), C.claveImagen(AHORA - 23 * H)]);
  assert.deepEqual(r.eventos_manifiestos.map((o) => o.clave), [C.claveManifiesto('ev-1')]);
  assert.deepEqual(r.eventos_imagenes.map((o) => o.clave), [C.claveEventoImagen('ev-1', AHORA - 90 * DIA)]);
});

// ───────────────────────── 7 · la entrada, sin secretos ─────────────────────────
test('entrada: sin las variables de R2 sale con código 2 y sin pedir nada', () => {
  const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('R2_')) delete env[k];
  const r = spawnSync(process.execPath, [path.join(dir, 'goes-serie.mjs')], { encoding: 'utf8', env });
  assert.equal(r.status, 2); assert.match(r.stderr, /faltan_secretos_r2/);
});
