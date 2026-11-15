// HN AGRO · imerg-pendientes · el barrido: UNA celda por vez, como mucho 2 por corrida, la NASA de a poco.
//
// Por qué así (232, PASO0-232): en hn-agro el job llevaba todas las celdas juntas con 120 min de tope y cada celda
// tarda ~27 min: entraban 4, la 5.ª se cortaba y las reservas quedaban 'pendiente (lazy)' sin que nadie las volviera
// a pedir. Acá:
//   · se TOMA una celda (la base garantiza que no haya dos tomas vivas), se baja y se GUARDA en una transacción;
//   · si GitHub corta el job, la toma vence a los 90 min y la corrida siguiente la retoma sola;
//   · la 2.ª celda sólo empieza si quedan al menos PRESUPUESTO_MS de corrida, y después de PAUSA_MS;
//   · ante cualquier error de la NASA la celda se suelta ('fallo (colectores)': se reintenta en 6 h) y la corrida
//     TERMINA: nada de seguir pidiendo contra un servicio que contesta mal.
// Los registros (el repo es público) muestran sólo cantidades: nunca la celda.

export const TOPE_MAX = 2;
export const PRESUPUESTO_MS = 45 * 60 * 1000;
export const PAUSA_MS = 60 * 1000;

export const tope = (t) => Math.max(1, Math.min(TOPE_MAX, Math.floor(Number(t)) || TOPE_MAX));

export async function barrer({ base, serie, tope: t = TOPE_MAX, esperaLazyMin = 180, presupuestoMs = PRESUPUESTO_MS, pausaMs = PAUSA_MS,
  reloj = Date.now, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  const n = tope(t), t0 = reloj();
  const r = { tomadas: 0, guardadas: 0, filas: 0, fallos: 0, motivo: null, error: null };
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      if (reloj() - t0 > presupuestoMs) { r.motivo = 'presupuesto'; break; }
      await dormir(pausaMs);
    }
    const c = await base.tomar(esperaLazyMin);
    if (!c) { r.motivo = 'nada_pendiente'; break; }
    r.tomadas++;
    let filas;
    try {
      filas = await serie(c);
    } catch (e) {
      r.fallos++;
      r.error = 'nasa_' + ((e && e.codigo) || 'error');
      await base.soltar(c).catch(() => {});
      log(`celda ${i + 1}/${n}: la NASA no la dio (${r.error}); queda para dentro de 6 h y la corrida termina`);
      r.motivo = 'fallo_nasa';
      break;
    }
    let guardadas;
    try {
      guardadas = await base.guardar(c, filas);
    } catch (e) {
      r.fallos++;
      r.error = (e && e.message) || 'guardar';
      await base.soltar(c).catch(() => {});
      r.motivo = 'fallo_base';
      break;
    }
    r.guardadas++; r.filas += guardadas;
    log(`celda ${i + 1}/${n}: ${guardadas} filas guardadas`);
  }
  if (!r.motivo) r.motivo = 'tope';
  return r;
}
