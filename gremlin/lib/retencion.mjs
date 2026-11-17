// HN AGRO · retención de GREMLIN en R2 (decisión de local, 17/11): 90 días, salvo los días con casos, que se guardan siempre.
// Va al final de cada corrida real, con un tope de borrados, así nunca se lista el depósito entero:
//  - una marca `gremlin/limpieza.json` dice hasta qué día UTC ya se limpió;
//  - cada corrida toma el día siguiente a la marca, si ya tiene más de 90 días: lo lista (sólo ese día) y borra hasta
//    TOPE_BORRADOS objetos (el índice del día, último); cuando el día queda vacío, avanza la marca;
//  - un día con caso no se toca nunca (se saltea y la marca avanza).
// Los días con casos están en gremlin/dias-casos.json (en el repo): días ARGENTINOS, «AAAA-MM-DD». Un día argentino va
// de las 03:00 UTC de D a las 03:00 UTC de D+1, así que se guardan los días UTC D y D+1.
// Si la lista no se puede leer o no es válida, NO SE BORRA NADA (mejor guardar de más que perder un caso).
export const DIAS_RETENCION = 90;
export const TOPE_BORRADOS = 300;
export const PARALELO = 8;
export const PRIMER_DIA = '2026-11-16';          // el colector no existía antes: no hay nada que limpiar más atrás
export const CLAVE_MARCA = 'gremlin/limpieza.json';
const DIA = 86400000;

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const esDia = (d) => typeof d === 'string' && RE_DIA.test(d) && new Date(Date.parse(d + 'T00:00:00Z')).toISOString().slice(0, 10) === d;
const msDia = (d) => Date.parse(d + 'T00:00:00Z');
const diaDe = (ms) => new Date(ms).toISOString().slice(0, 10);
export const siguienteDia = (d) => diaDe(msDia(d) + DIA);
export const prefijoDia = (d) => `gremlin/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/`;

/** Los días UTC protegidos a partir de la lista de días argentinos con casos. null si la lista no es válida. */
export function diasProtegidos(json) {
  const dias = json && Array.isArray(json.dias) ? json.dias : null;
  if (!dias || !dias.every(esDia)) return null;
  const out = new Set();
  for (const d of dias) { out.add(d); out.add(siguienteDia(d)); }
  return out;
}

/** El último día UTC que ya se puede borrar: el que terminó hace más de 90 días. */
export const ultimoBorrable = (ahoraMs) => diaDe(Math.floor(ahoraMs / DIA) * DIA - DIAS_RETENCION * DIA - DIA);

/**
 * Una pasada de limpieza. Devuelve { estado, borrados, dia, marca }.
 * @param {object} o
 * @param {object} o.almacen
 * @param {object|null} o.casos   el JSON de dias-casos.json (ya leído)
 */
export async function limpiar({ almacen, casos, ahoraMs = Date.now(), tope = TOPE_BORRADOS, log = console.log }) {
  const protegidos = diasProtegidos(casos);
  if (!protegidos) {
    log('gremlin · retención: la lista de días con casos no es válida; no borro nada');
    return { estado: 'sin-lista', borrados: 0 };
  }
  const leida = await almacen.leer(CLAVE_MARCA);
  let marca = diaDe(msDia(PRIMER_DIA) - DIA);   // «limpio hasta» el día anterior al primero
  if (leida) {
    try { const m = JSON.parse(leida.toString('utf8')); if (esDia(m.hasta)) marca = m.hasta; else throw new Error(); }
    catch { log('gremlin · retención: la marca no se puede leer; no borro nada'); return { estado: 'sin-marca', borrados: 0 }; }
  }
  const limite = ultimoBorrable(ahoraMs);
  let borrados = 0;
  let dia = siguienteDia(marca);
  // como mucho unos pocos días por corrida: los salteados (con caso) o vacíos no cuestan borrados
  for (let vueltas = 0; vueltas < 10 && dia <= limite && borrados < tope; vueltas++) {
    if (!protegidos.has(dia)) {
      const claves = (await almacen.listar(prefijoDia(dia))).filter((k) => k.startsWith(prefijoDia(dia)));
      const orden = [...claves.filter((k) => !k.endsWith('/indice.json')), ...claves.filter((k) => k.endsWith('/indice.json'))];
      const lote = orden.slice(0, tope - borrados);
      for (let i = 0; i < lote.length; i += PARALELO) await Promise.all(lote.slice(i, i + PARALELO).map((k) => almacen.borrar(k)));
      borrados += lote.length;
      if (lote.length < orden.length) break;   // el día no terminó: sigue en la próxima corrida, sin mover la marca
    }
    marca = dia;
    await almacen.escribir(CLAVE_MARCA, JSON.stringify({ hasta: marca, actualizado: new Date(ahoraMs).toISOString() }));
    dia = siguienteDia(marca);
  }
  if (borrados) log(`gremlin · retención: ${borrados} objetos borrados · limpio hasta ${marca}`);
  return { estado: 'ok', borrados, marca };
}
