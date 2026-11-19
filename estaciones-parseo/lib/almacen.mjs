// HN AGRO · estaciones-parseo · el almacén, SÓLO DE LECTURA: R2 (con el token de sólo lectura) o una carpeta (modo seco y
// tests). Se usa la firma SigV4 de sipan-alto-valle/lib/almacen.mjs (sin dependencias), pero acá se entrega un objeto
// congelado con `leer` y `listar` y NADA MÁS: el parseo no puede escribir ni borrar en R2 aunque el token pudiera.
import { almacenR2, almacenCarpeta } from '../../sipan-alto-valle/lib/almacen.mjs';

export const soloLectura = (a) => Object.freeze({ tipo: a.tipo, leer: (k) => a.leer(k), listar: (p) => a.listar(p) });

export function almacenDeR2(env = process.env) {
  return soloLectura(almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.PARSEO_R2_ACCESS_KEY_ID, secreto: env.PARSEO_R2_SECRET_ACCESS_KEY,
    deposito: env.R2_BUCKET }));
}
export const almacenDeCarpeta = (dir) => soloLectura(almacenCarpeta(dir));
