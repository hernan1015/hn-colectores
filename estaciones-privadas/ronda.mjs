// HN AGRO · estaciones privadas e internas (WeatherLink, Weathercloud, SIGA, EEAOC, Mendoza, San Luis, BCP), una ronda por hora. USO INTERNO.
// Autorizado por el maker el 15/11/2026, sabiendo que los términos de Davis y de Weathercloud prohíben los robots
// (ver hn-cortex docs/mejora-continua/PASO0-139-fuentes.md). El mail pidiendo permiso a Davis lo manda el maker.
// Reglas del maker: de a poco y sin disfrazarse. 1 pedido cada 4 s, tandas de 2 min con 30 s de pausa. UA honesto.
// Ante 403/429/5xx/HTML: corta la fuente en esa ronda; a la 3.ª ronda seguida con corte (marca en R2) no se pide más
// esa fuente hasta que alguien borre la marca. Nada de rotar IPs, proxys ni UAs de navegador.
// Los datos van a R2 (depósito privado, el mismo de los crudos del SIPAN). El registro de Actions es PÚBLICO: sólo
// se imprimen cantidades, nunca nombres, ids ni coordenadas.
import fs from 'node:fs';
import path from 'node:path';
import { almacenR2 } from '../sipan-alto-valle/lib/almacen.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const UA = 'hn-colector/1.0';
const PASO_MS = 4000, TANDA_MS = 120000, PAUSA_MS = 30000, TOPE_MS = 50 * 60000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ahora = new Date();
const dia = new Date(ahora.getTime() - 3 * 3600e3).toISOString().slice(0, 10);   // fecha ARG
const hora = ahora.toISOString().slice(11, 16).replace(':', '');                    // HHMM UTC
const PREF = 'estaciones-internas/';

const geo = JSON.parse(fs.readFileSync(path.join(DIR, 'argentina.geo.json'), 'utf8')).features[0].geometry;
const anillos = (geo.type === 'Polygon' ? [geo.coordinates] : geo.coordinates).map((p) => p[0]);
function enArgentina(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  for (const a of anillos) { let c = false; for (let i = 0, j = a.length - 1; i < a.length; j = i++) { const [xi, yi] = a[i], [xj, yj] = a[j]; if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c; } if (c) return true; }
  return false;
}

const r2 = almacenR2({ cuenta: process.env.R2_ACCOUNT_ID, clave: process.env.R2_ACCESS_KEY_ID, secreto: process.env.R2_SECRET_ACCESS_KEY, deposito: process.env.R2_BUCKET });
const esCorte = (r) => r.status === 403 || r.status === 429 || r.status >= 500 || !(r.headers.get('content-type') || '').includes('json');

async function marcaCorte(fuente, hubo) {
  const k = PREF + fuente + '/_cortes.json';
  const prev = JSON.parse((await r2.leer(k))?.toString() || '{"seguidos":0}');
  const nuevo = { seguidos: hubo ? prev.seguidos + 1 : 0, actualizado: ahora.toISOString() };
  if (hubo || prev.seguidos) await r2.escribir(k, JSON.stringify(nuevo));
  return nuevo.seguidos;
}
async function frenada(fuente) {
  const m = await r2.leer(PREF + fuente + '/_cortes.json');
  return m && JSON.parse(m.toString()).seguidos >= 3;
}

const resumen = {};

