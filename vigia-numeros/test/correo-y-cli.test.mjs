// Codex, 2.ª vuelta (n3-colectores-vigia-numeros): el SMTP compartido (vigia/lib/correo.mjs) no puede quedar colgado ni
// terminar «en silencio», y el CLI tiene que salir con el código que dice el LEEME. Sin red: servidores locales.
// node --test vigia-numeros/test/correo-y-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mandar } from '../../vigia/lib/correo.mjs';
import { correr } from '../vigia-numeros.mjs';
import { crearLector } from '../lib/fuentes.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url)), D = path.join(AQUI, 'datos');
const txt = (n) => fs.readFileSync(path.join(D, n), 'utf8');
const APP = txt('app_precios-granos_2026-11-10.json'), FOB = txt('magyp_fob_2026-11-10.json'), BNA = txt('bna_cotizaciones_2026-11-10.html'), BCR = txt('bcr_pizarra_2026-11-10.html');
const base = { usuario: 'u', clave: 'c', de: 'u@x.test', para: ['a@x.test'], asunto: 'x', cuerpo: 'x' };
async function servidor(alConectar) { const srv = net.createServer(alConectar); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return srv; }
const conectarA = (srv) => () => net.connect(srv.address().port, '127.0.0.1');

/* un servidor SMTP que contesta todo bien; `cortarEn` = la línea del cliente tras la cual cierra sin contestar */
function smtpFalso({ cortarEn = null, destruir = false } = {}) {
  return (s) => {
    let buf = '', enData = false, n = 0;
    s.write('220 hola\r\n');
    s.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (enData) { if (l === '.') { enData = false; s.write('250 ok\r\n'); } continue; }
        n++;
        if (cortarEn && l.startsWith(cortarEn)) { destruir ? s.destroy() : s.end(); return; }
        if (/^EHLO/.test(l)) s.write('250-hola\r\n250 AUTH LOGIN\r\n');
        else if (l === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else if (n === 3) s.write('334 UGFzc3dvcmQ6\r\n');
        else if (n === 4) s.write('235 ok\r\n');
        else if (/^MAIL FROM|^RCPT TO/.test(l)) s.write('250 ok\r\n');
        else if (l === 'DATA') { enData = true; s.write('354 dale\r\n'); }
        else if (l === 'QUIT') { s.write('221 chau\r\n'); s.end(); }
      }
    });
  };
}

test('SMTP: el diálogo completo sigue andando', { timeout: 5000 }, async () => {
  const srv = await servidor(smtpFalso());
  try { assert.deepEqual(await mandar({ ...base, host: '127.0.0.1', port: 465, _conectar: conectarA(srv) }), { ok: true, destinatarios: 1 }); } finally { srv.close(); }
});
test('⭐ SMTP: el servidor cierra LIMPIO a mitad del diálogo (después de MAIL FROM) → rechaza, no queda colgado', { timeout: 5000 }, async () => {
  const srv = await servidor(smtpFalso({ cortarEn: 'MAIL FROM' }));
  try { await assert.rejects(mandar({ ...base, host: '127.0.0.1', port: 465, tiempoMs: 60000, _conectar: conectarA(srv) }), /cerr/); } finally { srv.close(); }
});
test('SMTP: el servidor corta de golpe (destroy) en el DATA → rechaza', { timeout: 5000 }, async () => {
  const srv = await servidor(smtpFalso({ cortarEn: 'DATA', destruir: true }));
  try { await assert.rejects(mandar({ ...base, host: '127.0.0.1', port: 465, tiempoMs: 60000, _conectar: conectarA(srv) })); } finally { srv.close(); }
});
test('⭐ SMTP: el servidor acepta y NO contesta nunca → rechaza por tiempo, dentro del tope', { timeout: 5000 }, async () => {
  const abiertos = []; const srv = await servidor((s) => abiertos.push(s));
  const t0 = Date.now();
  try { await assert.rejects(mandar({ ...base, host: '127.0.0.1', port: 465, tiempoMs: 300, _conectar: conectarA(srv) }), /tiempo/); }
  finally { abiertos.forEach((s) => s.destroy()); srv.close(); }
  assert.ok(Date.now() - t0 < 1500, 'tardó ' + (Date.now() - t0) + ' ms');
});
test('SMTP: un cierre DESPUÉS de aceptar el DATA (sin contestar el QUIT) no es falla', { timeout: 5000 }, async () => {
  const srv = await servidor(smtpFalso({ cortarEn: 'QUIT' }));
  try { assert.deepEqual(await mandar({ ...base, host: '127.0.0.1', port: 465, _conectar: conectarA(srv) }), { ok: true, destinatarios: 1 }); } finally { srv.close(); }
});

