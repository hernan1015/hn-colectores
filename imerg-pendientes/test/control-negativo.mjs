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
const PR = 'lib/prender.mjs';

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
  ['SQL: dos tomas vivas a la vez', SQL, "  if exists (select 1 from imerg_colector.tomas t\n              where t.cerrada is null and t.tomada > v_ahora - interval '90 minutes') then\n    return;                                                     -- una toma viva: no se da otra\n  end if;\n", '', true],
  ['SQL: sin el candado global del barrido', SQL, "  perform pg_advisory_xact_lock(hashtext('imerg:barrido'));\n", '', true],
  ['SQL: la toma cortada no vence nunca (no retoma)', SQL, "v_hasta := v_ahora + least(interval '8 hours' * (2 ^ least(previas, 5)), interval '7 days');", "v_hasta := 'infinity'::timestamptz;", true],
  ['SQL: el fallo se reintenta enseguida', SQL, "no_antes_de = greatest(t.no_antes_de, v_ahora + interval '6 hours')", 'no_antes_de = v_ahora', true],
  ['SQL: le pisa a hn-agro la reserva fresca', SQL, 'make_interval(mins => greatest(coalesce(p_espera_lazy_min, 180), 180))', "interval '0 minutes'", true],
  // ── 2.ª vuelta · la base (n3-232-1411) ──
  ['P1.1/P1.3: la espera sobre la app vuelve a depender del parámetro (tomar(0))', SQL, 'greatest(coalesce(p_espera_lazy_min, 180), 180)', 'greatest(coalesce(p_espera_lazy_min, 180), 0)', true],
  ['P1.2: la toma vencida se retoma a los 90 min (antes de las 6 h del error)', SQL, "v_hasta := v_ahora + least(interval '8 hours' * (2 ^ least(previas, 5)), interval '7 days');", "v_hasta := v_ahora + interval '90 minutes';", true],
  ['P1.2: las candidatas no miran el «no antes de» (manda la fila de la app)', SQL, "   where not exists (select 1 from imerg_colector.tomas t\n                      where t.celda_lat = a.clat and t.celda_lon = a.clon and t.no_antes_de > clock_timestamp())\n     and (", '   where (', true],
  ['P1.2: soltar acorta la espera (6 h desde el fallo, aunque la toma pedía más)', SQL, "no_antes_de = greatest(t.no_antes_de, v_ahora + interval '6 hours')", "no_antes_de = v_ahora + interval '6 hours'", true],
  ['P1.2: guardar con una toma vencida (sólo mira la fila)', SQL, '  if v_toma is null or not found then', '  if not found then', true],
  ['P1.3: sin tope de 2 tomas por hora', SQL, "  if (select count(*) from imerg_colector.tomas t where t.tomada > v_ahora - interval '1 hour') >= 2 then\n    return;                                                     -- tope fijo: 2 tomas por hora\n  end if;\n", '', true],
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
  // ── 3.ª vuelta (n3-232-v2-1411) · P1: los límites no dependen de la transacción de quien llama ──
  ['3.ª P1: tomar acepta REPEATABLE READ / SERIALIZABLE (la foto vieja)', SQL, "begin\n  if current_setting('transaction_isolation') <> 'read committed' then\n    raise exception 'imerg_colector: sólo en READ COMMITTED (esta transacción es %)', current_setting('transaction_isolation');\n  end if;\n  perform pg_advisory_xact_lock(hashtext('imerg:barrido'));", "begin\n  perform pg_advisory_xact_lock(hashtext('imerg:barrido'));", true],
  ['3.ª P1: guardar acepta REPEATABLE READ / SERIALIZABLE', SQL, "  if current_setting('transaction_isolation') <> 'read committed' then\n    raise exception 'imerg_colector: sólo en READ COMMITTED (esta transacción es %)', current_setting('transaction_isolation');\n  end if;\n  n := coalesce", '  n := coalesce', true],
  ['3.ª P1: soltar acepta REPEATABLE READ / SERIALIZABLE', SQL, "  if current_setting('transaction_isolation') <> 'read committed' then\n    raise exception 'imerg_colector: sólo en READ COMMITTED (esta transacción es %)', current_setting('transaction_isolation');\n  end if;\n  v_lat := p_lat;", '  v_lat := p_lat;', true],
  ['3.ª P1: el control de aislamiento sólo mira SERIALIZABLE (deja pasar REPEATABLE READ)', SQL, "begin\n  if current_setting('transaction_isolation') <> 'read committed' then", "begin\n  if current_setting('transaction_isolation') = 'serializable' then", true],
  ['3.ª P1: tomar con la hora del comienzo de la transacción (now())', SQL, 'v_ahora := clock_timestamp();                                 -- después del candado', 'v_ahora := now();                                 -- después del candado', true],
  ['3.ª P1: el tope por hora con now()', SQL, "where t.tomada > v_ahora - interval '1 hour') >= 2 then", "where t.tomada > now() - interval '1 hour') >= 2 then", true],
  ['3.ª P1: _candidatas con now()', SQL, 't.no_antes_de > clock_timestamp())', 't.no_antes_de > now())', true],
  // ── 3.ª vuelta · P1: prender sólo con la lectura comprobada ──
  ['3.ª P1 ANTES: el comando de la 2.ª vuelta (grep -c sobre una lectura que puede fallar)', 'prender.sh', "RESP=$(gh api", 'N=$(gh api "repos/$APP/contents/$RUTA" --jq .content | base64 -d | grep -cE "^[[:space:]]*repository_dispatch:")\n[ "$N" = 0 ] && gh variable set IMERG_PENDIENTES_ON -b si -R "$ESTE" && echo PRENDIDO && exit 0\nRESP=$(gh api'],
  ['3.ª P1: sin ref=main (lee la rama por defecto, la que sea)', 'prender.sh', '$RUTA?ref=main', '$RUTA'],
  // (4.ª vuelta: los tres que siguen, adaptados a lib/prender.mjs con la misma intención)
  ['3.ª P1: repository_dispatch sólo como clave de mapa (la lista pasa)', PR, '    return on;\n  }', "    return on.filter((e) => e !== 'repository_dispatch');\n  }"],
  ['3.ª P1: los comentarios cuentan (no prende nunca con el comentario de cabecera)', PR, '  const ev = eventos(contenido(respuesta))', "  if (contenido(respuesta).includes('repository_dispatch')) no('hn-agro sigue con repository_dispatch');\n  const ev = eventos(contenido(respuesta))"],
  ['3.ª P1: cualquier archivo sirve (sin exigir workflow_dispatch)', PR, "  if (!ev.includes('workflow_dispatch')) no('no parece el imerg-backfill.yml (no tiene workflow_dispatch)');\n", ''],
  ['3.ª P1: dice PRENDIDO aunque gh variable set falle', 'prender.sh', ' || no "gh variable set falló"', ''],
  // ── 4.ª vuelta (n3-232-v3-1511) · P1: el YAML parseado de verdad y el archivo leído entero ──
  ['4.ª P1 ANTES: la 3.ª (sed de comentarios y buscar texto): el "#" en una cadena esconde el flujo', PR, '  const ev = eventos(contenido(respuesta)).map((e) => e.trim().toLowerCase());', "  const t = contenido(respuesta).replace(/#.*$/gm, '');\n  const ev = ['repository_dispatch', 'workflow_dispatch'].filter((e) => t.includes(e));"],
  ['4.ª P1: sin comparar el sha (un archivo alterado del mismo tamaño pasa)', PR, "  if (shaBlob(buf) !== j.sha) no('el contenido no coincide con el sha del archivo (incompleto o alterado)');\n", ''],
  ['4.ª P1: sin comparar el tamaño', PR, '  if (buf.length !== j.size) no(`el contenido está incompleto (${buf.length} de ${j.size} bytes)`);\n', ''],
  ['4.ª P1: sin mirar el path (otro archivo pasa)', PR, '  if (j.path !== RUTA) no(`la respuesta es de otro archivo (path=${JSON.stringify(j.path)})`);\n', ''],
  ['4.ª P1: sin mirar type=file', PR, "  if (j.type !== 'file') no(`la respuesta no es un archivo (type=${JSON.stringify(j.type)})`);\n", ''],
  ['4.ª P1: sin mirar encoding=base64', PR, "  if (j.encoding !== 'base64') no(`la respuesta no viene en base64 (encoding=${JSON.stringify(j.encoding)})`);\n", ''],
  ['4.ª P1: base64 laxo (sin alfabeto ni forma canónica)', PR, "  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4) no('el contenido no es base64');\n  const buf = Buffer.from(b64, 'base64');\n  if (buf.toString('base64') !== b64) no('el contenido no es base64 canónico');", "  const buf = Buffer.from(b64, 'base64');"],
  ['4.ª P1: los errores del parser no frenan', PR, "  if (doc.errors.length) no(`el YAML no parsea: ${doc.errors[0].message.split('\\n')[0]}`);\n", ''],
  ['4.ª P1: las advertencias del parser no frenan', PR, "  if (doc.warnings.length) no(`el YAML tiene advertencias: ${doc.warnings[0].message.split('\\n')[0]}`);\n", ''],
  ['4.ª P1: varios documentos YAML (se mira sólo el primero)', PR, 'docs.length !== 1) no(', 'docs.length < 1) no('],
  ['4.ª P1: sin resolver el merge << (el repository_dispatch que entra por merge pasa)', PR, 'merge: true,', 'merge: false,'],
  ['4.ª P1: sin exigir name = imerg-backfill', PR, "  if (js.name !== 'imerg-backfill') no(`no es el imerg-backfill.yml (name=${JSON.stringify(js.name)})`);\n", ''],
  ['4.ª P1: sin exigir jobs (el archivo truncado de Codex pasa)', PR, "  if (!esObjeto(js.jobs) || !Object.keys(js.jobs).length) no('no es el imerg-backfill.yml (sin jobs)');\n", ''],
  ['4.ª P1: prender.sh no mira el resultado del chequeo', 'prender.sh', ' 2>&1) || no "${R:-el chequeo (node lib/prender.mjs) falló; ¿npm ci --prefix imerg-pendientes?}"\n[ "$R" = \'SIN_REPOSITORY_DISPATCH\' ] || no "el chequeo no confirmó el workflow sin repository_dispatch ($R)"', ' 2>&1)'],
  ['SQL: el rol con BYPASSRLS no aborta', SQL, 'if r.rolsuper or r.rolreplication or r.rolbypassrls or', 'if r.rolsuper or r.rolreplication or', true],
];

function copiar() {
  fs.rmSync(path.join(REPO, '.mutante'), { recursive: true, force: true });
  fs.cpSync(RAIZ, COPIA, { recursive: true, filter: (s) => !s.includes(`${path.sep}.mutante`) });
  fs.mkdirSync(path.join(REPO, '.mutante', 'sipan-alto-valle', 'migracion'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'sipan-alto-valle', 'migracion', 'scram.mjs'), path.join(REPO, '.mutante', 'sipan-alto-valle', 'migracion', 'scram.mjs'));
}
function correr() {
  const r = spawnSync(process.execPath, ['--test', 'test/imerg-pendientes.test.mjs', 'test/pg-real.test.mjs', 'test/prender.test.mjs'], { cwd: COPIA, encoding: 'utf8', env: process.env });
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
