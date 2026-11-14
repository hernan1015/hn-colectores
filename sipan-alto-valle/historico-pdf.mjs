#!/usr/bin/env node
// HN AGRO · el histórico del SIPAN (resúmenes mensuales en PDF, de 2018 en adelante) · SÓLO PARA MEDIR, uso interno.
// ⛔ NO es una descarga masiva: corre a mano, en la corrida nocturna que el maker aprueba ESA noche, con una lista
//    explícita de direcciones (una por renglón) que se arma antes mirando la página del SIPAN. Nada desde 1970.
//    Los PDF quedan en la carpeta de salida (fuera de este repo público); no se suben a ningún lado.
//
//   node sipan-alto-valle/historico-pdf.mjs <lista.txt> <carpeta_salida> [--tope 12]
//
// Reglas: de a un pedido, 30 s entre pedidos (el mismo pedidor del colector), tope de 12 por corrida (se puede bajar,
// no subir de 24), sólo direcciones de sipan.inta.gob.ar, sólo años ≥ 2018 en la dirección, no se vuelve a bajar lo que
// ya está en la carpeta, y ante corte/403/429/5xx se para. Leer las tablas de los PDF es el paso siguiente, cuando haya
// un PDF de muestra para ver el formato (pdftotext; OCR si son imagen).
import fs from 'node:fs';
import path from 'node:path';
import { crearPedidor } from './sipan.mjs';

export const TOPE_MAX = 24;

export function filtrarLista(texto, yaBajados = new Set()) {
  const out = []; const rechazos = [];
  for (const l of String(texto).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))) {
    let u; try { u = new URL(l); } catch { rechazos.push({ l, motivo: 'no es una URL' }); continue; }
    if (u.protocol !== 'https:' || u.hostname !== 'sipan.inta.gob.ar') { rechazos.push({ l, motivo: 'no es sipan.inta.gob.ar' }); continue; }
    if (!/\.pdf$/i.test(u.pathname)) { rechazos.push({ l, motivo: 'no es un PDF' }); continue; }
    const anios = (u.pathname.match(/(?:19|20)\d\d/g) || []).map(Number);
    if (!anios.length || Math.max(...anios) < 2018) { rechazos.push({ l, motivo: 'sin año ≥ 2018 en la dirección' }); continue; }
    const nombre = path.basename(u.pathname);
    if (yaBajados.has(nombre)) { rechazos.push({ l, motivo: 'ya bajado' }); continue; }
    out.push({ url: u.href, nombre });
  }
  return { lista: [...new Map(out.map((x) => [x.nombre, x])).values()], rechazos };
}

const esPrincipal = !!process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (esPrincipal) {
  const [listaArch, salida] = process.argv.slice(2);
  const i = process.argv.indexOf('--tope');
  const tope = Math.min(TOPE_MAX, i > 0 ? +process.argv[i + 1] : 12);
  if (!listaArch || !salida) { console.error('uso: node historico-pdf.mjs <lista.txt> <carpeta_salida> [--tope 12]'); process.exit(2); }
  fs.mkdirSync(salida, { recursive: true });
  const { lista, rechazos } = filtrarLista(fs.readFileSync(listaArch, 'utf8'), new Set(fs.readdirSync(salida)));
  const ped = crearPedidor({ tope });
  let ok = 0;
  for (const x of lista) {
    const r = await ped.pedir(x.url);
    if (r.estado === 'ok') { fs.writeFileSync(path.join(salida, x.nombre), Buffer.from(r.texto, 'latin1')); ok++; }
    if (r.estado === 'cortado' || r.estado === 'tope') break;
  }
  console.log(JSON.stringify({ pedidos: ped.pedidos, bajados: ok, en_lista: lista.length, rechazados: rechazos.length, cortado: ped.cortado }));
}