// ── Weathercloud: un solo pedido trae el mundo; se guarda Argentina.
async function weathercloud() {
  if (await frenada('weathercloud')) { resumen.weathercloud = 'FRENADA (3 rondas con corte)'; return; }
  try {
    const r = await fetch('https://app.weathercloud.net/map/bgdevices', { method: 'POST', body: 'user=', signal: AbortSignal.timeout(180000),
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (r.status === 403 || r.status === 429 || r.status >= 500) { resumen.weathercloud = 'corte ' + r.status; await marcaCorte('weathercloud', true); return; }
    const j = await r.json();
    const ar = (j.devices || []).filter((d) => enArgentina(d[2], d[3]));
    await r2.escribir(`${PREF}weathercloud/${dia}/${hora}.json`, JSON.stringify({ leido: ahora.toISOString(), devices: ar }));
    resumen.weathercloud = { en_argentina: ar.length, en_linea: ar.filter((d) => d[4] === 2).length };
    await marcaCorte('weathercloud', false);
  } catch (e) { resumen.weathercloud = 'error'; }
}

// ── WeatherLink: índice 1 vez por día; después una lectura por estación, de a una.
async function weatherlink() {
  if (await frenada('weatherlink')) { resumen.weatherlink = 'FRENADA (3 rondas con corte)'; return; }
  const H = { 'User-Agent': UA, 'Referer': 'https://www.weatherlink.com/map', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' };
  const kIdx = `${PREF}weatherlink/indices/${dia}.json`;
  let idx = await r2.leer(kIdx);
  let lista;
  if (idx) lista = JSON.parse(idx.toString());
  else {
    const r = await fetch('https://www.weatherlink.com/map/data', { headers: H, signal: AbortSignal.timeout(120000) });
    if (esCorte(r)) { resumen.weatherlink = 'corte en el índice ' + r.status; await marcaCorte('weatherlink', true); return; }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.stations || j.data || []);
    lista = arr.filter((s) => s && enArgentina(s.lat, s.lng));
    await r2.escribir(kIdx, JSON.stringify(lista));
  }
  const activas = lista.filter((s) => s.tb !== -1);
  const filas = []; let tanda0 = Date.now(), ok = 0, err = 0, corte = false;
  for (const s of activas) {
    if (Date.now() - t0 > TOPE_MS) break;
    if (Date.now() - tanda0 > TANDA_MS) { await dormir(PAUSA_MS); tanda0 = Date.now(); }
    try {
      const r = await fetch(`https://www.weatherlink.com/map/data/station/${encodeURIComponent(s.id)}?aqiSchemeId=10&woodsmokeEnabled=false`, { headers: H, signal: AbortSignal.timeout(30000) });
      if (esCorte(r)) { corte = true; break; }
      filas.push(JSON.stringify({ id: s.id, leido: new Date().toISOString(), d: await r.json() }));
      ok++;
    } catch (e) { err++; }
    await dormir(PASO_MS);
  }
  if (filas.length) await r2.escribir(`${PREF}weatherlink/${dia}/${hora}.jsonl`, filas.join('\n') + '\n', { tipo: 'application/x-ndjson' });
  const seguidos = await marcaCorte('weatherlink', corte);
  resumen.weatherlink = { activas: activas.length, leidas: ok, con_error: err, corte, cortes_seguidos: seguidos };
}

// ── Redes provinciales e institucionales (USO INTERNO, autorizadas por el maker el 15/11): se guarda la respuesta
// CRUDA de su página o servicio público (uno o dos pedidos por red, con pausa); el parseo lo hace la 139.
const REDES = [
  { id: 'siga', pedidos: async () => {
      const cfg = await (await fetch('https://siga.inta.gob.ar/js/urlserver.js', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) })).text();
      const m = cfg.match(/^\s*var URL_MYSQL_ESTACION_AUTOMATICA\s*=\s*'([^']+)'/m);
      if (!m) throw new Error('sin URL en urlserver.js');
      return [['estaciones', 'https://siga.inta.gob.ar/' + m[1]]];
    } },
  { id: 'eeaoc', pedidos: async () => [['datos', 'https://agromet.eeaoc.gob.ar/services/datos-online.php'], ['estaciones', 'https://agromet.eeaoc.gob.ar/services/estaciones.php']] },
  { id: 'mendoza', pedidos: async () => [['instantaneas', 'https://agrometeo.mendoza.gov.ar/api/todas_instantaneas.json']] },
  { id: 'sanluis', pedidos: async () => [['mapa', 'https://clima.sanluis.gob.ar/InfoEstaciones.aspx']] },
  { id: 'bcp', pedidos: async () => [['mapa', 'https://info.bcp.org.ar/Estaciones/MapaG_NvoBCP.asp']] },
  // Entre Ríos, Dirección de Hidráulica: el archivo de la consola de cada estación automática (20, pocas activas).
  { id: 'entrerios', pedidos: async () => ['basavilbaso', 'bovril', 'ceibas', 'curuguay', 'concordia', 'feliciano', 'racedo',
      'gualeguay', 'gualeguaychu', 'lapaz', 'larroque', 'loscharruas', 'macia', 'parana', 'sanjose', 'sansalvador',
      'sauceluna', 'urdinarrain', 'villaparanacito', 'villaguay'].map((e) => [e, `https://www.hidraulica.gob.ar/ema/ema-${e}/downld08.txt`]) },
  // INA, sistema de alerta (a5): el listado de series meteorológicas (temp 53, viento 55, dirección 57, HR 58,
  // presión 60, lluvia diaria 1) y las observaciones de las últimas 6 h, de a 150 series por pedido.
  { id: 'ina', pedidos: async () => {
      const B = 'https://alerta.ina.gob.ar/a5/obs/puntual/';
      const r = await fetch(B + 'series?format=json&var_id=53,55,57,58,60,1', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('series ' + r.status);
      const j = await r.json();
      const ids = (Array.isArray(j) ? j : (j.rows || j.series || [])).map((s) => s.id).filter((x) => x != null);
      const hasta = new Date(), desde = new Date(hasta.getTime() - 6 * 3600e3);
      const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
      const pedidos = [['series', B + 'series?format=json&var_id=53,55,57,58,60,1']];
      for (let i = 0; i < ids.length; i += 150) pedidos.push(['obs_' + (i / 150), `${B}observaciones?tipo=puntual&series_id=${ids.slice(i, i + 150).join(',')}&timestart=${iso(desde)}&timeend=${iso(hasta)}`]);
      return pedidos;
    } },
];
async function redes() {
  for (const red of REDES) {
    if (await frenada(red.id)) { resumen[red.id] = 'FRENADA'; continue; }
    try {
      const lista = await red.pedidos();
      const partes = {}; let corte = false;
      for (const [nombre, url] of lista) {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(90000) });
        if (r.status === 403 || r.status === 429 || r.status >= 500) { corte = true; break; }
        partes[nombre] = { status: r.status, tipo: r.headers.get('content-type'), cuerpo: await r.text() };
        await dormir(PASO_MS);
      }
      if (Object.keys(partes).length) await r2.escribir(`${PREF}${red.id}/${dia}/${hora}.json`, JSON.stringify({ leido: ahora.toISOString(), partes }));
      await marcaCorte(red.id, corte);
      resumen[red.id] = corte ? 'corte' : Object.fromEntries(Object.entries(partes).map(([k, v]) => [k, `${v.status} · ${Math.round(v.cuerpo.length / 1024)} KB`]));
    } catch (e) { resumen[red.id] = 'error'; }
    await dormir(PASO_MS);
  }
}

// Una ronda por hora UTC: si esta hora ya se hizo (otra corrida de la cadena o el cron de respaldo), no se repite.
const kHecha = `${PREF}_rondas/${ahora.toISOString().slice(0, 13)}.json`;
if (await r2.leer(kHecha)) { console.log(JSON.stringify({ ya_hecha: ahora.toISOString().slice(0, 13) })); process.exit(0); }
await r2.escribir(kHecha, JSON.stringify({ empezo: ahora.toISOString() }));
await weathercloud();
await redes();
await weatherlink();
resumen.minutos = Math.round((Date.now() - t0) / 60000);
await r2.escribir(kHecha, JSON.stringify({ empezo: ahora.toISOString(), resumen }));
console.log(JSON.stringify(resumen));