/* ── vigia-numeros: el envío fallido ─────────────────────────────────── */
test('⭐ el envío falla → el resumen ya se imprimió ANTES, y después ENVIO_FALLO (código fijo, sin el mensaje crudo)', async () => {
  const logs = [];
  const red = async (u) => ({ ok: true, status: 200, text: async () => (u.includes('precios-granos') ? JSON.stringify({ ...JSON.parse(APP), tc_ars_usd: 1300 }) : u.includes('bna') ? BNA : u.includes('bcr') ? BCR : u.includes('monitorsiogranos') ? 'Error' : FOB) });
  const x = await correr({ seco: false, fetchFn: red, mandarFn: async () => { throw new Error('getaddrinfo ENOTFOUND smtp.secreto.example'); }, log: (s) => logs.push(s), env: {} });
  assert.equal(x.envio, 'ENVIO_FALLO');
  assert.equal(JSON.parse(logs[0]).mail, 'a mandar');
  assert.deepEqual(JSON.parse(logs[1]), { envio: 'ENVIO_FALLO' });
  assert.ok(!logs.join(' ').includes('secreto'), 'el mensaje crudo no va al registro');
});
test('MAGyP: la primaria trae sólo OTRO día → se prueba la alternativa antes de declararlo faltante', async () => {
  const otro = JSON.stringify({ posts: JSON.parse(FOB).posts.map((p) => ({ ...p, fecha: '2026-11-07 00:00:00.000' })) });
  const vistas = [];
  const L = crearLector({ fetchFn: async (u) => { vistas.push(u); return { ok: true, status: 200, text: async () => (u.includes('monitorsiogranos') ? otro : FOB) }; } });
  const r = await L.magyp('10/11/2026');
  assert.equal(r.ok, true); assert.equal(vistas.length, 2);
});

/* ── el CLI de verdad, con su código de salida (servidor HTTP local en lugar de la red) ── */
async function correrCLI({ magyp = 200, real = false, smtpPort = null } = {}) {
  const srv = http.createServer((q, s) => {
    const u = q.url;
    const cuerpo = u.startsWith('/app') ? APP : u.startsWith('/bna') ? BNA : u.startsWith('/bcr') ? BCR : u.startsWith('/magyp') ? (magyp === 200 ? FOB : null) : null;
    if (cuerpo == null) { s.writeHead(503); s.end(); return; }
    s.writeHead(200); s.end(cuerpo);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = 'http://127.0.0.1:' + srv.address().port;
  const env = { ...process.env, VIGIA_NUMEROS_URLS: JSON.stringify({ app: b + '/app', bna: b + '/bna', bcr: b + '/bcr', magyp: [b + '/magyp1', b + '/magyp2'] }) };
  if (real) Object.assign(env, { SATCHI_SMTP_HOST: '127.0.0.1', SATCHI_SMTP_PORT: String(smtpPort), SATCHI_SMTP_USER: 'u', SATCHI_SMTP_PASS: 'c', SATCHI_VIGIA_DESTINO: 'a@x.test' });
  try {
    return await new Promise((res) => {
      const p = spawn(process.execPath, [path.join(AQUI, '..', 'vigia-numeros.mjs'), ...(real ? [] : ['--seco'])], { env });
      let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => res({ code, out, err }));
    });
  } finally { srv.close(); }
}
test('⭐ CLI: el día completo sale con 0 y UNA línea de cantidades', { timeout: 15000 }, async () => {
  const r = await correrCLI();
  assert.equal(r.code, 0, r.err);
  const lineas = r.out.trim().split('\n'); assert.equal(lineas.length, 1);
  assert.equal(JSON.parse(lineas[0]).verificacion, 'completa');
});
test('⭐ CLI: MAGyP caído → INCOMPLETO y salida 1 (Actions en rojo)', { timeout: 15000 }, async () => {
  const r = await correrCLI({ magyp: 503 });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out.trim().split('\n')[0]).verificacion, 'INCOMPLETO');
});
test('⭐ CLI real: el SMTP corta la conexión → ENVIO_FALLO y salida 1, sin el nombre del servidor en el registro', { timeout: 15000 }, async () => {
  const smtp = await servidor((s) => s.destroy());
  try {
    const r = await correrCLI({ magyp: 503, real: true, smtpPort: smtp.address().port });
    assert.equal(r.code, 1);
    assert.match(r.out, /"envio":"ENVIO_FALLO"/);
    assert.ok(!/127\.0\.0\.1/.test(r.out + r.err), 'el registro no lleva el servidor');
  } finally { smtp.close(); }
});
