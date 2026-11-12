// Tests del vigía de frescura OPERA: sin red ni mail. «hoy» fijo = 2026-11-11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { evaluar, leerIndice, ejecutarMandar, redactar } from '../opera-frescura.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(AQUI, '..', 'opera-frescura.mjs');
const D = (n) => path.join(AQUI, 'datos', n);
const leer = (n) => JSON.parse(fs.readFileSync(D(n), 'utf8'));
const HOY = '2026-11-11';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opera-frescura-'));
const enviarOk = (mails) => async (m) => { mails.push(m); return { ok: true, destinatarios: 1 }; };

// ── la regla ──
test('índice de hace 4 días → avisa, con la clave de su «hasta»', () => {
  const v = evaluar(leer('opera_pasadas_hace4d.json'), HOY);
  assert.equal(v.avisar, true); assert.equal(v.tipo, 'atraso'); assert.equal(v.dias, 4); assert.equal(v.clave, 'opera-atraso-2026-11-07');
});
test('índice de hace 1 día → no avisa', () => {
  const v = evaluar(leer('opera_pasadas_hace1d.json'), HOY);
  assert.equal(v.avisar, false); assert.equal(v.dias, 1); assert.equal(v.sano, true);
});
test('el borde: 3 días justos no avisa (la regla es «pasa de 3»)', () => {
  assert.equal(evaluar({ ok: true, fuente: 'r2', hasta: '2026-11-08' }, HOY).avisar, false);
  assert.equal(evaluar({ ok: true, fuente: 'r2', hasta: '2026-11-07' }, HOY).avisar, true);
});
test('fuente que no es r2 → avisa aunque la fecha esté al día', () => {
  const v = evaluar({ ok: true, fuente: 'deploy', hasta: '2026-11-10' }, HOY);
  assert.equal(v.avisar, true); assert.equal(v.tipo, 'fuente'); assert.equal(v.clave, 'opera-fuente-deploy-2026-11-10');
});
test('el mismo «hasta» atrasado da la misma clave en días distintos; un «hasta» nuevo, otra', () => {
  const r = { ok: true, fuente: 'r2', hasta: '2026-10-25' };
  assert.equal(evaluar(r, '2026-11-11').clave, evaluar(r, '2026-11-20').clave);
  assert.notEqual(evaluar(r, '2026-11-11').clave, evaluar({ ...r, hasta: '2026-11-01' }, '2026-11-11').clave);
});

// ── caídas: errores de red y la clave por episodio ──
test('errores de red, tiempo, HTTP y JSON roto → leerIndice da null → aviso de caída', async () => {
  const casos = [
    async () => { throw new Error('ECONNRESET'); },
    async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    async () => ({ ok: false, status: 502, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('JSON'); } }),
  ];
  for (const f of casos) {
    const r = await leerIndice({ _fetch: f, tiempoMs: 1000 });
    assert.equal(r, null);
    const v = evaluar(r, HOY, { ultimoSano: '2026-11-10' });
    assert.equal(v.avisar, true); assert.equal(v.tipo, 'caido'); assert.equal(v.sano, false);
  }
  assert.equal(evaluar({ ok: false }, HOY).tipo, 'caido');
  assert.equal(evaluar({ ok: true, fuente: 'r2' }, HOY).tipo, 'caido');   // sin «hasta»
});
test('caída por episodio: la clave lleva el último día sano; una caída nueva tras recuperarse tiene otra clave', () => {
  const primera = evaluar(null, '2026-11-12', { ultimoSano: '2026-11-10' });
  const sigue = evaluar({ ok: false }, '2026-11-14', { ultimoSano: '2026-11-10' });   // la misma caída, días después
  assert.equal(primera.clave, 'opera-caido-tras-2026-11-10'); assert.equal(sigue.clave, primera.clave);
  const nueva = evaluar(null, '2026-11-25', { ultimoSano: '2026-11-20' });           // se recuperó y se volvió a caer
  assert.notEqual(nueva.clave, primera.clave);
  assert.equal(evaluar(null, HOY).clave, 'opera-caido-tras-sin-registro');
});
test('control negativo de la clave por episodio: con la clave fija de f5a1737, dos caídas distintas daban la misma clave', () => {
  const claveVieja = (resp) => 'opera-caido-' + ((resp && resp.hasta) || 'sin-hasta');
  assert.equal(claveVieja(null), claveVieja(null));   // el 2.º episodio quedaba suprimido por la caché
  assert.notEqual(evaluar(null, '2026-11-12', { ultimoSano: '2026-11-10' }).clave, evaluar(null, '2026-11-25', { ultimoSano: '2026-11-20' }).clave);
});

