// HN AGRO · estaciones-privadas/parseo · leer un objeto que guardó ronda.mjs en R2:
//   { leido: ISO, partes: { <nombre>: { status, tipo, cuerpo (texto) } } }
// `parte` devuelve el cuerpo de una parte sólo si vino con 200 (un 404 o cualquier otra cosa: null).
export function parte(obj, nombre) {
  const p = obj?.partes?.[nombre];
  if (!p || p.status !== 200 || typeof p.cuerpo !== 'string') return null;
  return p.cuerpo;
}
