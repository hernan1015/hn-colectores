// node --test test/nueve-fuentes.test.mjs · LA CORRIDA ENTERA: las 9 fuentes a la vez, en REAL, COMO el rol
// colector_estaciones, con la migración unificada aplicada sobre las reales: 0110 (copia en esquema-previo.sql) + 0147 +
// 0147b (políticas) + 0152. La 0151 (SMN) no hace falta: la 0152 fija la lista ENTERA de redes (incluye SMN_ABIERTO).
// Los datos: los fixtures REALES de la 139 (cortex, HN_FIXTURES_139: son datos internos, no van en este repo público)
// copiados a una carpeta-R2 temporal, más WeatherLink y Weathercloud SINTÉTICOS (fixtures.mjs). Ningún pedido real.
// Sin HN_PGLITE o sin HN_FIXTURES_139, salteado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { correr } from '../parseo.mjs';
import { ejecutorPglite, REDES } from '../lib/base.mjs';
import { FUENTES } from '../fuentes/index.mjs';
import * as WC from '../fuentes/weathercloud.mjs';
import { RAIZ, politicas0147b, carpeta, rondaWL, indiceWL, rondaWC, detalleWL, devWC, WC_PRUEBA } from './fixtures.mjs';

const DIR = process.env.HN_PGLITE || '';
const FIX = process.env.HN_FIXTURES_139 || 'C:/HN-AGRO/hn-cortex/docs/red-nacional-139/fixtures/r2';
const salto = (!(DIR && fs.existsSync(path.join(DIR, 'dist', 'index.js'))) && 'sin HN_PGLITE')
  || (!fs.existsSync(path.join(FIX, 'estaciones-internas')) && 'sin HN_FIXTURES_139 (los fixtures están en el cortex privado)');
const REPO = path.resolve(RAIZ, '..', '..');
const leerTxt = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const AHORA = Date.parse('2026-11-15T16:20:00Z');

test('las 9 fuentes a la vez, como el rol, con la 0152 unificada: las 10 redes guardadas, mostrar=false, idempotente, log sin ids', { skip: salto }, async () => {
  const { PGlite } = await import(pathToFileURL(path.join(DIR, 'dist', 'index.js')).href);
  const pg = new PGlite();
  await pg.exec(leerTxt(path.join(RAIZ, 'test', 'esquema-previo.sql')));
  await pg.exec(leerTxt(path.join(REPO, 'sipan-alto-valle', 'migracion', '0147_estaciones_noche_y_muestreo.sql')));
  await pg.exec(politicas0147b());
  await pg.exec(leerTxt(path.join(RAIZ, 'migracion', '0152_parseo_estaciones_unificada_PROPUESTA.sql')));

  const { dir, r2 } = carpeta();
  fs.cpSync(path.join(FIX, 'estaciones-internas'), path.join(dir, 'estaciones-internas'), { recursive: true });
  await indiceWL(r2, '2026-11-15', [{ id: '501', lat: -39.03, lng: -67.58, tb: 1 }]);
  for (const h of [15, 16]) {
    const ms = Date.parse(`2026-11-15T${h}:11:00Z`);
    await rondaWL(r2, ms, [{ id: '501', d: detalleWL({ t: new Date(ms - 6 * 60e3).toISOString(), f: 50 + h, nombre: 'Chacra Secreta' }) }]);
  }
  await rondaWC(r2, Date.parse('2026-11-15T16:11:00Z'), [devWC('c1'), devWC('c2', { estado: 1 })]);
  /* Weathercloud con el formato de PRUEBA (el real nace sin verificar y no guardaría nada) */
  const fuentes = FUENTES.map((f) => (f.id === 'weathercloud' ? WC.crear(WC_PRUEBA) : f));
  assert.equal(fuentes.length, 9);

  const ej = ejecutorPglite(pg, { rol: 'colector_estaciones' });
  const lineas = [];
  const r = await correr({ r2, ejecutor: ej, ahora: AHORA, fuentes, log: (x) => lineas.push(x) });
  assert.equal(r.ok, true, JSON.stringify(r.fuentes));
  assert.deepEqual(Object.keys(r.fuentes).sort(), FUENTES.map((f) => f.id).sort());

  const porRed = (await pg.query(`select red, count(*)::int n from estaciones_obs group by red order by red`)).rows;
  assert.deepEqual(porRed.map((x) => x.red), [...REDES].sort(), 'las 10 redes tienen filas');
  assert.ok(porRed.every((x) => x.n > 0));
  const abiertas = (await pg.query(`select count(*)::int n from estaciones where (metadatos->>'mostrar')::boolean is distinct from false`)).rows[0].n;
  assert.equal(abiertas, 0, 'ninguna estación se muestra');
  const ult = (await pg.query(`select red, count(*)::int n from estaciones_ultima_lectura group by red order by red`)).rows;
  assert.deepEqual(ult.map((x) => x.red), ['WEATHERCLOUD_PUB', 'WEATHERLINK_PUB'], 'la última lectura, sólo las de la 138b');
  const procesos = (await pg.query(`select proceso, count(*)::int n from registro_procesos group by proceso order by proceso`)).rows;
  assert.deepEqual(procesos.map((x) => x.proceso), [...new Set(FUENTES.map((f) => f.proceso))].sort());
  assert.equal(procesos.reduce((s, x) => s + x.n, 0), 9, 'un renglón por fuente');

  /* el log público: UNA línea, sólo cantidades */
  assert.equal(lineas.length, 1);
  for (const x of ['Grumbein', 'Bajastine', 'parana', '-38.75', 'Chacra', '-39.03', 'Córdoba']) assert.ok(!lineas[0].includes(x), 'el log trae ' + x);

  /* idempotente: la segunda corrida no escribe nada y deja lo mismo */
  const foto = async () => (await pg.query(`select md5(string_agg(red || estacion_id || fecha || coalesce(tmin_c::text,'') || coalesce(lluvia_mm::text,'') || (crudo->>'firma'), ',' order by red, estacion_id, fecha)) h from estaciones_obs`)).rows[0].h;
  const antes = await foto();
  const r2b = await correr({ r2, ejecutor: ej, ahora: AHORA + 60e3, fuentes, log: () => {} });
  assert.ok(Object.values(r2b.fuentes).every((t) => t.filas_escritas === 0 && t.estaciones_nuevas === 0), JSON.stringify(r2b.fuentes));
  assert.equal(await foto(), antes);
  await pg.close();
});
