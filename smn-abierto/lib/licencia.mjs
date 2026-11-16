// HN AGRO · SMN datos abiertos · la LICENCIA y la columna MOSTRAR / INTERNO (139b), en un solo lugar.
//
// El Paso 0 (hn-cortex docs/mejora-continua/PASO0-139-fuentes.md, fila 5a, leído completo el 13/11/2026):
//   Política de datos del SMN, IF-2022-12826402-APN-SMN#MD (9/2/2022), §4.A: «Estos son datos que el SMN tiene
//   disponibles en la web de acceso libre y gratuito. […] el SMN comparte sus contenidos bajo la licencia Creative
//   Commons Atribución 2.5 Argentina, la cual compromete a los usuarios a atribuir al SMN como fuente en caso de hacer
//   públicos los datos». Apéndice I.2.5: «Adaptar: remezclar, transformar y construir a partir del material para
//   cualquier propósito, incluso comercialmente.»
// Las obligaciones de CC BY 2.5 AR, al pie de la letra (139b): atribuir al SMN, enlazar a la licencia e indicar si hubo
// cambios. Y §4.C: una demanda periódica con «garantía de servicio» pasa a la categoría arancelada → se lee SÓLO el
// archivo abierto, sin pedir ninguna garantía (ni SLA, ni acuerdo, ni clave).
//
// MOSTRAR se marca sólo si la licencia está en la lista de las que lo permiten Y trae cita, enlace a la licencia,
// enlace a la política y la nota de cambios. Si falta algo, la función LANZA: nada va a MOSTRAR por suposición (139b).

export const LICENCIAS_MOSTRAR = new Set(['CC BY 2.5 AR']);

export const LICENCIA_SMN = Object.freeze({
  mostrar: true,
  licencia: 'CC BY 2.5 AR',
  licencia_url: 'https://creativecommons.org/licenses/by/2.5/ar/',
  cita: 'Fuente: Servicio Meteorológico Nacional (SMN), datos abiertos. Licencia CC BY 2.5 AR.',
  cita_textual: 'Estos son datos que el SMN tiene disponibles en la web de acceso libre y gratuito. Como muchos de los organismos del Sector Público Nacional, el SMN comparte sus contenidos bajo la licencia Creative Commons Atribución 2.5 Argentina, la cual compromete a los usuarios a atribuir al SMN como fuente en caso de hacer públicos los datos',
  politica: 'Política de datos del SMN, IF-2022-12826402-APN-SMN#MD (9/2/2022), §4.A (Dato Abierto) y Apéndice I.2.5',
  politica_url: 'https://argentina.gob.ar/normativa/361173_disp25_pdf/archivo',
  cambios: 'HN AGRO arma un resumen por día (mínima y máxima de las 24 lecturas horarias, mínima de la noche 18-09 h) y marca los valores imposibles; no cambia las lecturas.',
  categoria: 'Dato Abierto (§4.A). Sin garantía de servicio (§4.C): se lee el archivo público, sin acuerdo ni SLA.',
});

/** Los campos de licencia para `estaciones.metadatos`. Lanza si la licencia no alcanza para MOSTRAR. */
export function metaLicencia(l = LICENCIA_SMN) {
  const faltan = ['licencia', 'licencia_url', 'cita', 'politica', 'politica_url', 'cambios'].filter((k) => !l || !String(l[k] || '').trim());
  if (faltan.length) throw new Error('licencia incompleta (' + faltan.join(', ') + '): no se marca MOSTRAR');
  if (l.mostrar === true && !LICENCIAS_MOSTRAR.has(l.licencia)) throw new Error(`la licencia «${l.licencia}» no está entre las que permiten MOSTRAR`);
  if (!/^https:\/\//.test(l.licencia_url) || !/^https:\/\//.test(l.politica_url)) throw new Error('los enlaces de la licencia tienen que ser https');
  return { mostrar: l.mostrar === true, licencia: l.licencia, licencia_url: l.licencia_url, cita: l.cita, cita_textual: l.cita_textual || null,
    politica: l.politica, politica_url: l.politica_url, cambios: l.cambios, categoria: l.categoria || null };
}
