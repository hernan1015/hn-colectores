// HN AGRO · imerg-pendientes · el barrido: UNA celda por vez, como mucho 2 por corrida, la NASA de a poco.
//
// Por qué así (232, PASO0-232): en hn-agro el job llevaba todas las celdas juntas con 120 min de tope y cada celda
// tarda ~27 min: entraban 4, la 5.ª se cortaba y las reservas quedaban 'pendiente (lazy)' sin que nadie las volviera
// a pedir. Acá:
//   · se TOMA una celda (la base garantiza que no haya dos tomas vivas ni más de 2 por hora), se baja y se GUARDA en
//     una transacción;
//   · la 2.ª celda sólo empieza si quedan al menos PRESUPUESTO_MS de corrida, y después de PAUSA_MS;
//   · ante cualquier error de la NASA la celda se suelta ('fallo (colectores)') y la corrida TERMINA: nada de seguir
//     pidiendo contra un servicio que contesta mal;
//   · la espera NO depende de que `soltar` llegue: `tomar` ya grabó en la base el «no antes de» de la celda (8 h o más,
//     migracion/imerg_colector.sql). El registro dice si se pudo soltar y la hora que quedó grabada, nada más;
//   · si la base dice que la serie no vino completa (guardar = 0), no se escribió nada y la corrida también termina;
//   · si GitHub corta el job, la celda queda retenida hasta su «no antes de» y una corrida posterior la retoma sola.
// Los registros (el repo es público) muestran sólo cantidades y horas: nunca la celda.

export const TOPE_MAX = 2;
export const PRESUPUESTO_MS = 45 * 60 * 1000;
export const PAUSA_MS = 60 * 1000;

/** La hora (UTC, AAAA-MM-DD HH:MM) del «no antes de» que devolvió la base; null si no vino. */
export function horaUtc(d) {
  const t = d instanceof Date ? d : (d ? new Date(d) : null);
  return t && Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 16).replace('T', ' ') : null;
}

export const tope = (t) => Math.max(1, Math.min(TOPE_MAX, Math.floor(Number(t)) || TOPE_MAX));

export async function barrer({ base, serie, tope: t = TOPE_MAX, esperaLazyMin = 180, presupuestoMs = PRESUPUESTO_MS, pausaMs = PAUSA_MS,
  reloj = Date.now, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  const n = tope(t), t0 = reloj();
  const r = { tomadas: 0, guardadas: 0, filas: 0, fallos: 0, motivo: null, error: null, soltada: null };
  /* Suelta la celda y arma el renglón del registro con lo que de verdad quedó: si se soltó o no, y la hora grabada. */
  const retener = async (c) => {
    r.soltada = await Promise.resolve().then(() => base.soltar(c)).then((ok) => ok === true, () => false);
    const hora = horaUtc(c.noAntesDe);
    const hasta = hora ? `la base no la vuelve a dar antes de ${hora} UTC (lo grabó al tomarla)`
      : 'la base la retiene con la espera que grabó al tomarla';
    return (r.soltada ? 'soltada; ' : 'NO se pudo soltar; igual ') + hasta;
  };
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
      log(`celda ${i + 1}/${n}: la NASA no la dio (${r.error}); ${await retener(c)}; la corrida termina`);
      r.motivo = 'fallo_nasa';
      break;
    }
    let guardadas;
    try {
      guardadas = await base.guardar(c, filas);
    } catch (e) {
      r.fallos++;
      r.error = (e && e.message) || 'guardar';
      log(`celda ${i + 1}/${n}: no se pudo guardar (${r.error}); ${await retener(c)}; la corrida termina`);
      r.motivo = 'fallo_base';
      break;
    }
    if (!(guardadas > 0)) {
      r.fallos++;
      r.error = 'serie_parcial';
      const hora = horaUtc(c.noAntesDe);
      log(`celda ${i + 1}/${n}: la serie vino incompleta (${filas.length} días); no se guardó y queda 'parcial'`
        + (hora ? ` hasta ${hora} UTC` : '') + '; la corrida termina');
      r.motivo = 'parcial';
      break;
    }
    r.guardadas++; r.filas += guardadas;
    log(`celda ${i + 1}/${n}: ${guardadas} filas guardadas`);
  }
  if (!r.motivo) r.motivo = 'tope';
  return r;
}
