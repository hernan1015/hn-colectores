#!/usr/bin/env node
// HN AGRO · [_v1815 · la 262] RELLENO DE UNA VEZ: copia al depósito público de SATCHI (satchi-mapas) el derivado liviano de
// las horas que ya están en la caché privada (rayos-hora/AAAA/MM/DD/HH.json). Ver lib/publico.mjs y LEEME.md.
// Idempotente: lo que el índice público ya tiene (con el mismo estado y la misma firma) no se vuelve a escribir. No baja nada de NOAA.
//
// env: R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET   (la caché privada, sólo se LEE)
//      R2_OPERA_CUENTA · R2_OPERA_ACCESS_KEY_ID · R2_OPERA_SECRET_ACCESS_KEY  (el público, satchi-mapas: se escribe rayos/)
//      DESDE / HASTA (UTC, AAAA-MM-DD o AAAA-MM-DDTHH; por defecto, del 08/11/2026 01 UTC a la última hora cerrada)
//      ALMACEN_CARPETA / PUBLICO_CARPETA (sólo para probar a mano, en carpetas)
import fs from 'node:fs';
import { almacenCarpeta, almacenR2 } from './lib/almacen.mjs';
import { parsearHora, ultimaCerrada } from './lib/cache.mjs';
import { copiarAPublico, DEPOSITO_PUB, textoError } from './lib/publico.mjs';

const env = process.env;
const privado = env.ALMACEN_CARPETA ? almacenCarpeta(env.ALMACEN_CARPETA)
  : almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET });
const publico = env.PUBLICO_CARPETA ? almacenCarpeta(env.PUBLICO_CARPETA)
  : almacenR2({ cuenta: env.R2_OPERA_CUENTA, clave: env.R2_OPERA_ACCESS_KEY_ID, secreto: env.R2_OPERA_SECRET_ACCESS_KEY, deposito: DEPOSITO_PUB });
const desdeMs = env.DESDE ? parsearHora(env.DESDE) : Date.UTC(2026, 10, 8, 1);
const hastaMs = Math.min(env.HASTA ? parsearHora(env.HASTA, true) : Infinity, ultimaCerrada(Date.now()));
try {
  const r = await copiarAPublico({ privado, publico, desdeMs, hastaMs, log: (s) => console.log(s) });
  const linea = `### Rayos al depósito público · ${r.copiadas} copiadas, ${r.ya} ya estaban, ${r.ilegibles} ilegibles (de ${r.privadas}) · ${r.movidos} flashes a su hora, ${r.fuera} de borde sin su hora`;
  console.log(linea);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, linea + '\n');
} catch (e) {
  console.error('FALLÓ LA COPIA: ' + textoError(e));   // [2.ª vuelta] sin URLs ni tiras largas
  process.exit(1);
}
