// HN AGRO · colector de METAR de los aeropuertos argentinos (aviationweather.gov, NOAA), en R2 (317). Ver metar/LEEME.md.
// Variables:
//   METAR_ON (sólo «si» hace algo) · MODO (real | seco | relleno) · TOPE (pedidos por corrida) · DESDE / HASTA (relleno, UTC AAAA-MM-DD[THH])
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET: el depósito PRIVADO (los de rayos-hora y gremlin; nunca se imprimen)
//   R2_OPERA_CUENTA, R2_OPERA_ACCESS_KEY_ID, R2_OPERA_SECRET_ACCESS_KEY: el PÚBLICO de SATCHI (los de opera-mosaico-diario y
//     rayos-hora), en el depósito METAR_DEPOSITO_PUBLICO (variable, «satchi-metar» por defecto). Sin ellas no se copia.
//   o ALMACEN_CARPETA / PUBLICO_CARPETA para probar sin R2.
// Imprime sólo cantidades. Si falla R2, sale con error (rojo); si falla la API, queda anotado y sale bien (verde).
import { almacenCarpeta, almacenR2 } from '../rayos-hora/lib/almacen.mjs';
import { correr } from './lib/colector.mjs';

const env = process.env;
const prendida = env.METAR_ON === 'si';
const almacen = env.ALMACEN_CARPETA
  ? almacenCarpeta(env.ALMACEN_CARPETA)
  : prendida
    ? almacenR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET })
    : null;
const DEPOSITO_PUB = String(env.METAR_DEPOSITO_PUBLICO || 'satchi-metar').trim();
const publico = env.PUBLICO_CARPETA ? almacenCarpeta(env.PUBLICO_CARPETA)
  : prendida && env.R2_OPERA_CUENTA && env.R2_OPERA_ACCESS_KEY_ID && env.R2_OPERA_SECRET_ACCESS_KEY
    ? almacenR2({ cuenta: env.R2_OPERA_CUENTA, clave: env.R2_OPERA_ACCESS_KEY_ID, secreto: env.R2_OPERA_SECRET_ACCESS_KEY, deposito: DEPOSITO_PUB })
    : null;
if (prendida && !publico) console.log('metar: sin las llaves R2_OPERA_* (no copio el derivado público para SATCHI)');

const fecha = (s, fin) => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2] || (fin ? '23' : '00')}:00:00Z`);
  return Number.isFinite(t) ? t + (fin && !m[2] ? 3600000 : 0) : null;
};
const modo = ['seco', 'relleno'].includes(env.MODO) ? env.MODO : 'real';
try {
  await correr({ almacen, publico, llave: env.METAR_ON, modo, tope: env.TOPE, desdeMs: fecha(env.DESDE, false), hastaMs: fecha(env.HASTA, true) });
} catch (e) {
  console.error(`metar: falló (${e.message})`);
  process.exit(1);
}
