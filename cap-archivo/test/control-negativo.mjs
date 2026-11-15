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
  ['sin pausa después de un corte', F, '    estado.pausa_hasta = ahora() + minutos(minutosDePausa(m, r.retry_after));\n', ''],
  ['la pausa no se respeta', F, '  if (estado.pausa_hasta && estado.pausa_hasta > t0) {', '  if (false) {'],
  ['el Retry-After no se respeta', S, 'return Number.isFinite(ra) && ra > 0 ? Math.max(base, Math.min(360, Math.ceil(ra / 60))) : base;', 'return base;'],
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
  ['lista blanca abierta (cualquier carpeta del SMN)', S, '      if (!CARPETAS.includes(carpeta)) { fuera[carpeta] = (fuera[carpeta] || 0) + 1; continue; }\n', ''],
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
