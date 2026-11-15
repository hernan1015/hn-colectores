#!/usr/bin/env node
// 260 · control negativo de los tests: se rompe el código a propósito (en una copia temporal) y los tests TIENEN que
// fallar. Si un mutante pasa, el test no está cuidando eso.
//   HN_PGLITE=…/@electric-sql/pglite node test/control-negativo.mjs
// Los mutantes de la 0154 necesitan PGlite: sin HN_PGLITE se corta (si no, quedarían vivos sin que se note).
// La copia lleva lo que importan los tests: medicion-app, estaciones-privadas/parseo/lib, el esquema previo del parseo
// y las migraciones del SIPAN.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(RAIZ, '..');
const SQL = 'migracion/0154_medicion_app_PROPUESTA.sql';
const E = 'lib/estacion.mjs', O = 'lib/openmeteo.mjs', M = 'lib/metricas.mjs', J = 'medir-app.mjs', B = 'lib/base.mjs', S = 'lib/sello.mjs', R = 'lib/region.mjs';
const MUTANTES = [
  // el lado de la estación
  ['fracción mínima 0,8 → 0,5', S, 'fraccion_minima: 0.8,', 'fraccion_minima: 0.5,'],
  ['la ventana incluye las 18:00 en punto', E, '(t) => t > a && t <= b', '(t) => t >= a && t <= b'],
  ['sin la regla de la madrugada', E, "if (!mad.n) m.push('noche_sin_madrugada');", ''],
  ['sin la regla del hueco de la noche', E, "if (h.hueco_min > SELLO.hueco_noche_min) m.push('noche_hueco');", ''],
  ['la mínima de la fila del día y no de la mañana', E, 'noche.est = num(manana.tmin_noche_c);', 'noche.est = num(dia?.tmin_noche_c ?? manana.tmin_noche_c);'],
  ['el muestreo grueso pasa', E, 'const grueso = (m) => m != null && m > SELLO.muestreo_max_min;', 'const grueso = (m) => m != null && m > 200;'],
  ['BCP no se excluye', E, 'const sinExtremos = SELLO.redes_sin_extremos.includes(red);', 'const sinExtremos = false;'],
  ['la HR cuenta las lecturas marcadas', E, 'const enDia = lecDia.filter((r) => valida(r) && r.ok.hum != null', 'const enDia = lecDia.filter((r) => r.ok.hum != null'],
  ['el mínimo de la HR no se mira', E, "else if (!(enDia.length >= minimo(tmax.esperados))) mh.push('hr_pocas_lecturas');", ''],
  // el lado de la app
  ['la noche de la app incluye las 18:00', O, 'const noche = [19, 20, 21, 22, 23]', 'const noche = [18, 19, 20, 21, 22, 23]'],
  ['la noche de la app llega a las 10:00', O, '.concat([...Array(10).keys()]', '.concat([...Array(11).keys()]'],
  ['una hora faltante se tolera', O, 'return xs.every((x) => x != null && Number.isFinite(x)) ? xs : null;', 'return xs.some((x) => x != null && Number.isFinite(x)) ? xs : null;'],
  ['otro modelo (models=gfs_seamless)', O, '+ `&timezone=${encodeURIComponent(OM.timezone)}', '+ `&models=gfs_seamless&timezone=${encodeURIComponent(OM.timezone)}'],
  ['sin la pausa entre pedidos', O, 'if (i > 0) await esperar(pausaMs);', ''],
  ['sin reintento', O, 'for (let intento = 0; intento < 2 && json == null; intento++) {', 'for (let intento = 0; intento < 1 && json == null; intento++) {'],
  ['un 400 se reintenta', O, 'if (!reintentable(r.status)) break;', ''],
  ['el orden de la respuesta no se valida', O, "if (!cerca || o.utc_offset_seconds", "if (o.utc_offset_seconds"],
  ['el huso no se valida', O, 'o.utc_offset_seconds !== OM.offset_s || ', ''],
  ['sin el tope de puntos', O, 'const usados = puntos.slice(0, tope);', 'const usados = puntos.slice(0);'],
  ['los puntos repetidos se piden dos veces', O, 'const k = clavePunto(e.lat, e.lon);', 'const k = clavePunto(e.lat, e.lon) + String(e.estacion_id);'],
  ['100 coordenadas por pedido', S, 'por_pedido: 50,', 'por_pedido: 100,'],
  // las métricas y los cortes
  ['el borde del umbral no cuenta', M, 'Math.abs(x) >= umbral - 1e-9', 'Math.abs(x) > umbral'],
  ['sin el n mínimo del grupo', M, 'if (n < nMin) return { n, pocas: true };', 'if (n < 1) return { n, pocas: true };'],
  ['la región patagonia corrida a −40', R, 'if (lat <= -39 || (lat <= -36 && lon <= -68))', 'if (lat <= -40 || (lat <= -36 && lon <= -68))'],
  ['una zona fuera de la lista se acepta', R, "export const zonaDe = (z) => (ZONAS.includes(z) ? z : 'sin_dato');", "export const zonaDe = (z) => z || 'sin_dato';"],
  // el job
  ['la diferencia al revés (estación − app)', J, 'return { vale, dif: vale ? r2(vApp - vEst) : null };', 'return { vale, dif: vale ? r2(vEst - vApp) : null };'],
  ['se piden también las que no valen', J, 'const candidatas = lados.filter(({ est }) => est.noche.ok || est.tmax.ok || est.hr.ok);', 'const candidatas = lados;'],
  ['el seco escribe', J, 'if (real) ({ ok: escritas, errores } = await base.guardar(filas));', '({ ok: escritas, errores } = await base.guardar(filas));'],
  ['el log lleva un valor', J, "+ ` pedidos=${r.pedidos}", "+ ` sesgo=${r.total?.noche?.sesgo} pedidos=${r.pedidos}"],
  ['el resumen lleva los ids', J, 'escritas, errores: nErrores,', 'escritas, ids: filas.map((f) => f.estacion_id), errores: nErrores,'],
  ['la víspera en UTC', J, "export const vispera = (ahora = Date.now()) => sumarDias(new Date(ahora - 3 * 3600e3)", "export const vispera = (ahora = Date.now()) => sumarDias(new Date(ahora)"],
  // la 0154
  ['el rol lee estaciones', SQL, '-- Ningún grant sobre estaciones ni estaciones_obs.', 'grant select on table public.estaciones to medicion_app;'],
  ['el rol puede borrar', SQL, 'grant select, insert, update on table public.medicion_app_estacion to medicion_app;', 'grant select, insert, update, delete on table public.medicion_app_estacion to medicion_app;'],
  ['el rol anota cualquier proceso', SQL, "for insert to medicion_app with check (proceso = 'medicion_app');", 'for insert to medicion_app with check (true);'],
  ['el CHECK de la noche al revés', SQL, 'and abs(noche_dif_c - (noche_app_c - noche_est_c)) < 0.006', 'and abs(noche_dif_c - (noche_est_c - noche_app_c)) < 0.006'],
  ['la diferencia sin validez se acepta', SQL, "                                     else noche_dif_c is null end),", '                                     else true end),'],
  ['la función sin security definer', SQL, 'language sql stable security definer', 'language sql stable security invoker'],
  ['sin exigir la RLS de registro_procesos', SQL, "  if not (select relrowsecurity from pg_class where oid = 'public.registro_procesos'::regclass) then", '  if false then'],
  ['la función devuelve el nombre en zona', SQL, "case when jsonb_typeof(e.metadatos->'zona') = 'string' then e.metadatos->>'zona' end,", "coalesce(e.metadatos->>'zona', e.nombre),"],
  // la conexión
  ['TLS sin autenticar', B, 'ssl: { rejectUnauthorized: true, ca, servername: host', 'ssl: { rejectUnauthorized: false, ca, servername: host'],
  ['ssl:"require"', B, "ssl: { rejectUnauthorized: true, ca, servername: host, minVersion: 'TLSv1.2' },", "ssl: 'require',"],
  ['sin CA igual conecta', B, 'const opciones = opcionesPg(host, ca ?? leerCa());', 'const opciones = opcionesPg(host, ca);'],
  ['otro rol se acepta', B, "if (!u || (u !== ROL && !u.startsWith(ROL + '.'))) throw", "if (!u) throw"],
];

