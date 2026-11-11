// HN AGRO · VIGÍA DE NÚMEROS · LAS REGLAS. Los umbrales están escritos ANTES de mirar ningún desvío, cada uno con su motivo.
// Se comparan los números que SIRVE la app (endpoint público precios-granos) contra fuentes públicas sin clave.

export const UMBRALES = Object.freeze({
  /* TC: la app usa el BCRA (Com. A 3500, mayorista) y el BNA publica la «divisa» vendedora del mismo mercado. Entre las dos
     la diferencia normal es de menos de 1 % (el 10/11/2026: 1545 contra 1545,50, un 0,03 %). 2 % deja margen por la hora
     de corte y cualquier error real lo pasa: el respaldo fijo, un billete en lugar de la divisa o un dato de días. */
  tc_desvio_rel: 0.02,
  /* TC VIEJO: la app no puede mostrar un dólar más de 3 días corridos anterior al último que publicó el BNA (cubre un fin
     de semana largo: viernes → lunes son 3 días). */
  tc_dias_atraso: 3,
  /* FOB (trigo pan 1001.99 y soja 1201.90): la app elige UNO de los precios FOB que publica MAGyP ese día (el de la
     posición más cercana al mes). Cualquier número fuera del rango de ese día, con 1 % de margen por redondeo, no sale de
     MAGyP: es un respaldo, un dato de otro día o de otro grano (el candeal 1001.19 era el caso del 6/11). */
  fob_margen_rel: 0.01,
  /* PIZARRA ROSARIO contra FOB × TC: la pizarra es el disponible en Rosario, ya sin derechos de exportación ni gastos de
     embarque, así que siempre queda por DEBAJO del FOB pasado a pesos. El 10/11/2026 dio trigo 0,87 y soja 0,72 (pizarra
     del 06/11). La banda es ancha a propósito: no mide la retención, caza errores gruesos (pesos tomados como dólares,
     un ×10, un respaldo de meses, el precio de otro grano). Si los derechos cambian mucho, se revisa acá, con su fecha. */
  pizarra_cociente: { trigo: [0.70, 1.05], soja: [0.55, 1.00] },
  /* la pizarra tiene que ser de los últimos 7 días corridos contra la fecha FOB de la app; si no, no se compara */
  pizarra_dias_max: 7,
});
/* NCM de MAGyP: el mismo mapeo que la app (precios-granos.js) */
export const NCM = Object.freeze({ trigo: '100199', soja: '120190' });
export const CULTIVOS = Object.freeze(['trigo', 'soja']);

const DIA = 864e5;
const dias = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DIA);
/* 'dd/mm/aaaa' → 'AAAA-MM-DD' */
export const isoDeDMY = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || '')); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

