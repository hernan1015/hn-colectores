// node --test sipan-alto-valle/test/crudos-rol.test.mjs   (sin red ni base)
// Los crudos en releases diarias del repo privado (hn-radar). (La base con el rol propio está en base-pg.test.mjs.)
// Cada bloque trae su control negativo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { almacenReleases, partesDeClave } from '../lib/releases.mjs';
import { almacenDeEntorno, procesarEstacion } from '../sipan.mjs';
import { ESTACIONES } from '../lib/estaciones.mjs';
import { armar, serie } from './sintetico.mjs';

/** Un GitHub falso en memoria: releases por tag, assets por id, y el orden de las operaciones. */
function githubFalso() {
  const s = { releases: new Map(), assets: new Map(), orden: [], sigId: 1, fallarSubida: false };
  const resp = (status, cuerpo) => ({ ok: status < 300, status, text: async () => (cuerpo == null ? '' : JSON.stringify(cuerpo)) });
  const fetchFn = async (url, o = {}) => {
    const u = new URL(url); const m = o.method || 'GET'; let x;
    if ((x = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(u.pathname)) && m === 'GET') {
      const r = s.releases.get(x[1]);
      return r ? resp(200, { id: r.id, assets: r.assets.map((a) => ({ ...a })) }) : resp(404);
    }
    if (/^\/repos\/[^/]+\/[^/]+\/releases$/.test(u.pathname) && m === 'POST') {
      const b = JSON.parse(o.body);
      const r = { id: s.sigId++, tag: b.tag_name, assets: [] };
      s.releases.set(b.tag_name, r); s.orden.push('crear ' + b.tag_name);
      return resp(201, { id: r.id, assets: [] });
    }
    if (u.hostname === 'uploads.github.com' && (x = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/.exec(u.pathname))) {
      if (s.fallarSubida) return resp(500);
      const r = [...s.releases.values()].find((y) => y.id === +x[1]);
      const a = { id: s.sigId++, name: u.searchParams.get('name') };
      r.assets.push(a); s.assets.set(a.id, o.body); s.orden.push('subir ' + a.name);
      return resp(201, a);
    }
    if ((x = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(u.pathname))) {
      const id = +x[1];
      if (m === 'GET') return s.assets.has(id) ? { ok: true, status: 200, arrayBuffer: async () => s.assets.get(id) } : resp(404);
      if (m === 'DELETE') {
        for (const r of s.releases.values()) r.assets = r.assets.filter((a) => a.id !== id);
        s.assets.delete(id); s.orden.push('borrar ' + id);
        return resp(204);
      }
    }
    return resp(404);
  };
  return { s, fetchFn };
}
const gz = (o) => zlib.gzipSync(JSON.stringify(o));
const ungz = (b) => JSON.parse(zlib.gunzipSync(b).toString('utf8'));
const CLAVE = 'sipan-alto-valle/10/2026/2026-09-10.json.gz';

test('releases: un release sipan-AAAA-MM-DD por día y un asset por estación; el viejo se borra DESPUÉS de subir el nuevo', async () => {
  const gh = githubFalso(); let n = 0;
  const sello = () => 'S' + n++;
  const a1 = almacenReleases({ token: 't', repo: 'dueno/privado', fetchFn: gh.fetchFn, sello });
  await a1.escribir(CLAVE, gz({ registros: [{ local: '2026-09-10T00:10', v: { temp: 1 } }, { local: '2026-09-10T00:20', v: { temp: 2 } }] }));
  const a2 = almacenReleases({ token: 't', repo: 'dueno/privado', fetchFn: gh.fetchFn, sello });
  const leido = ungz(await a2.leer(CLAVE));
  assert.equal(leido.registros.length, 2);
  await a2.escribir(CLAVE, gz({ registros: [...leido.registros, { local: '2026-09-10T00:30', v: { temp: 3 } }] }));
  const rel = gh.s.releases.get('sipan-2026-09-10');
  assert.deepEqual(rel.assets.map((x) => x.name), ['10__S1.json.gz']);
  assert.deepEqual(gh.s.orden, ['crear sipan-2026-09-10', 'subir 10__S0.json.gz', 'subir 10__S1.json.gz', 'borrar 2']);
  assert.equal(ungz(await almacenReleases({ token: 't', repo: 'dueno/privado', fetchFn: gh.fetchFn }).leer(CLAVE)).registros.length, 3);
  await a2.escribir('sipan-alto-valle/40/2026/2026-09-10.json.gz', gz({ registros: [] }));
  assert.equal(gh.s.releases.size, 1);                                       // mismo día: mismo release
  assert.equal(gh.s.releases.get('sipan-2026-09-10').assets.length, 2);      // otra estación: otro asset
  /* control negativo: un día que no existe se lee como null (no como vacío inventado) */
  assert.equal(await a2.leer('sipan-alto-valle/10/2026/2026-09-11.json.gz'), null);
});

