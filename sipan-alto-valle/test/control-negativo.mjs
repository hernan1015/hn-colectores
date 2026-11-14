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
  ['estación quieta nunca avisa', 'sipan.mjs', ": st.estado === 'activa' && st.horas > QUIETA_H ? { tipo: 'estacion_quieta'", ": false ? { tipo: 'estacion_quieta'"],
  ['la medición acepta noches incompletas', 'medir.mjs', 'export const MIN_NOCHE = 0.9;', 'export const MIN_NOCHE = 0;'],
  ['el pronóstico con 23 horas cuenta', 'lib/medicion.mjs', "(out[f] ??= {})['d' + d] = ok.length === 24 ? Math.min(...ok) : null;", "(out[f] ??= {})['d' + d] = ok.length ? Math.min(...ok) : null;"],
  ['la radiación con huecos da un total corto', 'lib/resumen.mjs', 'rad_mj_m2: rs.filter((r) => r.ok.rad != null).length === esperados', 'rad_mj_m2: rs.filter((r) => r.ok.rad != null).length > 0'],
  ['falsa alarma contada como acierto', 'lib/medicion.mjs', 'if (po && ob) t.aciertos++; else if (po) t.falsas_alarmas++;', 'if (po) t.aciertos++; else if (false) t.falsas_alarmas++;'],
  ['crudos: borra el viejo ANTES de subir el nuevo', 'lib/releases.mjs', "      const subido = await pedir('POST',", "      for (const v of viejos) await pedir('DELETE', `${API}/repos/${repo}/releases/assets/${v.id}`);\n      const subido = await pedir('POST',"],
  ['crudos: mezcla las estaciones del mismo día', 'lib/releases.mjs', "a.name.startsWith(id + '__') && a.name.endsWith('.json.gz')", "a.name.endsWith('.json.gz')"],
  ['R2 prendido sin pedirlo', 'sipan.mjs', "if (env.SIPAN_R2_ON === 'si' && env.SIPAN_R2_DEPOSITO) {", 'if (env.SIPAN_R2_DEPOSITO) {'],
  ['el histórico acepta años antes de 2018', 'historico-pdf.mjs', 'Math.max(...anios) < 2018', 'Math.max(...anios) < 1900'],
  ['FK: los datos antes que la estación', 'sipan.mjs', '      if (!(await guardarEstacion(e, { ...meta, ...x.meta }))) continue;\n', ''],
  ['FK: guarda los datos aunque la estación falló', 'sipan.mjs', 'if (!(await guardarEstacion(e, { ...meta, ...x.meta }))) continue;', 'await guardarEstacion(e, { ...meta, ...x.meta });'],
  ['barrido sin la pausa desde el último pedido', 'sipan.mjs', 'ultimoPedido: pedidor.ultimo', 'ultimoPedido: null'],
  ['una falla de los crudos corta la corrida', 'sipan.mjs', "        catch (err) { errores.push(`${e.id} crudos: ${String(err && err.message).slice(0, 80)}`); }", '        catch (err) { throw err; }'],
  ['pg: no controla current_user', 'lib/base.mjs', "if (yo !== ROL || sesion !== ROL) {", "if (sesion !== ROL) {"],
  ['pg: no controla session_user', 'lib/base.mjs', "if (yo !== ROL || sesion !== ROL) {", "if (yo !== ROL) {"],
  ['pg: conecta a cualquier host', 'lib/base.mjs', "if (!host || !hostPermitido(host)) {", "if (false) {"],
  ['pg: el host del pooler sin anclar (acepta …pooler.supabase.com.evil.com)', 'lib/base.mjs', String.raw`export const HOST_POOLER = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;`, String.raw`export const HOST_POOLER = /pooler\.supabase\.com/;`],
  ['pg: tmin_noche_en vuelve como Date', 'lib/base.mjs', "for (const k of FECHAHORA) if (o[k] instanceof Date) o[k] = o[k].toISOString();", ""],
  ['pg: lat/lon como texto', 'lib/base.mjs', "'rad_mj_m2', 'lat', 'lon'];", "'rad_mj_m2'];"],
  ['0147b: el ALTER nombra NOBYPASSRLS (falla como no superusuario, PG16+)', 'migracion/0147b_rol_colector_estaciones.sql', "alter role colector_estaciones with login nocreatedb nocreaterole noinherit connection limit 3", "alter role colector_estaciones with login nocreatedb nocreaterole noinherit nobypassrls connection limit 3", { pg: true }],
  ['0147b: no verifica los atributos del rol', 'migracion/0147b_rol_colector_estaciones.sql', "  if r.rolsuper or r.rolreplication or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolinherit then", "  if false then", { pg: true }],
  ['pg: acepta cualquier usuario en la URL', 'lib/base.mjs', 'if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + \'.\'))) {', 'if (!usuario) {'],
  ['pg: el error de conexión sale con el mensaje del driver (URL, host)', 'lib/base.mjs', "  const err = new Error(`${que}: ${codigo}${DESC[codigo] ? ' (' + DESC[codigo] + ')' : ''}`);", "  const err = new Error(`${que}: ${codigo} ${e && e.message}`);"],
  ['pg: el error de una fila sale con el mensaje del driver', 'lib/base.mjs', "errores.push(`${f.estacion_id} ${f.fecha}: ${errorLimpio(e, 'estaciones_obs').message}`);", 'errores.push(`${f.estacion_id} ${f.fecha}: ${e.message}`);'],
  ['pg: con sentencias preparadas (rompe el pooler en modo transacción)', 'lib/base.mjs', 'max: 1, prepare: false,', 'max: 1, prepare: true,'],
  ['pg: no cierra la conexión al terminar', 'medir.mjs', '  finally { if (!baseDada && base.cerrar) await base.cerrar(); }', '  finally { }'],
  ['scram: ServerKey mal calculada', 'migracion/scram.mjs', "update('Server Key')", "update('Client Key')"],
  ['pg: los jsonb sin sql.json', 'lib/base.mjs', 'out[k] = JSONB.has(k) && v != null ? sql.json(v) : v;', 'out[k] = v;'],
  ['inactiva: a los 300 días en vez de 30', 'sipan.mjs', 'export const INACTIVA_DIAS = 30;', 'export const INACTIVA_DIAS = 300;'],
  ['inactiva: avisa en CADA corrida', 'sipan.mjs', "const cambio = estado === previo ? null :", "const cambio = estado === previo && estado === 'activa' ? null :"],
  ['inactiva: vuelve a escribir sus datos viejos', 'sipan.mjs', "      if (x.estadoEst === 'inactiva') {", '      if (false) {'],
  ['inactiva: un 404 de una inactiva avisa', 'sipan.mjs', "if (r.estado === 'no' && !inactiva)", "if (r.estado === 'no')"],
  ['inactiva: tampoco avisa una activa que no responde', 'sipan.mjs', "if (r.estado === 'no' && !inactiva)", 'if (false)'],
  ['mensuales: se les pide en cada corrida', 'sipan.mjs', "(e.pedir !== 'mensual' || primeraDelMes ||", '(true ||'],
  ['la columna activa siempre true', 'lib/estaciones.mjs', "activa: metadatos.estado !== 'inactiva',", 'activa: true,'],
  ['estado_desde se pisa en cada corrida', 'sipan.mjs', 'estado_desde: st.cambio || !metaPrevia.estado_desde ? new Date(ahoraMs).toISOString() : metaPrevia.estado_desde,', 'estado_desde: new Date(ahoraMs).toISOString(),'],
];

