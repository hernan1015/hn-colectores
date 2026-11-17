// Control negativo CONTADO del colector de METAR (317): se rompe a propósito una cosa por vez, en una copia de lib/, y se
// corre la suite contra la copia (METAR_LIB). Cada mutante tiene que hacer fallar al menos un test. Antes se corre la copia
// SIN romper, que tiene que pasar entera. Correr: node test/control-negativo.mjs  (dentro de metar/). El patrón es el de gremlin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUTANTES = [
  // el parser
  ['GR no cuenta como granizo', 'metar.mjs', "export const GRANIZO = Object.freeze(['GR', 'GS']);", "export const GRANIZO = Object.freeze(['GS']);"],
  ['GS no cuenta como granizo', 'metar.mjs', "export const GRANIZO = Object.freeze(['GR', 'GS']);", "export const GRANIZO = Object.freeze(['GR']);"],
  ['VCTS/VCGR cuentan como en la estación', 'metar.mjs', "const ahora = p.presente.filter((g) => g.intensidad !== 'VC' && conGr(g));", 'const ahora = p.presente.filter((g) => conGr(g));'],
  ['la tendencia se lee como presente', 'metar.mjs', "const FIN_CUERPO = new Set(['RMK', 'BECMG', 'TEMPO', 'NOSIG', 'TREND']);", "const FIN_CUERPO = new Set(['RMK']);"],
  ['REGR no se lee', 'metar.mjs', "if (/^RE[A-Z]{2,}$/.test(k)) {", "if (false) {"],
  ['«RE TSRA» con espacio se lee como presente', 'metar.mjs', "if (k === 'RE' && toks[j + 1]) {", "if (false) {"],
  ['sin el tamaño FMH-1 en RMK', 'metar.mjs', 'for (const m of t.matchAll(/\\s(GR|GS)\\s+(LESS THAN\\s+)?', 'for (const m of t.matchAll(/\\s(XX)\\s+(LESS THAN\\s+)?'],
  ['el RMK pegado no se separa', 'metar.mjs', ".replace(/(\\S)RMK(?= |$)/, '$1 RMK')", ''],
  ['acepta letras que sobran (CAVOK como tiempo)', 'metar.mjs', 'if (resto.length) return null;', ''],
  ['el mes anterior no se corrige', 'metar.mjs', 'if (p.dia > ref.getUTCDate() + 1) { mo -= 1; if (mo < 0) { mo = 11; y -= 1; } }', ''],
  // el pedido y la cortesía
  ['sin UA', 'colector.mjs', "headers: { 'user-agent': UA, accept: 'application/json' }", "headers: { accept: 'application/json' }"],
  ['sin pausa entre pedidos', 'colector.mjs', 'if (res.pedidos > 0 && pausaMs > 0) await esperar(pausaMs);', ''],
  ['no corta ante 3 fallas', 'colector.mjs', 'else if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;', ''],
  ['una estación por pedido', 'colector.mjs', "const q = [`ids=${ids.join(',')}`, 'format=json', `hours=${horas}`];", "const q = [`ids=${ids[0]}`, 'format=json', `hours=${horas}`];"],
  ['tope sin acotar', 'colector.mjs', 'return Math.min(max, Math.max(TOPE_MIN, n));', 'return n;'],
  ['no parte la lista al tope de 400', 'colector.mjs', 'if (j.length >= TOPE_API) {', 'if (false) {'],
  // idempotencia y faltantes
  ['reescribe lo que ya está en el índice', 'colector.mjs', "if (c.ind.obs[id] || vistos.has(id)) { res.repetidos++; continue; }", ''],
  ['escribe sin soloSiNoExiste', 'colector.mjs', 'almacen.escribir(p.clave, JSON.stringify(p.sobre), { soloSiNoExiste: true })', 'almacen.escribir(p.clave, JSON.stringify(p.sobre), {})'],
  ['la clave sin el sha del texto (un COR pisa al original)', 'colector.mjs', '-${tipo}-${sha8(crudo)}.json`', '-${tipo}.json`'],
  ['el día de la clave es el de la corrida', 'colector.mjs', 'const ki = claveIndiceDia(x.ms);', 'const ki = claveIndiceDia(ahoraMs);'],
  ['revisa la hora en curso', 'colector.mjs', 'h + HORA <= Math.min(hastaMs, ahoraMs - 10 * MIN) + 1', 'h <= ahoraMs'],
  ['truncado igual revisa horas (faltantes falsos)', 'colector.mjs', 'horas: t.truncado ? [] : horasRevisables(ahoraMs - HORAS_NORMAL * HORA, ahoraMs, ahoraMs)', 'horas: horasRevisables(ahoraMs - HORAS_NORMAL * HORA, ahoraMs, ahoraMs)'],
  ['acepta partes de otra estación', 'colector.mjs', "if (p.estacion !== est) return { descartado: 'el texto es de otra estación' };", ''],
  ['acepta la hora cruzada', 'colector.mjs', 'if (ms == null || Math.abs(ms - ref) > 70 * MIN)', 'if (ms == null)'],
  // la llave, la API caída y el relleno
  ['la llave acepta cualquier cosa', 'colector.mjs', "if (llave !== 'si') {", 'if (!llave) {'],
  // [n3-317col P8] el mutante escribe de verdad el índice (con todas las horas «sin dato») y sigue devolviendo api-caida
  ['la API caída igual escribe el índice', 'colector.mjs', "return { ...res, estado: 'api-caida' };", "await ingerir({ almacen, entradas: [], horas: horasRevisables(ahoraMs - HORAS_NORMAL * HORA, ahoraMs, ahoraMs), ahoraMs, res, indices }); await guardarIndices(almacen, indices, ahoraMs); return { ...res, estado: 'api-caida' };"],
  ['NIL cuenta como dato', 'colector.mjs', 'if (!o.nil && t >= h && t < h + HORA) con.add(o.estacion);', 'if (t >= h && t < h + HORA) con.add(o.estacion);'],
  ['NIL es «última lectura»', 'colector.mjs', 'if (!o.nil && (!ultima[o.estacion]', 'if ((!ultima[o.estacion]'],
  ['NIL en la validación', 'validacion.mjs', 'if (x.descartado || x.parseado.nil) continue;', 'if (x.descartado) continue;'],
  ['un 200 inválido no cuenta como falla', 'colector.mjs', 'const invalida = (motivo) => { fallasSeguidas++;', 'const invalida = (motivo) => { fallasSeguidas += 0;'],
  ['truncado se publica como completo', 'colector.mjs', 'const pub = armarPublico(inds, ahoraMs, { completo });', 'const pub = armarPublico(inds, ahoraMs, { completo: true });'],
  ['el relleno publica', 'colector.mjs', "if (publico && modo === 'real') {", 'if (publico) {'],
  ["317b: sin plazo por pedido (un cuelgue frena todo)","colector.mjs","mal(new Error('TimeoutError')); }, plazoMs); });","mal(new Error('TimeoutError')); }, 1e9); });"],
  ["317b: sin reintento","colector.mjs","if ((r.status === 0 || r.status >= 500) && !cortar && res.pedidos < maxPedidos) {","if (false) {"],
  ["317b: la marca del relleno recién al final", "colector.mjs", "      await guardarMarca(almacen, prog, ahoraMs);\n      res.tramos++;", "      res.tramos++;"],
  ["n3-317b: la marca pisa la de otra corrida", "colector.mjs", "  const actual = (await leerJSON(almacen, CLAVE_RELLENO)) || { v: 1, tramos: {} };", "  const actual = { v: 1, tramos: {} };"],
  ["n3-317b: truncado pisa a hecho", "colector.mjs", "if (tramos[k] !== 'hecho') tramos[k] = v;", "tramos[k] = v;"],
  ["317b: los índices recién al final","colector.mjs","      res.indices += await guardarIndices(almacen, indices, ahoraMs);\n      prog.tramos","      prog.tramos"],
  ["317b: sin presupuesto de tiempo","colector.mjs","if (reloj() - inicio >= presupuestoMs) {","if (false) {"],
  ["317b: sin log por tramo","colector.mjs","· ${res.guardados - antes} nuevos${t.truncado ? ' · TRUNCADO' : ''} · guardado`);","`);"],
  ["317b: escrituras de a una","colector.mjs","export const ESCRITURAS_PARALELAS = 8;","export const ESCRITURAS_PARALELAS = 1;"],
  // [n3-317col-v2] la cobertura del ojo en la celda del aeropuerto y el 200 vacío
  ['validación: sin celda del aeropuerto igual es útil', 'validacion.mjs', "return !!s && s.motivo === 'despejado';", 'return true;'],
  ['validación: sin_pixel cuenta como dato', 'validacion.mjs', "return !!s && s.motivo === 'despejado';", 'return !!s;'],
  ['validación: una celda incompleta es útil', 'validacion.mjs', 'if (c) return !c.incompleta && c.patas != null;', 'if (c) return true;'],
  ['un 200 vacío es «sin partes»', 'colector.mjs', "if (!r.texto.trim()) return invalida('respuesta vacía');", "if (!r.texto.trim()) return { ok: true, entradas: [] };"],
  ['un 200 con lista vacía es «sin partes»', 'colector.mjs', "if (!j.length) return invalida('lista vacía con HTTP 200');", ''],
  ['validación: un barrido parcial da pérdida', 'validacion.mjs', "m.utiles === 0 ? 'SIN DATO' : 'PÉRDIDA'", "m.barridos === 0 ? 'SIN DATO' : 'PÉRDIDA'"],
  ['relleno sin el piso de 30 días', 'colector.mjs', 'const piso = ahoraMs - DIAS_HISTORIA * 24 * HORA + HORA;', 'const piso = 0;'],
  ['relleno repide lo hecho', 'colector.mjs', "if (hechos[k] === 'hecho') continue;", ''],
  // el público
  ['el público sin ventana de 24 h', 'colector.mjs', 'if (!(t >= desde && t <= ahoraMs + 5 * MIN)) continue;', ''],
  ['el público inventa «ultima» para todos', 'colector.mjs', 'ultima: ultima[id] || null', 'ultima: ultima[id] || new Date(ahoraMs).toISOString()'],
  // la validación
  ['validación con 60 km', 'validacion.mjs', 'export const RADIO_KM = 30,', 'export const RADIO_KM = 60,'],
  ['validación: sin barridos es pérdida', 'validacion.mjs', "m.utiles === 0 ? 'SIN DATO' : 'PÉRDIDA'", "'PÉRDIDA'"],
  ['validación: 2 patas cuentan como destacada', 'validacion.mjs', 'if (c.destacada && (!dest || d < dest.km))', 'if ((c.destacada || c.patas >= 2) && (!dest || d < dest.km))'],
  ['validación: REGR no mira la hora anterior', 'validacion.mjs', '? p.ms - RECIENTE_MIN * MIN : p.ms;', '? p.ms : p.ms;'],
  ['validación: sin parte del METAR igual es no confirmada', 'validacion.mjs', 'if (!cerca.length) continue;', ''],
];

