// HN AGRO · estaciones-parseo · de punta a punta contra PostgreSQL de verdad (PGlite), COMO el rol colector_estaciones,
// con el esquema de producción (copias de 0075, 0110, 0147, 0147b) y la 0161: el job entero en seco sobre las fixtures.
//   · la primera corrida escribe; la SEGUNDA no escribe NADA (idempotente por la firma);
//   · mostrar queda en false y el rol no lo puede cambiar; las duplicadas a < 2 km quedan las dos, con la preferida;
//   · la vista para comparar un punto devuelve lo de 25 km con su serie;
//   · CONTROL NEGATIVO: sin la 0161 el guardado no puede (falta la tabla / la política).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIX, AHORA, SIN_PGLITE, PGlite } from './ayuda.mjs';
import { conectarPglite } from '../lib/base.mjs';
import { almacenDeCarpeta } from '../lib/almacen.mjs';
import { correr } from '../parsear.mjs';
import { guardarRed } from '../lib/guardar.mjs';

const opts = { skip: SIN_PGLITE };
const nueva = async (o = {}) => conectarPglite({ PGlite: await PGlite(), ...o });
const comoAdmin = async (db, f) => { await db.pg.exec('reset role'); try { return await f(); } finally { await db.pg.exec('set role colector_estaciones'); } };

test('el job en seco: primera corrida escribe, la segunda NO escribe nada (idempotente)', opts, async () => {
  const db = await nueva();
  const almacen = almacenDeCarpeta(FIX);
  const r1 = await correr({ almacen, db, ahora: AHORA });
  assert.equal(r1.ok, true);
  assert.equal(r1.total.nuevas, 23);   // 23: la de WeatherLink ya no entra (formato sin verificar, 0152 obs. 6)
  assert.equal(r1.total.estaciones, 17);
  const r2 = await correr({ almacen, db, ahora: AHORA });
  assert.equal(r2.ok, true);
  assert.equal(r2.total.estaciones, 0);
  assert.equal(r2.total.nuevas, 0);
  assert.equal(r2.total.cambiadas, 0);
  assert.equal(r2.total.iguales, 23);
  const n = await comoAdmin(db, () => db.q('select count(*)::int as n from estaciones_lecturas'));
  assert.equal(n[0].n, 23);
  const reg = await comoAdmin(db, () => db.q("select count(*)::int as n from registro_procesos where proceso = 'estaciones_parseo' and ok"));
  assert.equal(reg[0].n, 2);
  await db.cerrar();
});

test('lo que queda en la base: imposibles en NULL con marca, el 0 medido es 0, la vieja y la futura no entraron', opts, async () => {
  const db = await nueva();
  await correr({ almacen: almacenDeCarpeta(FIX), db, ahora: AHORA });
  const f = await comoAdmin(db, () => db.q(`select estacion_id, temp_c, hum_pct, presion_hpa, lluvia_dia_mm, marcas, crudo
    from estaciones_lecturas where red = 'EEAOC' order by estacion_id, instante`));
  assert.deepEqual(f.map((x) => x.estacion_id), ['9001', '9001', '9002']);
  const [a, b, c] = f;
  assert.equal(Number(a.lluvia_dia_mm), 0);
  assert.equal(Number(b.lluvia_dia_mm), 2.5);
  assert.equal(c.temp_c, null);
  assert.equal(c.hum_pct, null);
  assert.equal(Number(c.presion_hpa), 1010);
  assert.deepEqual(c.marcas, ['hum_imposible', 'temp_imposible']);
  assert.deepEqual(c.crudo, { temp_c: 55, hum_pct: 255, viento_medio: 10, viento_max: 20 });
  await db.cerrar();
});

test('mostrar = false siempre, y el rol del colector no lo puede cambiar; WeatherLink no se puede mostrar ni como admin', opts, async () => {
  const db = await nueva();
  await correr({ almacen: almacenDeCarpeta(FIX), db, ahora: AHORA });
  const m = await comoAdmin(db, () => db.q('select count(*)::int as n, count(*) filter (where mostrar)::int as si from estaciones'));
  assert.equal(m[0].n, 17);
  assert.equal(m[0].si, 0);
  // el rol intenta al dar de alta: el disparador la deja en false
  await db.q("insert into estaciones (red, estacion_id, mostrar) values ('EEAOC', '9099', true)");
  assert.equal((await db.q("select mostrar from estaciones where estacion_id = '9099'"))[0].mostrar, false);
  // el rol intenta: el disparador conserva el valor
  await db.q("update estaciones set mostrar = true where red = 'EEAOC'");
  const m2 = await comoAdmin(db, () => db.q("select count(*) filter (where mostrar)::int as si from estaciones"));
  assert.equal(m2[0].si, 0);
  await comoAdmin(db, async () => {
    await assert.rejects(db.q("update estaciones_redes set mostrar = true where red = 'WEATHERLINK_PUB'"));
    await assert.rejects(db.q("update estaciones set mostrar = true where red = 'EEAOC'"));   // su red es interna
  });
  await db.cerrar();
});

