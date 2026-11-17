// Control negativo CONTADO: se rompe a propósito una cosa por vez (en una copia de lib/) y se corre la suite.
// Cada mutante tiene que hacer fallar al menos un test. Al final: «N de N mutantes detectados».
// Antes se corre la copia SIN romper (tiene que pasar entera), así un fallo no es culpa de la copia.
// Correr: node test/control-negativo.mjs  (dentro de gremlin/)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUTANTES = [
  // claves
  ['clave de tesela con columna_fila', 'colector.mjs', 'export const nombreTesela = ({ fila, col }) => `${p3(fila)}_${p3(col)}`;', 'export const nombreTesela = ({ fila, col }) => `${p3(col)}_${p3(fila)}`;'],
  ['clave sin el zoom', 'colector.mjs', "`${dirTiempo(t)}/${String(ZOOM).padStart(2, '0')}/${nombreTesela(tes)}.png`", '`${dirTiempo(t)}/${nombreTesela(tes)}.png`'],
  ['acepta tiempos imposibles', 'slider.mjs', 'return Number.isFinite(ms) && isoTiempo(ms) === aIso(t);', 'return true;'],
  ['URL de tesela con el zoom sin cero', 'slider.mjs', '/${p2(zoom)}/${p3(fila)}_${p3(col)}.png', '/${zoom}/${p3(fila)}_${p3(col)}.png'],
  // recorte
  ['zoom 2 (4 km) en vez del nativo', 'slider.mjs', 'export const ZOOM = 3;', 'export const ZOOM = 2;'],
  ['lon0 de GOES-West (−137.2)', 'slider.mjs', 'LON0 = -75.0,', 'LON0 = -137.2,'],
  ['caja sin Patagonia sur', 'slider.mjs', 'lat_min: -56.5,', 'lat_min: -45,'],
  ['filas y columnas cruzadas', 'slider.mjs', 'const fila = Math.floor(p.fila / TESELA_PX), col = Math.floor(p.col / TESELA_PX);', 'const col = Math.floor(p.fila / TESELA_PX), fila = Math.floor(p.col / TESELA_PX);'],
  ['sin el test de visibilidad del disco', 'slider.mjs', 'sy * sy + (REQ * REQ / (RPOL * RPOL)) * sz * sz) return null;', 'sy * sy + (REQ * REQ / (RPOL * RPOL)) * sz * sz) { /* nada */ }'],
  // idempotencia
  ['rebaja tiempos completos', 'colector.mjs', "if (e && e.estado === 'completo') continue;", ''],
  ['rebaja las teselas ya guardadas', 'colector.mjs', 'const aPedir = esperadas.filter((x) => !guardadas.has(nombreTesela(x)));', 'const aPedir = esperadas;'],
  ['olvida el índice entre tiempos del mismo día', 'colector.mjs', '    indices.set(ki, ind);\n', '\n'],
  // faltantes y basura
  ['guarda un 200 que no es PNG', 'colector.mjs', '      else motivo = motivoTeselaMala(r.buf);', '      else motivo = null;'],
  ['no compara el tamaño anunciado', 'colector.mjs', 'else if (r.largo && r.buf.length !== r.largo)', 'else if (false)'],
  ['no exige el IEND', 'slider.mjs', "if (!buf.subarray(buf.length - 8).equals(FIN_PNG)) return 'PNG cortado (sin IEND)';", ''],
  ['incompleto marcado como completo', 'colector.mjs', "const estado = faltantes.length === 0 && teselas.length === esperadas.length ? 'completo' : 'incompleto';", "const estado = 'completo';"],
  ['olvida las teselas previas al reintentar', 'colector.mjs', 'const guardadas = new Map((previo?.teselas || []).map((x) => [nombreTesela(x), x]));', 'const guardadas = new Map();'],
  ['reintenta sin tope de intentos', 'colector.mjs', 'if (e && (e.intentos || 0) >= MAX_INTENTOS) continue;', ''],
  ['ventana sin límite hacia atrás', 'colector.mjs', 'if (ms < ahoraMs - VENTANA_H * HORA || ms > ahoraMs + 15 * 60000) continue;', 'if (ms > ahoraMs + 15 * 60000) continue;'],
  // tope y cortesía
  ['sin tope de pedidos', 'colector.mjs', 'if (res.pedidos + aPedir.length > maxPedidos) {', 'if (false) {'],
  ['tope sin acotar', 'colector.mjs', 'return Math.min(TOPE_MAX, Math.max(TOPE_MIN, n));', 'return n;'],
  ['sin pausa entre pedidos', 'colector.mjs', 'if (res.pedidos > 0 && pausaMs > 0) await esperar(pausaMs);', ''],
  ['sin UA', 'colector.mjs', "headers: { 'user-agent': UA, accept: 'image/png,application/json' }", "headers: { accept: 'image/png,application/json' }"],
  ['no corta ante un 429', 'colector.mjs', "if (r.status === 429 || r.status === 403) cortar = `SLIDER respondió ${r.status}`;\n      else ", ''],
  ['no corta ante fallas seguidas', 'colector.mjs', 'else if (fallasSeguidas >= FALLAS_SEGUIDAS_CORTE) cortar = `${fallasSeguidas} fallas seguidas`;', ''],
  ['del más nuevo al más viejo', 'slider.mjs', 'return [...ok].sort();', 'return [...ok].sort().reverse();'],
  // la llave
  ['llave ignorada', 'colector.mjs', "if (llave !== 'si') {", 'if (false) {'],
  ['llave sin distinguir mayúsculas', 'colector.mjs', "if (llave !== 'si') {", "if (String(llave).toLowerCase() !== 'si') {"],
  ['seco que baja igual', 'colector.mjs', "if (modo === 'seco') {", 'if (false) {'],
  // el sobre
  ['sobre sin caja', 'colector.mjs', 'zoom: ZOOM, resolucion: RESOLUCION, tesela_px: TESELA_PX, caja: { ...CAJA },', 'zoom: ZOOM, resolucion: RESOLUCION, tesela_px: TESELA_PX,'],
  ['sobre sin cita', 'slider.mjs', "  cita: 'GOES-19 · NOAA · imágenes CIRA/RAMMB SLIDER · GREMLIN (CIRA)',\n", ''],
  ['sobre sin faltantes', 'colector.mjs', '      teselas, faltantes, generado: isoTiempo(ahoraMs),', '      teselas, faltantes: [], generado: isoTiempo(ahoraMs),'],
  ['sobre con el tiempo de la corrida', 'colector.mjs', 'tiempo: isoTiempo(tiempoMs(t)),', 'tiempo: isoTiempo(ahoraMs),'],
  ['índice sin faltantes', 'colector.mjs', 'faltantes: faltantes.map(nombreTesela), intentos,', 'faltantes: [], intentos,'],
  // 311b (revisión de Codex)
  ['visibilidad con H·(H − sx) (la de antes)', 'slider.mjs', 'if (sx * (H - sx) < sy * sy', 'if (H * (H - sx) < sy * sy'],
  ['sin el CRC de los chunks', 'slider.mjs', "!== buf.readUInt32BE(pos + 8 + largo)) return `PNG con el CRC de ${tipo} mal`;", "!== buf.readUInt32BE(pos + 8 + largo) && false) return 'x';"],
  ['sin descomprimir el IDAT', 'slider.mjs', "try { crudo = zlib.inflateSync(Buffer.concat(idat)); } catch { return 'PNG con el IDAT corrupto'; }", "try { crudo = zlib.inflateSync(Buffer.concat(idat)); } catch { crudo = Buffer.alloc(alto * (1 + Math.ceil((ancho * CANALES[color] * prof) / 8))); }"],
  ['no recupera lo que quedó en R2 sin sobre', 'colector.mjs', "if (guardadas.has(nombreTesela(tes)) || !enR2.has(clave)) continue;", 'continue;'],
  ['adopta lo de R2 sin validarlo', 'colector.mjs', '      if (!b || motivoTeselaMala(b)) continue;', '      if (!b) continue;'],
  // 311b, 3.ª vuelta (n3-311b-v2): el PNG según la especificación
  ['PLTE de cualquier largo', 'slider.mjs', "if (largo === 0 || largo % 3 !== 0) return 'PNG con una PLTE de largo inválido';", ''],
  ['PLTE sin tope de entradas', 'slider.mjs', 'if (entradas > Math.min(256, 2 ** ihdr[8])) return', 'if (false) return'],
  ['PLTE sin tope por profundidad (sólo 256)', 'slider.mjs', 'if (entradas > Math.min(256, 2 ** ihdr[8])) return', 'if (entradas > 256) return'],
  ['dos PLTE aceptadas', 'slider.mjs', "if (entradas) return 'PNG con dos PLTE';", ''],
  ['tRNS sin tope', 'slider.mjs', "if (largo > entradas) return 'PNG con más tRNS que entradas de PLTE';", ''],
  ['tRNS antes de PLTE aceptado', 'slider.mjs', "if (!entradas) return 'PNG con tRNS antes de la PLTE';", ''],
  ['tRNS después del IDAT aceptado', 'slider.mjs', "if (idat.length) return 'PNG con tRNS después del IDAT';", ''],
  ['profundidad sin mirar el tipo', 'slider.mjs', 'if (!PROFUNDIDADES[color].includes(prof)) return', 'if (![1, 2, 4, 8, 16].includes(prof)) return'],
  ['cualquier tipo de color', 'slider.mjs', 'if (color !== 3) return', 'if (false) return'],
  ['sin mirar los índices', 'slider.mjs', 'if (indice >= entradas) return', 'if (false) return'],
  ['índices sin deshacer el filtro', 'slider.mjs', 'fila[i] = (ent[i] + pred) & 0xff;', 'fila[i] = ent[i];'],
  ['Paeth mal (elige c antes que b)', 'slider.mjs', 'pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;', 'pred = pa <= pb && pa <= pc ? a : pc <= pb ? c : b;'],
  ['índices de profundidad < 8 mal leídos', 'slider.mjs', '(fila[bit >> 3] >> (8 - prof - (bit & 7))) & mascara', '(fila[bit >> 3] >> (bit & 7)) & mascara'],
  ['chunk crítico desconocido aceptado', 'slider.mjs', '} else if (tipo.charCodeAt(0) < 97) {', '} else if (false) {'],
  ['IDAT no consecutivos aceptados', 'slider.mjs', "if (idatCerrado) return 'PNG con IDAT no consecutivos';", ''],
  // retención (17/11): 90 días, salvo los días con casos
  ['retención de 89 días', 'retencion.mjs', 'export const DIAS_RETENCION = 90;', 'export const DIAS_RETENCION = 89;'],
  ['casos sin el D+1 UTC', 'retencion.mjs', 'for (const d of dias) { out.add(d); out.add(siguienteDia(d)); }', 'for (const d of dias) { out.add(d); }'],
  ['casos ignorados', 'retencion.mjs', '    if (!protegidos.has(dia)) {', '    if (true) {'],
  ['borra con la lista inválida', 'retencion.mjs', "  if (!protegidos) {\n    log('gremlin · retención: la lista de días con casos no es válida; no borro nada');\n    return { estado: 'sin-lista', borrados: 0 };\n  }", '  if (!protegidos) return limpiar({ almacen, casos: { dias: [] }, ahoraMs, tope, log });'],
  ['acepta días imposibles en la lista', 'retencion.mjs', "&& new Date(Date.parse(d + 'T00:00:00Z')).toISOString().slice(0, 10) === d;", ';'],
  ['sin tope de borrados', 'retencion.mjs', 'const lote = objetos.slice(0, tope - borrados);', 'const lote = objetos;'],
  ['la marca avanza con el día a medias', 'retencion.mjs', '      if (lote.length < objetos.length) break;', ''],
  ['[M1] lista vacía válida', 'retencion.mjs', 'if (!dias || dias.length === 0 || !dias.every(esDia)) return null;', 'if (!dias || !dias.every(esDia)) return null;'],
  ['[M2] sin mirar el reloj contra SLIDER', 'retencion.mjs', 'if (!Number.isFinite(masNuevoMs) || ahoraMs - masNuevoMs > ADELANTO_MAX_MS) {', 'if (false) {'],
  ['[M2] adelanto de 10 días', 'retencion.mjs', 'export const ADELANTO_MAX_MS = 86400000;', 'export const ADELANTO_MAX_MS = 10 * 86400000 + 1;'],
  ['[M2] la corrida no pasa la referencia', 'colector.mjs', 'masNuevoMs: tiempos.length ? tiempoMs(tiempos.at(-1)) : NaN,', 'masNuevoMs: ahoraMs,'],
  ['[M3] el índice en la misma tanda', 'retencion.mjs', "      const objetos = claves.filter((k) => !k.endsWith('/indice.json'));", '      const objetos = claves;'],
  ['[M3] borra el índice aunque haya fallas', 'retencion.mjs', '      if (fallas) throw new Error(', '      if (false) throw new Error('],
  ['[M3] índice sin borrar nunca', 'retencion.mjs', '      for (const k of indices) { await almacen.borrar(k); borrados++; }', ''],
  ['marca ilegible = empezar de cero', 'retencion.mjs', "catch { log('gremlin · retención: la marca no se puede leer; no borro nada'); return { estado: 'sin-marca', borrados: 0 }; }", 'catch { /* sigue */ }'],
  ['la corrida no limpia', 'colector.mjs', '  if (casos !== undefined) res.retencion = await limpiar(', '  if (false) res.retencion = await limpiar('],
  ['SLIDER caído escribe igual', 'colector.mjs', "    return { ...res, estado: 'slider-caido' };", '    tiempos = [];'],
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
  const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'test', 'gremlin.test.mjs')], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GREMLIN_LIB: pathToFileURL(path.join(dir, 'lib')).href + '/' },
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
