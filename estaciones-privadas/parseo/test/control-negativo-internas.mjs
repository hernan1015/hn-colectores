// Control negativo CONTADO del parseo: se rompe una cosa por vez en una copia y se corre la suite; cada mutante tiene
// que hacer fallar al menos un test. Antes se corre la copia SIN romper (tiene que pasar entera).
// Correr: node estaciones-privadas/parseo/test/control-negativo.mjs   (con HN_PGLITE, también los del guardado y la 0152)
// La copia va a <repo>/.mutante/ (en .gitignore), con sipan-alto-valle/ al lado. Hace falta HN_FIXTURES_139 (cortex).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PARSEO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(PARSEO, '..', '..');
const conPg = !!process.env.HN_PGLITE;

const MUTANTES = [
  ['la clave de las 00-02 UTC cae en el mismo día', 'parsear.mjs', 'return Number(m[2]) < 3 ? ms + 864e5 : ms;', 'return ms;'],
  ['sin la regla de las 12 h', 'parsear.mjs', "if (Number.isFinite(tope) && (tope - t > (cfg.maxEdadH ?? 12) * 3600e3 || t - tope > 15 * 60e3)) { r.descartadas++; continue; }", ''],
  ['lee cualquier hora de R2', 'parsear.mjs', 'if (t != null && t >= desde && t <= ahora + 600e3) out.push(k);', 'if (t != null) out.push(k);'],
  ['el log imprime nombres', 'parsear.mjs', "log(JSON.stringify({ parseo: total, seco, horas }));", "log(JSON.stringify({ parseo: total, seco, horas, muestra: FUENTES.length }) + ' Grumbein');"],
  ['reescribe el catálogo cada vez', 'parsear.mjs', 'if (!mismo(guardadas.get(id), e) || guardadas.get(id)?.metadatos?.mostrar !== false) cat.push(e);', 'cat.push(e);', { pg: true }],
  ['se reescribe sin cambios', 'lib/diario.mjs', 'if (f && firmas.get(fecha) !== f.crudo.firma) filas.push(f);', 'if (f) filas.push(f);', { pg: true }],
  ['HR 0 es válida', 'lib/diario.mjs', 'hum: [1, 100],', 'hum: [0, 255],'],
  ['50 °C es válido', 'lib/diario.mjs', 'temp: [-39.9, 49.9], tmin: [-39.9, 49.9], tmax: [-39.9, 49.9],', 'temp: [-39.9, 60], tmin: [-39.9, 60], tmax: [-39.9, 60],'],
  ['mostrar no se fuerza en el SQL', 'lib/base.mjs', "metadatos = (estaciones.metadatos || excluded.metadatos || '{\"mostrar\": false, \"uso\": \"interno\"}'::jsonb)", 'metadatos = (excluded.metadatos || estaciones.metadatos)', { pg: true }],
  ['BCP por posición fija', 'fuentes/bcp.mjs', "if (faltan.length) throw new Error('bcp: la página cambió, no declara ' + faltan.join(','));", ''],
  ['BCP: la humedad se usa', 'fuentes/bcp.mjs', 'temp: valor(D(i, \'iSensorTemp\')), tmin:', "hum: valor(D(i, 'iSensorHum_Rel')), temp: valor(D(i, 'iSensorTemp')), tmin:"],
  ['BCP: entran las viejas', 'fuentes/bcp.mjs', 'if (rot[i] == null || Number(habil[i]) !== 1) continue;', 'if (rot[i] == null) continue;'],
  ['ER: sin el alias del carácter de reemplazo', 'fuentes/er.mjs', "'temp. m?x.': 'tmax', 'temp. m?n.': 'tmin', ", ''],
  ['ER: el 404 se lee', 'lib/crudo.mjs', 'if (!p || p.status !== 200 || typeof p.cuerpo !== \'string\') return null;', "if (!p || typeof p.cuerpo !== 'string') return null;"],
  ['INA: la lluvia va a la fila de la temperatura', 'fuentes/ina.mjs', "if (s.campo === 'lluvia_diaria') {", 'if (false) {'],
  ['INA: estacion_id = la serie', 'fuentes/ina.mjs', "const k = s.estacion.estacion_id + '|' + local;", "const k = String(o.series_id) + '|' + local;"],
  ['INA: la lluvia de otra hora entra', 'fuentes/ina.mjs', "if (local.slice(11) !== '09:00' || v < 0 || v >= 450) { problemas++; continue; }", 'if (v < 0 || v >= 450) { problemas++; continue; }'],
  ['INA: corte a las 00', 'fuentes/ina.mjs', "hora_corte: '09:00', lluvia_mm", "hora_corte: '00:00', lluvia_mm"],
  ['San Luis: entran los PRONO', 'fuentes/rem.mjs', "if (red === 'PRONO') { pronostico++; continue; }", ''],
  ['Mendoza: la precipitación va a la lluvia', 'fuentes/dacc.mjs', "lluvia: null, eto: false, fuente: 'DACC", "lluvia: 'acumulado_consola', eto: false, fuente: 'DACC"],
  ['SIGA: entran las convencionales', 'fuentes/siga.mjs', 'if (e.idTipo != null && e.idTipo !== 2) continue;', ''],
  ['SIGA: acepta cualquier forma', 'fuentes/siga.mjs', "if (!Array.isArray(a)) throw new Error('siga: la respuesta no es un arreglo');", 'if (!Array.isArray(a)) return { estaciones: [], lecturas: [], problemas: 1 };'],
  ['0152 sin las internas', 'migracion/0152_parseo_estaciones_unificada_PROPUESTA.sql', ", 'SIGA_RT', 'EEAOC', 'DACC_MZA', 'REM_SL', 'ER_HIDRAULICA', 'INA_METEO', 'INA_ALERTA', 'BCP_RT', 'WEATHERCLOUD_PUB')$r$", ")$r$", { pg: true }],
];

