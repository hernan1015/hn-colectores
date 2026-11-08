// Control negativo CONTADO: se rompe a propósito una cosa por vez (en una copia de lib/) y se corre la suite.
// Cada mutante tiene que hacer fallar al menos un test. Al final: «N de N mutantes detectados».
// Antes se corre la copia SIN romper (tiene que pasar entera), así un fallo no es culpa de la copia.
// La copia va en <raíz del repo>/.goes-mutante/lib (a la misma altura que goes-serie/lib, por el import de rayos-hora).
// Correr: node goes-serie/test/control-negativo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(path.dirname(RAIZ), '.goes-mutante');
// [nombre, [[archivo, texto exacto (1 vez), reemplazo], …]]
const MUTANTES = [
  ['retención de 31 días', [['claves.mjs', 'export const RETENCION_DIAS = 30;', 'export const RETENCION_DIAS = 31;']]],
  ['la rotación también barre goes-eventos/', [
    ['claves.mjs', "if (typeof k !== 'string' || !k.startsWith(PREFIJO_SERIE)) continue;", "if (typeof k !== 'string') continue;"],
    ['claves.mjs', 'export const RE_IMAGEN = /^goes-serie\\/', 'export const RE_IMAGEN = /^goes-(?:serie|eventos\\/[a-z0-9-]+)\\/'],
    ['serie.mjs', 'const todo = await r2.listar(PREFIJO_SERIE);', "const todo = await r2.listar('goes-');"],
    ['serie.mjs', 'if (!k.startsWith(PREFIJO_SERIE)) continue;', ''],
  ]],
  ['la rotación borra el índice de un día que todavía tiene turnos', [['claves.mjs', 'if (d != null && d + DIA_MS <= corte) out.push(k);', 'if (d != null && d <= corte) out.push(k);']]],
  ['el mes sale corrido (getUTCMonth sin +1)', [['claves.mjs', 'dd(d.getUTCMonth() + 1)}/${dd(d.getUTCDate())}`, hhmm', 'dd(d.getUTCMonth())}/${dd(d.getUTCDate())}`, hhmm']]],
  ['el turno no se redondea a 10 min', [['claves.mjs', 'export const turno = (ms) => Math.floor(ms / PASO_MS) * PASO_MS;', 'export const turno = (ms) => Math.floor(ms / 60e3) * 60e3;']]],
  ['un turno sin cerrar cuenta como faltante', [['claves.mjs', 'export const MARGEN_CIERRE_MS = 30 * 60e3;', 'export const MARGEN_CIERRE_MS = 0;']]],
  ['goesDesde salta los cortes', [['claves.mjs', 'if (desde - s[i] !== PASO_MS) break;', '']]],
  ['ventana del evento de ±5 h', [['claves.mjs', 'export const VENTANA_EVENTO_H = 6;', 'export const VENTANA_EVENTO_H = 5;']]],
  ['el firmador no recibe los manifiestos', [['claves.mjs', 'if (RE_EVENTO_MANIFIESTO.test(k)) { r.eventos_manifiestos.push(o); continue; }', '']]],
  ['una imagen que falla corta la serie', [['serie.mjs', 'try { buf = await noaa.bajar(o); }\n    catch (e) { faltante(t, codigoDe(e));', 'try { buf = await noaa.bajar(o); }\n    catch (e) { throw e;']]],
  ['una imagen que falla no se cuenta como faltante', [['serie.mjs', 'try { buf = await noaa.bajar(o); }\n    catch (e) { faltante(t, codigoDe(e));', 'try { buf = await noaa.bajar(o); }\n    catch (e) {']]],
  ['un fallo al subir a R2 no se cuenta', [['serie.mjs', 'try { await r2.escribir(clave, buf, { tipo: TIPO }); }\n    catch (e) { faltante(t, codigoDe(e));', 'try { await r2.escribir(clave, buf, { tipo: TIPO }); }\n    catch (e) {']]],
  ['rota con la serie parada', [['serie.mjs', 'if (borrar.length && !res.guardadas && !reciente) {', 'if (false) {']]],
  ['no rota', [['serie.mjs', 'try { await r2.borrar(k); res.borradas++; }', 'try { res.borradas++; }']]],
  ['el índice pisa lo anterior (no fusiona)', [['serie.mjs', 'const img = new Map(((previo && Array.isArray(previo.imagenes)) ? previo.imagenes : []).map((e) => [e.hhmm, e]));', 'const img = new Map();']]],
  ['un faltante que llega tarde sigue en faltantes', [['serie.mjs', 'for (const h of img.keys()) fal.delete(h);', '']]],
  ['re-baja lo que ya está en R2', [['serie.mjs', 'if (enR2.has(claveImagen(t))) { res.ya_estaban++; continue; }', '']]],
  ['de a 8 bajadas por vez', [['serie.mjs', 'const PARALELO = 2;', 'const PARALELO = 8;']]],
  ['no verifica el tamaño bajado', [['noaa.mjs', "if ((largo && buf.length !== largo) || (obj.bytes && buf.length !== obj.bytes)) throw errorCodigo('noaa_incompleto');", '']]],
  ['no verifica la firma HDF5', [['noaa.mjs', "if (buf.length < 8 || !buf.subarray(0, 8).equals(FIRMA_HDF5)) throw errorCodigo('noaa_no_hdf5');", '']]],
  ['pisa un evento que ya existe con otros datos', [['evento.mjs', 'if (previo && (previo.lat !== e.lat', 'if (false && (previo.lat !== e.lat']]],
  ['sin respaldo «bajar y subir» cuando R2 no copia', [['evento.mjs', "if (codigoDe(x) !== 'r2_copiar_no_soportado') throw x;", 'throw x;']]],
  ['no controla el sha256 al bajar y subir', [['evento.mjs', "if (meta.sha256 && sha !== meta.sha256) throw errorCodigo('origen_sha256_distinto');", '']]],
  ['lo que todavía no pasó cuenta como faltante', [['evento.mjs', 'if (t + MARGEN_CIERRE_MS > ahoraMs) { res.pendientes++; continue; }', '']]],
  ['no valida el nombre del evento', [['evento.mjs', "if (!RE_EVENTO.test(ev)) throw errorCodigo('evento_invalido');", '']]],
  ['vuelve a copiar lo que ya está en el evento', [['evento.mjs', 'if (destino.has(dest)) { res.ya_estaban++;', 'if (false) { res.ya_estaban++;']]],
];

