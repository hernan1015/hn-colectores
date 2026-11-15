// HN AGRO · parseo · EL REGISTRO DE FUENTES. Un módulo por fuente; el job (../parseo.mjs) las corre todas en orden.
//
// Para sumar una fuente (SIGA, EEAOC, DACC, REM, BCP, INA, Entre Ríos…): un archivo fuentes/<fuente>.mjs que exporte
//   fuente          'siga'                     (la carpeta de R2: estaciones-internas/<fuente>/)
//   red             'INTA_SIGA'                (la de estaciones / estaciones_obs; sumarla a REDES en lib/guardar.mjs
//                                               y a la política del rol colector_estaciones en una migración)
//   muestreo_min    60                         (cada cuánto hay una lectura por estación en el crudo)
//   async leer({ r2, dias }) → { estaciones: [filas de estaciones], lecturas: [ver lib/dia.mjs],
//                                cuentas: {sólo números}, claves_descartadas?, presentes?: [ids] | null, avisos?: [] }
// y una línea acá abajo. `r2` es SÓLO de lectura (leer / listar). Nada de pedidos a la fuente.
import * as weatherlink from './weatherlink.mjs';
import * as weathercloud from './weathercloud.mjs';

export const FUENTES = [weatherlink, weathercloud];