// ── una sola consulta: mandar no vuelve a leer el índice ──
test('transición atraso → red caída: igual sale el mail, sin una 2.ª consulta', async () => {
  const ev = evaluar(leer('opera_pasadas_hace4d.json'), HOY);
  let consultas = 0; const fetchOrig = globalThis.fetch;
  globalThis.fetch = async () => { consultas++; throw new Error('ECONNRESET'); };
  const mails = [];
  try {
    const r = await ejecutarMandar(ev, { enviar: enviarOk(mails), cfg: {}, marcaDir: path.join(tmp(), 'm') });
    assert.equal(r.enviado, true);
  } finally { globalThis.fetch = fetchOrig; }
  assert.equal(consultas, 0); assert.equal(mails.length, 1); assert.match(mails[0].asunto, /2026-11-07/);
});
test('transición timeout → ok:false con «hasta»: sale el mail de la caída que se evaluó', async () => {
  const ev = evaluar(null, HOY, { ultimoSano: '2026-11-09' });
  let consultas = 0; const fetchOrig = globalThis.fetch;
  globalThis.fetch = async () => { consultas++; return { ok: true, json: async () => ({ ok: false, hasta: '2026-11-07' }) }; };
  const mails = [];
  try {
    const r = await ejecutarMandar(ev, { enviar: enviarOk(mails), cfg: {}, marcaDir: path.join(tmp(), 'm') });
    assert.equal(r.enviado, true);
  } finally { globalThis.fetch = fetchOrig; }
  assert.equal(consultas, 0); assert.equal(mails.length, 1); assert.match(mails[0].cuerpo, /opera-caido-tras-2026-11-09/);
});
test('control negativo de la consulta única: re-evaluar al mandar (f5a1737) cambiaba la clave en las dos transiciones', () => {
  // con el diseño viejo, `mandar` volvía a consultar y comparaba la clave con la de `evaluar`: si difería, no mandaba
  const viejaCaido = (resp) => 'opera-caido-' + ((resp && resp.hasta) || 'sin-hasta');
  assert.notEqual(viejaCaido(null), viejaCaido({ ok: false, hasta: '2026-11-07' }));             // timeout → ok:false con hasta
  assert.notEqual(evaluar(leer('opera_pasadas_hace4d.json'), HOY).clave, evaluar(null, HOY).clave); // atraso → timeout
});
test('la marca para la caché queda SÓLO si el mail salió', async () => {
  const dir = path.join(tmp(), 'm');
  await assert.rejects(ejecutarMandar(evaluar(null, HOY), { enviar: async () => { throw new Error('SMTP 535 (esperaba 235)'); }, cfg: {}, marcaDir: dir }));
  assert.equal(fs.existsSync(path.join(dir, 'clave')), false);
  await ejecutarMandar(evaluar(null, HOY), { enviar: async () => ({ ok: true, destinatarios: 1 }), cfg: {}, marcaDir: dir });
  assert.equal(fs.readFileSync(path.join(dir, 'clave'), 'utf8').trim(), 'opera-caido-tras-sin-registro');
});
test('sin aviso, ejecutarMandar no manda ni deja marca', async () => {
  const dir = path.join(tmp(), 'm'); const mails = [];
  const r = await ejecutarMandar(evaluar(leer('opera_pasadas_hace1d.json'), HOY), { enviar: enviarOk(mails), cfg: {}, marcaDir: dir });
  assert.equal(r.enviado, false); assert.equal(mails.length, 0); assert.equal(fs.existsSync(dir), false);
});

