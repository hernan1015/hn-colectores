// Control negativo CONTADO (como el SIPAN): se rompe a propósito una cosa por vez, en una copia, y se corre la suite.
// Cada mutante tiene que hacer fallar al menos un test. Antes se corre la copia SIN romper (tiene que pasar entera).
// Correr: node smn-abierto/test/control-negativo.mjs
//   con SMN_FIXTURES (o la carpeta del cortex en pc-nanci), también los del fixture real;
//   con HN_PGLITE, también los de las migraciones (0149 / 0149b contra PGlite).
// La copia va a <repo>/.mutante/ (en .gitignore), con lib/releases.mjs y la 0147b de sipan-alto-valle al lado, porque
// el colector y el test de PGlite los leen por ruta relativa.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // smn-abierto/
const REPO = path.dirname(RAIZ);
const FIXT = process.env.SMN_FIXTURES || 'C:/HN-AGRO/hn-cortex/docs/red-nacional-139/fixtures';
const conFixture = fs.existsSync(path.join(FIXT, 'smn-datohorario.zip'));
const conPg = !!process.env.HN_PGLITE;

const MUTANTES = [
  // ── el formato ──
  ['el faltante en blanco se lee como 0', 'lib/datohorario.mjs', "if (t === '' || /^-+$/.test(t) || /^n\\/?d$/i.test(t) || /^nan$/i.test(t)) return null;", "if (t === '' || /^-+$/.test(t)) return 0;"],
  ['no se exigen las 8 columnas', 'lib/datohorario.mjs', "if (faltan.length) return { ok: false, motivo: 'faltan_columnas', detalle: faltan.join(','), columnas };", ''],
  ['no se mira el orden de las columnas', 'lib/datohorario.mjs', "if (columnas.join(' ') !== COLUMNAS.join(' ')) return", 'if (false) return'],
  ['acepta la hora en UTC como si fuera HOA', 'lib/datohorario.mjs', "if (hora !== 'HOA') return", 'if (false) return'],
  ['filas rotas sin tope', 'lib/datohorario.mjs', 'export const MAX_DESCARTADAS = 0.1;', 'export const MAX_DESCARTADAS = 1;'],
  ['un campo en blanco corre los demás de columna', 'lib/datohorario.mjs', 'const d = Math.abs(finCol[col] - w.fin);', 'const d = 0;'],
  ['la firma distinta se carga igual', 'smn.mjs', 'if (previa && previa !== p.firma && aceptar !== p.firma) {', 'if (false) {'],
  ['la fecha del nombre no se controla', 'smn.mjs', "if (p.fecha_archivo !== fechaNombre) return", 'if (false) return'],
  ['un ZIP con otras entradas se acepta', 'smn.mjs', 'if (z.entradas.length !== 1 || txts.length !== 1) return', 'if (txts.length < 1) return'],
  ['el archivo vacío del último intento no avisa', 'smn.mjs', 'aviso: ultimo ? {', 'aviso: false ? {'],
  ['el archivo vacío avisa siempre (ruido en el primer intento)', 'smn.mjs', 'aviso: ultimo ? {', 'aviso: true ? {'],
  ['el archivo vacío cuenta como formato roto', 'smn.mjs', "if (!p.ok && p.motivo === 'vacio') {", 'if (false) {', { fixture: true }],
  // ── huecos, imposibles y dedup ──
  ['los imposibles entran en la mínima', 'lib/resumen.mjs', "if (x != null && (x < a || x > b)) { r.marcas.push(`${k}_fuera_de_rango`); r.ok[k] = null; }", "if (x != null && (x < a || x > b)) { r.marcas.push(`${k}_fuera_de_rango`); }"],
  ['sin pico aislado', 'lib/resumen.mjs', 'const SALTO_C = 15;', 'const SALTO_C = 1e9;'],
  ['sin sensor trabado', 'lib/resumen.mjs', 'const TRABADA_H = 12;', 'const TRABADA_H = 1e9;'],
  ['sin dedup al unir', 'lib/resumen.mjs', 'if (!v || llenos(r.v) >= llenos(v.v)) m.set(r.local, r);', 'm.set(r.local + Math.random(), r);'],
  ['la lectura vacía pisa a la completa', 'lib/resumen.mjs', 'if (!v || llenos(r.v) >= llenos(v.v)) m.set(r.local, r);', 'm.set(r.local, r);'],
  ['el día sin temperaturas da 0', 'lib/resumen.mjs', 'tmin_c: t.length ? Math.min(...t) : null,', 'tmin_c: t.length ? Math.min(...t) : 0,'],
  ['la lluvia sin medir sale 0', 'smn.mjs', 'lluvia_mm: null, horas_validas: null,', 'lluvia_mm: 0, horas_validas: 24,'],
  ['un día con huecos pisa uno completo', 'smn.mjs', 'const usarDia = !viejo || dia.registros_validos >= (viejo.registros_validos ?? -1);', 'const usarDia = true;'],
  ['la noche arranca a medianoche', 'lib/resumen.mjs', "const rs = ventana(controladas, sumarDias(fecha, -1) + 'T18:00', fecha + 'T09:00');", "const rs = ventana(controladas, fecha + 'T00:00', fecha + 'T09:00');"],
  ['la lectura de las 00 cuenta para el mismo día', 'lib/resumen.mjs', 'export const diaDe = (local) => new Date(ms(local) - 60e3).toISOString().slice(0, 10);', 'export const diaDe = (local) => new Date(ms(local)).toISOString().slice(0, 10);'],
  ['no se usa lo guardado de ayer', 'smn.mjs', 'const deFila = (fila) => Object.entries(', 'const deFila = (fila) => Object.entries({}) || Object.entries('],
  // ── la licencia ──
  ['MOSTRAR con cualquier licencia', 'lib/licencia.mjs', 'if (l.mostrar === true && !LICENCIAS_MOSTRAR.has(l.licencia))', 'if (false)'],
  ['MOSTRAR sin cita', 'lib/licencia.mjs', "const faltan = ['licencia', 'licencia_url', 'cita', 'politica',", "const faltan = ['licencia', 'licencia_url', 'politica',"],
  ['MOSTRAR con enlace http', 'lib/licencia.mjs', "if (!/^https:\\/\\//.test(l.licencia_url) || !/^https:\\/\\//.test(l.politica_url))", 'if (false)'],
  ['lo guardado pisa la licencia', 'smn.mjs', '...metaLicencia(LICENCIA_SMN),', '...metaLicencia(LICENCIA_SMN), ...metadatos,'],
  ['la estación no lleva la licencia', 'smn.mjs', '      ...metaLicencia(LICENCIA_SMN),\n', ''],
  // ── inactiva y quieta ──
  ['nunca pasa a inactiva', 'smn.mjs', "const estado = horas > INACTIVA_DIAS * 24 ? 'inactiva' : 'activa';", "const estado = 'activa';"],
  ['la inactiva avisa en cada corrida', 'smn.mjs', 'const cambio = estado === previo ? null :', "const cambio = estado === 'activa' && previo === 'activa' ? null :"],
  ['la que manda sólo vacíos no envejece', 'smn.mjs', 'ctrl.filter((r) => Object.values(r.ok).some((x) => x != null))', 'ctrl.filter((r) => true)'],
  ['la quieta nunca avisa', 'smn.mjs', 'export const QUIETA_H = 48;', 'export const QUIETA_H = 1e9;'],
  // ── el pedido y la frecuencia ──
  ['sigue pidiendo después de un corte', 'smn.mjs', "if (cortado) return { estado: 'cortado' };", ''],
  ['un 403 no corta', 'smn.mjs', 'if (r.status === 402 || r.status === 403 || r.status === 429 || r.status >= 500)', 'if (r.status === 402 || r.status === 429 || r.status >= 500)'],
  ['el desafío HTML se acepta', 'smn.mjs', "if (/text\\/html/i.test(tipo) || /^\\s*</.test(buf.subarray(0, 64).toString('latin1')))", 'if (false)'],
  ['más de un pedido por corrida', 'smn.mjs', 'export const TOPE_PEDIDOS = 1;', 'export const TOPE_PEDIDOS = 5;'],
  ['pide aunque el archivo de ayer ya esté cargado', 'smn.mjs', 'if (!archivo && cargado && cargado >= ayer)', 'if (false)'],
  ['guarda los datos aunque su estación falló (FK)', 'smn.mjs', 'x.filasObs.filter((f) => guardadas.has(f.estacion_id) && !inactivas.has(f.estacion_id))', 'x.filasObs.filter((f) => !inactivas.has(f.estacion_id))'],
  ['en seco escribe', 'smn.mjs', 'if (seco) return fin(out);', ''],
  // ── la base ──
  ['pg: otra red', 'lib/base.mjs', "export const RED = 'SMN_ABIERTO';", "export const RED = 'INTA_SIPAN_AV';"],
  ['pg: no controla session_user', 'lib/base.mjs', 'if (yo !== ROL || sesion !== ROL) {', 'if (yo !== ROL) {'],
  ['pg: el error de una fila sale con el mensaje del driver', 'lib/base.mjs', "errores.push(`${f.estacion_id} ${f.fecha}: ${errorLimpio(e, 'estaciones_obs').message}`);", 'errores.push(`${f.estacion_id} ${f.fecha}: ${e.message}`);'],
  // ── workflow y migraciones ──
  ['el workflow con schedule', 'smn-abierto.workflow.yml.txt', 'on:\n  workflow_dispatch:', "on:\n  schedule:\n    - cron: '17 13 * * *'\n  workflow_dispatch:"],
  ['el workflow real por defecto', 'smn-abierto.workflow.yml.txt', 'options: [seco, real]\n        default: seco', 'options: [seco, real]\n        default: real'],
  ['0149: se pierde WEATHERLINK_PUB', 'migracion/0149_smn_abierto_rol.sql', "red in ('INTA_SIPAN_AV', 'WEATHERLINK_PUB', 'SMN_ABIERTO')", "red in ('INTA_SIPAN_AV', 'SMN_ABIERTO')", { pg: true }],
  ['0149: sin el proceso smn_abierto', 'migracion/0149_smn_abierto_rol.sql', "'weatherlink_publico', 'smn_abierto'));", "'weatherlink_publico'));", { pg: true }],
  ['0149: crea políticas aunque falte la 0147b', 'migracion/0149_smn_abierto_rol.sql', "      raise exception '0149: falta la política colector_estaciones_sus_redes en % (aplicar antes la 0147b)', t;\n", '      continue;\n', { pg: true }],
  ['0149b: la llave nace prendida', 'migracion/0149b_smn_abierto_disparo.sql', "('smn-abierto', false,", "('smn-abierto', true,", { pg: true }],
  ['0149b: volver a aplicarla pisa la llave', 'migracion/0149b_smn_abierto_disparo.sql', 'on conflict (etiqueta) do nothing;', 'on conflict (etiqueta) do update set activa = excluded.activa;', { pg: true }],
  ['0149b: sin la guardia de la 0148', 'migracion/0149b_smn_abierto_disparo.sql', "    raise exception '0149b: falta la 0148", "    raise notice '0149b: falta la 0148", { pg: true }],
  ['0149b: el segundo intento sin «ultimo»', 'migracion/0149b_smn_abierto_disparo.sql', `'{"modo":"real","ultimo":"si"}'`, `'{"modo":"real"}'`, { pg: true }],
];

