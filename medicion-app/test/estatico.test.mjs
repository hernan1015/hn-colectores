// node --test · lo que se ve leyendo los archivos: un solo host de afuera (Open-Meteo, sin models), un solo lugar que
// imprime, el workflow apagado con la llave y el cron de las 10 ARG, y los umbrales iguales a los del SELLO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELLO, OM, REGLA, ZONAS, REGIONES } from '../lib/sello.mjs';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codigo = ['medir-app.mjs', ...fs.readdirSync(path.join(RAIZ, 'lib')).map((f) => 'lib/' + f)];
const txt = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');

test('un solo host de afuera (api.open-meteo.com), sin models; sólo medir-app.mjs imprime', () => {
  for (const f of codigo) {
    const t = txt(f);
    const hosts = [...t.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]).filter((h) => !/claude\.ai|github\.com/.test(h));
    assert.ok(hosts.every((h) => h === 'api.open-meteo.com'), `${f}: ${hosts}`);
    assert.ok(!/models=|&models|cell_selection=/.test(t), `${f} no pide otro modelo`);
    if (f !== 'medir-app.mjs') assert.ok(!/console\.(log|error|warn)/.test(t), `${f} no imprime`);
  }
  assert.equal(OM.base, 'https://api.open-meteo.com/v1/forecast');
  assert.deepEqual([...OM.hourly], ['temperature_2m', 'relative_humidity_2m']);
});

test('el workflow: .yml.txt, cron 13:00 UTC, la llave MEDICION_APP_ON, real sólo por el cron, secretos sin imprimir', () => {
  const w = txt('medicion-app.workflow.yml.txt');
  assert.match(w, /- cron: '0 13 \* \* \*'/);
  assert.match(w, /if: \$\{\{ vars\.MEDICION_APP_ON == 'si' \}\}/);
  assert.match(w, /MODO: \$\{\{ github\.event_name == 'schedule' && 'real' \|\| inputs\.modo \}\}/);
  assert.match(w, /default: seco/);
  assert.match(w, /persist-credentials: false/);
  assert.match(w, /permissions:\n {2}contents: read/);
  assert.match(w, /estaciones-privadas\/parseo\/lib/);
  assert.ok(!/echo .*\$\{\{ secrets|echo .*MEDICION_PG/.test(w));
  assert.ok(!fs.existsSync(path.join(RAIZ, '..', '.github', 'workflows', 'medicion-app.yml')), 'no se instala acá');
});

test('los umbrales son los del SELLO (m1); con HN_SELLO_260 se comparan con el archivo del cortex', () => {
  assert.equal(REGLA, 'm1');
  assert.deepEqual([...ZONAS], ['agricola', 'pastizal', 'urbana', 'natural', 'sin_dato']);
  assert.deepEqual([...REGIONES], ['patagonia', 'noa', 'nea', 'cuyo', 'pampa_norte', 'pampa_sur']);
  const s = process.env.HN_SELLO_260;
  if (!s) return;
  const sello = JSON.parse(fs.readFileSync(s, 'utf8'));
  assert.equal(sello.regla, REGLA);
  assert.equal(sello.datos_suficientes.fraccion_minima, SELLO.fraccion_minima);
  assert.equal(sello.metricas.n_minimo_grupo, SELLO.n_minimo_grupo);
  assert.deepEqual(sello.cortes.region.cajas.map((c) => c[0]), [...REGIONES]);
  const t = JSON.stringify(sello);
  for (const frase of ['≤ 120 min', '≤ 180 min', '≤ 60 min', '|dif| ≥ 3 °C', '|dif| ≥ 10 pp', 'lotes de 50 coordenadas', '30 s de pausa', '2.000 coordenadas por corrida', '(fecha+1 03:00, 09:00]', 'BCP_RT'])
    assert.ok(t.includes(frase), 'el sello dice ' + frase);
  assert.equal(SELLO.hueco_noche_min, 120); assert.equal(SELLO.hueco_dia_min, 180); assert.equal(SELLO.muestreo_max_min, 60);
  assert.equal(SELLO.umbral_temp_c, 3); assert.equal(SELLO.umbral_hr_pp, 10);
  assert.equal(OM.por_pedido, 50); assert.equal(OM.pausa_ms, 30000); assert.equal(OM.tope_puntos, 2000);
});
