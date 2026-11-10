// Tests del estado en el repo (rama huérfana vigia-estado) con un repo TEMPORAL: un remoto «bare» y dos clones.
// Y el orden que evita el mail doble (primero se guarda; si no se pudo, no hay mail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearEstadoGit, parsear, RAMA, ARCHIVO } from '../lib/estado-git.mjs';
import { escalasEnEvacuacion, focosGrandes } from '../lib/reglas.mjs';
import { correr } from '../vigia-satchi.mjs';

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos');
const ESC = JSON.parse(fs.readFileSync(path.join(D, 'escalas_2026-11-10.json'), 'utf8'));
const FOC = JSON.parse(fs.readFileSync(path.join(D, 'focos_pais_2026-11-10.json'), 'utf8'));
const AHORA = Date.parse('2026-11-10T21:30:00Z');
const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@ejemplo.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repos() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-git-'));
  const remoto = path.join(raiz, 'remoto.git');
  git(['init', '-q', '--bare', remoto], raiz);
  const a = path.join(raiz, 'a'), b = path.join(raiz, 'b');
  git(['clone', '-q', remoto, a], raiz);
  fs.writeFileSync(path.join(a, 'LEEME.md'), 'repo de prueba\n');
  git(['add', '.'], a); git(['commit', '-q', '-m', 'inicio'], a); git(['push', '-q', 'origin', 'HEAD'], a);
  git(['clone', '-q', remoto, b], raiz);
  return { raiz, remoto, a, b };
}
const delRemoto = (r) => parsear(git(['show', RAMA + ':' + ARCHIVO], r.remoto));
const commits = (r) => Number(git(['rev-list', '--count', RAMA], r.remoto).trim());
const RECONQUISTA = escalasEnEvacuacion(ESC).find((x) => x.nombre === 'Reconquista');
const ROSARIO_CLAVE = 'escala:34:evacuacion';

