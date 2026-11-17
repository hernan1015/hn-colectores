// HN AGRO · colector de GREMLIN (CIRA/RAMMB SLIDER) sobre la Argentina, en R2. Ver gremlin/LEEME.md.
// Variables: GREMLIN_ON (sólo «si» hace algo), MODO (real | seco), TOPE (pedidos por corrida, 10 a 300; 60 por defecto),
// R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (los de rayos-hora y SHN; nunca se imprimen)
// o ALMACEN_CARPETA=/una/carpeta para probar sin R2.
// Imprime sólo cantidades. Si falla R2, sale con error (corrida en rojo); si falla SLIDER, queda anotado y sale bien.
import { almacenCarpeta, almacenR2 } from '../rayos-hora/lib/almacen.mjs';
import { correr } from './lib/colector.mjs';

const env = process.env;
const almacen = env.ALMACEN_CARPETA
  ? almacenCarpeta(env.ALMACEN_CARPETA)
  : env.GREMLIN_ON === 'si'
    ? almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET })
    : null;
try {
  await correr({ almacen, llave: env.GREMLIN_ON, modo: env.MODO === 'seco' ? 'seco' : 'real', tope: env.TOPE });
} catch (e) {
  console.error(`gremlin: falló (${e.message})`);
  process.exit(1);
}