test('el rol sólo escribe sus redes: SNIH no; y no puede borrar', opts, async () => {
  const db = await nueva();
  await assert.rejects(guardarRed(db, { red: 'SNIH', estaciones: [{ estacion_id: 'prueba', metadatos: {} }], lecturas: [] }));
  await correr({ almacen: almacenDeCarpeta(FIX), db, ahora: AHORA });
  await assert.rejects(db.q("delete from estaciones_lecturas where red = 'EEAOC'"));
  await db.cerrar();
});

test('duplicadas a < 2 km: se guardan las dos y la preferida es la institucional', opts, async () => {
  const db = await nueva();
  await correr({ almacen: almacenDeCarpeta(FIX), db, ahora: AHORA });
  const d = await comoAdmin(db, () => db.q(`select red, estacion_id, duplicado_de_red, duplicado_de_id from estaciones
    where duplicado_de_red is not null or (red, estacion_id) in (('EEAOC', '9001'))`));
  assert.deepEqual(d.map((x) => [x.red, x.estacion_id, x.duplicado_de_red, x.duplicado_de_id]).sort(),
    [['EEAOC', '9001', null, null], ['WEATHERLINK_PUB', 'prueba-wl-1', 'EEAOC', '9001']]);
  await db.cerrar();
});

test('la vista para comparar un punto: a ≤ 25 km, por distancia, con fuente, última lectura y serie', opts, async () => {
  const db = await nueva();
  await correr({ almacen: almacenDeCarpeta(FIX), db, ahora: AHORA });
  const f = await comoAdmin(db, () => db.q(`select red, estacion_id, fuente, mostrar, preferida, distancia_km::float8 as d, ultima, serie, diario
    from estaciones_comparar_punto(-34.5, -60.5, 25, '2026-01-10T16:30:00Z')`));
  const ids = f.map((x) => x.estacion_id);
  assert.deepEqual(ids.slice(0, 2), ['9001', 'prueba-wl-1']);
  assert.ok(f.every((x) => x.d <= 25 && x.mostrar === false));
  assert.ok(!ids.includes('9201'));                     // Mendoza de prueba: a más de 100 km
  const a = f[0];
  assert.equal(a.fuente, 'EEAOC Tucumán');
  assert.equal(a.preferida, true);
  assert.equal(Number(a.ultima.temp_c), 21);
  assert.equal(a.serie.length, 2);
  assert.equal(a.diario.length, 1);
  assert.equal(Number(a.diario[0].lluvia_mm), 2.5);
  assert.equal(a.diario[0].lluvia_origen, 'acumulado_consola');
  await db.cerrar();
});

test('CONTROL NEGATIVO: sin la 0161 el job no puede guardar (y lo dice con una categoría, sin datos)', opts, async () => {
  const db = await nueva({ sin0161: true });
  const r = await correr({ almacen: almacenDeCarpeta(FIX), db, ahora: AHORA });
  assert.equal(r.ok, false);
  assert.match(r.fuentes.eeaoc.error, /^base:/);
  await db.cerrar();
});

test('la base también frena (aunque el parseo se equivoque): 50 °C, HR 0, sin variables, del futuro, firma rota', opts, async () => {
  const db = await nueva();
  await guardarRed(db, { red: 'EEAOC', estaciones: [{ estacion_id: '9001', metadatos: {} }], lecturas: [] });
  const ins = (cols, vals) => db.q(`insert into estaciones_lecturas (red, estacion_id, instante, leido_en, firma, ${cols})
    values ('EEAOC', '9001', '2026-01-10T15:00:00Z', '2026-01-10T15:11:00Z', '0123456789abcdef', ${vals})`);
  await assert.rejects(ins('temp_c', '50'));
  await assert.rejects(ins('hum_pct', '0'));
  await assert.rejects(ins('hum_pct', '255'));
  await assert.rejects(ins('lluvia_mm', '1'));          // lluvia sin período
  await assert.rejects(db.q(`insert into estaciones_lecturas (red, estacion_id, instante, leido_en, firma)
    values ('EEAOC', '9001', '2026-01-10T15:00:00Z', '2026-01-10T15:11:00Z', '0123456789abcdef')`));   // sin ninguna variable
  await assert.rejects(db.q(`insert into estaciones_lecturas (red, estacion_id, instante, leido_en, firma, temp_c)
    values ('EEAOC', '9001', '2026-01-10T16:00:00Z', '2026-01-10T15:11:00Z', '0123456789abcdef', 20)`));  // 49 min al futuro
  await assert.rejects(ins('temp_c', '20').then(() => db.q(`update estaciones_lecturas set firma = 'no es una firma'`)));
  await db.q("update estaciones_lecturas set temp_c = 49.9 where red = 'EEAOC'");   // el borde posible sí
  await db.cerrar();
});