function correrCon(nombre, archivo, viejo, nuevo) {
  const dir = path.join(RAIZ, '.mutante');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const x of ['lib', 'test', 'migracion', 'sipan.mjs', 'medir.mjs', 'historico-pdf.mjs']) fs.cpSync(path.join(RAIZ, x), path.join(dir, x), { recursive: true });
  if (archivo) {
    const p = path.join(dir, archivo);
    const txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');   // un clon de Windows con CRLF no rompe la búsqueda
    const veces = txt.split(viejo).length - 1;
    if (veces !== 1) throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces (tiene que ser 1)`);
    fs.writeFileSync(p, txt.replace(viejo, nuevo));
  }
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'test', 'sipan.test.mjs'), path.join(dir, 'test', 'crudos-rol.test.mjs'), path.join(dir, 'test', 'prender.test.mjs'), path.join(dir, 'test', 'base-pg.test.mjs'), path.join(dir, 'test', 'pg-real.test.mjs'), path.join(dir, 'test', 'inactivas.test.mjs')], { encoding: 'utf8', env: process.env });
  return r.status === 0;
}

let muertos = 0;
/* los mutantes de la 0147b sólo se pueden matar con un PostgreSQL de verdad (test/pg-real.test.mjs, SIPAN_PG_BIN) */
const conPg = !!process.env.SIPAN_PG_BIN;
const lista = MUTANTES.filter((m) => conPg || !(m[4] && m[4].pg));
if (!correrCon('sin romper', null)) { console.error('la copia SIN romper no pasa: revisar antes de contar mutantes'); process.exit(1); }
for (const [nombre, archivo, viejo, nuevo] of lista) {
  const pasa = correrCon(nombre, archivo, viejo, nuevo);
  console.log(`${pasa ? 'VIVO   ' : 'muerto '} ${nombre}`);
  if (!pasa) muertos++;
}
fs.rmSync(path.join(RAIZ, '.mutante'), { recursive: true, force: true });
console.log(`${muertos} de ${lista.length} mutantes detectados${conPg ? '' : ` (sin SIPAN_PG_BIN: ${MUTANTES.length - lista.length} de la 0147b sin probar)`}`);
process.exit(muertos === lista.length ? 0 : 1);
