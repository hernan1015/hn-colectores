// HN AGRO · estaciones-parseo · las 9 fuentes que baja estaciones-privadas/ronda.mjs, un módulo por fuente.
// Cada módulo exporta por defecto { id (el prefijo de R2: estaciones-internas/<id>/), red, leer(obj, ctx) } y, si
// hace falta, ext (la extensión de la ronda; por defecto .json), abrir(texto) y contexto({ almacen, dias }).
// leer → { red, estaciones: [...], lecturas: [{ estacion_id, instante (ms), tipo: 'instantanea' | 'registro', temp_c, …,
//          crudo }], descartadas: { motivo: n } }. Las reglas de calidad las aplica lib/calidad.mjs, igual para todas.
import weatherlink from './weatherlink.mjs';
import weathercloud from './weathercloud.mjs';
import siga from './siga.mjs';
import eeaoc from './eeaoc.mjs';
import mendoza from './mendoza.mjs';
import sanluis from './sanluis.mjs';
import bcp from './bcp.mjs';
import entrerios from './entrerios.mjs';
import ina from './ina.mjs';

export const FUENTES = Object.freeze([weatherlink, weathercloud, siga, eeaoc, mendoza, sanluis, bcp, entrerios, ina]);
/** Las redes que escribe el parseo: tienen que estar en la política del rol (migración 0161). */
export const REDES = Object.freeze(FUENTES.map((f) => f.red));
