// HN AGRO · [r77] las teselas de SATCHI ya reproyectadas (GeoColor, visible, GREMLIN) en el depósito PÚBLICO. Ver gremlin/LEEME-precocido.md.
// Variables: PRECOCIDO_ON (sólo «si» hace algo), MODO (real | seco), TOPE (pedidos a SLIDER por corrida, 20 a 400; 120 por defecto),
// RETENCION_H (horas que se guardan, 1 a 24; 6 por defecto), PRECOCIDO_DEPOSITO (el depósito público; «satchi-slider» por defecto),
// R2_OPERA_CUENTA · R2_OPERA_ACCESS_KEY_ID · R2_OPERA_SECRET_ACCESS_KEY (las del depósito público de SATCHI; nunca se imprimen)
// o PUBLICO_CARPETA=/una/carpeta para probar SIN R2 (la llave seca: escribe en esa carpeta y nada más).
// [r79 · 1-bis] PRECOCIDO_CUADROS (todo menos «no»): además, el cuadro entero WebP (z4, z5) y las metateselas de 1024 px sobre la Argentina;
// con ellos el tope por defecto es TOPE_CUADROS (300). «no»: exactamente la r77. Ver gremlin/LEEME-precocido.md.
// [Codex n3-r77-colector · 3] El registro de Actions es PÚBLICO: se imprimen sólo cantidades y, si algo falla, UNA CATEGORÍA FIJA
// (error:almacen, error:red, error:interno) y el código HTTP numérico si lo hay. NUNCA el mensaje del error (puede traer una URL firmada,
// una cabecera o un secreto). Si falla el depósito, sale con error (corrida en rojo); si falla SLIDER, sigue con lo que pueda y sale bien.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { almacenCarpeta, almacenR2 } from '../rayos-hora/lib/almacen.mjs';
import { correr, categoriaError, TOPE_CUADROS } from './lib/precocido.mjs';

export async function principal({ env = process.env, almacen, fetchFn, log = console.log, logError = console.error } = {}) {
  const DEPOSITO = String(env.PRECOCIDO_DEPOSITO || 'satchi-slider').trim();
  if (!almacen) {
    if (env.PUBLICO_CARPETA) almacen = almacenCarpeta(env.PUBLICO_CARPETA);
    else if (env.PRECOCIDO_ON === 'si' && env.R2_OPERA_CUENTA && env.R2_OPERA_ACCESS_KEY_ID && env.R2_OPERA_SECRET_ACCESS_KEY) {
      almacen = almacenR2({ cuenta: env.R2_OPERA_CUENTA, clave: env.R2_OPERA_ACCESS_KEY_ID, secreto: env.R2_OPERA_SECRET_ACCESS_KEY, deposito: DEPOSITO });
    }
  }
  /* el almacén marca sus errores: así se clasifican como error:almacen aunque el mensaje no lo diga */
  const marcado = almacen && Object.fromEntries(['leer', 'escribir', 'borrar', 'listar'].filter((k) => typeof almacen[k] === 'function')
    .map((k) => [k, (...a) => Promise.resolve().then(() => almacen[k](...a)).catch((e) => { try { e.almacen = true; } catch { /* */ } throw e; })]));
  /* [r79 · 1-bis] los cuadros enteros y las metateselas WebP: prendidos salvo PRECOCIDO_CUADROS=no (el rollback: la r77 tal cual).
     El codificador (sharp) se carga sólo si hace falta: con la llave apagada no se toca ninguna dependencia. */
  const cuadros = env.PRECOCIDO_ON === 'si' && env.PRECOCIDO_CUADROS !== 'no';
  const tope = env.TOPE || (cuadros ? String(TOPE_CUADROS) : undefined);
  try {
    const codificarWebp = cuadros ? (await import('./webp.mjs')).codificarWebp : null;
    await correr({ almacen: marcado ? { ...almacen, ...marcado } : almacen, llave: env.PRECOCIDO_ON, modo: env.MODO === 'seco' ? 'seco' : 'real', tope, retencionH: env.RETENCION_H, cuadros, codificarWebp, ...(fetchFn ? { fetchFn } : {}), log });
    return 0;
  } catch (e) {
    logError('precocido: falló (' + categoriaError(e) + ')');
    return 1;
  }
}
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) process.exitCode = await principal();
