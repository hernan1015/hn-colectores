// HN AGRO · estaciones-parseo · EL REPO ES PÚBLICO: que no haya NADA real (ni nombres, ni ids, ni coordenadas).
//   1. Siempre: todo lo que sale de las fixtures es sintético a la vista: ids 9001…9999 o «prueba…», nombres «Prueba N»,
//      coordenadas redondas (≤ 3 decimales) dentro de la caja inventada (−36…−33, −62…−59).
//   2. Si están a mano las muestras REALES (fuera del repo, en el cortex privado: HN_FIXTURES_PRIVADAS = la carpeta que
//      tiene estaciones-internas/), se parsean con los mismos módulos y se controla que ningún id, nombre ni coordenada
//      de ellas aparezca en NINGÚN archivo de estaciones-parseo/. Ese control corre en pc-nanci, no en Actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ, FIX, archivos } from './ayuda.mjs';
import { FUENTES } from '../fuentes/index.mjs';
import { crear as crearWC, FORMATO } from '../fuentes/weathercloud.mjs';

/** Todo lo que los módulos sacan de una carpeta con la forma de R2. */
function extraer(dir) {
  const out = { ids: new Set(), nombres: new Set(), coords: [] };
  const base = path.join(dir, 'estaciones-internas');
  if (!fs.existsSync(base)) return out;
  for (const f of FUENTES) {
    const d = path.join(base, f.id);
    if (!fs.existsSync(d)) continue;
    let indice = new Map();
    const pIdx = path.join(d, 'indices');
    if (fs.existsSync(pIdx)) for (const a of fs.readdirSync(pIdx)) {
      for (const s of JSON.parse(fs.readFileSync(path.join(pIdx, a), 'utf8'))) indice.set(String(s.id), { lat: s.lat, lon: s.lng, tb: s.tb });
    }
    const mod = f.id === 'weathercloud' ? crearWC({ ...FORMATO, verificado: true, posiciones: { ...FORMATO.posiciones, id: 0, nombre: 1 } }) : f;
    for (const a of archivos(d).filter((p) => !p.includes(path.sep + 'indices' + path.sep))) {
      const t = fs.readFileSync(a, 'utf8');
      const obj = f.abrir ? f.abrir(t) : JSON.parse(t);
      const r = mod.leer(obj, { indice });
      for (const e of r.estaciones) {
        out.ids.add(e.estacion_id);
        if (e.nombre) out.nombres.add(e.nombre);
        if (e.lat != null) out.coords.push([e.lat, e.lon]);
      }
      for (const [id, i] of indice) { out.ids.add(id); if (i.lat != null) out.coords.push([i.lat, i.lon]); }
    }
  }
  return out;
}

test('las fixtures del repo son sintéticas: ids, nombres y coordenadas inventados', () => {
  const x = extraer(FIX);
  assert.ok(x.ids.size >= 15);
  for (const id of x.ids) assert.match(id, /^(9\d{3}|prueba[a-z0-9-]*)$/, id);
  for (const n of x.nombres) assert.match(n, /^Prueba \d+$/, n);
  for (const [lat, lon] of x.coords) {
    assert.ok(lat > -36 && lat < -33 && lon > -62 && lon < -59, `${lat},${lon}`);
    assert.ok(Math.abs(lat * 1000 - Math.round(lat * 1000)) < 1e-6 && Math.abs(lon * 1000 - Math.round(lon * 1000)) < 1e-6, `${lat},${lon}`);
  }
});

test('ninguna clave de API ni token en estaciones-parseo/', () => {
  for (const p of archivos(RAIZ)) {
    const t = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(t, /AIza[0-9A-Za-z_-]{20,}/, p);          // claves de Google (la página de BCP trae una)
    assert.doesNotMatch(t, /postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`@]{6,}@/, p);
    assert.doesNotMatch(t, /\b[0-9a-f]{32}\.r2\.cloudflarestorage/, p);
  }
});

const PRIV = process.env.HN_FIXTURES_PRIVADAS;
test('nada de las muestras REALES aparece en el repo (HN_FIXTURES_PRIVADAS)', { skip: PRIV ? false : 'sin HN_FIXTURES_PRIVADAS (corre en pc-nanci)' }, () => {
  const real = extraer(PRIV);
  assert.ok(real.ids.size > 50, 'las muestras reales no se leyeron (¿cambió el formato?)');
  const textos = archivos(RAIZ).map((p) => [p, fs.readFileSync(p, 'utf8')]);
  const buscar = (aguja, que) => {
    for (const [p, t] of textos) assert.ok(!t.includes(aguja), `${que} real en ${path.relative(RAIZ, p)}`);
  };
  for (const n of real.nombres) if (n.length >= 5) buscar(n, 'nombre');
  for (const [lat, lon] of real.coords) { buscar(lat.toFixed(4), 'latitud'); buscar(lon.toFixed(4), 'longitud'); }
  // los ids: los que tienen letras, en ningún archivo; los NUMÉRICOS, en las fixtures (en el código hay números como
  // 100 o 1440 que no son ids)
  const esc = (i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const conLetras = [...real.ids].filter((i) => i.length >= 3 && /[A-Za-z]/.test(i));
  const numericos = [...real.ids].filter((i) => i.length >= 3 && !/[A-Za-z]/.test(i));
  const re = (ids) => new RegExp(`["'\\[/ ](${ids.map(esc).join('|')})["'\\],/ ]`);
  for (const [p, t] of textos) {
    if (conLetras.length) assert.doesNotMatch(t, re(conLetras), `id real en ${path.relative(RAIZ, p)}`);
    if (numericos.length && p.includes(path.sep + 'fixtures' + path.sep)) assert.doesNotMatch(t, re(numericos), `id real en ${path.relative(RAIZ, p)}`);
  }
});