/** Compara. Devuelve { desvios: [...], faltan: [...], hechas: [...], afuera: [...] }. Ningún desvío sale de una fuente que faltó. */
export function comparar({ app, bna, fob, bcr }, U = UMBRALES) {
  const desvios = [], faltan = [], hechas = [];
  const afuera = ['A3 (futuros de MATba-Rofex): la API pide usuario y clave, y el endpoint de futuros de la app pide sesión. Queda afuera.'];
  if (!app || app.ok === false) { desvios.push({ tipo: 'app_no_sirve', detalle: (app && app.motivo) || 'sin respuesta' }); return { desvios, faltan, hechas, afuera }; }
  const precios = app.precios || {};

  /* 1 · la app avisa ella misma que sirve un respaldo */
  if (String(app.fuente_tc || '').startsWith('fallback')) desvios.push({ tipo: 'tc_respaldo', detalle: app.fuente_tc, app: app.tc_ars_usd });
  if (app.es_referencia) desvios.push({ tipo: 'precios_respaldo', detalle: app.fuente_real || app.fuente });
  for (const c of CULTIVOS) if ((app.estimados || []).includes(c)) desvios.push({ tipo: 'precio_estimado', cultivo: c });

  /* 2 · TC contra BNA divisa vendedora */
  if (!bna || bna.ok === false) faltan.push('bna');
  else if (!(app.tc_ars_usd > 0)) desvios.push({ tipo: 'tc_sin_numero' });
  else {
    hechas.push('tc');
    const rel = Math.abs(app.tc_ars_usd - bna.venta) / bna.venta;
    if (rel > U.tc_desvio_rel) desvios.push({ tipo: 'tc_desvio', app: app.tc_ars_usd, bna: bna.venta, rel: +rel.toFixed(4), fecha_bna: bna.fecha });
    if (app.fecha_tc && bna.fecha && dias(bna.fecha, app.fecha_tc) > U.tc_dias_atraso) desvios.push({ tipo: 'tc_viejo', fecha_app: app.fecha_tc, fecha_bna: bna.fecha });
  }

  /* 3 · FOB de trigo y soja dentro del rango oficial del día */
  if (!fob || fob.ok === false) faltan.push('magyp');
  else for (const c of CULTIVOS) {
    const usd = precios[c] && precios[c].usd, lista = (fob.posts || []).filter((p) => String(p.posicion || '').startsWith(NCM[c]) && typeof p.precio === 'number').map((p) => p.precio);
    if (!lista.length) { faltan.push('magyp_' + c); continue; }
    if (!(usd > 0)) { desvios.push({ tipo: 'fob_sin_numero', cultivo: c }); continue; }
    hechas.push('fob_' + c);
    const lo = Math.min(...lista) * (1 - U.fob_margen_rel), hi = Math.max(...lista) * (1 + U.fob_margen_rel);
    if (usd < lo || usd > hi) desvios.push({ tipo: 'fob_fuera_de_rango', cultivo: c, app: usd, rango: [Math.min(...lista), Math.max(...lista)], fecha: app.magyp_fecha });
  }

  /* 4 · pizarra Rosario contra FOB × TC (sanidad gruesa) */
  const fApp = isoDeDMY(app.magyp_fecha);
  if (!bcr || bcr.ok === false) faltan.push('bcr');
  else if (!fApp || Math.abs(dias(fApp, bcr.fecha)) > U.pizarra_dias_max) faltan.push('bcr_vieja');
  else for (const c of CULTIVOS) {
    const pz = bcr.precios && bcr.precios[c], usd = precios[c] && precios[c].usd;
    if (!pz || pz.sin_cotizacion || !(pz.ars > 0)) { faltan.push('bcr_' + c); continue; }
    if (!(usd > 0 && app.tc_ars_usd > 0)) continue;
    hechas.push('pizarra_' + c);
    const q = pz.ars / (usd * app.tc_ars_usd), [lo, hi] = U.pizarra_cociente[c];
    if (q < lo || q > hi) desvios.push({ tipo: 'pizarra_fuera_de_banda', cultivo: c, cociente: +q.toFixed(3), banda: [lo, hi], pizarra_ars: pz.ars, fob_usd: usd, tc: app.tc_ars_usd, fecha_pizarra: bcr.fecha });
  }
  return { desvios, faltan, hechas, afuera };
}

const LINEA = {
  app_no_sirve: (d) => `La app no sirvió precios (${d.detalle}).`,
  tc_respaldo: (d) => `El dólar de la app es el de RESPALDO (${d.detalle}): ${d.app}.`,
  precios_respaldo: (d) => `Los precios de la app son de RESPALDO (${d.detalle}).`,
  precio_estimado: (d) => `El precio de ${d.cultivo} de la app está marcado como estimado.`,
  tc_sin_numero: () => 'La app no trae dólar.',
  tc_desvio: (d) => `Dólar: la app muestra ${d.app} y el BNA (divisa, venta, ${d.fecha_bna}) ${d.bna}: ${(100 * d.rel).toFixed(1)} % de diferencia.`,
  tc_viejo: (d) => `Dólar viejo: la app usa el del ${d.fecha_app} y el BNA ya publicó el del ${d.fecha_bna}.`,
  fob_sin_numero: (d) => `La app no trae FOB de ${d.cultivo}.`,
  fob_fuera_de_rango: (d) => `FOB de ${d.cultivo}: la app muestra ${d.app} USD/t y MAGyP publicó ese día (${d.fecha}) entre ${d.rango[0]} y ${d.rango[1]}.`,
  pizarra_fuera_de_banda: (d) => `Pizarra Rosario de ${d.cultivo} (${d.fecha_pizarra}): $${d.pizarra_ars} contra FOB ${d.fob_usd} × ${d.tc} de la app: cociente ${d.cociente}, fuera de ${d.banda[0]}-${d.banda[1]}.`,
};
export function textoDe(r, { prueba = true, hoy = new Date().toISOString().slice(0, 10) } = {}) {
  const asunto = (prueba ? '[prueba] ' : '') + 'HN AGRO · vigía de números: ' + r.desvios.length + (r.desvios.length === 1 ? ' desvío' : ' desvíos') + ' (' + hoy + ')';
  const cuerpo = ['Lo que muestra la app no coincide con la fuente pública:', '', ...r.desvios.map((d) => '· ' + (LINEA[d.tipo] ? LINEA[d.tipo](d) : d.tipo)), '',
    'Comparado: ' + (r.hechas.join(', ') || 'nada') + (r.faltan.length ? ' · no se pudo comparar: ' + r.faltan.join(', ') : ''),
    'Fuera de este vigía: ' + r.afuera.join(' '), '', 'Umbrales y motivos: vigia-numeros/lib/reglas.mjs del repo hn-colectores.'].join('\n');
  return { asunto, cuerpo };
}
