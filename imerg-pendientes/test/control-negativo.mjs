// Control negativo CONTADO (como sipan y rayos-hora): se rompe a propósito una cosa por vez, en una copia, y se corre
// la suite. Cada mutante tiene que hacer fallar al menos un test. Antes se corre la copia SIN romper (tiene que pasar).
// Los mutantes de la migración necesitan IMERG_PG_BIN (PostgreSQL portable); sin él se saltean y se avisa.
// Correr: node imerg-pendientes/test/control-negativo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));      // imerg-pendientes/
const REPO = path.dirname(RAIZ);
const COPIA = path.join(REPO, '.mutante', 'imerg-pendientes');
const PG = !!(process.env.IMERG_PG_BIN || process.env.SIPAN_PG_BIN);
const SQL = 'migracion/imerg_colector.sql';

const MUTANTES = [
  // ── «el código de antes»: todas las celdas en un job, sin presupuesto ni toma por celda ──
  ['ANTES: el job lleva hasta 20 celdas (TOPE_CELDAS del _v1681)', 'lib/barrido.mjs', 'export const TOPE_MAX = 2;', 'export const TOPE_MAX = 20;'],
  ['ANTES: sin presupuesto (sigue hasta que GitHub corta)', 'lib/barrido.mjs', "if (reloj() - t0 > presupuestoMs) { r.motivo = 'presupuesto'; break; }", ''],
  ['ANTES: el workflow con timeout 120 y 20 celdas', 'imerg-pendientes.workflow.yml.txt', "TOPE: ${{ github.event_name == 'schedule' && '2' || inputs.tope }}", "TOPE: ${{ github.event_name == 'schedule' && '20' || inputs.tope }}"],
  ['ANTES: timeout que no alcanza para 2 celdas', 'imerg-pendientes.workflow.yml.txt', 'timeout-minutes: 100', 'timeout-minutes: 60'],
  // ── la NASA de a poco ──
  ['sin pausa entre celdas', 'lib/barrido.mjs', 'export const PAUSA_MS = 60 * 1000;', 'export const PAUSA_MS = 0;'],
  ['sigue pidiendo después de un error de la NASA', 'lib/barrido.mjs', "      r.motivo = 'fallo_nasa';\n      break;", "      r.motivo = 'fallo_nasa';\n      continue;"],
  ['no suelta la celda ante un error de la NASA', 'lib/barrido.mjs', "log(`celda ${i + 1}/${n}: la NASA no la dio (${r.error}); ${await retener(c)}; la corrida termina`);", "log(`celda ${i + 1}/${n}: la NASA no la dio (${r.error}); la corrida termina`);"],
  // ── 2.ª vuelta · JS ──
  ['P1.2: el registro dice «soltada» aunque soltar falle', 'lib/barrido.mjs', 'r.soltada = await Promise.resolve().then(() => base.soltar(c)).then((ok) => ok === true, () => false);', 'await Promise.resolve().then(() => base.soltar(c)).catch(() => {}); r.soltada = true;'],
  ['P1.3: sigue pidiendo después de una serie parcial', 'lib/barrido.mjs', "      r.motivo = 'parcial';\n      break;", "      r.motivo = 'parcial';\n      continue;"],
  ['P1.3: una serie parcial cuenta como guardada', 'lib/barrido.mjs', 'if (!(guardadas > 0)) {', 'if (guardadas < 0) {'],
  ['P1.3: la CLI deja pasar la espera 0', 'imerg-pendientes.mjs', 'Math.min(Math.max(n, ESPERA_MIN), 7 * 24 * 60)', 'Math.min(Math.max(n, 0), 7 * 24 * 60)'],
  ['el pedido sin corte', 'lib/giovanni.mjs', '      signal: AbortSignal.timeout(ms),\n', ''],
  ['el relleno −9999,9 se guarda', 'lib/giovanni.mjs', "if (!Number.isFinite(mm) || mm < 0) continue;", 'if (!Number.isFinite(mm)) continue;'],
  ['el CSV vacío cuenta como bien', 'lib/giovanni.mjs', "if (!filas.length) throw new ErrorNasa('sin_filas');", ''],
  // ── el registro público y la base ──
  ['el registro muestra la celda', 'lib/barrido.mjs', 'log(`celda ${i + 1}/${n}: ${guardadas} filas guardadas`);', 'log(`celda ${c.lat},${c.lon}: ${guardadas} filas guardadas`);'],
  ['acepta otro usuario en la URL', 'lib/base.mjs', "if (!usuario || !(usuario === ROL || usuario.startsWith(ROL + '.'))) throw", 'if (!usuario) throw'],
  ['no verifica current_user', 'lib/base.mjs', "if (u !== ROL) throw Object.assign(new Error('rol'), { code: 'ROL_DISTINTO' });", ''],
  ['seco también toma', 'imerg-pendientes.mjs', "if (!real) { log('modo seco: no se toma nada'); return 0; }", ''],
  // ── la migración (necesitan PostgreSQL) ──
  ['SQL: dos tomas vivas a la vez', SQL, "  if exists (select 1 from imerg_colector.tomas t\n              where t.cerrada is null and t.tomada > now() - interval '90 minutes') then\n    return;                                                     -- una toma viva: no se da otra\n  end if;\n", '', true],
  ['SQL: sin el candado global del barrido', SQL, "  perform pg_advisory_xact_lock(hashtext('imerg:barrido'));\n", '', true],
  ['SQL: la toma cortada no vence nunca (no retoma)', SQL, "v_hasta := now() + least(interval '8 hours' * (2 ^ least(previas, 5)), interval '7 days');", "v_hasta := 'infinity'::timestamptz;", true],
  ['SQL: el fallo se reintenta enseguida', SQL, "no_antes_de = greatest(t.no_antes_de, now() + interval '6 hours')", 'no_antes_de = now()', true],
  ['SQL: le pisa a hn-agro la reserva fresca', SQL, 'make_interval(mins => greatest(coalesce(p_espera_lazy_min, 180), 180))', "interval '0 minutes'", true],
  // ── 2.ª vuelta · la base (n3-232-1411) ──
  ['P1.1/P1.3: la espera sobre la app vuelve a depender del parámetro (tomar(0))', SQL, 'greatest(coalesce(p_espera_lazy_min, 180), 180)', 'greatest(coalesce(p_espera_lazy_min, 180), 0)', true],
  ['P1.2: la toma vencida se retoma a los 90 min (antes de las 6 h del error)', SQL, "v_hasta := now() + least(interval '8 hours' * (2 ^ least(previas, 5)), interval '7 days');", "v_hasta := now() + interval '90 minutes';", true],
  ['P1.2: las candidatas no miran el «no antes de» (manda la fila de la app)', SQL, "   where not exists (select 1 from imerg_colector.tomas t\n                      where t.celda_lat = a.clat and t.celda_lon = a.clon and t.no_antes_de > now())\n     and (", '   where (', true],
  ['P1.2: soltar acorta la espera (6 h desde el fallo, aunque la toma pedía más)', SQL, "no_antes_de = greatest(t.no_antes_de, now() + interval '6 hours')", "no_antes_de = now() + interval '6 hours'", true],
  ['P1.2: guardar con una toma vencida (sólo mira la fila)', SQL, '  if v_toma is null or not found then', '  if not found then', true],
  ['P1.3: sin tope de 2 tomas por hora', SQL, "  if (select count(*) from imerg_colector.tomas t where t.tomada > now() - interval '1 hour') >= 2 then\n    return;                                                     -- tope fijo: 2 tomas por hora\n  end if;\n", '', true],
  ['P1.3: guardar da por completa cualquier serie (una fecha con 0 mm)', SQL, "  if not (v_desde = date '2000-06-01' and v_hasta >= date '2025-09-30' and n >= (v_hasta - v_desde + 1) - 30) then", '  if false then', true],
  ['P1.3: sin tolerancia declarada (acepta cualquier hueco)', SQL, ' and n >= (v_hasta - v_desde + 1) - 30) then', ') then', true],
  ['P1.3: sin la última fecha esperada (acepta una serie que termina antes)', SQL, " and v_hasta >= date '2025-09-30'", '', true],
  ['P1.3: sin empezar en 2000-06-01', SQL, "v_desde = date '2000-06-01' and ", '', true],
  ['P1.3: sin espera creciente (la celda que nunca sale se pide cada 8 h para siempre)', SQL, '(2 ^ least(previas, 5))', '1', true],
  ['search_path: pg_temp y public adelante', SQL, 'set search_path = pg_catalog, pg_temp', 'set search_path = pg_temp, public', true],
  ['privilegios por defecto: la tabla tomas queda para anon', SQL, "      execute format('revoke all on all tables in schema imerg_colector from %I', r);\n", '', true],
  ['privilegios por defecto: las funciones quedan para anon', SQL, "      execute format('revoke all on all functions in schema imerg_colector from %I', r);\n", '', true],
  ['SQL: también los lotes de baja', SQL, '     where l.activo = true and l.lat is not null and l.lon is not null)\n  select a.clat', '     where l.lat is not null and l.lon is not null)\n  select a.clat', true],
  ['SQL: la celda del doctor (numeric) en vez de la de la app', SQL, "  select (floor((floor((p_lat + 89.95::float8) / 0.1::float8) * 0.1::float8 - 89.95::float8) * 100::float8 + 0.5::float8) / 100::float8)::numeric(5,2),\n         (floor((floor((p_lon + 179.95::float8) / 0.1::float8) * 0.1::float8 - 179.95::float8) * 100::float8 + 0.5::float8) / 100::float8)::numeric(6,2)",
    "  select round((floor((p_lat::numeric + 89.95) / 0.1) * 0.1 - 89.95)::numeric, 2)::numeric(5,2),\n         round((floor((p_lon::numeric + 179.95) / 0.1) * 0.1 - 179.95)::numeric, 2)::numeric(6,2)", true],
  ['SQL: guardar sin exigir la toma', SQL, "  if v_toma is null or not found then\n    raise exception 'imerg_colector: la celda no está tomada por el colector';\n  end if;\n", '', true],
  ['SQL: guardar acepta fechas repetidas', SQL, "  if (select count(distinct f) from unnest(p_fechas) f) <> n then\n    raise exception 'imerg_colector: fechas repetidas';\n  end if;\n", '', true],
  ['SQL: guardar acepta valores imposibles', SQL, 'or mm < 0 or mm > 2000', 'or false', true],
  ['SQL: las funciones quedan para PUBLIC (anon por RPC)', SQL, 'revoke all on function imerg_colector.tomar(integer) from public;\n', '', true],
  ['SQL: el rol con BYPASSRLS no aborta', SQL, 'if r.rolsuper or r.rolreplication or r.rolbypassrls or', 'if r.rolsuper or r.rolreplication or', true],
];