function correrCon(nombre, cambios) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.cpSync(path.join(RAIZ, 'lib'), path.join(DIR, 'lib'), { recursive: true });
  for (const [archivo, viejo, nuevo] of cambios) {
    const p = path.join(DIR, 'lib', archivo);
    const txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');      // un checkout con CRLF no rompe los mutantes de varias líneas
    const veces = txt.split(viejo).length - 1;
    if (veces !== 1) { fs.rmSync(DIR, { recursive: true, force: true }); throw new Error(`mutante «${nombre}»: el texto aparece ${veces} veces en ${archivo} (tiene que ser 1)`); }
    fs.writeFileSync(p, txt.replace(viejo, () => nuevo));
  }
  const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'test', 'goes-serie.test.mjs')], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GOES_LIB: pathToFileURL(path.join(DIR, 'lib')).href + '/' },
  });
  fs.rmSync(DIR, { recursive: true, force: true });
  const fallan = Number((r.stdout.match(/ℹ fail (\d+)/) || [])[1] || 0);
  return { codigo: r.status, fallan };
}

const base = correrCon('sin romper', []);
if (base.codigo !== 0) { console.log(`la copia SIN romper falla (${base.fallan} tests): el control no vale`); process.exit(2); }
console.log('copia sin romper: pasa entera');
let detectados = 0;
for (const [nombre, cambios] of MUTANTES) {
  const r = correrCon(nombre, cambios);
  const ok = r.codigo !== 0;
  if (ok) detectados++;
  console.log(`${ok ? 'detectado ' : 'NO DETECTADO'} · ${nombre} · tests que fallan: ${r.fallan}`);
}
console.log(`\n${detectados} de ${MUTANTES.length} mutantes detectados`);
process.exit(detectados === MUTANTES.length ? 0 : 1);
