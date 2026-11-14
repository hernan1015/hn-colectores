#!/usr/bin/env node
// Control negativo CONTADO del archivo de granizo (147): rompe UNA cosa por vez en una copia temporal (lib/ común,
// granizo-archivo/ y vigia/) y corre la suite. Cada mutante tiene que hacer caer al menos un test.
// Antes corre la copia SIN romper: tiene que pasar entera, así un fallo no es culpa de la copia.
// Uso: node granizo-archivo/test/control-negativo.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MUTANTES = [
  // releases.mjs (común)
  ['reemplazar borra el viejo ANTES de subir el nuevo', 'lib/releases.mjs',
    '    const r = await subir(rel, nombre, cuerpo, tipo);\n    if (r.yaEstaba)',
    '    for (const v of viejos) if (v.name !== nombre) await borrar(rel, v);\n    const r = await subir(rel, nombre, cuerpo, tipo);\n    if (r.yaEstaba)'],
  ['reemplazar borra aunque el nombre ya existía', 'lib/releases.mjs', "    if (r.yaEstaba) throw new Error('GitHub: ya hay un asset con ese nombre; el reemplazo necesita un nombre nuevo (no se borró nada)');\n", ''],
  ['sin paginar (sólo la primera página)', 'lib/releases.mjs', 'if (l.length < 100) break;', 'break;'],
  ['el asset a medio subir (starter) cuenta como subido', 'lib/releases.mjs', "if (hay.some((a) => a.state === 'uploaded')) return { yaEstaba: true };", 'if (hay.length) return { yaEstaba: true };'],
  ['422 al subir es error', 'lib/releases.mjs', "if (s._estado === 422) return { yaEstaba: true };", "if (s._estado === 422) throw new Error('422');"],
  ['422 al crear el release es error', 'lib/releases.mjs', "rel = c && c._estado === 422 ? await pedir('GET', `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`) : c;", 'rel = c;'],
  ['el release nuevo queda «Latest»', 'lib/releases.mjs', "make_latest: 'false'", "make_latest: 'true'"],
  // barrido.mjs
  ['ok:false cuenta como buena', 'granizo-archivo/lib/barrido.mjs', "if (j.ok === false) { c.motivo", "if (false) { c.motivo"],
  ['parcial cuenta como buena', 'granizo-archivo/lib/barrido.mjs', "if (j.parcial === true) { c.estado = 'parcial';", "if (false) { c.estado = 'parcial';"],
  ['HTTP ≠ 200 no es falla', 'granizo-archivo/lib/barrido.mjs', "if (p.http !== 200) { c.motivo", "if (false) { c.motivo"],
  ['sin scan_t igual es buena', 'granizo-archivo/lib/barrido.mjs', "if (c.scan_ms == null) { c.estado = 'parcial'; c.motivo = 'sin_scan_t'; return c; }", ''],
  ['scan_t sin control de rango', 'granizo-archivo/lib/barrido.mjs', 'if (!Number.isFinite(ms) || ms < pedido_ms - 2 * 864e5 || ms > pedido_ms + 60 * MIN) return null;', 'if (!Number.isFinite(ms)) return null;'],
  ['el nombre sin el estado (la parcial pisa la buena)', 'granizo-archivo/lib/barrido.mjs', "`${minutoUTC(c.scan_ms)}Z.${c.estado}.json.gz`", "`${minutoUTC(c.scan_ms)}Z.buena.json.gz`"],
  ['la falla sin scan por el minuto, no por el turno de 10 min', 'granizo-archivo/lib/barrido.mjs', '`pedido-${minutoUTC(turno10(pedido_ms))}Z.${c.estado}.json.gz`', '`pedido-${minutoUTC(pedido_ms)}Z.${c.estado}.json.gz`'],
  ['el release por día UTC (no argentino)', 'granizo-archivo/lib/barrido.mjs', "export const diaAR = (ms) => horaAR(ms).slice(0, 10);", 'export const diaAR = (ms) => new Date(ms).toISOString().slice(0, 10);'],
  ['el cuerpo re-serializado (no tal cual)', 'granizo-archivo/lib/barrido.mjs', '    colector, cuerpo: p.cuerpo,', '    colector, cuerpo: p.cuerpo == null ? null : JSON.stringify((() => { try { return JSON.parse(p.cuerpo); } catch { return p.cuerpo; } })()),'],
  ['sin la hora argentina en el sobre', 'granizo-archivo/lib/barrido.mjs', 'pedido_art: horaAR(p.pedido_ms),', 'pedido_art: null,'],
  ['se guardan todas las cabeceras', 'granizo-archivo/lib/barrido.mjs', "const v = r.headers && r.headers.get ? r.headers.get(k) : null;", "const v = r.headers && r.headers.get ? r.headers.get(k) : null; out.cabeceras['x-secreto'] = r.headers.get('x-secreto');"],
  ['el cuerpo gigante se guarda igual', 'granizo-archivo/lib/barrido.mjs', "if (Buffer.byteLength(t, 'utf8') > TOPE_BYTES) out.error", "if (false) out.error"],
  // flujo.mjs / indice.mjs
  ['la repetida se sube otra vez', 'granizo-archivo/lib/flujo.mjs', '  if (!ya) nuevo = !(await cliente.subir(rel, nombre, gz, \'application/gzip\')).yaEstaba;', "  nuevo = true; await cliente.borrar(rel, (await cliente.assets(rel)).find((a) => a.name === nombre) || { id: -1 }).catch(() => {}); await cliente.subir(rel, nombre, gz, 'application/gzip');"],
  ['seco sube igual', 'granizo-archivo/lib/flujo.mjs', "if (seco) return { ...base, seco: true, repetido: ya, nuevo: false, indice: 'no (seco)' };", ''],
  ['el índice no borra los viejos (no une)', 'granizo-archivo/lib/flujo.mjs', 'viejos: previos.map((p) => p.asset) });', 'viejos: [] });'],
  ['el índice no une: se queda con el último', 'granizo-archivo/lib/indice.mjs', '  for (const t of textos) {', '  for (const t of textos.slice(-1)) {'],
  ['la falla del índice no se informa', 'granizo-archivo/lib/flujo.mjs', "} catch (e) { indice = 'falló';", "} catch (e) { indice = 'ok';"],
  // frescura.mjs / vigia-frescura.mjs
  ['ventana de 60 min', 'granizo-archivo/lib/frescura.mjs', 'export const VENTANA_MIN = 40;', 'export const VENTANA_MIN = 60;'],
  ['parado con clave que cambia (repite el mail)', 'granizo-archivo/lib/frescura.mjs', "clave: 'granizo-archivo-parado-tras-' + limpiar(ultimo ? ultimo.name : 'sin-registro'),", "clave: 'granizo-archivo-parado-' + ahoraMs,"],
  ['repetidos cuentan como barrido nuevo', 'granizo-archivo/lib/frescura.mjs', '  if (!nuevos.length) {\n    const scan', '  if (false) {\n    const scan'],
  ['fallas cuentan como sano', 'granizo-archivo/lib/frescura.mjs', "if (nuevos.every((a) => a.n.estado === 'falla')) {", 'if (false) {'],
  ['no mira el release de ayer', 'granizo-archivo/lib/frescura.mjs', '[...new Set([diaAR(ahoraMs - 864e5), diaAR(ahoraMs)])]', '[diaAR(ahoraMs)]'],
  ['error de lectura = sin aviso', 'granizo-archivo/vigia-frescura.mjs', 'return est ? evaluarFrescura({ ahoraMs, ...est }) : sinLectura(ahoraMs);', "return est ? evaluarFrescura({ ahoraMs, ...est }) : { avisar: false, tipo: 'ok' };"],
  ['la marca queda aunque el mail no salió', 'granizo-archivo/vigia-frescura.mjs',
    "  const r = await enviar({ ...cfg, asunto: ev.asunto, cuerpo: ev.detalle + '\\n\\nClave del aviso: ' + ev.clave + '\\n\\n(vigía granizo-frescura, hn-colectores)' });\n  fs.mkdirSync(marcaDir, { recursive: true }); fs.writeFileSync(path.join(marcaDir, 'clave'), ev.clave + '\\n');",
    "  fs.mkdirSync(marcaDir, { recursive: true }); fs.writeFileSync(path.join(marcaDir, 'clave'), ev.clave + '\\n');\n  const r = await enviar({ ...cfg, asunto: ev.asunto, cuerpo: ev.detalle });"],
];