test('releases: si quedaron dos assets de la misma estación (una corrida cortada), al leer se unen sin duplicar', async () => {
  const gh = githubFalso();
  const a = almacenReleases({ token: 't', repo: 'd/p', fetchFn: gh.fetchFn, sello: () => 'A' });
  await a.escribir(CLAVE, gz({ registros: [{ local: '2026-09-10T00:10', v: { temp: 1 } }, { local: '2026-09-10T00:20', v: { temp: 2 } }] }));
  /* a mano, un segundo asset de la misma estación que se solapa */
  const rel = gh.s.releases.get('sipan-2026-09-10');
  rel.assets.push({ id: 99, name: '10__B.json.gz' }); gh.s.assets.set(99, gz({ registros: [{ local: '2026-09-10T00:20', v: { temp: 2.5 } }, { local: '2026-09-10T00:30', v: { temp: 3 } }] }));
  const u = ungz(await almacenReleases({ token: 't', repo: 'd/p', fetchFn: gh.fetchFn }).leer(CLAVE));
  assert.deepEqual(u.registros.map((r) => r.local), ['2026-09-10T00:10', '2026-09-10T00:20', '2026-09-10T00:30']);
  assert.equal(u.registros[1].v.temp, 2.5);                                  // gana el más nuevo (por nombre)
  /* control negativo: el asset de OTRA estación no se mezcla */
  rel.assets.push({ id: 100, name: '40__C.json.gz' }); gh.s.assets.set(100, gz({ registros: [{ local: '2026-09-10T05:00', v: {} }] }));
  assert.equal(ungz(await almacenReleases({ token: 't', repo: 'd/p', fetchFn: gh.fetchFn }).leer(CLAVE)).registros.length, 3);
});

test('releases · control negativo: si la subida falla, el crudo viejo NO se borra y la corrida se entera', async () => {
  const gh = githubFalso();
  await almacenReleases({ token: 't', repo: 'd/p', fetchFn: gh.fetchFn, sello: () => 'A' }).escribir(CLAVE, gz({ registros: [{ local: '2026-09-10T00:10', v: {} }] }));
  gh.s.fallarSubida = true;
  await assert.rejects(almacenReleases({ token: 't', repo: 'd/p', fetchFn: gh.fetchFn, sello: () => 'B' }).escribir(CLAVE, gz({ registros: [] })));
  assert.deepEqual(gh.s.releases.get('sipan-2026-09-10').assets.map((x) => x.name), ['10__A.json.gz']);
  /* una clave que no es de un crudo se rechaza: no escribe en cualquier lado */
  assert.throws(() => partesDeClave('../otra/cosa'));
  assert.throws(() => almacenReleases({ token: 't', repo: 'no es un repo' }));
  assert.throws(() => almacenReleases({ repo: 'd/p' }));
});

test('releases con el colector: la segunda bajada solapada completa el día sin duplicar (dedup contra lo guardado)', async () => {
  const gh = githubFalso();
  const alm = almacenReleases({ token: 't', repo: 'd/p', fetchFn: gh.fetchFn });
  const e = ESTACIONES.find((x) => x.id === '10');
  const x1 = await procesarEstacion({ e, texto: armar(serie('2026-09-10T00:10', '2026-09-10T16:00', () => 6)), almacen: alm });
  await alm.escribir(CLAVE, gz({ registros: x1.todos.map((r) => ({ local: r.local, v: r.v, texto: r.texto })) }));
  const x2 = await procesarEstacion({ e, texto: armar(serie('2026-09-10T08:10', '2026-09-11T00:00', () => 6)), almacen: almacenReleases({ token: 't', repo: 'd/p', fetchFn: gh.fetchFn }) });
  assert.equal(x2.filas.find((f) => f.fecha === '2026-09-10').registros_validos, 144);
  assert.equal(new Set(x2.todos.map((r) => r.local)).size, x2.todos.length);
  /* control negativo: sin lo guardado, el día queda con la segunda bajada sola */
  const x3 = await procesarEstacion({ e, texto: armar(serie('2026-09-10T08:10', '2026-09-11T00:00', () => 6)) });
  assert.equal(x3.filas.find((f) => f.fecha === '2026-09-10').registros_validos, 96);
});

test('destino de los crudos: releases con SIPAN_CRUDOS_REPO; R2 sólo con SIPAN_R2_ON=si; si no, ninguno', () => {
  const r2 = { SIPAN_R2_CUENTA: 'c', SIPAN_R2_ACCESS_KEY_ID: 'k', SIPAN_R2_SECRET_ACCESS_KEY: 's', SIPAN_R2_DEPOSITO: 'd' };
  assert.equal(almacenDeEntorno({ SIPAN_CRUDOS_REPO: 'd/p', SIPAN_CRUDOS_TOKEN: 't', ...r2, SIPAN_R2_ON: 'si' }).tipo, 'releases');
  assert.equal(almacenDeEntorno({ ...r2 }), null);                           // R2 apagado aunque estén sus variables
  assert.equal(almacenDeEntorno({ ...r2, SIPAN_R2_ON: 'si' }).tipo, 'r2');   // control negativo: prendido a propósito
  assert.equal(almacenDeEntorno({}), null);
});
