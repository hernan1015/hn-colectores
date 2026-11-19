// Control negativo CONTADO de la subida del Litoral: se rompe a propósito una cosa por vez (en una copia de lib/) y se corre la suite.
// Cada mutante tiene que hacer fallar al menos un test. Al final: «N de N mutantes detectados».
// Antes se corre la copia SIN romper (tiene que pasar entera). Correr: node test/control-negativo.mjs  (dentro de crecidas-litoral/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUTANTES = [
  ['el índice ANTES de las teselas', 'subir.mjs', '  /* 1) TODAS las teselas de la versión nueva */', '  await op(() => almacen.escribir(prefijo + \'/indice.json\', Buffer.from(\'{}\'), {}));\n  /* 1) TODAS las teselas de la versión nueva */'],
  ['las teselas sin versión (pisan las publicadas)', 'subir.mjs', "prefijo + '/' + version + '/' + a.ruta", "prefijo + '/' + a.ruta"],
  ['borra la versión vieja en la misma corrida', 'subir.mjs', 'if (vieja) pendientes.push({ version: vieja, desde: ahoraMs });', 'if (vieja) aBorrar.push(vieja);'],
  ['borra sin esperar las 6 h', 'subir.mjs', 'if (ahoraMs - Number(p.desde) >= ESPERA_BORRAR_MS) aBorrar.push(p.version);', 'if (true) aBorrar.push(p.version);'],
  ['borra antes de escribir el índice', 'subir.mjs', "  /* 2) el índice nuevo, con lo que queda por borrar más tarde */", "  for (const p of (anterior && anterior.borrar_despues) || []) { for (const k of await almacen.listar(prefijo + '/' + p.version + '/')) await almacen.borrar(k); }\n  /* 2) el índice nuevo, con lo que queda por borrar más tarde */"],
  ['sin reintentos', 'subir.mjs', 'if (!reintentable(e) || k === reintentos) break;', 'break;'],
  ['reintenta también los 4xx', 'subir.mjs', 'return h == null ? true : h >= 500;', 'return true;'],
  ['la categoría con el mensaje', 'subir.mjs', "if (e && e.almacen) return 'error:almacen' + (e.http ? ' http ' + e.http : '');", "if (e && e.almacen) return 'error:almacen ' + e.message;"],
  ['acepta fechas de un tipo que no es medido ni pronóstico', 'subir.mjs', "(x.tipo === 'medido' || x.tipo === 'pronostico')", 'true'],
  ['sube archivos que no son teselas', 'subir.mjs', 'const m = RE_TESELA.exec(a.ruta); return m && fechas.has(m[1]);', 'return true;'],
  ['el índice sin la versión', 'subir.mjs', 'const nuevo = { ...I, version,', 'const nuevo = { ...I, version: undefined,'],
];
function correrSuite(lib) {
  const r = spawnSync(process.execPath, ['--test', 'test/subir.test.mjs'], { cwd: RAIZ, env: { ...process.env, LITORAL_LIB: lib ? pathToFileURL(lib).href + '/' : '' }, encoding: 'utf8' });
  return r.status === 0;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'litoral-mut-'));
const copiar = () => { const d = fs.mkdtempSync(path.join(tmp, 'lib-')); for (const f of fs.readdirSync(path.join(RAIZ, 'lib'))) fs.copyFileSync(path.join(RAIZ, 'lib', f), path.join(d, f)); return d; };
if (!correrSuite(copiar())) { console.error('la copia SIN romper no pasa: el control no vale'); process.exit(2); }
let det = 0;
for (const [nom, arch, a, b] of MUTANTES) {
  const d = copiar(), f = path.join(d, arch), s = fs.readFileSync(f, 'utf8');
  if (s.split(a).length !== 2) { console.error('✗ el mutante no aplica: ' + nom); continue; }
  fs.writeFileSync(f, s.split(a).join(b));
  const vivo = correrSuite(d);
  console.log((vivo ? '✗ VIVO  ' : '✓ muerto ') + nom);
  if (!vivo) det++;
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(det + ' de ' + MUTANTES.length + ' mutantes detectados');
process.exit(det === MUTANTES.length ? 0 : 1);
