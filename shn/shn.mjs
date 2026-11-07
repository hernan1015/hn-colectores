#!/usr/bin/env node
// HN AGRO · colector del SHN (uso interno; los datos van a R2 privado, nunca a este repo). Node >= 18, sin dependencias.
// Uso:  node shn/shn.mjs <horario|modelo|pronostico|referencia|chequeo> [opciones]   (ver shn/LEEME.md)
//   --estacion SFER,MAGA   --maxatras 72   --dias 3   --pausa 6 (segundos)   --forzar (ignora un bloqueo anotado)
//   --carpeta DIR          prueba local: guarda en DIR en vez de R2 (también SHN_CARPETA)
import { almacenDesdeEntorno } from './lib/almacen.mjs';
import { crearContexto, correr, MODOS } from './lib/colector.mjs';
import fs from 'node:fs';

function args(a) {
  const o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      if (i + 1 < a.length && !a[i + 1].startsWith('--')) o[k] = a[++i]; else o[k] = true;
    } else o._.push(a[i]);
  }
  return o;
}

const o = args(process.argv.slice(2));
const modo = o._[0];
if (!MODOS[modo]) {
  console.log('Uso: node shn/shn.mjs <horario|modelo|pronostico|referencia|chequeo> [--estacion SFER,MAGA] [--maxatras 72] [--dias 3] [--pausa 6] [--forzar] [--carpeta DIR]');
  process.exit(2);
}
if (o.forzar === 'false' || o.forzar === '') delete o.forzar;
let almacen;
try { almacen = almacenDesdeEntorno({ carpeta: typeof o.carpeta === 'string' ? o.carpeta : undefined }); } catch (e) { console.log(e.message); process.exit(2); }

const lineas = [];
const ctx = crearContexto({ almacen, salida: (m) => { console.log(m); lineas.push(m); } });
if (o.pausa) ctx.pausaBaseMs = Math.max(2000, Number(o.pausa) * 1000);
console.log(`almacén: ${almacen.tipo}`);
const codigo = await correr(ctx, modo, o);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### SHN · ${modo}\n` + lineas.map((l) => `- ${l}`).join('\n') + '\n');
}
process.exitCode = codigo;
