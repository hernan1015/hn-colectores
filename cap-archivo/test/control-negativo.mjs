#!/usr/bin/env node
// Control negativo CONTADO del archivo CAP (225): rompe UNA regla por vez en una copia temporal (lib/ común y
// cap-archivo/) y corre la suite. Cada mutante tiene que hacer caer al menos un test.
// Antes corre la copia SIN romper: tiene que pasar entera, así un fallo no es culpa de la copia.
// Uso: node cap-archivo/test/control-negativo.mjs   (sin red: los tests usan el SMN y GitHub falsos)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = 'cap-archivo/lib/flujo.mjs', S = 'cap-archivo/lib/smn.mjs', E = 'cap-archivo/lib/estado.mjs', B = 'cap-archivo/lib/base.mjs';
const MUTANTES = [
  // anti-spam
  ['el índice se pide dos veces', F, '  const ri = await pedidor.pedir(INDICE_URL);\n', '  await pedidor.pedir(INDICE_URL + \'?otra\');\n  const ri = await pedidor.pedir(INDICE_URL);\n'],
  ['el pedidor repite una URL', S, "    if (pedidas.has(url)) return { url, pedido: false, motivo: 'ya_pedida' };\n", ''],
  ['el pedidor sigue después de un corte', S, "    if (p.cortado) return { url, pedido: false, motivo: 'cortado' };\n", ''],
  ['un 429 no corta', S, "  if (r.http === 429) return 'http_429';\n", ''],
  ['un 403 no corta', S, "  if (r.http === 403) return 'http_403';\n", ''],
  ['sin pausa después de un corte', F, '    estado.pausa_hasta = ahora() + minutos(minutosDePausa(m, r.retry_after, r.pedido_ms));\n', ''],
  ['la pausa no se respeta', F, '  if (estado.pausa_hasta && estado.pausa_hasta > t0) {', '  if (false) {'],
  ['el Retry-After no se respeta', S, 'return ra ? Math.max(base, Math.min(360, Math.ceil(ra / 60))) : base;', 'return base;'],
  ['reintentos sin tope (en bucle)', E, 'export const INTENTOS_MAX = 2;', 'export const INTENTOS_MAX = 99;'],
  ['sin pausa entre pedidos', S, '    if (p.pedidos > 0 && pausaMs > 0) { await dormir(pausaMs); p.pausas++; }\n', ''],
  ['sin tope de XML por corrida', F, '        if (pedidos >= tope) break;\n', ''],
  ['sin User-Agent', S, "headers: { 'User-Agent': UA, Accept", 'headers: { Accept'],
  ['seco pide los XML', F, '    if (!seco) {\n      let pedidos = 0;', '    if (true) {\n      let pedidos = 0;'],
  // dedup
  ['sin dedup por URL', E, '  if (!x) return true;\n  return !x.final && (x.intentos || 0) < INTENTOS_MAX;', '  return true;'],
  ['sin dedup por hash', F, '          const ya = hashes.get(r.sha256);', '          const ya = null;'],
  ['el índice igual se guarda entero', F, '    res.indice.nuevo = !estado.indice || estado.indice.sha256 !== ri.sha256;', '    res.indice.nuevo = true;'],
  ['no se lee el estado del día anterior', E, 'export const DIAS_ATRAS = 3;', 'export const DIAS_ATRAS = 0;'],
  ['el estado se guarda aunque el sobre no subió', F, '    return fin();   // sin el sobre no se toca el estado', '    // sin el sobre no se toca el estado'],
  // lista blanca (222)
  ['lista blanca abierta (cualquier carpeta del SMN)', S, '    if (!CARPETAS.includes(carpeta)) { fuera[carpeta] = (fuera[carpeta] || 0) + 1; return; }\n', ''],
  ['el link sin anclar (otro host pasa)', S, "export const RE_LINK = /^https?:\\/\\/(ssl|forms)\\.smn\\.gob\\.ar\\/feeds", "export const RE_LINK = /https?:\\/\\/[\\w.]+\\/feeds"],
  ['sin el ACP en la lista', S, "export const CARPETAS = Object.freeze(['xml_generados', 'avisocortoplazo', 'oladecalor']);", "export const CARPETAS = Object.freeze(['xml_generados', 'oladecalor']);"],
  ['carpeta nueva sin falla', F, "    for (const [carpeta, n] of Object.entries(lectura.fuera)) avisos.push({ tipo: 'carpeta_nueva', carpeta: carpeta.slice(0, 40), n });\n", ''],
  ['índice cortado sin falla', F, "    else if (!lectura.entero || lectura.abiertos !== lectura.items) avisos.push({ tipo: 'indice_cortado', abiertos: lectura.abiertos, items: lectura.items });\n", ''],
  // avisos y fallas
  ['un aviso de estado cuenta como falla (tope)', F, "new Set(['en_pausa', 'tope', 'xml_no_disponible',", "new Set(['en_pausa', 'xml_no_disponible',"],
  ['una falla cuenta como aviso (smn_corto)', F, "'xml_no_cap', 'estado_nuevo']);", "'xml_no_cap', 'estado_nuevo', 'smn_corto']);"],
  ['un 404 de un XML corta la corrida', S, "  if (r.http >= 500) return 'http_5xx';", "  if (r.http >= 400) return 'http_5xx';"],
  // registro y guardado
  ['sin base no hay falla', F, "      if (!base) avisos.push({ tipo: 'sin_registro' });\n", '      if (!base) {}\n'],
  ['el registro no anota las cantidades', F, '{ ...res, avisos, errores_detalle: errores.slice(0, 10) }', '{ avisos }'],
  ['el índice no se guarda (sólo el hash)', F, '    if (res.indice.nuevo) Object.assign(sobre.indice, cuerpoDe(ri.buf));\n', ''],
  ['la release por día UTC', F, "export const diaAR = (ms) => horaAR(ms).slice(0, 10);", 'export const diaAR = (ms) => new Date(ms).toISOString().slice(0, 10);'],
  ['sin la cita CC BY en las notas', F, "'(https://creativecommons.org/licenses/by/4.0/deed.es). Archivo", "'Archivo"],
  ['la base acepta otro usuario', B, '  if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + \'.\'))) throw', '  if (!usuario) throw'],
  ['la base no verifica la sesión', B, '  if (yo !== ROL || sesion !== ROL) {', '  if (yo !== ROL) {'],
  // workflow
  ['el workflow prendido sin la variable', 'cap-archivo/cap-archivo.workflow.yml.txt', " || vars.CAP_ARCHIVO_ON == 'si' }}", " || true }}"],
  ['a mano, real por defecto', 'cap-archivo/cap-archivo.workflow.yml.txt', '        default: seco', '        default: real'],
  // 2.ª vuelta (n3-225-1511): uno por cada arreglo
  ['P2-1 · un fallido final cuenta como guardado', F, '    res.xml.ya_guardados = lectura.enlaces.filter((e) => estado.urls[e.url] && estado.urls[e.url].asset).length;', '    res.xml.ya_guardados = lectura.enlaces.length - pend.length;'],
  ['P2-2 · el sobre sin los pedidos finales', F, '  // el resumen del sobre: los pedidos ya están todos hechos; lo de la subida (asset, errores) todavía no se sabe y no va\n  res.pedidos = pedidor.pedidos;\n', ''],
  ['P2-3 · un estado ilegible se ignora', F, '  if (est.rotos.length) {', '  if (false) {'],
  ['P2-3 · un estado ilegible hace retroceder a uno viejo', F, '    if (x) return { estado: x.estado, assets: [], rotos: x.rotos,', '    if (x && x.estado) return { estado: x.estado, assets: [], rotos: [],'],
  ['P2-4 · fetch sigue los redirects', S, "redirect: 'manual', signal", 'signal'],
  ['P2-4 · un XML redirigido no es falla', F, "      if (res.xml.redirigidos) avisos.push({ tipo: 'xml_redirige', n: res.xml.redirigidos });\n", ''],
  ['P2-5 · el Retry-After con fecha se ignora', S, '  const ms = Date.parse(t);', '  const ms = NaN;'],
  ['P2-6 · el BOM se come', S, 'ignoreBOM: true', 'ignoreBOM: false'],
  ['P2-7 · yaEstaba con otro contenido pasa', F, '    if (s.yaEstaba && !(await mismoContenido(cliente, rel, nombre, cuerpoSobre))) {', '    if (false) {'],
  ['P2-8 · comentarios y CDATA se leen como marcado', S, '  const t = sinComentariosNiCdata(t0);', '  const t = t0;'],
  ['P2-8 · un link ajeno en un ítem con otro bueno no cuenta', S, '    if (!m) { raros++; return; }', '    if (!m) return;'],
  ['P2-9 · el cuerpo de error del índice no se guarda', F, '  if (ri.http !== 200 && ri.buf) Object.assign(sobre.indice, cuerpoDe(ri.buf));\n', ''],
  ['P2-9 · el cuerpo de error de un XML no se guarda', F, '        if (r.http !== 200 && r.buf) Object.assign(x, cuerpoDe(r.buf));   // el cuerpo de error, si llegó\n', ''],
  ['P2-10 · comillas escapadas en PRENDER', 'cap-archivo/PRENDER.md', 'VERIF=$(CLAVE="$CLAVE" node', 'VERIF=$(CLAVE=\\"$CLAVE\\" node'],
  // 3.ª vuelta (n3-225-v2-1511): uno por cada arreglo
  ['3.ª P2 · un estado listado cuya descarga da 404 se ignora (la 2.ª vuelta)', F, '    for (const a of listados) if (!bajados.has(a.name)) rotos.push(a.name);   // listado pero no bajado: ilegible\n', ''],
  ['3.ª P2 · sin bajar ninguno, la release cuenta como «sin estado» (retrocede o arranca vacío)', F, '    if (!listados.length && !previos.length) return null;', '    if (!previos.length) return null;'],
  ['3.ª P2 · el DOCTYPE no frena la lectura del índice (la 2.ª vuelta)', S, "  if (RE_DTD.test(t0)) return { items: 0, abiertos: 0, entero, enlaces: [], por_carpeta: {}, fuera: {}, raros: 0, dtd: true };\n", ''],
  ['3.ª P2 · sólo DOCTYPE (un <!ENTITY suelto pasa)', S, 'export const RE_DTD = /<!\\s*(?:DOCTYPE|ENTITY)/i;', 'export const RE_DTD = /<!\\s*DOCTYPE/i;'],
  ['3.ª P2 · DTD sensible a mayúsculas (<!doctype pasa)', S, 'export const RE_DTD = /<!\\s*(?:DOCTYPE|ENTITY)/i;', 'export const RE_DTD = /<!\\s*(?:DOCTYPE|ENTITY)/;'],
  ['3.ª P2 · el DTD no es falla (termina en verde)', F, "    if (lectura.dtd) avisos.push({ tipo: 'indice_dtd' });", '    if (lectura.dtd) {}'],
  // 4.ª vuelta (n3-225-v3-1511): un estado a medio subir (starter) es ilegible
  ['4.ª P2 · el listado del estado sólo con los uploaded (la 3.ª vuelta)', F, '    const listados = (await cliente.assets(r, { todos: true })).filter((a) => RE_ESTADO.test(a.name));', '    const listados = (await cliente.assets(r)).filter((a) => RE_ESTADO.test(a.name));'],
  ['4.ª P2 · el cliente ignora `todos` (siempre filtra los uploaded)', 'lib/releases.mjs', "    return todos ? rel._assets.slice() : rel._assets.filter((a) => a.state === 'uploaded');", "    return rel._assets.filter((a) => a.state === 'uploaded');"],
  ['4.ª P2 · el cliente pierde el state (todo cuenta como uploaded)', 'lib/releases.mjs', "state: a.state || 'uploaded', size: a.size", "state: 'uploaded', size: a.size"],
];

function copia() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ctrl-'));
  fs.cpSync(path.join(RAIZ, 'lib'), path.join(d, 'lib'), { recursive: true });
  fs.cpSync(path.join(RAIZ, 'cap-archivo'), path.join(d, 'cap-archivo'), { recursive: true, filter: (s) => !s.includes(`${path.sep}.mutante`) });
  return d;
}
function correr(d) {
  const r = spawnSync(process.execPath, ['--test', 'test/cap-archivo.test.mjs', 'test/base.test.mjs', 'test/workflow.test.mjs'], { cwd: path.join(d, 'cap-archivo'), encoding: 'utf8' });
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
