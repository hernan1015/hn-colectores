// HN AGRO · [r79 · 10] TODO EL LITORAL · sube lo que dejó litoral.py. Ver crecidas-litoral/LEEME.md.
// Variables: CRECIDAS_LITORAL_ON (sólo «si» hace algo), MODO (real | seco), LITORAL_SALIDA (la carpeta de litoral.py),
// LITORAL_CARPETA (el «depósito» del modo seco: una carpeta local), PRECOCIDO_DEPOSITO (satchi-slider por defecto),
// R2_OPERA_CUENTA · R2_OPERA_ACCESS_KEY_ID · R2_OPERA_SECRET_ACCESS_KEY (las del depósito público; nunca se imprimen).
// El registro de Actions es PÚBLICO: sólo cantidades y, si falla, una categoría fija.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { almacenCarpeta, almacenR2 } from '../rayos-hora/lib/almacen.mjs';
import { subir, categoriaError } from './lib/subir.mjs';

export function archivosDe(carpeta) {
  const out = [];
  const r = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), q = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) r(p, q); else if (e.name.endsWith('.png')) out.push({ ruta: q, leer: () => fs.readFileSync(p) });
    }
  };
  r(carpeta, '');
  return out.sort((a, b) => (a.ruta < b.ruta ? -1 : 1));
}

export async function principal({ env = process.env, almacen, log = console.log, logError = console.error, ahoraMs } = {}) {
  if (env.CRECIDAS_LITORAL_ON !== 'si') { log('crecidas-litoral: llave apagada, nada que hacer'); return 0; }
  const seco = env.MODO !== 'real';
  if (!almacen) {
    if (seco) {
      if (!env.LITORAL_CARPETA) { logError('crecidas-litoral: falló (error:interno) · modo seco sin LITORAL_CARPETA'); return 1; }
      almacen = almacenCarpeta(env.LITORAL_CARPETA);
    } else if (env.R2_OPERA_CUENTA && env.R2_OPERA_ACCESS_KEY_ID && env.R2_OPERA_SECRET_ACCESS_KEY) {
      almacen = almacenR2({ cuenta: env.R2_OPERA_CUENTA, clave: env.R2_OPERA_ACCESS_KEY_ID, secreto: env.R2_OPERA_SECRET_ACCESS_KEY, deposito: env.PRECOCIDO_DEPOSITO || 'satchi-slider' });
    } else { logError('crecidas-litoral: falló (error:interno) · faltan las llaves del depósito'); return 1; }
  }
  try {
    const sal = env.LITORAL_SALIDA;
    if (!sal || !fs.existsSync(path.join(sal, 'indice.json'))) { log('crecidas-litoral: sin salida de litoral.py (sin cambios o no corrió), nada que subir'); return 0; }
    const indice = JSON.parse(fs.readFileSync(path.join(sal, 'indice.json'), 'utf8'));
    const r = await subir({ almacen, indice, archivos: archivosDe(sal), log: (m) => log('crecidas-litoral: ' + m), ...(ahoraMs ? { ahoraMs } : {}) });
    log('crecidas-litoral: listo · ' + (seco ? 'seco' : 'real') + ' · ' + r.teselas + ' teselas · ' + (r.bytes / 1e6).toFixed(2) + ' MB');
    return 0;
  } catch (e) {
    logError('crecidas-litoral: falló (' + categoriaError(e) + ')');
    return 1;
  }
}
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) process.exitCode = await principal();
