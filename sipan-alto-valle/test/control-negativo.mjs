// Control negativo CONTADO (como rayos-hora): se rompe a propósito una cosa por vez, en una copia, y se corre la suite.
// Cada mutante tiene que hacer fallar al menos un test. Antes se corre la copia SIN romper (tiene que pasar entera).
// Correr: node sipan-alto-valle/test/control-negativo.mjs   (con SIPAN_FIXTURES, también los de los fixtures reales)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUTANTES = [
  ['el faltante «---» se lee como 0', 'lib/davis.mjs', "if (t === '' || /^-+$/.test(t) || /^n\\/?d$/i.test(t) || /^nan$/i.test(t)) return null;", "if (t === '' || /^-+$/.test(t)) return 0;"],
  ['no se controla la cantidad de campos', 'lib/davis.mjs', "if (c.length !== cols.length) { descartadas.push({ motivo: 'campos', n: c.length }); continue; }", ''],
  ['no se exigen las columnas obligatorias', 'lib/davis.mjs', "if (faltan.length) return { ok: false, motivo: 'faltan_columnas', detalle: faltan.join(','), columnas: cols };", ''],
  ['no se miran las unidades', 'lib/davis.mjs', "if (tmed != null && (tmed > 45 || tmed < -30)) return", "if (false) return"],
  ['reloj de 12 h mal (12:10a = 12:10)', 'lib/davis.mjs', "hh = mh[3] === 'a' ? (hh === 12 ? 0 : hh) : (hh === 12 ? 12 : hh + 12);", "hh = mh[3] === 'a' ? hh : hh + 12;"],
  ['la firma distinta se carga igual', 'sipan.mjs', "if (previa && previa !== p.firma && aceptar[e.id] !== p.firma) {", "if (false) {"],
  ['la noche arranca a medianoche', 'lib/resumen.mjs', "export function resumenNoche(controlados, fecha, intervalo = 10, { desde = '18:00', hasta = '09:00' } = {}) {", "export function resumenNoche(controlados, fecha, intervalo = 10, { desde = '00:00', hasta = '09:00' } = {}) {\n  fecha = fecha; const _d = 0;"],
  ['la noche incluye el registro de las 18:00', 'lib/resumen.mjs', 'return registros.filter((r) => { const t = ms(r.local); return t > a && t <= b; });', 'return registros.filter((r) => { const t = ms(r.local); return t >= a && t <= b; });'],
  ['los imposibles entran en la mínima', 'lib/resumen.mjs', "if (x != null && (x < a || x > b)) { r.marcas.push(`${k}_fuera_de_rango`); r.ok[k] = null; }", "if (x != null && (x < a || x > b)) { r.marcas.push(`${k}_fuera_de_rango`); }"],
  ['sin dedup al unir', 'lib/resumen.mjs', 'for (const r of nuevos || []) { const v = m.get(r.local); if (!v || llenos(r) >= llenos(v)) m.set(r.local, r); }', "for (const r of nuevos || []) m.set(r.local + Math.random(), r);"],
  ['el día sin lluvia medida da 0', 'lib/resumen.mjs', 'lluvia_mm: horas > 0 ? lluvia : null,', 'lluvia_mm: lluvia ?? 0,'],
  ['un día con huecos pisa uno completo', 'sipan.mjs', 'const usarDia = !viejo || (dia.registros_validos >= (viejo.registros_validos ?? -1));', 'const usarDia = true;'],
  ['sin pausa entre pedidos', 'sipan.mjs', 'export const PAUSA_MS = 30000;', 'export const PAUSA_MS = 0;'],
  ['sigue pidiendo después de un 429', 'sipan.mjs', "if (cortado) return { estado: 'cortado' };", ''],
  ['estación quieta nunca avisa', 'sipan.mjs', 'aviso: horasQuieta > QUIETA_H ?', 'aviso: false ?'],
  ['la medición acepta noches incompletas', 'medir.mjs', 'export const MIN_NOCHE = 0.9;', 'export const MIN_NOCHE = 0;'],
  ['el pronóstico con 23 horas cuenta', 'lib/medicion.mjs', "(out[f] ??= {})['d' + d] = ok.length === 24 ? Math.min(...ok) : null;", "(out[f] ??= {})['d' + d] = ok.length ? Math.min(...ok) : null;"],
  ['la radiación con huecos da un total corto', 'lib/resumen.mjs', 'rad_mj_m2: rs.filter((r) => r.ok.rad != null).length === esperados', 'rad_mj_m2: rs.filter((r) => r.ok.rad != null).length > 0'],
  ['falsa alarma contada como acierto', 'lib/medicion.mjs', 'if (po && ob) t.aciertos++; else if (po) t.falsas_alarmas++;', 'if (po) t.aciertos++; else if (false) t.falsas_alarmas++;'],
];

function correrCon(nombre, archivo, viejo, nuevo) {
  const dir = path.join(RAIZ, '.mutante');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const x of ['lib', 'test', 'sipan.mjs', 'medir.mjs']) fs.cpSync(path.join(RAIZ, x), path.join(dir, x), { recursive: true });
  if (archivo) {
    const p = path.join(dir, archivo);
    const txt = fs.readFileSync(p, 'utf8');
    const veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'test', 'sipan.test.mjs')], { encoding: 'utf8', env: process.env });
  return r.status === 0;
}

let muertos = 0;
if (!correrCon('sin romper', null)) { console.error('la copia SIN romper no pasa: revisar antes de contar mutantes'); process.exit(1); }
for (const [nombre, archivo, viejo, nuevo] of MUTANTES) {
  const pasa = correrCon(nombre, archivo, viejo, nuevo);
  console.log(`${pasa ? 'VIVO   ' : 'muerto '} ${nombre}`);
  if (!pasa) muertos++;
}
fs.rmSync(path.join(RAIZ, '.mutante'), { recursive: true, force: true });
console.log(`${muertos} de ${MUTANTES.length} mutantes detectados`);
process.exit(muertos === MUTANTES.length ? 0 : 1);
