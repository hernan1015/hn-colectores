#!/usr/bin/env node
// 257 · control negativo de los tests: se rompe el código a propósito (una copia en una carpeta temporal) y los
// tests TIENEN que fallar. Si alguna mutación pasa los tests, el test no está cuidando eso.
//   HN_PGLITE=…/@electric-sql/pglite node test/control-negativo.mjs
// Corre los tests de JS y los de la 0153 (PGlite). Sin HN_PGLITE, los de la migración se saltean y sus mutantes
// quedan vivos: por eso se exige.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = 'migracion/0153_estaciones_zona_PROPUESTA.sql';
const MUTANTES = [
  ['umbral de urbana 30 → 3', 'lib/regla.mjs', 'export const UMBRAL_URBANA = 30;', 'export const UMBRAL_URBANA = 3;'],
  ['desempate al revés', 'lib/regla.mjs', "['agricola', 'pastizal', 'natural'].sort(", "['natural', 'pastizal', 'agricola'].sort("],
  ['el 0 cuenta como dato', 'lib/regla.mjs', 'for (const c of CLASES) total += conteos?.[c] || 0;', 'for (const c of [0, ...CLASES]) total += conteos?.[c] || 0;'],
  ['píxel corrido una columna', 'lib/grilla.mjs', 'return { gx: Math.floor((lon + 180) * PX_POR_GRADO)', 'return { gx: 1 + Math.floor((lon + 180) * PX_POR_GRADO)'],
  ['tile nombrado por la esquina norte', 'lib/grilla.mjs', 'const latS = 90 - (ty + 1) * 3;', 'const latS = 90 - ty * 3;'],
  ['un error cualquiera se toma como tile faltante', 'lib/worldcover.mjs', 'export const esFaltante = (e) => e?.tileInexistente === true;', 'export const esFaltante = (e) => true;'],
  ['se mira sólo el píxel', 'lib/worldcover.mjs', 'if (d <= r) conteos[r][v]', 'if (gx === gxP && gy === gyP) conteos[r][v]'],
  ['la caché no se usa', 'lib/worldcover.mjs', 'if (enCache) { out.set(p.clave, enCache); continue; }', ''],
  // ── 2.ª vuelta (Codex 15/11, n3-257-1511) ──
  ['C1 · la cobertura no se mira', 'lib/regla.mjs', 'if (!total || total * 100 < umbralCobertura * circulo) {', 'if (!total) {'],
  ['C1 · lo no leído vale 0 y no cuenta en el círculo', 'lib/worldcover.mjs', 'new Uint8Array(ancho * alto).fill(NO_LEIDO)', 'new Uint8Array(ancho * alto)'],
  ['C1 · sin marca de dudosa por cobertura', 'lib/regla.mjs', "if (total < circulo) motivos.push('cobertura');", ''],
  ['C1 · umbral de cobertura 90 → 40', 'lib/regla.mjs', 'export const UMBRAL_COBERTURA = 90;', 'export const UMBRAL_COBERTURA = 40;'],
  ['C2 · un 403 se toma como «no existe»', 'lib/worldcover.mjs', 'if (sonda.status === 404) throw new TileInexistente();', 'if (sonda.status === 404 || sonda.status === 403) throw new TileInexistente();'],
  ['C2 · faltante por el texto del error', 'lib/worldcover.mjs', 'export const esFaltante = (e) => e?.tileInexistente === true;', 'export const esFaltante = (e) => e?.tileInexistente === true || /40[34]/.test(String(e?.message));'],
  ['C2 · el error copia el texto original', 'lib/worldcover.mjs', "if (!esFaltante(e)) throw (e?.propio ? e : new FallaLectura('un tile no se pudo abrir'));", 'if (!esFaltante(e)) throw e;'],
  ['C2 · el log nombra el tile', 'lib/worldcover.mjs', 'log(`tile ${i}/${nombres.length} listo', 'log(`tile ${nombre} ${i}/${nombres.length} listo'],
  ['C2 · el CLI imprime cualquier mensaje', 'clasificar-zona.mjs', 'export const mensajeError = (e) => (e?.propio ?', 'export const mensajeError = (e) => (true ?'],
  ['C3 · urbana con el % redondeado', 'lib/regla.mjs', 'if (n(50) * 100 >= umbralUrbana * total) {', 'if (pct[50] >= umbralUrbana) {'],
  ['C3 · ganador con el % redondeado', 'lib/regla.mjs', '.sort((a, b) => g[b] - g[a])', '.sort((a, b) => grupos[b] - grupos[a])'],
  ['C3 · dudosa con el margen redondeado', 'lib/regla.mjs', 'if (ventaja * 100 < umbralMargen * total)', 'if (mostrar(ventaja, total) < umbralMargen)'],
  ['C4 · sin validar lat', SQL, "if not public.estaciones_zona_en_rango(d->'lat', -90, 90) then return false; end if;", ''],
  ['C4 · sin validar la regla', SQL, "if jsonb_typeof(d->'regla') <> 'string' or d->>'regla' not in ('r1') then return false; end if;", ''],
  ['C4 · sin validar los %', SQL, 'or not public.estaciones_zona_en_rango(x.value, 0, 100)) else false end', ') else false end'],
  ['C4 · sin validar la cita', SQL, "foreach k in array array['cita', 'fuente', 'licencia', 'calculado_en'] loop", "foreach k in array array['fuente', 'licencia', 'calculado_en'] loop"],
  ['C4 · claves de más aceptadas', SQL, 'if exists (select 1 from jsonb_object_keys(d) x where x <> all (claves)) then return false; end if;', ''],
  ['C4 · pendientes castea sin mirar el tipo', SQL, "coalesce(public.estaciones_zona_num(e.metadatos->'zona_wc'->'lat'), 999)", "coalesce((e.metadatos->'zona_wc'->>'lat')::numeric, 999)"],
  ['--todas reescribe lo que no cambió', SQL, "is not distinct from p_detalle - 'calculado_en' then", "is not distinct from p_detalle - 'calculado_en' and false then"],
  ['C5 · TLS sin autenticar', 'lib/base.mjs', 'ssl: { rejectUnauthorized: true, ca, servername: host', 'ssl: { rejectUnauthorized: false, ca, servername: host'],
  ['C5 · ssl:"require"', 'lib/base.mjs', "ssl: { rejectUnauthorized: true, ca, servername: host, minVersion: 'TLSv1.2' },", "ssl: 'require',"],
  ['C5 · sin CA igual conecta', 'lib/base.mjs', 'const opciones = opcionesPg(host, ca ?? leerCa());', 'const opciones = opcionesPg(host, ca);'],
];

