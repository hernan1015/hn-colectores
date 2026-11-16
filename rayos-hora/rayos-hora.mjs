#!/usr/bin/env node
// HN AGRO · caché horaria de rayos GLM (GOES) recortada a la Argentina, en R2 · 6/11/2026. Ver LEEME.md.
// Cada corrida: toma el candado, mira qué horas UTC cerradas de las últimas 48 h faltan (o están incompletas y
// vale reintentar), baja los 180 archivos de 20 s de cada una del bucket público de NOAA, se queda con los
// flashes dentro de la caja Argentina y sube rayos-hora/AAAA/MM/DD/HH.json. Los registros muestran sólo cantidades.
//
// env: R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET (secrets del repo)
//      DESDE / HASTA (opcionales, UTC: AAAA-MM-DD o AAAA-MM-DDTHH) · MAX_HORAS (tope por corrida, 48)
//      ALMACEN_CARPETA (sólo para probar a mano: guarda en esa carpeta en vez de R2)
//      [_v1815] R2_OPERA_CUENTA · R2_OPERA_ACCESS_KEY_ID · R2_OPERA_SECRET_ACCESS_KEY: el depósito PÚBLICO de SATCHI
//      (satchi-mapas). Con ellas, al final se copia el derivado liviano de las últimas 48 h (lib/publico.mjs). Sin ellas, no.
//      PUBLICO_CARPETA (sólo para probar a mano: el «público» en esa carpeta)
import fs from 'node:fs';
import { almacenCarpeta, almacenR2 } from './lib/almacen.mjs';
import { correr, parsearHora, ultimaCerrada, VENTANA_H, HORA } from './lib/cache.mjs';
import { copiarAPublico, DEPOSITO_PUB, textoError } from './lib/publico.mjs';

const env = process.env;
const almacen = env.ALMACEN_CARPETA
  ? almacenCarpeta(env.ALMACEN_CARPETA)
  : almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET });

const desdeMs = env.DESDE ? parsearHora(env.DESDE) : null;
const hastaMs = env.HASTA ? parsearHora(env.HASTA, true) : null;
const maxHoras = Math.max(1, Math.min(200, Number(env.MAX_HORAS) || 48));
const dueno = `${env.GITHUB_RUN_ID || 'local'}-${env.GITHUB_RUN_ATTEMPT || '1'}-${process.pid}`;

const t0 = Date.now();
let res;
try {
  res = await correr({ almacen, desdeMs, hastaMs, maxHoras, dueno, log: (s) => console.log(s) });
} catch (e) {
  // R2 (o algo nuestro) falló: la corrida queda en ROJO para que se vea
  console.error('FALLÓ LA CORRIDA: ' + String(e?.message || e).slice(0, 200));
  process.exit(1);
}
const resumen = [
  `### Rayos GLM por hora · ${new Date().toISOString().slice(0, 16)}Z`,
  `- horas pendientes: **${res.pendientes}** · procesadas: **${res.procesadas}** (completas ${res.completas}, incompletas ${res.incompletas})`,
  `- flashes en la caja Argentina: ${res.flashes} · bajado de NOAA: ${(res.bytes / 1e6).toFixed(0)} MB · ${Math.round((Date.now() - t0) / 1000)} s`,
  res.alertas ? `- alertas anotadas en rayos-hora/alertas.txt: **${res.alertas}**` : '- sin alertas',
  res.cortada ? `- corrida cortada: ${res.cortada}` : '',
].filter(Boolean).join('\n');
console.log(resumen);
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, resumen + '\n');

// [_v1815 · la 262] el derivado público para SATCHI (rayos/AAAA-MM-DD/HH.json + rayos/indice.json). Si falla, ROJO:
// la caché privada ya quedó guardada y la próxima corrida vuelve a copiar lo que falte (mira el índice, no la hora).
const pub = env.PUBLICO_CARPETA ? almacenCarpeta(env.PUBLICO_CARPETA)
  : (env.R2_OPERA_CUENTA && env.R2_OPERA_ACCESS_KEY_ID && env.R2_OPERA_SECRET_ACCESS_KEY)
    ? almacenR2({ cuenta: env.R2_OPERA_CUENTA, clave: env.R2_OPERA_ACCESS_KEY_ID, secreto: env.R2_OPERA_SECRET_ACCESS_KEY, deposito: DEPOSITO_PUB })
    : null;
if (!pub) console.log('público: sin las llaves R2_OPERA_* (no copio a satchi-mapas)');
else if (res.candado) {   // sin candado (otra corrida trabajando) no se copia: lo hace la otra
  const hasta = ultimaCerrada(Date.now());
  try { await copiarAPublico({ privado: almacen, publico: pub, desdeMs: hasta - (VENTANA_H - 1) * HORA, hastaMs: hasta, log: (s) => console.log(s) }); }
  catch (e) { console.error('FALLÓ LA COPIA AL PÚBLICO: ' + textoError(e)); process.exit(1); }   // [2.ª vuelta] sin URLs ni tiras largas
}
