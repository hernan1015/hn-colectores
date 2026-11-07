// Respuestas de MUESTRA armadas a mano (no son datos del SHN) y un reloj falso para los tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { almacenCarpeta } from '../lib/almacen.mjs';
import { crearContexto, URL_API, URL_SVG, URL_PRONO, URL_AVISO, URL_TABLA } from '../lib/colector.mjs';

export const AHORA = Date.parse('2026-11-06T18:00:00Z'); // 15:00 hora argentina

export function carpetaTemporal() { return fs.mkdtempSync(path.join(os.tmpdir(), 'shn-test-')); }

const p2 = (n) => String(n).padStart(2, '0');
const fechaLocal = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:45:00`;
// altura ficticia, determinística por hora
const altura = (d, base) => Number((base + ((d.getTime() / 3600e3) % 7) / 10).toFixed(2));

// Ventana de la API: 13 lecturas que terminan en la hora pedida + astronómica de -12 h a +8 h.
export function ventanaMuestra(clave, { sinLecturas = false } = {}) {
  const T = new Date(Date.UTC(+clave.slice(0, 4), +clave.slice(4, 6) - 1, +clave.slice(6, 8), +clave.slice(8, 10), 45));
  const lecturas = [], astronomica = [];
  for (let k = 12; k >= 0; k--) { const d = new Date(T - k * 3600e3); if (!sinLecturas) lecturas.push({ fecha: fechaLocal(d), altura: altura(d, 1) }); }
  for (let k = -12; k <= 8; k++) { const d = new Date(T.getTime() + k * 3600e3); astronomica.push({ fecha: fechaLocal(d), altura: altura(d, 0.9) }); }
  return { lecturas, astronomica, observaciones: '' };
}

export function svgMuestra(n = 97) {
  let s = '<svg xmlns="http://www.w3.org/2000/svg"><title>Altura total MUESTRA</title>';
  for (let i = 0; i < n; i++) s += `<g><desc class="x_label">0${1 + Math.floor(i / 24)}-11| ${p2(i % 24)}:00</desc><desc class="value">${(1 + i / 100).toFixed(2)}</desc></g>`;
  return s + '</svg>';
}
const HTML_PRONO = '<html><body>Compartir en redes sociales<p>' + 'Pronostico de MUESTRA para tests. '.repeat(10) + '</p></body></html>';
const HTML_TABLA = '<html><body><p>Nivel medio: 0,50 m</p><p>Las alturas estan referidas al plano de reduccion que se encuentra a 0,50 m debajo del nivel medio.</p></body></html>';

function respuesta(status, cuerpo = '', headers = {}) {
  return new Response(status === 204 ? null : cuerpo, { status, headers });
}

// SHN falso. `guion(url, n)` puede devolver un status para forzar fallas (n = número de pedido, desde 1).
export function shnFalso({ guion, lastModified = 'Fri, 06 Nov 2026 17:02:00 GMT', svgN = 97 } = {}) {
  const f = async (url, opts = {}) => {
    f.pedidos.push({ url, metodo: opts.method || 'GET' });
    const forzado = guion?.(url, f.pedidos.length);
    if (forzado) return respuesta(forzado, 'no');
    if (url.startsWith(URL_API)) return respuesta(200, JSON.stringify(ventanaMuestra(url.split('/').pop())), { 'content-type': 'application/json' });
    if (url.startsWith(URL_SVG)) return respuesta(200, svgMuestra(svgN), { 'last-modified': lastModified });
    if (url === URL_PRONO || url === URL_AVISO) return respuesta(200, HTML_PRONO);
    if (url === URL_TABLA) return respuesta(200, HTML_TABLA);
    return respuesta(404);
  };
  f.pedidos = [];
  return f;
}

// Contexto con carpeta temporal, reloj falso (dormir adelanta el reloj) y salida silenciosa.
export function contexto({ dir = carpetaTemporal(), fetchFn = shnFalso(), ahora = AHORA, ...resto } = {}) {
  const reloj = { t: ahora };
  const ctx = crearContexto({
    almacen: almacenCarpeta(dir), fetchFn, corrida: 'test',
    ahora: () => reloj.t, dormir: async (ms) => { reloj.t += ms; }, salida: () => {}, ...resto,
  });
  ctx.reloj = reloj; ctx.dir = dir;
  return ctx;
}
export const leer = (dir, clave) => { try { return fs.readFileSync(path.join(dir, ...clave.split('/')), 'utf8'); } catch { return null; } };