// ── el CLI ──
test('CLI: evaluar escribe la evaluación y GITHUB_OUTPUT; mandar exige --evaluacion', () => {
  const t = tmp(); const out = path.join(t, 'gh_output'), ev = path.join(t, 'ev.json'), sano = path.join(t, 'sano');
  fs.writeFileSync(sano, '2026-11-10\n');
  execFileSync(process.execPath, [CLI, 'evaluar', '--fixture', D('opera_pasadas_hace4d.json'), '--hoy', HOY, '--salida', ev, '--sano-archivo', sano], { env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.match(fs.readFileSync(out, 'utf8'), /avisar=si\nclave=opera-atraso-2026-11-07\nsano=si/);
  assert.equal(JSON.parse(fs.readFileSync(ev, 'utf8')).clave, 'opera-atraso-2026-11-07');
  fs.writeFileSync(out, '');
  execFileSync(process.execPath, [CLI, 'evaluar', '--fixture', D('opera_pasadas_hace1d.json'), '--hoy', HOY, '--salida', ev], { env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.match(fs.readFileSync(out, 'utf8'), /avisar=no\nclave=ninguna\nsano=si/);
  assert.throws(() => execFileSync(process.execPath, [CLI, 'mandar'], { stdio: 'pipe' }));
});

// ── secretos en los errores ──
test('redactar: el host, el usuario, la clave y los destinos del SMTP no salen en el error', () => {
  const env = { SATCHI_SMTP_HOST: 'smtp.secreto-ejemplo.net', SATCHI_SMTP_USER: 'avisos@ejemplo.org', SATCHI_SMTP_PASS: 'clave-de-prueba-123', SATCHI_VIGIA_DESTINO: 'uno@ejemplo.org, dos@otro.net' };
  const msg = 'getaddrinfo ENOTFOUND smtp.secreto-ejemplo.net; Host: smtp.secreto-ejemplo.net. is not in the cert altnames; user avisos@ejemplo.org pass clave-de-prueba-123 to dos@otro.net';
  const r = redactar(msg, env);
  for (const v of ['smtp.secreto-ejemplo.net', 'avisos@ejemplo.org', 'clave-de-prueba-123', 'dos@otro.net']) assert.equal(r.includes(v), false);
  assert.match(r, /ENOTFOUND \[redactado\]/);
  assert.equal(redactar('x@y.com', {}), '[mail]');
});
test('control negativo de redactar: sin redactar, el host del SMTP sí aparecía en el mensaje', () => {
  const crudo = 'getaddrinfo ENOTFOUND smtp.secreto-ejemplo.net';
  assert.equal(crudo.includes('smtp.secreto-ejemplo.net'), true);
  assert.equal(redactar(crudo, { SATCHI_SMTP_HOST: 'smtp.secreto-ejemplo.net' }).includes('smtp.secreto-ejemplo.net'), false);
});
test('el CLI redacta el error real del SMTP antes de imprimirlo', () => {
  const t = tmp(); const ev = path.join(t, 'ev.json');
  fs.writeFileSync(ev, JSON.stringify(evaluar(null, HOY)));
  let err = '';
  try {
    execFileSync(process.execPath, [CLI, 'mandar', '--evaluacion', ev], { cwd: t, stdio: 'pipe',
      env: { ...process.env, SATCHI_SMTP_HOST: 'host-inexistente.invalid', SATCHI_SMTP_PORT: '465', SATCHI_SMTP_USER: 'u@ejemplo.org', SATCHI_SMTP_PASS: 'p-secreta-9', SATCHI_VIGIA_DESTINO: 'd@ejemplo.org' } });
  } catch (e) { err = String(e.stderr); }
  assert.match(err, /opera-frescura: error/);
  for (const v of ['host-inexistente.invalid', 'u@ejemplo.org', 'p-secreta-9', 'd@ejemplo.org']) assert.equal(err.includes(v), false);
});
