// [r79 · 1-bis] Control negativo CONTADO de test/precocido-cuadros.test.mjs: rompe una cosa por vez de los cuadros y las metateselas en
// una copia de lib/ (en una carpeta temporal FUERA del repo) y exige rojo. Antes corre la copia SIN romper (tiene que pasar entera).
// Correr: node test/control-cuadros.mjs  (dentro de gremlin/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const F = 'precocido.mjs';
const MUTANTES = [
  ['el cuadro con un hueco se escribe igual', F, 'if (z > zM || malZ.has(z)) { res.cuadros_faltantes++; continue; }', 'if (z > zM) { res.cuadros_faltantes++; continue; }'],
  ['la metatesela con un hueco se escribe igual', F, 'if (rp.faltan > 0) { mal = true; break; }', ''],
  ['el WebP sin su etiqueta', F, "<hn-slider>' + et + '</hn-slider>", "<hn-slider>' + 'x' + '</hn-slider>"],
  ['la etiqueta de la metatesela con x e y cruzados', F, "prod + '/' + t + '/m/' + z + '/' + mx + '/' + my;", "prod + '/' + t + '/m/' + z + '/' + my + '/' + mx;"],
  ['sin cuadros (el índice igual)', F, 'if (cuadros && fallidas === 0) {', 'if (cuadros && false) {'],
  ['«hecho» sin mirar cuadros ni metateselas', F, 'return Array.isArray(q.c) && Z_CUADRO.every((z) => q.c.indexOf(z) >= 0) && !!q.m && q.m.faltan === 0;', 'return true;'],
  ['la cobertura agrandada', F, 'let c = { x0: tx(CAJA_META.oeste, top),', 'let c = { x0: tx(CAJA_META.oeste, top) - 8,'],
  ['las teselas fuera de la cobertura se dibujan', F, 'if (!enCobertura(cob, x, y) || validarTesela(prod, z, x, y)) {', 'if (validarTesela(prod, z, x, y)) {'],
  ['reducir sin el alfa', F, 'a += al; r += src[s] * al;', 'a += al; r += src[s] * 255;'],
  ['de noche pide las nativas de las metateselas', F, 'if (PRODUCTOS[prod].diurno && enteraDeNoche(z, x, y, ms)) { tes.push({ x, y, noche: true, nat: [] }); continue; }', ''],
  ['el borrado diferido sin los cuadros', F, '.concat(cuadros || e.conC ? clavesCuadros(prod, q.t) : [])', '.concat([])'],
  ['sin el ritmo de cortesía', F, 'if (conRitmo) { if (pausaMs > 0) await ritmo(); }', 'if (conRitmo) { }'],
  ['8 pedidos a SLIDER en vuelo', F, 'export const EN_VUELO_SLIDER = 3;', 'export const EN_VUELO_SLIDER = 8;'],
  ['las metateselas de abajo que no hacen falta, escritas', F, 'if (!metasDe(prod, z).some((q) => q[0] === Q.mx && q[1] === Q.my)) continue;', ''],
  ['el log con la clave del cuadro', F, '${cuadros ? ` · ${res.cuadros} cuadros', '${cuadros ? ` · ${claveCuadro(\'gremlin\', \'x\', 5)} · ${res.cuadros} cuadros'],
  ['[Codex · 1] las faltantes sin sus coordenadas', F, "else if (estado === 'mal') { mFal++; res.metas_faltantes++; faltantes.push(z + '/' + mx + '/' + my); }", "else if (estado === 'mal') { mFal++; res.metas_faltantes++; }"],
  ['[Codex · 1] «completo» con metateselas faltantes', F, 'const estado = faltan === 0 && todoCuadros ?', 'const estado = faltan === 0 ?'],
  ['[Codex · 2] el ritmo sin volver a mirar al arrancar', F, 'if (falta <= 0) { ultimoInicio = a; return; } await esperar(falta);', 'ultimoInicio = Math.max(a, ultimoInicio + pausaMs); if (falta > 0) await esperar(falta); return;'],
  ['la cabecera sin la cobertura', F, 'cobertura: Object.fromEntries((Z_META[prod] || []).map((z) => [z, coberturaMeta(prod, z)])) },', 'cobertura: {} },'],
];
function correrCon(nombre, archivo, viejo, nuevo) {
  const dir = fs.mkdtempSync(path.join(process.env.TMP || os.tmpdir(), 'mutante-cuadros-'));
  fs.cpSync(path.join(RAIZ, 'lib'), path.join(dir, 'lib'), { recursive: true });
  if (archivo) {
    const p = path.join(dir, 'lib', archivo), txt = fs.readFileSync(p, 'utf8'), veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'test', 'precocido-cuadros.test.mjs')], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GREMLIN_LIB: pathToFileURL(path.join(dir, 'lib')).href + '/' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { codigo: r.status, fallan: Number((r.stdout.match(/ℹ fail (\d+)/) || [])[1] || 0) };
}
const base = correrCon('sin romper', null);
if (base.codigo !== 0) { console.log(`la copia SIN romper falla (${base.fallan} tests): el control no vale`); process.exit(2); }
console.log('copia sin romper: pasa entera');
let detectados = 0;
for (const [nombre, archivo, viejo, nuevo] of MUTANTES) {
  const r = correrCon(nombre, archivo, viejo, nuevo); const ok = r.codigo !== 0; if (ok) detectados++;
  console.log(`${ok ? 'detectado ' : 'NO DETECTADO'} · ${nombre} · tests que fallan: ${r.fallan}`);
}
console.log(`\n${detectados} de ${MUTANTES.length} mutantes detectados`);
process.exit(detectados === MUTANTES.length ? 0 : 1);