if (!process.env.HN_PGLITE) { console.log('falta HN_PGLITE (los mutantes de la 0153 necesitan PGlite)'); process.exit(2); }
let malos = 0;
for (const [nombre, archivo, de, a] of MUTANTES) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zona257-'));
  fs.cpSync(RAIZ, tmp, { recursive: true, filter: (s) => !/[\\/](node_modules|cache|datos)([\\/]|$)/.test(s) });
  // postgres.js para el test de TLS: una junction al node_modules de verdad (se quita ANTES de borrar la copia)
  const nm = path.join(tmp, 'node_modules');
  if (fs.existsSync(path.join(RAIZ, 'node_modules'))) fs.symlinkSync(path.join(RAIZ, 'node_modules'), nm, 'junction');
  const f = path.join(tmp, archivo);
  const txt = fs.readFileSync(f, 'utf8');
  if (!txt.includes(de)) { console.log(`✗ ${nombre}: no encontré el texto a mutar`); malos++; }
  else {
    fs.writeFileSync(f, txt.replace(de, a));
    const tests = ['zona.test.mjs', 'vuelta2.test.mjs', 'migracion.test.mjs'].map((t) => path.join(tmp, 'test', t));
    const r = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8' });
    const cae = r.status !== 0;
    console.log(`${cae ? '✓' : '✗'} ${nombre}: ${cae ? 'los tests fallan (bien)' : 'LOS TESTS PASAN (mal)'}`);
    if (!cae) malos++;
  }
  try { fs.rmdirSync(nm); } catch { /* no había */ }
  if (fs.existsSync(nm)) { console.log('✗ no se pudo quitar la junction: no borro la copia'); process.exit(1); }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(malos ? `${malos} mutantes vivos` : `los ${MUTANTES.length} mutantes caen`);
process.exit(malos ? 1 : 0);
