// HN AGRO · archivo de granizo (147) · UNA CORRIDA: el pedido ya hecho → el asset del día + el índice.
// Orden (lo que no se puede perder, primero):
//   1. el barrido: si su nombre (scan + estado) ya está en el release, NO se sube otra vez (repetido);
//   2. el índice: se leen los que haya, se unen, se agrega la línea de este pedido y se sube el NUEVO antes de borrar
//      los viejos (lib/releases.mjs · reemplazar). Si el índice falla, el barrido ya quedó: la corrida sale en rojo igual.
import { clasificar, nombreBarrido, tagDe, sobre, empaquetar } from './barrido.mjs';
import { RE_INDICE, unirIndices, entrada, agregar } from './indice.mjs';
import { selloUTC } from '../../lib/releases.mjs';

export const notasRelease = (dia) => `SATCHI · GRANIZO β EN VIVO · ${dia} (día argentino). Un asset por barrido: la respuesta ENTERA de ` +
  'satchi-publico?que=granizo, tal cual, con la hora del pedido (UTC y ART) y el estado HTTP. Nombre = hora del scan de GOES-19 (UTC) + ' +
  'estado (buena | parcial | falla); `pedido-…` = sin scan, por la hora del pedido. indice__*.json = una línea por pedido. ' +
  'Índice sin calibrar, señales observadas. USO INTERNO HN AGRO: no se publica ni se redistribuye.';

export async function archivar({ cliente, pedido, colector = {}, seco = false, sello = () => selloUTC() }) {
  const c = clasificar(pedido);
  const nombre = nombreBarrido(c, pedido.pedido_ms);
  const tag = tagDe(c, pedido.pedido_ms);
  const s = sobre(pedido, c, colector);
  const gz = empaquetar(s);
  const base = { tag, nombre, estado: c.estado, motivo: c.motivo, scan_t: c.scan_t, http: pedido.http, bytes: gz.length };
  const dia = tag.slice('granizo-'.length);
  const rel = await cliente.release(tag, { crear: !seco, nombre: `SATCHI granizo en vivo · ${dia}`, notas: notasRelease(dia) });
  const ya = rel ? (await cliente.assets(rel)).some((a) => a.name === nombre) : false;
  if (seco) return { ...base, seco: true, repetido: ya, nuevo: false, indice: 'no (seco)' };

  let nuevo = false;
  if (!ya) nuevo = !(await cliente.subir(rel, nombre, gz, 'application/gzip')).yaEstaba;

  let indice = 'ok', errorIndice = null;
  try {
    const previos = await cliente.leerVarios(rel, (n) => RE_INDICE.test(n));
    const ind = agregar(unirIndices(previos.map((p) => p.buf), tag), entrada(s, nombre, nuevo));
    await cliente.reemplazar(rel, { nombre: `indice__${sello()}.json`, cuerpo: JSON.stringify(ind), tipo: 'application/json', viejos: previos.map((p) => p.asset) });
  } catch (e) { indice = 'falló'; errorIndice = String((e && e.message) || e).slice(0, 200); }
  return { ...base, seco: false, repetido: !nuevo, nuevo, indice, errorIndice };
}
