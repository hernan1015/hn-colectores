// Tests del vigía de SATCHI con datos REALES del 10/11/2026 (test/datos/, bajados de satchi-publico, 21:19-21:23 UTC).
// node --test vigia/test/vigia.test.mjs · control negativo: node vigia/test/control-negativo.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escalasEnEvacuacion, escalasFueraDeEvacuacion, pronosticoQueCruza, focosGrandes, nuevos, textoDe } from '../lib/reglas.mjs';
import { invoco, crearLector } from '../lib/fuentes.mjs';
import { mandar, armarMensaje } from '../lib/correo.mjs';
import { correr } from '../vigia-satchi.mjs';
import { crearEstadoSupabase } from '../lib/estado.mjs';

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos');
const leer = (n) => JSON.parse(fs.readFileSync(path.join(D, n), 'utf8'));
const ESC = leer('escalas_2026-11-10.json'), PRO = leer('prono_2026-11-10.json'), FOC = leer('focos_pais_2026-11-10.json');
const CHICOS = leer('focos_chicos_corrientes_2026-11-10.json');
const AHORA = Date.parse('2026-11-10T21:30:00Z');

/* ── crecidas ─────────────────────────────────────────────────────────────── */
test('⭐ Reconquista en evacuación (5,80 m, cota 5,30) da aviso', () => {
  const r = escalasEnEvacuacion(ESC).find((x) => x.nombre === 'Reconquista');
  assert.ok(r, 'Reconquista tiene que estar');
  assert.equal(r.h, 5.8); assert.equal(r.evacuacion_m, 5.3); assert.equal(r.clave, 'escala:24:evacuacion');
  assert.equal(nuevos([r], new Map(), AHORA).length, 1);
});
test('⭐ una escala normal no da aviso (Rosario 4,30 m, nivel 4; Santa Fe 5,02 m)', () => {
  const nombres = escalasEnEvacuacion(ESC).map((x) => x.nombre);
  assert.ok(!nombres.includes('Rosario')); assert.ok(!nombres.includes('Santa Fe'));
  assert.ok(escalasFueraDeEvacuacion(ESC).includes('escala:34:evacuacion'));
});
test('una escala en ALERTA (no evacuación) no da aviso: Itatí 7,36 m, alerta 6,8, evacuación 7,5', () => {
  assert.ok(!escalasEnEvacuacion(ESC).some((x) => x.nombre === 'Itatí'));
});
test('una escala sin lectura reciente (nivel null) no avisa ni se «rearma»', () => {
  assert.ok(!escalasEnEvacuacion(ESC).some((x) => x.nombre === 'Brazo Largo'));
  assert.ok(!escalasFueraDeEvacuacion(ESC).includes('escala:97:evacuacion'));
});
test('ya avisada y activa: no se repite; si bajó y se rearmó, vuelve a avisar', () => {
  const r = escalasEnEvacuacion(ESC).find((x) => x.nombre === 'Reconquista');
  assert.equal(nuevos([r], new Map([[r.clave, { activo: true, tipo: 'crecida' }]]), AHORA).length, 0);
  assert.equal(nuevos([r], new Map([[r.clave, { activo: false, tipo: 'crecida' }]]), AHORA).length, 1);
});
test('pronóstico real de hoy: ninguna de las 8 ciudades cruza la evacuación en 72 h (Rosario 4,3 m, cota 5,3)', () => {
  assert.equal(pronosticoQueCruza(PRO, ESC, AHORA).length, 0);
});
test('pronóstico que cruza (la serie real de Rosario subida 1,1 m, armado a mano): avisa', () => {
  const p = JSON.parse(JSON.stringify(PRO));
  const ro = p.ciudades.find((c) => c.nombre === 'Rosario'); ro.puntos = ro.puntos.map((x) => ({ ...x, h: x.h + 1.1, t: new Date(AHORA + 6 * 3600e3).toISOString() }));
  const r = pronosticoQueCruza(p, ESC, AHORA);
  assert.equal(r.length, 1); assert.equal(r[0].nombre, 'Rosario');
});

/* ── focos ────────────────────────────────────────────────────────────────── */
test('⭐ los focos grandes reales de hoy salen todos (12) y en las provincias elegidas, sólo esos', () => {
  assert.equal(focosGrandes(FOC).length, 12);
  const f = focosGrandes(FOC, ['Formosa']);
  assert.ok(f.length >= 1 && f.every((x) => x.provincia === 'Formosa'));
  assert.deepEqual(focosGrandes(FOC, ['Santa Fe']), []);
});
test('⭐ foco chico no avisa: Corrientes tiene 86 detecciones FIRMS reales hoy, ninguna arma un grupo grande', () => {
  assert.equal(CHICOS.focos.length, 86);
  assert.deepEqual(focosGrandes(FOC, ['Corrientes']), []);
  /* y un grupo por debajo del umbral de SATCHI (29 FIRMS y 3 GOES) no pasa aunque viniera en la lista */
  const casi = { ...FOC, grandes: [{ lat: -27.5, lon: -58.8, provincia: 'Corrientes', firms_n: 29, goes_n: 3 }] };
  assert.deepEqual(focosGrandes(casi, ['Corrientes']), []);
});
test('un foco ya avisado a ≤ 15 km en las últimas 24 h no se repite; a 40 km sí', () => {
  const [a] = focosGrandes(FOC, ['Catamarca']);
  const est = (lat, lon, h) => new Map([['x', { tipo: 'foco', ultimo_aviso: new Date(AHORA - h * 3600e3).toISOString(), detalle: { lat, lon } }]]);
  assert.equal(nuevos([a], est(a.lat + 0.05, a.lon, 3), AHORA).length, 0);
  assert.equal(nuevos([a], est(a.lat + 0.36, a.lon, 3), AHORA).length, 1);
  assert.equal(nuevos([a], est(a.lat, a.lon, 30), AHORA).length, 1);   // pasó el día
});