function copia() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'granizo-ctrl-'));
  for (const sub of ['lib', 'granizo-archivo', 'vigia']) fs.cpSync(path.join(RAIZ, sub), path.join(d, sub), { recursive: true });
  return d;
}
function correr(d) {
  const r = spawnSync(process.execPath, ['--test', path.join('granizo-archivo', 'test', 'granizo-archivo.test.mjs')], { cwd: d, encoding: 'utf8' });
  const n = (k) => Number(((r.stdout || '').match(new RegExp('ℹ ' + k + ' (\\d+)')) || [])[1] ?? NaN);
  return { codigo: r.status, pasan: n('pass'), fallan: n('fail') };
}

const d0 = copia();
const base = correr(d0);
fs.rmSync(d0, { recursive: true, force: true });
console.log(`copia sin romper: ${base.pasan} pasan, ${base.fallan} fallan`);
if (base.codigo !== 0 || !(base.pasan > 0)) { console.log('la suite tiene que pasar entera antes del control: no vale'); process.exit(2); }
let detectados = 0;
for (const [nombre, archivo, viejo, nuevo] of MUTANTES) {
  const d = copia();
  const f = path.join(d, archivo);
  const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const veces = src.split(viejo).length - 1;
  if (veces !== 1) { fs.rmSync(d, { recursive: true, force: true }); throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces en ${archivo} (tiene que ser 1)`); }
  fs.writeFileSync(f, src.replace(viejo, () => nuevo));
  const r = correr(d);
  fs.rmSync(d, { recursive: true, force: true });
  const ok = r.codigo !== 0;
  if (ok) detectados++;
  console.log(`${ok ? 'detectado   ' : 'NO DETECTADO'} · ${nombre} · tests que fallan: ${r.fallan}`);
}
console.log(`\n${detectados} de ${MUTANTES.length} mutantes detectados`);
process.exit(detectados === MUTANTES.length ? 0 : 1);