const DIR = path.join(REPO, '.mutante');
const SMN = path.join(DIR, 'smn-abierto');
function correrCon(nombre, archivo, viejo, nuevo) {
  fs.rmSync(DIR, { recursive: true, force: true });
  for (const x of ['lib', 'test', 'migracion', 'node_modules', 'smn.mjs', 'smn-abierto.workflow.yml.txt', 'PRENDER.md', 'package.json']) fs.cpSync(path.join(RAIZ, x), path.join(SMN, x), { recursive: true });
  fs.cpSync(path.join(REPO, 'lib', 'releases.mjs'), path.join(DIR, 'lib', 'releases.mjs'));
  fs.cpSync(path.join(REPO, 'sipan-alto-valle', 'migracion', '0147b_rol_colector_estaciones.sql'), path.join(DIR, 'sipan-alto-valle', 'migracion', '0147b_rol_colector_estaciones.sql'));
  if (archivo) {
    const p = path.join(SMN, archivo);
    const txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');   // un clon de Windows con CRLF no rompe la búsqueda
    const veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const tests = ['smn.test.mjs', 'base-pg.test.mjs', 'estatico.test.mjs', 'migracion-pglite.test.mjs'].map((t) => path.join(SMN, 'test', t));
  const r = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8', env: { ...process.env, ...(conFixture ? { SMN_FIXTURES: FIXT } : {}) } });
  return r.status === 0;
}

const lista = MUTANTES.filter((m) => (conPg || !(m[4] && m[4].pg)) && (conFixture || !(m[4] && m[4].fixture)));
if (!correrCon('sin romper', null)) { console.error('la copia SIN romper no pasa: revisar antes de contar mutantes'); process.exit(1); }
let muertos = 0;
for (const [nombre, archivo, viejo, nuevo] of lista) {
  const pasa = correrCon(nombre, archivo, viejo, nuevo);
  console.log(`${pasa ? 'VIVO   ' : 'muerto '} ${nombre}`);
  if (!pasa) muertos++;
}
fs.rmSync(DIR, { recursive: true, force: true });
const fuera = MUTANTES.length - lista.length;
console.log(`${muertos} de ${lista.length} mutantes detectados${fuera ? ` (${fuera} sin probar: ${conPg ? '' : 'falta HN_PGLITE '}${conFixture ? '' : 'falta SMN_FIXTURES'})` : ''}`);
process.exit(muertos === lista.length ? 0 : 1);
