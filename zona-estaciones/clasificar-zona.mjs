#!/usr/bin/env node
// HN AGRO · 257 · la ZONA de cada estación (agricola / pastizal / urbana / natural) por la cobertura del suelo en su
// punto, con ESA WorldCover 2021 v200 (10 m).
//
//   Fuente: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA
//   WorldCover consortium. Zanaga, D. et al. (2022). ESA WorldCover 10 m 2021 v200. doi:10.5281/zenodo.7254221.
//   Licencia CC BY 4.0. Se lee del bucket público de AWS (s3://esa-worldcover, por HTTPS), SIN cuenta.
//
// La regla está en lib/regla.mjs (r1: círculo de 250 m; urbana si construido ≥ 30 %; si no, el mayor de
// cultivo / pastizal / el resto).
//
// MODOS
//   Seco con un listado (pc-nanci, la tanda del 15/11):
//     node clasificar-zona.mjs --entrada datos/estaciones.csv --salida datos/zona-resultados.csv --cache cache/ventanas.json
//   Desde la base (Actions, workflow_dispatch; lee `estaciones` con el rol clasificador_zona):
//     ZONA_PG_URL=… ZONA_PG_CA=… node clasificar-zona.mjs --base [--todas] [--real] [--salida x.csv]
//     · ZONA_PG_CA (o ZONA_PG_CA_FILE) = la CA de Supabase en PEM: el TLS autentica al servidor; sin ella no conecta.
//     · sin --real NO escribe nada (seco): imprime cantidades.
//     · con --real escribe metadatos.zona y metadatos.zona_wc de cada estación (sólo esas dos claves).
//     · sin --todas toma sólo las que no tienen zona con esta regla para su coordenada actual (las nuevas o movidas).
//     · con --todas recalcula todas, pero la base NO reescribe las que dan igual (estaciones_fijar_zona devuelve false).
//   El registro sólo muestra cantidades (nada de nombres, ids ni coordenadas): el repo de Actions es público.
import fs from 'node:fs';
import path from 'node:path';
import { leerVentanas, RADIOS_M } from './lib/worldcover.mjs';
import { clasificar, porcentajes, REGLA, RADIO_REGLA_M, UMBRAL_URBANA, UMBRAL_COBERTURA, UMBRAL_MARGEN, CLASES, NOMBRE_CLASE, ZONAS } from './lib/regla.mjs';

export const FUENTE = 'ESA WorldCover 10 m 2021 v200';
export const CITA = '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. Zanaga et al. (2022), doi:10.5281/zenodo.7254221';
export const LICENCIA = 'CC BY 4.0';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const flag = (n) => args.includes(n);
const propio = (m) => Object.assign(new Error(m), { propio: true });
const log = (s) => process.stdout.write(s + '\n');

/** CSV simple con comillas. */
export function leerCsv(txt) {
  const filas = []; let campo = '', fila = [], q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"' && txt[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') q = false; else campo += c; }
    else if (c === '"') q = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...resto] = filas.filter((f) => f.length > 1 || f[0]);
  return resto.map((f) => Object.fromEntries(cab.map((k, j) => [k, f[j] ?? ''])));
}

