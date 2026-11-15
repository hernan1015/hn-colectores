// HN AGRO · estaciones-privadas/parseo · la hora de Argentina (UTC−3 fija, sin horario de verano desde 2009). Sin dependencias.
// «local» es texto 'AAAA-MM-DDTHH:MM' en hora argentina. Se resta como si fuera UTC: sólo para comparar y restar.
export const OFFSET_MS = 3 * 3600e3;

/** Un instante (Date, ms o ISO con zona) → 'AAAA-MM-DDTHH:MM' local de Argentina. null si no se entiende. */
export function localDe(instante) {
  const t = instante instanceof Date ? instante.getTime() : typeof instante === 'number' ? instante : Date.parse(instante);
  if (!Number.isFinite(t)) return null;
  return new Date(t - OFFSET_MS).toISOString().slice(0, 16);
}
/** 'AAAA-MM-DDTHH:MM' local → ISO UTC. */
export const utcDe = (local) => new Date(Date.parse(local + ':00Z') + OFFSET_MS).toISOString();
/** ms de un local (para restar). NaN si no tiene la forma. */
export const msLocal = (local) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(local)) ? Date.parse(local + ':00Z') : NaN);
export const sumarDias = (fecha, n) => new Date(Date.parse(fecha + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/** El día (0110, corte 00:00) al que pertenece el registro que TERMINA en `local`: el de las 00:00 es del día anterior. */
export const diaDe = (local) => new Date(msLocal(local) - 60e3).toISOString().slice(0, 10);
