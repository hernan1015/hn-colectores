// Control negativo CONTADO (como rayos-hora): se rompe a propósito una cosa por vez, en una COPIA de la carpeta, y se
// corre la suite. Cada mutante tiene que hacer fallar al menos un test. Al final: «N de N mutantes detectados».
// Antes se corre la copia SIN romper (tiene que pasar entera). Correr: node test/control-negativo.mjs (dentro de la carpeta).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUTANTES = [
  ['24 pedidos a la vez a S3', 'lib/red.mjs', 'export const CONCURRENCIA = 4;', 'export const CONCURRENCIA = 24;'],
  ['no reintenta un 429', 'lib/red.mjs', 'const reintentable = (st) => st >= 500 || st === 429 || st === 403;', 'const reintentable = (st) => st >= 500;'],
  ['ignora el Retry-After', 'lib/red.mjs', 'if (ra && /^\\d+$/.test(ra)) w = Math.min(RETRY_AFTER_MAX_MS, Math.max(w, +ra * 1000));', ''],
  ['baja la fase en el modo como_19', 'lib/red.mjs', "if (u.includes('ABI-L2-ACTPF') && modo === 'como_19')", 'if (false)'],
  ['siempre goes19', 'lib/red.mjs', "if (sat === 'goes16') u = u.replace('noaa-goes19', 'noaa-goes16');", ''],
  ['sin caché: el segundo modo vuelve a bajar todo', 'lib/red.mjs', 'if (c) { c.usado = instante; stats.de_cache++; return respuesta(c); }', ''],
  ['habla con cualquier host', 'lib/red.mjs', "if (!S3.test(u)) throw new Error('host no permitido en la Fase B');", ''],
  ['sin el instante de t−10', 'lib/plan.mjs', 'if (prev) elegidos.set(k - 1,', 'if (false) elegidos.set(k - 1,'],
  ['ventana [ini − 1 h, fin]', 'lib/plan.mjs', 'const desde = Date.parse(v.ini) - 2 * H, hasta = Date.parse(v.fin);', 'const desde = Date.parse(v.ini) - 1 * H, hasta = Date.parse(v.fin);'],
  ['la ventana del control de hora corrida −5 h', 'lib/plan.mjs', 'desde: desde - 6 * H, hasta: hasta - 6 * H', 'desde: desde - 5 * H, hasta: hasta - 5 * H'],
  ['siempre goes19 en el plan', 'lib/plan.mjs', "c.sat = d0 < CAMBIO_SAT_MS ? 'goes16' : 'goes19';", "c.sat = 'goes19';"],
  ['N a 30 km en vez de 25', 'lib/celdas.mjs', 'RADIO_N_KM = 25', 'RADIO_N_KM = 30'],
  ['guarda las celdas de 1 pata', 'lib/celdas.mjs', 'export const seGuarda = (c) => (!c.incompleta && c.patas >= 2) || (c.incompleta && c.patas_min >= 2);', 'export const seGuarda = () => true;'],
  ['N(t−10) con los flashes de t', 'lib/celdas.mjs', 'n25_t10: flT10 ? cuentaCerca(flT10,', 'n25_t10: flT10 ? cuentaCerca(flT,'],
  ['salto con diferencia ≥ 15', 'lib/evaluar.mjs', 'DIF_MIN: 20', 'DIF_MIN: 15'],
  ['salto sin pedir el barrido anterior', 'lib/evaluar.mjs', 'const puedeSalto = !!(cf.glm_completo && ant && ant.con_fase && ant.con_fase.valido && ant.con_fase.glm_completo && cf.t10_disponible);', 'const puedeSalto = true;'],
  ['cuenta barridos no válidos', 'lib/evaluar.mjs', 'if (!cf || !cf.valido) continue;', 'if (!cf) continue;'],
  ['radio de 35 km', 'lib/evaluar.mjs', 'export const RADIO_KM = 30;', 'export const RADIO_KM = 35;'],
  ['barajado con puntos fijos', 'lib/evaluar.mjs', 'if (p.every((v, i) => v !== i)) out.push(p);', 'out.push(p);'],
  ['2 episodios nuevos alcanzan', 'lib/evaluar.mjs', 'nuevos_min: 3', 'nuevos_min: 2'],
  ['no mira C_dias', 'lib/evaluar.mjs', 'd_controles: { C_dias: Cdias.V1.en_regla, C_hora: Chora.V1.en_regla, en_regla: Cdias.V1.en_regla && Chora.V1.en_regla },', 'd_controles: { C_dias: Cdias.V1.en_regla, C_hora: Chora.V1.en_regla, en_regla: Chora.V1.en_regla },'],
  ['no mira C_hora', 'lib/evaluar.mjs', 'd_controles: { C_dias: Cdias.V1.en_regla, C_hora: Chora.V1.en_regla, en_regla: Cdias.V1.en_regla && Chora.V1.en_regla },', 'd_controles: { C_dias: Cdias.V1.en_regla, C_hora: Chora.V1.en_regla, en_regla: Cdias.V1.en_regla },'],
  ['no verifica el sha de la lib', 'medir-caso.mjs', "if (h !== s) throw new Error('la lib cambió: ' + f + ' ' + h.slice(0, 12));", ''],
  ['no vacía /tmp/hn-goes', 'medir-caso.mjs', 'resumen.tmp_borrados += vaciarTmp(tmpDir);', ''],
  ['sin la pausa del presupuesto', 'medir-caso.mjs', "if (reloj() > (o.presupuestoMs ?? PRESUPUESTO_MS)) { resumen.cortado = 'presupuesto_5h30';", "if (false) { resumen.cortado = 'presupuesto_5h30';"],
  ['workflow con schedule', 'granizo-beta-fase-b.workflow.yml.txt', 'on:\n  workflow_dispatch:', 'on:\n  schedule:\n    - cron: \'0 3 * * *\'\n  workflow_dispatch:']
];

function copiar(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  for (const e of fs.readdirSync(RAIZ)) if (!['node_modules', '_app', '.mutante', 'salida'].includes(e)) fs.cpSync(path.join(RAIZ, e), path.join(dir, e), { recursive: true });
}
function correrCon(nombre, archivo, viejo, nuevo) {
  const dir = path.join(RAIZ, '.mutante');
  copiar(dir);
  if (archivo) {
    const p = path.join(dir, archivo), txt = fs.readFileSync(p, 'utf8');
    const veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const tests = ['plan', 'red', 'caso', 'evaluar', 'workflow'].map((t) => path.join(dir, 'test', t + '.test.mjs'));
  const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { codigo: r.status, fallan: Number((r.stdout.match(/ℹ fail (\d+)/) || [])[1] || 0) };
}
const base = correrCon('sin romper', null);
if (base.codigo !== 0) { console.log(`la copia SIN romper falla (${base.fallan} tests): el control no vale`); process.exit(2); }
console.log('copia sin romper: pasa entera');
let detectados = 0;
for (const [nombre, archivo, viejo, nuevo] of MUTANTES) {
  const r = correrCon(nombre, archivo, viejo, nuevo);
  if (r.codigo !== 0) detectados++;
  console.log(`${r.codigo !== 0 ? 'detectado ' : 'NO DETECTADO'} · ${nombre} · tests que fallan: ${r.fallan}`);
}
console.log(`\n${detectados} de ${MUTANTES.length} mutantes detectados`);
process.exit(detectados === MUTANTES.length ? 0 : 1);