const claveDe = (lat, lon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;
const soloConDato = (pct) => Object.fromEntries(Object.entries(pct).filter(([, v]) => v > 0));

/**
 * El detalle que va a metadatos.zona_wc.
 *   cobertura = % del círculo con dato, por radio (para mostrar; la decisión se toma con los conteos enteros).
 *   pct       = % de cada clase SOBRE LOS PÍXELES CON DATO; si la cobertura no es 100, `dudosa` lo dice.
 *   dudosa    = true si el margen es < 10 o la ventana no está entera; `dudosa_motivo` = ['margen', 'cobertura'].
 *   pixeles / pixeles_circulo = los conteos enteros del círculo de la regla (con dato / todos).
 */
export function detalle(v, lat, lon, ahora = new Date()) {
  const r = clasificar(v.conteos[RADIO_REGLA_M]);
  const pctDe = (radio) => soloConDato(porcentajes(v.conteos[radio]).pct);
  return {
    zona: r.zona,
    detalle: {
      regla: REGLA, radio_m: RADIO_REGLA_M, umbral_urbana_pct: UMBRAL_URBANA, umbral_cobertura_pct: UMBRAL_COBERTURA,
      umbral_margen: UMBRAL_MARGEN, margen: r.margen, dudosa: r.dudosa, dudosa_motivo: r.motivos, pixel: v.pixel ?? null,
      cobertura: Object.fromEntries(RADIOS_M.map((rad) => [String(rad), porcentajes(v.conteos[rad]).cobertura])),
      pct: Object.fromEntries(RADIOS_M.map((rad) => [String(rad), pctDe(rad)])),
      pixeles: r.total, pixeles_circulo: r.circulo, lat, lon, fuente: FUENTE, licencia: LICENCIA, cita: CITA,
      calculado_en: ahora.toISOString(),
    },
  };
}

function cacheEnDisco(ruta) {
  if (!ruta) return null;
  let datos = {};
  try { datos = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { /* vacío */ }
  return {
    get: (k) => datos[k],
    set: (k, v) => { datos[k] = v; },
    guardar: () => { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, JSON.stringify(datos)); },
  };
}

function contarBytes() {
  const orig = globalThis.fetch;
  const c = { pedidos: 0, bytes: 0 };
  globalThis.fetch = async (...a) => {
    const r = await orig(...a);
    c.pedidos++;
    const n = Number(r.headers.get('content-length'));
    if (Number.isFinite(n)) c.bytes += n;
    return r;
  };
  return c;
}

export function filaCsv(e, z) {
  const q = (s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? '');
  const d = z.detalle;
  const cols = [e.red, e.estacion_id, e.nombre ?? '', e.lat.toFixed(6), e.lon.toFixed(6), z.zona, d.margen ?? '', d.dudosa ? 'si' : 'no',
    d.dudosa_motivo.join('+'), d.cobertura[String(RADIO_REGLA_M)], d.pixel ?? '', d.pixeles];
  for (const rad of RADIOS_M) for (const c of CLASES) cols.push(d.pct[String(rad)][c] ?? 0);
  return cols.map(q).join(',');
}
export const CABECERA_CSV = ['red', 'estacion_id', 'nombre', 'lat', 'lon', 'zona', 'margen', 'dudosa', 'dudosa_motivo', 'cobertura_250m', 'pixel', 'pixeles_250m',
  ...RADIOS_M.flatMap((rad) => CLASES.map((c) => `p${rad}_${NOMBRE_CLASE[c]}`))].join(',');

async function main() {
  const real = flag('--real');
  let estaciones, base = null;
  if (flag('--base')) {
    const url = process.env.ZONA_PG_URL;
    if (!url) throw propio('falta ZONA_PG_URL');
    const { conectar } = await import('./lib/base.mjs');
    base = await conectar(url);
    estaciones = (await base.pendientes(REGLA, flag('--todas'))).map((e) => ({ ...e, lat: Number(e.lat), lon: Number(e.lon) }));
  } else {
    const entrada = arg('--entrada');
    if (!entrada) throw propio('uso: --entrada listado.csv | --base');
    if (real) throw propio('--real sólo con --base');
    estaciones = leerCsv(fs.readFileSync(entrada, 'utf8')).map((e) => ({ ...e, lat: Number(e.lat), lon: Number(e.lon) }));
  }
  estaciones = estaciones.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon) && Math.abs(e.lat) <= 90 && Math.abs(e.lon) <= 180);
  log(`estaciones: ${estaciones.length} · modo ${real ? 'REAL (escribe metadatos)' : 'seco'}`);
  const cache = cacheEnDisco(arg('--cache'));
  const red = contarBytes();
  const puntos = [...new Map(estaciones.map((e) => [claveDe(e.lat, e.lon), { clave: claveDe(e.lat, e.lon), lat: e.lat, lon: e.lon }])).values()];
  const vent = await leerVentanas(puntos, { cache, log, pausaTileMs: Number(arg('--pausa-ms') ?? 2000) });
  cache?.guardar();
  log(`bajada: ${red.pedidos} pedidos HTTP, ${(red.bytes / 1048576).toFixed(1)} MB`);

  const ahora = new Date();
  const resumen = {};
  const salida = arg('--salida');
  const lineas = salida ? [CABECERA_CSV] : null;
  let escritas = 0, iguales = 0, dudosas = 0;
  for (const e of estaciones) {
    const z = detalle(vent.get(claveDe(e.lat, e.lon)), e.lat, e.lon, ahora);
    resumen[e.red] ??= Object.fromEntries(ZONAS.map((k) => [k, 0]));
    resumen[e.red][z.zona]++;
    if (z.detalle.dudosa) dudosas++;
    lineas?.push(filaCsv(e, z));
    // con --todas se recalcula todo, pero la función NO reescribe lo que no cambió (devuelve false)
    if (real) { if (await base.fijar(e.red, e.estacion_id, z.zona, z.detalle)) escritas++; else iguales++; }
  }
  if (salida) { fs.mkdirSync(path.dirname(path.resolve(salida)), { recursive: true }); fs.writeFileSync(salida, lineas.join('\n') + '\n'); }
  for (const [r, z] of Object.entries(resumen)) log(`${r}: ${ZONAS.map((k) => `${k} ${z[k]}`).join(' · ')}`);
  log(`dudosas: ${dudosas}`);
  log(`escritas en la base: ${escritas} · sin cambio (no se reescriben): ${iguales}`);
  await base?.cerrar();
}

const esMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// Sólo los mensajes nuestros salen al log público (el de Actions es público); de un error ajeno, sólo su tipo.
export const mensajeError = (e) => (e?.propio ? String(e.message).slice(0, 200) : `error inesperado (${String(e?.name || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40)})`);
if (esMain) main().catch((e) => { process.stderr.write(`error: ${mensajeError(e)}\n`); process.exit(1); });