function copiar() {
  fs.rmSync(path.join(REPO, '.mutante'), { recursive: true, force: true });
  fs.cpSync(RAIZ, COPIA, { recursive: true, filter: (s) => !s.includes(`${path.sep}.mutante`) });
  fs.mkdirSync(path.join(REPO, '.mutante', 'sipan-alto-valle', 'migracion'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'sipan-alto-valle', 'migracion', 'scram.mjs'), path.join(REPO, '.mutante', 'sipan-alto-valle', 'migracion', 'scram.mjs'));
}
function correr() {
  const r = spawnSync(process.execPath, ['--test', 'test/imerg-pendientes.test.mjs', 'test/pg-real.test.mjs'], { cwd: COPIA, encoding: 'utf8', env: process.env });
  const m = /ℹ fail (\d+)/.exec(r.stdout || '');
  return { fallan: m ? Number(m[1]) : -1, codigo: r.status };
}

copiar();
const base = correr();
if (base.fallan !== 0) { console.error('la copia SIN romper no pasa entera (' + base.fallan + ' fallan): no se sigue'); process.exit(1); }
let vivos = 0, salteados = 0, n = 0;
for (const [nombre, archivo, de, a, esSql] of MUTANTES) {
  if (esSql && !PG) { salteados++; console.log('  (salteado, sin PostgreSQL) ' + nombre); continue; }
  copiar();
  const f = path.join(COPIA, archivo);
  const txt = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (!txt.includes(de)) { console.error('✖ el mutante no encuentra su texto: ' + nombre); process.exit(1); }
  fs.writeFileSync(f, txt.replace(de, () => a));
  n++;
  const { fallan } = correr();
  if (fallan > 0) console.log(`  ✔ rojo (${fallan}) · ${nombre}`);
  else { vivos++; console.log(`  ✖ SIGUE VERDE · ${nombre}`); }
}
fs.rmSync(path.join(REPO, '.mutante'), { recursive: true, force: true });
console.log(`\nmutantes: ${n} corridos · ${n - vivos} en rojo · ${vivos} vivos · ${salteados} salteados (sin PostgreSQL)`);
process.exit(vivos ? 1 : 0);