const tmp = fs.mkdtempSync(path.join(process.env.METAR_TMP || os.tmpdir(), 'metar-mut-'));
const copiar = () => { const d = path.join(tmp, 'lib'); fs.rmSync(d, { recursive: true, force: true }); fs.cpSync(path.join(RAIZ, 'lib'), d, { recursive: true }); return d; };
// [317b] con tope de tiempo: un mutante que cuelga (sin plazo por pedido) tiene que contar como detectado, no colgar el control
const suite = (lib) => spawnSync(process.execPath, ['--test', '--test-timeout=20000', path.join(RAIZ, 'test', 'metar.test.mjs')], { env: { ...process.env, METAR_LIB: lib }, encoding: 'utf8', timeout: 120000 });

const base = suite(copiar());
if (base.status !== 0) { console.error('la copia SIN romper no pasa: no se puede medir nada'); console.error(base.stdout.slice(-3000)); process.exit(1); }
let detectados = 0;
const vivos = [];
for (const [nombre, archivo, de, a] of MUTANTES) {
  const lib = copiar();
  const f = path.join(lib, archivo);
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes(de)) { console.error(`el mutante «${nombre}» no encuentra su texto en ${archivo}`); process.exit(1); }
  fs.writeFileSync(f, src.replace(de, a));
  const r = suite(lib);
  if (r.status !== 0 || r.error) detectados++; else vivos.push(nombre);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${detectados} de ${MUTANTES.length} mutantes detectados`);
if (vivos.length) { console.log('VIVOS (ningún test los ve): ' + vivos.join(' · ')); process.exit(1); }