test('⭐ sin rama todavía: el estado empieza vacío; al guardar se crea la rama HUÉRFANA con estado.json', async () => {
  const r = repos();
  try {
    const E = crearEstadoGit({ repo: r.a });
    assert.equal((await E.leer()).size, 0);
    assert.deepEqual((await E.guardar({ avisar: [RECONQUISTA], ahoraMs: AHORA })).map((x) => x.clave), ['escala:24:evacuacion']);
    const m = delRemoto(r);
    assert.equal(m.get('escala:24:evacuacion').activo, true);
    assert.equal(git(['log', '--format=%s', RAMA], r.remoto).trim().split('\n').length, 1, 'huérfana: un solo commit, sin la historia de main');
    assert.deepEqual(git(['ls-tree', '--name-only', RAMA], r.remoto).trim().split('\n'), [ARCHIVO], 'sólo estado.json');
    /* sólo lo público: ni la altura, ni la URL, ni destinatarios */
    assert.deepEqual(Object.keys(m.get('escala:24:evacuacion')).sort(), ['activo', 'actualizado', 'clave', 'primer_aviso', 'tipo', 'ultimo_aviso']);
  } finally { fs.rmSync(r.raiz, { recursive: true, force: true }); }
});
test('otro clon lo lee; sin cambios no hay commit nuevo; al bajar la escala se rearma', async () => {
  const r = repos();
  try {
    await crearEstadoGit({ repo: r.a }).leer();
    const A = crearEstadoGit({ repo: r.a }); await A.leer(); await A.guardar({ avisar: [RECONQUISTA], ahoraMs: AHORA });
    const B = crearEstadoGit({ repo: r.b });
    assert.equal((await B.leer()).get('escala:24:evacuacion').activo, true);
    const n = commits(r);
    assert.deepEqual(await B.guardar({ avisar: [RECONQUISTA], rearmar: [], ahoraMs: AHORA + 9e5 }), [], 'ya avisada y activa: no va de nuevo');
    assert.equal(commits(r), n, 'nada cambió: no se commitea');
    await B.guardar({ rearmar: ['escala:24:evacuacion'], ahoraMs: AHORA + 18e5 });
    assert.equal(delRemoto(r).get('escala:24:evacuacion').activo, false);
  } finally { fs.rmSync(r.raiz, { recursive: true, force: true }); }
});
test('⭐ otra corrida guardó en el medio: se aplica sobre lo más nuevo (no se pisa) y lo que ella ya avisó no se manda de nuevo', async () => {
  const r = repos();
  try {
    const A = crearEstadoGit({ repo: r.a }), B = crearEstadoGit({ repo: r.b });
    await A.leer(); await B.leer();   // los dos leen el estado vacío
    const [foco] = focosGrandes(FOC, ['Catamarca']);
    assert.deepEqual((await B.guardar({ avisar: [RECONQUISTA], ahoraMs: AHORA })).map((x) => x.clave), ['escala:24:evacuacion']);
    const van = await A.guardar({ avisar: [RECONQUISTA, foco], ahoraMs: AHORA + 60e3 });
    assert.deepEqual(van.map((x) => x.clave), [foco.clave], 'Reconquista ya la avisó B: A no la manda');
    const m = delRemoto(r);
    assert.ok(m.has('escala:24:evacuacion') && m.has(foco.clave));
  } finally { fs.rmSync(r.raiz, { recursive: true, force: true }); }
});
test('⭐ push rechazado (otra corrida subió entre el commit y el push): un reintento con pull --rebase, y quedan las dos', async () => {
  const r = repos();
  try {
    const ent = (clave) => ({ clave, tipo: 'crecida' });
    const base = crearEstadoGit({ repo: r.a }); await base.leer();
    await base.guardar({ avisar: [ent('escala:10:evacuacion'), ent('escala:50:evacuacion'), ent('escala:90:evacuacion')], ahoraMs: AHORA });
    const B = crearEstadoGit({ repo: r.b }); await B.leer();
    let rechazos = 0;
    const A = crearEstadoGit({ repo: r.a, log: () => rechazos++, _antesDePush: () => { B.guardar({ avisar: [ent('escala:80:evacuacion')], ahoraMs: AHORA + 1 }); } });
    await A.leer();
    const van = await A.guardar({ avisar: [ent('escala:20:evacuacion')], ahoraMs: AHORA + 2 });
    assert.equal(rechazos, 1, 'hubo un rechazo y un reintento');
    assert.deepEqual(van.map((x) => x.clave), ['escala:20:evacuacion']);
    const m = delRemoto(r);
    for (const k of ['escala:10:evacuacion', 'escala:20:evacuacion', 'escala:50:evacuacion', 'escala:80:evacuacion', 'escala:90:evacuacion']) assert.ok(m.has(k), k);
  } finally { fs.rmSync(r.raiz, { recursive: true, force: true }); }
});
test('⭐ si el reintento también choca (la misma clave tocada por las dos), guardar da false: no hay mail', async () => {
  const r = repos();
  try {
    const base = crearEstadoGit({ repo: r.a }); await base.leer();
    await base.guardar({ avisar: [{ clave: ROSARIO_CLAVE, tipo: 'crecida' }], ahoraMs: AHORA });
    const B = crearEstadoGit({ repo: r.b }); await B.leer();
    const A = crearEstadoGit({ repo: r.a, _antesDePush: () => { B.guardar({ rearmar: [ROSARIO_CLAVE], ahoraMs: AHORA + 7 }); } });
    await A.leer();
    assert.equal(await A.guardar({ rearmar: [ROSARIO_CLAVE], ahoraMs: AHORA + 5 }), false);
  } finally { fs.rmSync(r.raiz, { recursive: true, force: true }); }
});

/* el orden: primero se guarda, después el mail */
function redFalsa() {
  const PRO = JSON.parse(fs.readFileSync(path.join(D, 'prono_2026-11-10.json'), 'utf8'));
  return async (u) => { const q = new URL(u).searchParams; const b = q.get('que') === 'focos' ? FOC : q.get('parte') === 'escalas' ? ESC : PRO;
    return new Response(JSON.stringify(b), { status: 200, headers: { 'cache-status': '"Netlify Durable"; hit' } }); };
}
test('⭐ NO DOBLE: si el estado no se pudo guardar, NO se manda el mail', async () => {
  let mails = 0;
  const almacen = { leer: async () => new Map(), guardar: async () => false };
  const r = await correr({ seco: false, ahoraMs: AHORA, env: {}, fetchFn: redFalsa(), mandarFn: async () => { mails++; return { ok: true }; }, log: () => {}, almacen });
  assert.equal(mails, 0);
  assert.match(r.resumen.estado, /NO SE PUDO GUARDAR/);
});
test('⭐ el estado se guarda ANTES del mail', async () => {
  const orden = [];
  const almacen = { leer: async () => new Map(), guardar: async () => { orden.push('guardar'); return true; } };
  await correr({ seco: false, ahoraMs: AHORA, env: {}, fetchFn: redFalsa(), mandarFn: async () => { orden.push('mail'); return { ok: true }; }, log: () => {}, almacen });
  assert.deepEqual(orden, ['guardar', 'mail']);
});