/* ── costo: invocaciones ──────────────────────────────────────────────────── */
test('⭐ la caché de Netlify: un hit no invoca la function; miss, stale y bypass sí (cabeceras reales)', () => {
  assert.equal(invoco('"Netlify Durable"; hit; ttl=3575, "Netlify Edge"; fwd=miss; fwd-status=200; stored'), false);
  assert.equal(invoco('"Netlify Durable"; fwd=vary-miss; stored, "Netlify Edge"; fwd=miss; fwd-status=200; stored'), true);
  assert.equal(invoco('"Netlify Durable"; fwd=bypass, "Netlify Edge"; fwd=miss; fwd-status=200'), true);
  assert.equal(invoco('"Netlify Durable"; fwd=stale; ttl=-40753; stored, "Netlify Edge"; fwd=miss'), true);
  assert.equal(invoco(null), null);
});

/* ── de punta a punta, en seco ────────────────────────────────────────────── */
function redFalsa(cache = {}) {
  return async (u) => {
    const q = new URL(u).searchParams, que = q.get('que'), parte = q.get('parte');
    const cuerpo = que === 'focos' ? FOC : parte === 'escalas' ? ESC : PRO;
    const cs = cache[que + (parte || '')] || '"Netlify Durable"; hit; ttl=100, "Netlify Edge"; fwd=miss';
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { 'cache-status': cs } });
  };
}
test('⭐ --seco: calcula y muestra, sin mail y sin base; en el registro sólo cantidades', async () => {
  const salida = [];
  let mails = 0;
  const r = await correr({ seco: true, ahoraMs: AHORA, todo: true, env: { SATCHI_VIGIA_PROVINCIAS: 'Santa Fe,Formosa' }, fetchFn: redFalsa({ inaprono: '"Netlify Durable"; fwd=bypass' }),
    mandarFn: async () => { mails++; }, log: (s) => salida.push(s) });
  assert.equal(mails, 0);
  assert.equal(r.resumen.modo, 'seco');
  assert.ok(r.avisar.some((a) => a.nombre === 'Reconquista'));
  assert.ok(r.avisar.filter((a) => a.tipo === 'foco').every((a) => a.provincia === 'Formosa'));
  assert.equal(r.resumen.pedidos, 3); assert.equal(r.resumen.invocaciones, 1);
  assert.ok(!/SMTP|PASS|@/.test(salida[0]), 'la primera línea (la que va al registro) no lleva nada privado');
});
test('fuera de su hora el pronóstico no se pide (cada 3 h)', async () => {
  const r = await correr({ seco: true, ahoraMs: Date.parse('2026-11-10T22:31:00Z'), env: {}, fetchFn: redFalsa(), log: () => {} });
  assert.equal(r.resumen.prono_leido, false); assert.equal(r.resumen.pedidos, 2);
});
test('si SATCHI no contesta las escalas, no se inventa nada: faltan escalas, 0 crecidas', async () => {
  const f = async (u) => (new URL(u).searchParams.get('parte') === 'escalas' ? new Response('no', { status: 503 }) : redFalsa()(u));
  const r = await correr({ seco: true, ahoraMs: AHORA, env: {}, fetchFn: f, log: () => {} });
  assert.ok(r.resumen.faltan.includes('escalas'));
  assert.equal(r.avisar.filter((a) => a.tipo === 'crecida').length, 0);
});

test('si las alturas del Paraná vienen sin leer (parana.ok = false), tampoco: no se avisa con lo viejo', async () => {
  const viejo = JSON.parse(JSON.stringify(ESC)); viejo.parana.ok = false;
  const f = async (u) => (new URL(u).searchParams.get('parte') === 'escalas' ? new Response(JSON.stringify(viejo), { status: 200 }) : redFalsa()(u));
  const r = await correr({ seco: true, ahoraMs: AHORA, env: {}, fetchFn: f, log: () => {} });
  assert.ok(r.resumen.faltan.includes('escalas'));
  assert.equal(r.avisar.filter((a) => a.tipo === 'crecida').length, 0);
});