if (!process.env.HN_PGLITE) { console.log('falta HN_PGLITE (los mutantes de la 0154 necesitan PGlite)'); process.exit(2); }
const COPIAR = [['medicion-app'], ['estaciones-privadas', 'parseo', 'lib'], ['estaciones-privadas', 'parseo', 'test', 'esquema-previo.sql'], ['sipan-alto-valle', 'migracion']];
const tests = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).scripts.test.split(' ').filter((x) => x.startsWith('test/'));

function copia() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medicion260-'));
  for (const p of COPIAR) fs.cpSync(path.join(REPO, ...p), path.join(tmp, ...p), { recursive: true, filter: (s) => !/[\\/](node_modules|\.mutante)([\\/]|$)/.test(s) });
  return tmp;
}
function correrTests(tmp) {
  const r = spawnSync(process.execPath, ['--test', ...tests().map((t) => path.join(tmp, 'medicion-app', t))], { encoding: 'utf8', env: { ...process.env, HN_SELLO_260: '' } });
  return r.status === 0 && !/# skipped [1-9]|ℹ skipped [1-9]/.test(r.stdout);
}

// la copia SIN romper tiene que pasar, sin salteados
{
  const tmp = copia();
  const ok = correrTests(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!ok) { console.log('✗ la copia sin romper no pasa (o saltea): no sirve como control'); process.exit(1); }
  console.log('✓ la copia sin romper pasa, sin salteados');
}
let vivos = 0;
for (const [nombre, archivo, de, a] of MUTANTES) {
  const tmp = copia();
  const f = path.join(tmp, 'medicion-app', archivo);
  const txt = fs.readFileSync(f, 'utf8');
  if (!txt.includes(de)) { console.log(`✗ ${nombre}: no encontré el texto a mutar`); vivos++; }
  else {
    fs.writeFileSync(f, txt.replace(de, a));
    const pasa = correrTests(tmp);
    console.log(`${pasa ? '✗' : '✓'} ${nombre}: ${pasa ? 'LOS TESTS PASAN (mal)' : 'los tests fallan (bien)'}`);
    if (pasa) vivos++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(vivos ? `${vivos} mutantes vivos de ${MUTANTES.length}` : `los ${MUTANTES.length} mutantes caen`);
process.exit(vivos ? 1 : 0);
