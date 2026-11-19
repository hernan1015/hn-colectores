// HN AGRO · estaciones-parseo · MUTANTES: rompe a propósito una regla por vez (en una COPIA en una carpeta temporal) y
// verifica que algún test se dé cuenta. No es un test de `npm test`: se corre a mano, con PGlite:
//   HN_PGLITE=<…>/@electric-sql/pglite node estaciones-parseo/test/mutantes.mjs [carpeta-temporal]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RAIZ } from './ayuda.mjs';

const REPO = path.join(RAIZ, '..');
const MUTANTES = [
  ['lib/calidad.mjs', 'HORAS_INSTANTANEA = 12', 'HORAS_INSTANTANEA = 13', 'la regla de las 12 h'],
  ['lib/calidad.mjs', 'DIAS_REGISTRO = 8', 'DIAS_REGISTRO = 30', 'el tope de 8 días de los registros'],
  ['lib/calidad.mjs', 'FUTURO_MS = 15 * 60e3', 'FUTURO_MS = 120 * 60e3', 'el tope del futuro'],
  ['lib/calidad.mjs', 'temp_c: (x) => x > -40 && x < 50', 'temp_c: (x) => x > -40 && x <= 50', '50 °C es imposible'],
  ['lib/calidad.mjs', 'hum_pct: (x) => x > 0 && x <= 100', 'hum_pct: (x) => x >= 0 && x <= 255', 'HR 0 y 255 son imposibles'],
  ['lib/calidad.mjs', "if (!conDatos(l)) { sumar(descartadas, 'sin_variables'); continue; }", '', 'sin variables no entra'],
  ['lib/calidad.mjs', 'out.crudo[k] = typeof v', 'out.crudo.x = typeof v', 'el imposible queda en crudo'],
  ['lib/calidad.mjs', 'const base = { i: l.instante, m: l.marcas, c: l.crudo, p: l.lluvia_periodo_min ?? null };', 'const base = { i: l.instante, n: Math.random() };', 'la firma es estable'],
  ['lib/comun.mjs', "if (!Number.isFinite(n) || n <= -999 || centinelas.includes(n)) return null;", 'if (!Number.isFinite(n)) return 0;', 'NULL nunca es 0'],
  ['lib/comun.mjs', "if (!/^[-+]?\\d+(\\.\\d+)?$/.test(t)) return null;", "if (!/^[-+]?\\d+(\\.\\d+)?$/.test(t)) return 0;", 'un vacío no es 0'],
  ['lib/guardar.mjs', 'where s.parseo_firma is distinct from excluded.parseo_firma', '', 'la estación sólo se reescribe si cambió'],
  ['lib/guardar.mjs', 'where l.firma is distinct from excluded.firma and', 'where', 'la lectura sólo se reescribe si cambió'],
  ['lib/guardar.mjs', "const dup = await db.q('select public.estaciones_marcar_duplicados(2) as n', [], 'duplicadas');", "const dup = [{ n: 0 }];", 'las duplicadas se marcan'],
  ['parsear.mjs', "if (!/^[a-z][a-z0-9_:.]{0,39}$/.test(o))", 'if (false)', 'el log sólo lleva categorías'],
  ['parsear.mjs', 'if (h < 3) t += 864e5;', '', 'la clave de 00 a 02 UTC'],
  ['lib/almacen.mjs', 'Object.freeze({ tipo: a.tipo, leer: (k) => a.leer(k), listar: (p) => a.listar(p) })', 'a', 'el almacén es de sólo lectura'],
  ['fuentes/weatherlink.mjs', ': fAc(x); };', ': x; };', 'WeatherLink °F → °C'],
  ['fuentes/bcp.mjs', '? kmhAms(v) :', '? v :', 'BCP km/h → m/s'],
  ['fuentes/entrerios.mjs', "'temp. ext.': 'temp'", "'temp. m?x.': 'temp'", 'Entre Ríos: la columna por la cabecera'],
  ['fuentes/ina.mjs', 'fin - ini !== 864e5', 'false', 'INA: la lluvia diaria es de 24 h'],
  ['fuentes/sanluis.mjs', "if (subred === 'PRONO') { sumar(descartadas, 'pronostico'); continue; }", '', 'San Luis: los PRONO afuera'],
  ['fuentes/weathercloud.mjs', 'if (!formato.verificado || p.id == null)', 'if (p.id == null && false)', 'Weathercloud sin verificar no guarda'],
  ['esquema/0161_estaciones_parseo_unificada_COPIA.sql', "      new.mostrar := false;\n      new.duplicado_de_red := null;", "      new.duplicado_de_red := null;", 'el colector no puede mostrar (insert)'],
  ['esquema/0161_estaciones_parseo_unificada_COPIA.sql', '      new.mostrar := old.mostrar;', '      null;', 'el colector no puede mostrar (update)'],
  ['esquema/0161_estaciones_parseo_unificada_COPIA.sql', "check (not mostrar or red not in ('WEATHERLINK_PUB', 'WEATHERCLOUD_PUB', 'INTA_SIPAN_AV')),\n  constraint estaciones_redes_red_forma", "check (true),\n  constraint estaciones_redes_red_forma", 'WeatherLink no se puede mostrar'],
  ['esquema/0161_estaciones_parseo_unificada_COPIA.sql', "constraint el_temp      check (temp_c is null or (temp_c > -40 and temp_c < 50)),", '', 'la base frena los 50 °C'],
  ['esquema/0161_estaciones_parseo_unificada_COPIA.sql', '       and d.lat between e.lat - radio / 111.0 and e.lat + radio / 111.0\n       and public.estaciones_distancia_km(e.lat, e.lon, d.lat, d.lon) < radio;', '       and true;', 'duplicadas: sólo a < 2 km'],
  ['esquema/0161_estaciones_parseo_unificada_COPIA.sql', '  where c.d <= p_radio_km', '  where true', 'la vista: sólo a ≤ 25 km'],
];

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'mutantes-parseo-'));
let muertos = 0; const vivos = [];
for (const [i, [arch, de, a, que]] of MUTANTES.entries()) {
  const dest = path.join(tmp, 'm' + i);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, 'estaciones-parseo'), path.join(dest, 'estaciones-parseo'), { recursive: true });
  fs.cpSync(path.join(REPO, 'sipan-alto-valle', 'lib'), path.join(dest, 'sipan-alto-valle', 'lib'), { recursive: true });
  fs.cpSync(path.join(REPO, 'sipan-alto-valle', 'migracion'), path.join(dest, 'sipan-alto-valle', 'migracion'), { recursive: true });
  const p = path.join(dest, 'estaciones-parseo', arch);
  const t = fs.readFileSync(p, 'utf8');
  if (!t.includes(de)) { console.log(`?? ${i} no encontré el texto: ${que}`); vivos.push(que + ' (no aplicado)'); continue; }
  fs.writeFileSync(p, t.replace(de, a));
  const r = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: path.join(dest, 'estaciones-parseo'), env: process.env, encoding: 'utf8' });
  if (r.status !== 0) { muertos++; console.log(`muerto  ${i} ${que}`); } else { vivos.push(que); console.log(`VIVO    ${i} ${que}`); }
  fs.rmSync(dest, { recursive: true, force: true });
}
console.log(`\n${muertos}/${MUTANTES.length} muertos${vivos.length ? ' · vivos: ' + vivos.join(' | ') : ''}`);
