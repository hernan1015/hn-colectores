// HN AGRO · parseo · EL REGISTRO DE FUENTES: las 9, un módulo por fuente. El job (../parseo.mjs) las corre en orden.
//
// Un módulo exporta por defecto:
//   id          'eeaoc'                  el prefijo de R2: estaciones-internas/<id>/<día ARG>/<HHMM UTC>.json(l)
//   nombre      texto                    (no se imprime en el log público)
//   proceso     'interna_eeaoc'          el renglón de registro_procesos (tiene que estar en la política de la 0152)
//   redes       { RED: cfg }             cfg del diario (lib/diario.mjs): pasoMin, extremos, lluvia, eto, fuente, url,
//                                        maxEdadH (LA regla de la edad de esa red), ultima (estaciones_ultima_lectura),
//                                        o { diaria: true, armar } para las que ya vienen por día (INA_ALERTA)
//   leer(obj, ctx) → [{ red, estaciones, lecturas: [{ id, local, v, leido? }], diarias?, paso?, problemas,
//                       cuentas? (sólo números), claves_descartadas? (sólo NOMBRES), presentes?, avisos? }]
//   opcionales: ext (la extensión de la ronda; por defecto .json), lote (las claves de un lote, p. ej. el de la
//               notebook), abrir(texto, clave) → [obj] (por defecto JSON.parse), contexto({ r2, dias }) → ctx.
// La red va también en REDES de lib/base.mjs y en la política del rol (migración 0152). `r2` es SÓLO de lectura.
import weatherlink from './weatherlink.mjs';
import weathercloud from './weathercloud.mjs';
import siga from './siga.mjs';
import eeaoc from './eeaoc.mjs';
import mendoza from './dacc.mjs';
import sanluis from './rem.mjs';
import bcp from './bcp.mjs';
import entrerios from './er.mjs';
import ina from './ina.mjs';

export const FUENTES = Object.freeze([weatherlink, weathercloud, siga, eeaoc, mendoza, sanluis, bcp, entrerios, ina]);
