// node --test sipan-alto-valle/test/salida.test.mjs
// El código de salida de la corrida (138, orden de local 14/11): los avisos de ESTADO de una estación (quieta, inactiva,
// revivió) se registran y se ven, pero NO ponen la corrida en rojo; una FALLA real (formato, no responde, SIPAN
// cortado, ninguna estación al día, filas que no se guardaron) sigue dando exit 2. Sin red: todo con --archivo y
// archivos sintéticos (el INTA no se toca).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armar, serie } from './sintetico.mjs';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(RAIZ, 'sipan.mjs');
const H = 3600e3;
/* «AAAA-MM-DDTHH:MM» local (UTC−3), redondeado a 10 min */
const local = (ms) => { const d = new Date(ms - 3 * H); d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0); return d.toISOString().slice(0, 16); };
const ahora = Date.now();
const FRESCA = armar(serie(local(ahora - 8 * H), local(ahora - 1 * H)));          // al día (último dato hace ~1 h)
const QUIETA = armar(serie(local(ahora - 6 * 24 * H), local(ahora - 5 * 24 * H)));   // quieta hace 5 días (< 30: sigue activa también con el PR #4)
const BASURA = 'esto no es un downld02\r\nni tiene columnas\r\n';

function cli(archivos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipan-salida-'));
  const arg = Object.entries(archivos).map(([id, txt]) => { const p = path.join(dir, id + '.txt'); fs.writeFileSync(p, txt, 'latin1'); return `${id}=${p}`; }).join(',');
  const r = spawnSync(process.execPath, [SCRIPT, '--seco', '--archivo', arg], { encoding: 'utf8', env: { ...process.env, SIPAN_PG_URL: '' } });
  fs.rmSync(dir, { recursive: true, force: true });
  return { codigo: r.status, salida: r.stdout + r.stderr };
}

test('salida: una corrida con SÓLO estacion_quieta (la 10, la 41 y la 42) termina en 0, con el aviso a la vista', () => {
  const r = cli({ 10: QUIETA, 40: FRESCA, 41: QUIETA, 42: QUIETA, 45: FRESCA });
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /::warning::SIPAN \(aviso, no falla\): .*estacion_quieta 10.*estacion_quieta 41.*estacion_quieta 42/);
  assert.doesNotMatch(r.salida, /::error::/);
  /* el aviso también queda en el resumen impreso (y en registro_procesos, ver abajo) */
  assert.match(r.salida, /"avisos":\["estacion_quieta 10","estacion_quieta 41","estacion_quieta 42"\]/);
});

test('salida: una falla real sigue dando 2 aunque también haya quietas (formato que no se entiende)', () => {
  const r = cli({ 10: QUIETA, 40: BASURA, 45: FRESCA });
  assert.equal(r.codigo, 2, r.salida);
  assert.match(r.salida, /::error::SIPAN: formato_no_se_entiende 40/);
  assert.match(r.salida, /::warning::SIPAN \(aviso, no falla\): estacion_quieta 10/);
});

test('salida: en la corrida completa, si NINGUNA estación está al día (todas quietas) es falla', async () => {
  const { correr, codigoSalida } = await import('../sipan.mjs');
  const { ESTACIONES } = await import('../lib/estaciones.mjs');
  const todas = (txt) => Object.fromEntries(ESTACIONES.map((e) => [e.id, txt]));
  const r = await correr({ seco: true, archivos: todas(QUIETA), log: () => {}, ahoraMs: ahora });
  assert.ok(r.avisos.some((a) => a.tipo === 'ninguna_al_dia'));
  assert.equal(codigoSalida(r), 2);
  /* control: con una sola al día, ya no */
  const r2 = await correr({ seco: true, archivos: { ...todas(QUIETA), 40: FRESCA }, log: () => {}, ahoraMs: ahora });
  assert.ok(!r2.avisos.some((a) => a.tipo === 'ninguna_al_dia'));
  assert.equal(codigoSalida(r2), 0);
  /* y una corrida a mano de UNA estación quieta (--archivo / --ids) no la dispara */
  assert.equal(cli({ 10: QUIETA }).codigo, 0);
});

test('salida: todo al día, sin avisos → 0 y sin ::warning::', () => {
  const r = cli({ 40: FRESCA, 45: FRESCA });
  assert.equal(r.codigo, 0, r.salida);
  assert.doesNotMatch(r.salida, /::warning::|::error::/);
});

test('codigoSalida: estado (quieta, inactiva, revivió) → 0; cualquier otro tipo, uno desconocido o filas sin guardar → 2', async () => {
  const { codigoSalida } = await import('../sipan.mjs');
  for (const tipo of ['estacion_quieta', 'estacion_inactiva', 'estacion_revivio']) assert.equal(codigoSalida({ avisos: [{ tipo, id: '10' }], errores: [] }), 0, tipo);
  for (const tipo of ['formato_cambiado', 'formato_no_se_entiende', 'no_responde', 'sipan_corto', 'ninguna_al_dia', 'algo_nuevo']) {
    assert.equal(codigoSalida({ avisos: [{ tipo: 'estacion_quieta', id: '10' }, { tipo, id: '40' }], errores: [] }), 2, tipo);
  }
  assert.equal(codigoSalida({ avisos: [{ tipo: 'estacion_quieta', id: '10' }], errores: ['40 estaciones_obs: 409'] }), 2);
  assert.equal(codigoSalida({ avisos: [], errores: [] }), 0);
});

/* la corrida real con una base falsa: el aviso queda en registro_procesos, con ok=true si no hubo fallas */
function baseFalsa({ erroresObs = [] } = {}) {
  const s = { obs: [], estaciones: [], registro: [] };
  return { s, async estaciones() { return []; }, async guardarEstaciones(f) { s.estaciones.push(...f); }, async obs() { return []; },
    async guardarObs(f) { s.obs.push(...f); return { ok: f.length - erroresObs.length, errores: erroresObs }; },
    async registrar(proceso, ok, resumen) { s.registro.push({ proceso, ok, resumen }); } };
}
test('registro_procesos: con sólo quietas queda ok=true, con el aviso y fallas=0; con filas sin guardar, ok=false', async () => {
  const { correr, codigoSalida } = await import('../sipan.mjs');
  const base = baseFalsa();
  const r = await correr({ seco: false, ids: ['10', '40'], archivos: { 10: QUIETA, 40: FRESCA }, base, almacen: null, log: () => {}, ahoraMs: ahora });
  assert.equal(base.s.registro.length, 1);
  assert.equal(base.s.registro[0].ok, true);
  assert.equal(base.s.registro[0].resumen.fallas, 0);
  assert.ok(base.s.registro[0].resumen.avisos.some((a) => a.tipo === 'estacion_quieta' && a.id === '10'));
  assert.equal(codigoSalida(r), 0);
  assert.ok(base.s.obs.length > 0);
  /* control: la base no guarda una fila → falla */
  const base2 = baseFalsa({ erroresObs: ['40 estaciones_obs: 409'] });
  const r2 = await correr({ seco: false, ids: ['10', '40'], archivos: { 10: QUIETA, 40: FRESCA }, base: base2, almacen: null, log: () => {}, ahoraMs: ahora });
  assert.equal(base2.s.registro[0].ok, false);
  assert.equal(codigoSalida(r2), 2);
});
