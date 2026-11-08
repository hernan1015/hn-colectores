// Control negativo CONTADO: se rompe a propósito una cosa por vez (en una copia de lib/) y se corre la suite.
// Cada mutante tiene que hacer fallar al menos un test. Al final: «N de N mutantes detectados».
// Antes se corre la copia SIN romper (tiene que pasar entera), así un fallo no es culpa de la copia.
// Correr: node test/control-negativo.mjs  (dentro de rayos-hora/; tarda unos minutos)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUTANTES = [
  ['recorte a la caja desactivado', 'glm.mjs', 'if (!(la >= caja.latMin && la <= caja.latMax && lo >= caja.lonMin && lo <= caja.lonMax)) continue;', 'if (false) continue;'],
  ['_Unsigned ignorado', 'glm.mjs', 'if (sinSigno && v < 0) v += 65536;', ''],
  ['calidad de relleno leída como 0 («buena»)', 'glm.mjs', "calidad: qq && Number.isFinite(qq[i]) ? qq[i] : -1,", 'calidad: qq && Number.isFinite(qq[i]) ? qq[i] : 0,'],
  ['no verifica el tamaño bajado', 'glm.mjs', 'if ((largo && buf.length !== largo) || (tam && buf.length !== tam))', 'if (false)'],
  ['reintenta la bajada 5 veces', 'glm.mjs', 'for (let intento = 0; intento < 2; intento++)', 'for (let intento = 0; intento < 5; intento++)'],
  ['siempre GOES-19', 'glm.mjs', "return horaMs >= CAMBIO_SATELITE_MS ? 'goes19' : 'goes16';", "return 'goes19';"],
  ['hora incompleta marcada como completa', 'cache.mjs', 'const completa = faltantes.length === 0;', 'const completa = true;'],
  ['ventana de 47 h', 'cache.mjs', 'export const VENTANA_H = 48;', 'export const VENTANA_H = 47;'],
  ['incluye la hora todavía abierta', 'cache.mjs', 'return Math.floor((ahoraMs - MARGEN_MS) / HORA) * HORA - HORA;', 'return Math.floor((ahoraMs - MARGEN_MS) / HORA) * HORA;'],
  ['ignora un candado vigente', 'cache.mjs', 'if (c && Date.parse(c.vence) > ahoraMs) return { ok: false, de: c.dueno, vence: c.vence };', ''],
  ['no suelta el candado', 'cache.mjs', 'await soltarCandado(almacen, dueno);', ''],
  ['rehace horas ya guardadas (no idempotente)', 'cache.mjs', 'if (debeReintentar(meta, ahoraMs)) out.push({ hora: h, previa: meta });', 'out.push({ hora: h, previa: meta });'],
  ['reintenta sin tope de intentos', 'cache.mjs', 'if ((meta.intentos || 1) >= MAX_INTENTOS) return false;', ''],
  ['sigue golpeando a NOAA después de un error', 'cache.mjs', "log(`NOAA falló en ${isoHora(hora)}: corto (anotado en alertas)`);\n        break;", 'continue;'],
  ['no anota la alerta de NOAA', 'cache.mjs', 'await alertar(almacen, `NOAA: ${error}. Se corta la corrida; la próxima vuelve a probar.`, ahoraMs);', ''],
];

function correrCon(nombre, archivo, viejo, nuevo) {
  const dir = path.join(RAIZ, '.mutante');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(RAIZ, 'lib'), path.join(dir, 'lib'), { recursive: true });
  if (archivo) {
    const p = path.join(dir, 'lib', archivo);
    const txt = fs.readFileSync(p, 'utf8');
    const veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'test', 'rayos-hora.test.mjs')], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, RAYOS_LIB: pathToFileURL(path.join(dir, 'lib')).href + '/' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const fallan = Number((r.stdout.match(/ℹ fail (\d+)/) || [])[1] || 0);
  return { codigo: r.status, fallan };
}

const base = correrCon('sin romper', null);
if (base.codigo !== 0) { console.log(`la copia SIN romper falla (${base.fallan} tests): el control no vale`); process.exit(2); }
console.log('copia sin romper: pasa entera');
let detectados = 0;
for (const [nombre, archivo, viejo, nuevo] of MUTANTES) {
  const r = correrCon(nombre, archivo, viejo, nuevo);
  const ok = r.codigo !== 0;
  if (ok) detectados++;
  console.log(`${ok ? 'detectado ' : 'NO DETECTADO'} · ${nombre} · tests que fallan: ${r.fallan}`);
}
console.log(`\n${detectados} de ${MUTANTES.length} mutantes detectados`);
process.exit(detectados === MUTANTES.length ? 0 : 1);
