// Archivos downld02 SINTÉTICOS con los encabezados reales de WeatherLink (sólo el formato: este repo es público y no
// guarda datos del INTA). Los fixtures reales (copias de la Wayback Machine) quedan fuera del repo; los tests que los
// usan corren si SIPAN_FIXTURES apunta a la carpeta (ver LEEME).
export const ENC_40 = [
  '                  Temp     Hi    Low   Out         Wind        Wind    Hi    Hi   Wind   Heat          THSW                Rain  Solar   Solar Hi Solar         UV    Hi     Heat    Cool    In     In    In     In     In   In Air           Leaf   Leaf   Wind  Wind    ISS   Arc.',
  '  Date    Time     Out   Temp   Temp   Hum    Dew Speed   Dir   Run Speed   Dir  Chill  Index    THW  Index   Bar    Rain  Rate   Rad.  Energy    Rad.    UV   Dose   UV     D-D     D-D    Temp   Hum    Dew   Heat    EMC Density     ET   Wet 1  Temp 1  Samp   Tx   Recept  Int.',
];
export const ENC_33 = [
  '                  Temp     Hi    Low   Out    Dew  Wind  Wind   Wind    Hi    Hi   Wind   Heat    THW   THSW                Rain  Solar   Solar Hi Solar    Heat    Cool    In     In    In     In           Wind  Wind    ISS   Arc.',
  '  Date    Time     Out   Temp   Temp   Hum    Pt. Speed   Dir    Run Speed   Dir  Chill  Index  Index  Index   Bar    Rain  Rate   Rad.  Energy    Rad.     D-D     D-D    Temp   Hum    Dew   Heat     ET   Samp   Tx   Recept  Int.',
];
const RAYA = '-'.repeat(200);
const p2 = (n) => String(n).padStart(2, '0');

/** «AAAA-MM-DDTHH:MM» (hora de fin) → [fecha dd/mm/aa, hora] en 24 h o en 12 h con a/p */
export function rotulo(local, doce = false) {
  const [f, h] = local.split('T');
  const [y, m, d] = f.split('-');
  let [hh, mm] = h.split(':').map(Number);
  let hora = `${hh}:${p2(mm)}`;
  if (doce) { const s = hh < 12 ? 'a' : 'p'; const h12 = hh % 12 === 0 ? 12 : hh % 12; hora = `${h12}:${p2(mm)}${s}`; }
  return [`${d}/${m}/${y.slice(2)}`, hora];
}

/** registros: [{ local, t, lo, hi, hum, lluvia, et }] (null → '---') */
export function armar(registros, { formato = 40, doce = false } = {}) {
  const enc = formato === 33 ? ENC_33 : ENC_40;
  const f = (x, dec = 1) => (x == null ? '---' : Number(x).toFixed(dec));
  const filas = registros.map((r) => {
    const [d, h] = rotulo(r.local, doce);
    const t = f(r.t), hi = f(r.hi ?? r.t), lo = f(r.lo ?? r.t), hum = r.hum === null ? '---' : String(r.hum ?? 60);
    const ll = r.lluvia === null ? '---' : (r.lluvia ?? 0).toFixed(2), et = r.et === null ? '---' : (r.et ?? 0.01).toFixed(2);
    if (formato === 33) {
      return [d, h, t, hi, lo, hum, '5.0', '1.6', 'N', '0.27', '4.0', 'N', t, t, t, '---', '1012.0', ll, '0.0', '0', '0.00', '0', '0.000', '0.050', '22.0', '35', '6.0', '21.0', et, '233', '1', '100.0', '10'].join('   ');
    }
    return [d, h, t, hi, lo, hum, '5.0', '0.0', '---', '0.00', '0.0', '---', t, t, t, t, '1012.0', ll, '0.0', '0', '0.00', '0', '0.0', '0.00', '0.0', '0.050', '0.000', '22.0', '34', '6.0', '21.0', '6.80', '.0741', et, '0', '8.9', '232', '1', '100.0', '10'].join('   ');
  });
  return [...enc, RAYA, ...filas].join('\r\n') + '\r\n';
}

/** una serie de 10 min entre dos horas locales (de fin), con temperatura dada por una función del índice */
/*  Por defecto se le suma un vaivén de 0 a 0,2 °C (así una serie «constante» no parece un sensor trabado); el mínimo
    de la serie sigue siendo el valor pedido. { plano: true } la deja exactamente constante. */
export function serie(desde, hasta, temp = () => 10, extra = () => ({}), { plano = false } = {}) {
  const out = [];
  const a = Date.parse(desde + ':00Z'), b = Date.parse(hasta + ':00Z');
  for (let t = a, i = 0; t <= b; t += 600e3, i++) {
    const local = new Date(t).toISOString().slice(0, 16);
    const v = temp(i, local);
    /* [v] (en un arreglo) = valor exacto, sin vaivén */
    out.push({ local, t: Array.isArray(v) ? v[0] : v == null || plano ? v : Math.round((v + (i % 3) * 0.1) * 10) / 10, ...extra(i) });
  }
  return out;
}
