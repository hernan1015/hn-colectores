// HN AGRO · estaciones-parseo · [0152 obs. 2, 20/11] EL LOG DE ACTIONS ES PÚBLICO: los NOMBRES de las claves del crudo
// (las que la fuente trae y el parseo no conoce) no salen nunca al stdout. Van a registro_procesos (privado) y, en
// --seco, a un archivo fuera del repo si se pide. El log lleva sólo cuántas son, por fuente.
//   · CONTROL NEGATIVO: con el código de antes (soloCantidades aceptaba cualquier clave de letras) la clave sintética
//     pasaba al log; acá se reproduce la regla vieja y se ve que la dejaba pasar.
//   · MUTANTE (test/mutantes.mjs): volver a la regla vieja hace fallar estos tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RAIZ, FIX, AHORA, SIN_PGLITE, PGlite, archivos } from './ayuda.mjs';
import { conectarPglite } from '../lib/base.mjs';
import { almacenDeCarpeta } from '../lib/almacen.mjs';
import { correr, soloCantidades, PERMITIDAS, dentroDelRepo } from '../parsear.mjs';

const RARA = 'xq_campo_raro';                   // una clave SINTÉTICA «del crudo», hecha sólo de letras
const REGLA_VIEJA = (k) => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) && !/\d{3,}/.test(k);

/** Una copia de las fixtures (en una carpeta temporal propia) con un detalle de WeatherLink que trae RARA. */
function carpetaConRara() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parseo-log-'));
  fs.cpSync(FIX, tmp, { recursive: true });
  const p = path.join(tmp, 'estaciones-internas', 'weatherlink', '2026-01-10', '1511.jsonl');
  fs.appendFileSync(p, JSON.stringify({ id: 'prueba-wl-9', leido: '2026-01-10T15:23:00.000Z', d: { [RARA]: 1 } }) + '\n');
  return tmp;
}

test('soloCantidades: lista CERRADA; una clave de letras que no está (como una del crudo) frena el log', () => {
  assert.throws(() => soloCantidades({ fuentes: { weatherlink: { claves_sin_instante: { [RARA]: 1 } } } }), /clave no permitida/);
  assert.throws(() => soloCantidades({ [RARA]: 1 }), /clave no permitida/);
  assert.throws(() => soloCantidades({ stationName: 1 }), /clave no permitida/);
  assert.doesNotThrow(() => soloCantidades({ fuentes: { weatherlink: { claves_desconocidas: 3, descartadas: { formato_sin_verificar: 2 } } } }));
  // CONTROL NEGATIVO: la regla de antes la dejaba pasar
  assert.equal(REGLA_VIEJA(RARA), true);
  assert.equal(PERMITIDAS.has(RARA), false);
});

test('PERMITIDAS tiene todos los motivos de descarte que escribe el código (si no, el log se frenaría)', () => {
  const codigo = archivos(RAIZ).filter((p) => p.endsWith('.mjs') && !p.includes(path.sep + 'test' + path.sep) && !p.endsWith('parsear.mjs'));
  const motivos = new Set();
  for (const p of codigo) {
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/sumar\(descartadas, '([a-z0-9_]+)'/g)) motivos.add(m[1]);
    for (const m of t.matchAll(/vacio\('([a-z0-9_]+)'\)/g)) motivos.add(m[1]);
  }
  const edad = /export function motivoEdad[\s\S]*?\n}/.exec(fs.readFileSync(path.join(RAIZ, 'lib', 'calidad.mjs'), 'utf8'))[0];
  for (const m of edad.matchAll(/'([a-z0-9_]+)'/g)) if (m[1] !== 'registro') motivos.add(m[1]);
  assert.ok(motivos.size >= 20, String(motivos.size));
  for (const m of motivos) assert.ok(PERMITIDAS.has(m), m);
});

test('el job: la clave del crudo NO está en el resumen público y SÍ en registro_procesos (privado)', { skip: SIN_PGLITE }, async () => {
  const tmp = carpetaConRara();
  const db = await conectarPglite({ PGlite: await PGlite() });
  try {
    const privado = {};
    const r = await correr({ almacen: almacenDeCarpeta(tmp), db, ahora: AHORA, privado });
    assert.equal(r.ok, true);
    const pub = JSON.stringify(r);
    assert.ok(!pub.includes(RARA), 'la clave del crudo salió al resumen público');
    assert.ok(!pub.includes('stationName') && !pub.includes('idTipo'), 'otra clave del crudo salió al resumen público');
    assert.equal(typeof r.fuentes.weatherlink.claves_desconocidas, 'number');
    assert.ok(r.fuentes.weatherlink.claves_desconocidas >= 1);
    assert.equal(typeof r.fuentes.siga.claves_desconocidas, 'number');
    assert.equal(privado.claves_desconocidas.weatherlink[RARA], 1);
    await db.pg.exec('reset role');
    const [f] = await db.q("select resumen from registro_procesos where proceso = 'estaciones_parseo' order by 1 desc limit 1");
    assert.equal(f.resumen.privado.claves_desconocidas.weatherlink[RARA], 1);
    assert.ok(f.resumen.privado.claves_desconocidas.siga.idTipo >= 1);
    // lo de afuera de `privado` es el mismo resumen público
    const { privado: _, ...resto } = f.resumen;
    assert.ok(!JSON.stringify(resto).includes(RARA));
  } finally { await db.cerrar(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('el stdout de parsear.mjs --seco no trae la clave del crudo; --claves-a la escribe sólo en un archivo fuera del repo', { skip: SIN_PGLITE }, () => {
  const tmp = carpetaConRara();
  const archivo = path.join(tmp, 'claves.json');
  try {
    const correrCli = (...extra) => spawnSync(process.execPath, [path.join(RAIZ, 'parsear.mjs'), '--seco', '--carpeta', tmp,
      '--ahora', new Date(AHORA).toISOString(), ...extra], { encoding: 'utf8', env: process.env });
    const a = correrCli('--claves-a', archivo);
    assert.equal(a.status, 0, a.stderr);
    const salida = a.stdout + a.stderr;
    assert.ok(!salida.includes(RARA), 'la clave del crudo salió al stdout');
    const r = JSON.parse(a.stdout.trim().split('\n').pop());
    assert.equal(r.modo, 'seco');
    assert.ok(r.fuentes.weatherlink.claves_desconocidas >= 1);
    assert.equal(JSON.parse(fs.readFileSync(archivo, 'utf8')).claves_desconocidas.weatherlink[RARA], 1);
    // sin --claves-a, tampoco sale
    const b = correrCli();
    assert.equal(b.status, 0, b.stderr);
    assert.ok(!(b.stdout + b.stderr).includes(RARA));
    // adentro del repo, no: se frena con una categoría y no escribe nada
    const adentro = path.join(RAIZ, 'claves-prueba.json');
    assert.equal(dentroDelRepo(adentro), true);
    assert.equal(dentroDelRepo(archivo), false);
    const c = correrCli('--claves-a', adentro);
    assert.equal(c.status, 1);
    assert.deepEqual(JSON.parse(c.stdout.trim()), { ok: false, error: 'claves_a_no_permitido' });
    assert.equal(fs.existsSync(adentro), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
