#!/usr/bin/env node
// Control negativo del vigía de números: rompe UNA cosa por vez (en una copia temporal) y verifica que algún test caiga.
// Si una falla pasa sin que ningún test la detecte, el control falla. Uso: node vigia-numeros/test/control-negativo.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');   // la raíz del repo (el vigía importa ../vigia/lib/correo.mjs)
const PRIVADO_DE_PRUEBA = ['zz', 'privado', 'de', 'prueba'].join('-');
const FALLAS = [
  ['umbral del dólar al 20 %', 'vigia-numeros/lib/reglas.mjs', 'tc_desvio_rel: 0.02,', 'tc_desvio_rel: 0.20,'],
  ['no mira el dólar viejo', 'vigia-numeros/lib/reglas.mjs', '> U.tc_dias_atraso) desvios.push', '> 999) desvios.push'],
  ['compara contra BILLETES en vez de divisas', 'vigia-numeros/lib/fuentes.mjs', "indexOf('id=\"divisas\"')", "indexOf('id=\"billetes\"')"],
  ['FOB sin rango (cualquier número pasa)', 'vigia-numeros/lib/reglas.mjs', 'if (usd < lo || usd > hi) desvios.push', 'if (false) desvios.push'],
  ['FOB con el NCM del candeal', 'vigia-numeros/lib/reglas.mjs', "trigo: '100199'", "trigo: '100119'"],
  ['banda de pizarra que acepta todo', 'vigia-numeros/lib/reglas.mjs', 'if (q < lo || q > hi) desvios.push', 'if (false) desvios.push'],
  ['usa el estimado (E) de la pizarra', 'vigia-numeros/lib/fuentes.mjs', '/S\\/C/.test(txt) ?', 'false ?'],
  ['compara con el BNA caído', 'vigia-numeros/lib/reglas.mjs', "if (!bna || bna.ok === false) falta('bna', bna && bna.motivo);", "if (!bna) falta('bna');"],
  ['lo que faltó se ve como tranquilidad (Codex)', 'vigia-numeros/lib/reglas.mjs', 'incompleto: faltan.length > U.faltantes_tolerados', 'incompleto: false'],
  ['el mail sale sólo con desvíos', 'vigia-numeros/vigia-numeros.mjs', 'const mail = r.desvios.length || r.incompleto ?', 'const mail = r.desvios.length ?'],
  ['MAGyP de otro día se compara igual', 'vigia-numeros/lib/fuentes.mjs', "j.posts.filter((p) => String(p.fecha || '').slice(0, 10) === iso)", 'j.posts'],
  ['SMTP: un cierre limpio a mitad del diálogo no se ve (Codex 2.ª)', 'vigia/lib/correo.mjs', "    s.on('end', () => fallar('el servidor cerró la conexión antes de terminar'));\n    s.on('close', () => fallar('la conexión se cerró antes de terminar'));\n", ''],
  ['SMTP: el tope de tiempo vía destroy (Codex 2.ª)', 'vigia/lib/correo.mjs', "const tope = setTimeout(() => fallar('tiempo'), tiempoMs);", "const tope = setTimeout(() => sock && sock.destroy(new Error('tiempo')), tiempoMs);"],
  ['el envío fallido copia el mensaje crudo', 'vigia-numeros/vigia-numeros.mjs', "catch { envio = 'ENVIO_FALLO'; }", 'catch (e) { envio = String(e && e.message); }'],
  ['el CLI sale con 0 aunque esté INCOMPLETO o falle el envío', 'vigia-numeros/vigia-numeros.mjs', "if (x.r.incompleto || x.resumen.comparaciones === 0 || x.envio === 'ENVIO_FALLO') process.exitCode = 1;", 'if (x.resumen.comparaciones === 0) process.exitCode = 2;'],
  ['MAGyP de otro día en la primaria no prueba la alternativa', 'vigia-numeros/lib/fuentes.mjs', "        motivo = 'MAGyP sin dato del ' + fechaDMY;", "        return { ok: false, motivo: 'MAGyP sin dato del ' + fechaDMY };"],
  /* identificador privado: el control NO repone ningún nombre real. Inyecta un token de prueba (armado en partes, para que
     este archivo no lo contenga entero) y lo agrega a VIGIA_PRIVADOS sólo durante el control (ver correrTests). */
  ['vuelve un identificador privado al LEEME del vigía de SATCHI', 'vigia/LEEME.md', 'sin nombres en este repo', 'sin nombres en este repo (' + PRIVADO_DE_PRUEBA + ')'],
  ['vuelve un identificador privado al LEEME del vigía de números', 'vigia-numeros/LEEME.md', '# Vigía de números (diario)', '# Vigía de números (diario) ' + PRIVADO_DE_PRUEBA],
  ['--seco imprime el mail en Actions', 'vigia-numeros/vigia-numeros.mjs', 'if (seco && detalle) log(', 'if (seco) log('],
  ['no mira el respaldo de la app', 'vigia-numeros/lib/reglas.mjs', "if (String(app.fuente_tc || '').startsWith('fallback'))", 'if (false)'],
  ['--seco manda el mail', 'vigia-numeros/vigia-numeros.mjs', 'if (!seco && mail) {', 'if (mail) {'],
  ['sin la URL alternativa de MAGyP', 'vigia-numeros/lib/fuentes.mjs', 'for (const base of urls.magyp) {', 'for (const base of urls.magyp.slice(0, 1)) {'],
  ['el registro público lleva el detalle', 'vigia-numeros/vigia-numeros.mjs', 'log(JSON.stringify(resumen));', 'log(JSON.stringify({ ...resumen, r }));'],
];
function correrTests(dir) {
  const r = spawnSync(process.execPath, ['--test', 'vigia-numeros/test/vigia-numeros.test.mjs', 'vigia-numeros/test/correo-y-cli.test.mjs'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, VIGIA_PRIVADOS: [process.env.VIGIA_PRIVADOS, PRIVADO_DE_PRUEBA].filter(Boolean).join(',') } });
  const n = (k) => Number(((r.stdout || '').match(new RegExp('(?:ℹ|#) ' + k + ' ([0-9]+)')) || [])[1] ?? NaN);
  return { pasan: n('pass'), fallan: n('fail') + (n('cancelled') || 0) };   // un test que se cuelga (timeout) cuenta como caído
}
const base = correrTests(RAIZ);
console.log('sin fallas: ' + base.pasan + ' pasan, ' + base.fallan + ' fallan');
if (!(base.pasan > 0) || base.fallan !== 0) { console.log('la suite tiene que pasar entera antes del control'); process.exit(1); }
let malos = 0;
for (const [nombre, archivo, de, a] of FALLAS) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vnum-ctrl-'));
  for (const sub of ['vigia', 'vigia-numeros']) fs.cpSync(path.join(RAIZ, sub), path.join(d, sub), { recursive: true });
  const f = path.join(d, archivo), src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const veces = src.split(de).length - 1;
  if (veces !== 1) { console.log('✗ ' + nombre + ': el texto a romper aparece ' + veces + ' veces'); malos++; fs.rmSync(d, { recursive: true, force: true }); continue; }
  fs.writeFileSync(f, src.replace(de, a));
  const r = correrTests(d);
  const ok = r.fallan > 0;
  console.log((ok ? '✓ ' : '✗ ') + nombre + ': ' + r.fallan + ' test(s) caen');
  if (!ok) malos++;
  fs.rmSync(d, { recursive: true, force: true });
}
console.log(malos ? malos + ' falla(s) SIN detectar' : 'las ' + FALLAS.length + ' fallas se detectan');
process.exit(malos ? 1 : 0);