const COPIA = path.join(REPO, '.mutante');
function copiar() {
  fs.rmSync(COPIA, { recursive: true, force: true });
  fs.cpSync(PARSEO, path.join(COPIA, 'estaciones-privadas', 'parseo'), { recursive: true, filter: (s) => !s.includes('node_modules') });
  fs.cpSync(path.join(REPO, 'sipan-alto-valle'), path.join(COPIA, 'sipan-alto-valle'), { recursive: true, filter: (s) => !s.includes('node_modules') });
}
const suite = () => spawnSync(process.execPath, ['--test', path.join(COPIA, 'estaciones-privadas', 'parseo', 'test', 'internas.test.mjs')], { encoding: 'utf8', env: process.env, timeout: 300000 }).status === 0;

copiar();
if (!suite()) { console.error('la copia SIN romper no pasa: no se puede contar'); process.exit(1); }
let vivos = 0, muertos = 0, salteados = 0;
for (const [nombre, archivo, de, a, op = {}] of MUTANTES) {
  if (op.pg && !conPg) { salteados++; console.log('  salteado (sin HN_PGLITE):', nombre); continue; }
  copiar();
  const ruta = path.join(COPIA, 'estaciones-privadas', 'parseo', archivo);
  const t = fs.readFileSync(ruta, 'utf8');
  if (!t.includes(de)) { console.error('✗ NO ENCONTRÉ el texto del mutante:', nombre); vivos++; continue; }
  fs.writeFileSync(ruta, t.replace(de, a));
  if (suite()) { vivos++; console.log('✗ VIVO:', nombre); } else { muertos++; console.log('✓ muerto:', nombre); }
}
fs.rmSync(COPIA, { recursive: true, force: true });
console.log(`\n${muertos} muertos, ${vivos} vivos, ${salteados} salteados, de ${MUTANTES.length}`);
process.exit(vivos ? 1 : 0);