/* ── el mail ──────────────────────────────────────────────────────────────── */
test('el texto: asunto con lo que pasa, Reconquista con su altura y su cota, y el aviso de prueba', () => {
  const t = textoDe(escalasEnEvacuacion(ESC).filter((x) => x.nombre === 'Reconquista'), { prueba: true, ahoraMs: AHORA });
  assert.match(t.asunto, /^\[SATCHI vigía · prueba\] 1 escala en evacuación$/);
  assert.match(t.cuerpo, /Reconquista \(Santa Fe\): 5,80 m, la cota de evacuación es 5,30 m/);
  assert.match(t.cuerpo, /MODO PRUEBA/);
});
test('SMTP: el diálogo completo contra un servidor falso local (AUTH LOGIN, varios destinatarios, DATA)', async () => {
  const visto = [];
  const srv = net.createServer((s) => {
    let buf = '', enData = false;
    s.write('220 hola\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (enData) { if (l === '.') { enData = false; s.write('250 ok\r\n'); } else visto.push('D:' + l); continue; }
        visto.push(l);
        if (/^EHLO/.test(l)) s.write('250-hola\r\n250 AUTH LOGIN\r\n');
        else if (l === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else if (visto.length === 3 || visto.length === 4) s.write(visto.length === 3 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n');
        else if (/^MAIL FROM|^RCPT TO/.test(l)) s.write('250 ok\r\n');
        else if (l === 'DATA') { enData = true; s.write('354 dale\r\n'); }
        else if (l === 'QUIT') { s.write('221 chau\r\n'); s.end(); }
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await mandar({ host: '127.0.0.1', port: 465, usuario: 'u@ejemplo.test', clave: 'clave-de-prueba', de: 'u@ejemplo.test', para: ['a@ejemplo.test', 'b@ejemplo.test'],
      asunto: '[SATCHI vigía · prueba] 1 escala en evacuación', cuerpo: 'Reconquista 5,80 m', _conectar: () => net.connect(port, '127.0.0.1') });
    assert.deepEqual(r, { ok: true, destinatarios: 2 });
    assert.equal(visto.filter((l) => /^RCPT TO/.test(l)).length, 2);
    const datos = visto.filter((l) => l.startsWith('D:')).map((l) => l.slice(2));
    const cuerpo = Buffer.from(datos.slice(datos.indexOf('') + 1).join(''), 'base64').toString('utf8');
    assert.equal(cuerpo, 'Reconquista 5,80 m');
    assert.ok(datos.some((l) => l.startsWith('Subject: =?UTF-8?B?')));
  } finally { srv.close(); }
});
test('SMTP en 587 sin STARTTLS: NO manda la clave en claro', async () => {
  const srv = net.createServer((s) => { s.write('220 hola\r\n'); s.on('data', (d) => { if (/^EHLO/.test(d.toString())) s.write('250 AUTH LOGIN\r\n'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(mandar({ host: '127.0.0.1', port: 587, usuario: 'u', clave: 'c', de: 'u@x.test', para: ['a@x.test'], asunto: 'x', cuerpo: 'x',
      _conectar: () => net.connect(srv.address().port, '127.0.0.1') }), /STARTTLS/);
  } finally { srv.close(); }
});
test('el mensaje: un renglón que empieza con «.» va duplicado (no corta el DATA)', () => {
  const m = armarMensaje({ de: 'a@x.test', para: ['b@x.test'], asunto: 'x', cuerpo: '.hola' });
  const b = m.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(b, 'base64').toString('utf8'), '..hola');
});

/* ── el estado en Supabase (API REST simulada: nunca se toca la base real) ─── */
test('estado: lee activos y recientes, marca avisado (upsert por clave) y rearma; la clave va en cabeceras, no en la URL', async () => {
  const pedidos = [];
  const f = async (u, o) => { pedidos.push({ u, m: o.method, h: o.headers, b: o.body }); return new Response(o.method === 'GET' ? JSON.stringify([{ clave: 'escala:24:evacuacion', tipo: 'crecida', activo: true }]) : '', { status: 200 }); };
  const E = crearEstadoSupabase({ url: 'https://ejemplo.supabase.co/', clave: 'clave-falsa', fetchFn: f });
  const m = await E.leer(AHORA);
  assert.equal(m.get('escala:24:evacuacion').activo, true);
  await E.avisado(escalasEnEvacuacion(ESC).slice(0, 2), AHORA);
  await E.rearmar(['escala:34:evacuacion'], AHORA);
  assert.deepEqual(pedidos.map((p) => p.m), ['GET', 'POST', 'PATCH']);
  assert.ok(pedidos.every((p) => p.u.startsWith('https://ejemplo.supabase.co/rest/v1/satchi_vigia_avisos') && !p.u.includes('clave-falsa')));
  assert.match(pedidos[1].h.Prefer, /merge-duplicates/);
  assert.equal(JSON.parse(pedidos[1].b).length, 2);
  assert.ok(decodeURIComponent(pedidos[2].u).endsWith('?activo=eq.true&clave=in.("escala:34:evacuacion")'));
});
test('sin las variables de Supabase, el modo real no arranca (no avisa a ciegas)', () => {
  assert.throws(() => crearEstadoSupabase({ url: '', clave: '' }), /faltan/);
});
