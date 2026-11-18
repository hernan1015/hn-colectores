// HN AGRO · [r77] las teselas de SATCHI ya reproyectadas (GeoColor, visible, GREMLIN) en el depósito PÚBLICO. Ver gremlin/LEEME-precocido.md.
// Variables: PRECOCIDO_ON (sólo «si» hace algo), MODO (real | seco), TOPE (pedidos a SLIDER por corrida, 20 a 400; 120 por defecto),
// RETENCION_H (horas que se guardan, 1 a 24; 6 por defecto), PRECOCIDO_DEPOSITO (el depósito público; «satchi-slider» por defecto),
// R2_OPERA_CUENTA · R2_OPERA_ACCESS_KEY_ID · R2_OPERA_SECRET_ACCESS_KEY (las del depósito público de SATCHI; nunca se imprimen)
// o PUBLICO_CARPETA=/una/carpeta para probar SIN R2 (la llave seca: escribe en esa carpeta y nada más).
// Imprime sólo cantidades. Si falla el depósito, sale con error (corrida en rojo); si falla SLIDER, sigue con lo que pueda y sale bien.
import { almacenCarpeta, almacenR2 } from '../rayos-hora/lib/almacen.mjs';
import { correr } from './lib/precocido.mjs';

const env = process.env;
const DEPOSITO = String(env.PRECOCIDO_DEPOSITO || 'satchi-slider').trim();
let almacen = null;
if (env.PUBLICO_CARPETA) almacen = almacenCarpeta(env.PUBLICO_CARPETA);
else if (env.PRECOCIDO_ON === 'si' && env.R2_OPERA_CUENTA && env.R2_OPERA_ACCESS_KEY_ID && env.R2_OPERA_SECRET_ACCESS_KEY) {
  almacen = almacenR2({ cuenta: env.R2_OPERA_CUENTA, clave: env.R2_OPERA_ACCESS_KEY_ID, secreto: env.R2_OPERA_SECRET_ACCESS_KEY, deposito: DEPOSITO });
}
try {
  await correr({ almacen, llave: env.PRECOCIDO_ON, modo: env.MODO === 'seco' ? 'seco' : 'real', tope: env.TOPE, retencionH: env.RETENCION_H });
} catch (e) {
  console.error(`precocido: falló (${String(e.message).replace(/[A-Za-z0-9]{32,}/g, '…')})`);
  process.exit(1);
}
