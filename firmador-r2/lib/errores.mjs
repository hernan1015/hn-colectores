// HN AGRO · firmador-r2 · errores SIN texto crudo (2.ª vuelta, revisión Codex n3).
// Un mensaje de Postgres, de fetch o de R2 puede traer la URL firmada, el host o la cadena de conexión. Por eso a la
// consola y al resumen sólo llega un CÓDIGO de una lista cerrada de formas; e.message no se imprime nunca.

/** Error propio con código fijo (el mensaje es el mismo código: nada variable adentro) */
export function errorCodigo(codigo) { return Object.assign(new Error(codigo), { codigo }); }

const NOMBRES = new Set(['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'RangeError']);

/** cualquier error → código seguro: el propio (a-z0-9_), el SQLSTATE de Postgres / código de Node (A-Z0-9_), el
    nombre de una clase estándar, o 'error'. Nunca e.message. */
export function codigoDe(e) {
  if (e && typeof e.codigo === 'string' && /^[a-z0-9_]{1,60}$/.test(e.codigo)) return e.codigo;
  if (e && typeof e.code === 'string' && /^[A-Z0-9_]{1,30}$/.test(e.code)) return e.code;
  if (e && typeof e.name === 'string' && NOMBRES.has(e.name)) return e.name;
  return 'error';
}
