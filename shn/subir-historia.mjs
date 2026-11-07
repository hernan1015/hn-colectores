#!/usr/bin/env node
// HN AGRO · sube UNA VEZ la carpeta datos/ del colector de la PC a R2, bajo el prefijo shn/ (misma estructura).
// No pisa nada: lo que ya existe en R2 se deja como está y se lista aparte.
// Con --fusionar, los archivos de texto que ya existen se UNEN (no se reemplazan):
//   horario/*.csv  por hora (si las dos versiones tienen el dato, queda el de R2);
//   *.jsonl        unión de renglones (primero los de R2);
//   otros .csv/.txt/.log  encabezado + unión de renglones, ordenados.
// Lo demás que ya existe (SVG, HTML, JSON) no se toca nunca.
//
// Uso (con R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET en el entorno):
//   node shn/subir-historia.mjs <carpeta datos> --probar          muestra qué haría, sin escribir nada
//   node shn/subir-historia.mjs <carpeta datos> [--fusionar] [--lista archivo.txt]
// Prueba local sin R2: --destino DIR (escribe en una carpeta en vez de R2).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { almacenCarpeta, almacenDesdeEntorno } from './lib/almacen.mjs';
import { parseHorario, textoHorario, fusionarHorario } from './lib/colector.mjs';

// La PC guardaba las alertas en alertas/alertas.txt; en R2 van en shn/alertas.txt. El candado no se sube.
export function claveDestino(rel) {
  if (rel === 'alertas/alertas.txt') return 'alertas.txt';
  if (rel === '.candado' || rel.endsWith('.tmp') || /\.tmp\d+$/.test(rel)) return null;
  return rel;
}

export function fusionarTexto(clave, enR2, local) {
  if (/^horario\/[A-Z]+\.csv$/.test(clave)) return textoHorario(fusionarHorario(parseHorario(enR2), parseHorario(local)));
  const a = enR2.split('\n').filter((l) => l.trim());
  const b = local.split('\n').filter((l) => l.trim());
  if (clave.endsWith('.jsonl')) {
    const ya = new Set(a);
    return [...a, ...b.filter((l) => !ya.has(l))].join('\n') + '\n';
  }
  if (/\.(csv|txt|log)$/.test(clave)) {
    const conCab = clave.endsWith('.csv');
    const cab = conCab ? (a[0] ?? b[0]) : null;
    const cuerpo = new Set([...(conCab ? a.slice(1) : a), ...(conCab ? b.slice(1) : b)]);
    return (conCab ? [cab] : []).concat([...cuerpo].sort()).join('\n') + '\n';
  }
  return null; // no fusionable
}

function archivos(raiz) {
  const out = [];
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p); else out.push(path.relative(raiz, p).split(path.sep).join('/'));
    }
  };
  recorrer(raiz);
  return out.sort();
}

export async function subir({ origen, almacen, probar = false, fusionar = false, salida = console.log }) {
  const yaEnR2 = new Set(await almacen.listar(''));
  const r = { subidos: [], fusionados: [], omitidos: [], ignorados: [] };
  for (const rel of archivos(origen)) {
    const clave = claveDestino(rel);
    if (!clave) { r.ignorados.push(rel); continue; }
    const cuerpo = fs.readFileSync(path.join(origen, ...rel.split('/')));
    if (!yaEnR2.has(clave)) {
      if (!probar) {
        const ok = await almacen.escribir(clave, cuerpo, { soloSiNoExiste: true });
        if (!ok) { r.omitidos.push(clave); continue; } // apareció entre la lista y la escritura
      }
      r.subidos.push(clave); continue;
    }
    if (fusionar) {
      const actual = (await almacen.leer(clave))?.toString('utf8') ?? '';
      const nuevo = fusionarTexto(clave, actual, cuerpo.toString('utf8'));
      if (nuevo != null) {
        if (nuevo !== actual) { if (!probar) await almacen.escribir(clave, nuevo); r.fusionados.push(clave); } else r.omitidos.push(clave);
        continue;
      }
    }
    r.omitidos.push(clave);
  }
  salida(`${probar ? '(prueba, no se escribió nada) ' : ''}subidos ${r.subidos.length}, fusionados ${r.fusionados.length}, ya existían sin tocar ${r.omitidos.length}, ignorados ${r.ignorados.length}`);
  return r;
}

// ---------- línea de comandos ----------
const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esPrincipal) {
  const a = process.argv.slice(2);
  const o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); if (i + 1 < a.length && !a[i + 1].startsWith('--')) o[k] = a[++i]; else o[k] = true; } else o._.push(a[i]);
  }
  const origen = o._[0];
  if (!origen || !fs.existsSync(origen) || !fs.statSync(origen).isDirectory()) {
    console.log('Uso: node shn/subir-historia.mjs <carpeta datos> [--probar] [--fusionar] [--lista archivo.txt] [--destino DIR]');
    process.exit(2);
  }
  let almacen;
  try { almacen = typeof o.destino === 'string' ? almacenCarpeta(o.destino) : almacenDesdeEntorno({ env: { ...process.env, SHN_CARPETA: '' } }); } catch (e) { console.log(e.message); process.exit(2); }
  const t0 = Date.now();
  const r = await subir({ origen, almacen, probar: !!o.probar, fusionar: !!o.fusionar });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
  const lista = [
    `# subida de la historia a ${almacen.tipo} · ${new Date().toISOString()}${o.probar ? ' · PRUEBA (no se escribió nada)' : ''}`,
    ...r.subidos.map((k) => `subido      ${k}`),
    ...r.fusionados.map((k) => `fusionado   ${k}`),
    ...r.omitidos.map((k) => `ya existía  ${k}`),
    ...r.ignorados.map((k) => `ignorado    ${k}`),
  ].join('\n') + '\n';
  const archivoLista = typeof o.lista === 'string' ? o.lista : `subida-historia-${stamp}.txt`;
  fs.writeFileSync(archivoLista, lista);
  if (!o.probar) await almacen.escribir(`log/subida-historia-${stamp}.txt`, lista);
  console.log(`lista: ${archivoLista}${o.probar ? '' : ` (y en log/subida-historia-${stamp}.txt del almacén)`} · ${Math.round((Date.now() - t0) / 1000)} s`);
  if (r.omitidos.length && !o.fusionar) console.log('Hay archivos que ya existían (seguramente de corridas del colector en la nube). Para unirlos sin perder nada: volver a correr con --fusionar.');
}
