#!/usr/bin/env node
// HN AGRO · VIGÍA DE NÚMEROS (diario). Compara lo que SIRVE la app (endpoint público precios-granos) contra fuentes
// públicas sin clave: el dólar contra el BNA, el FOB de trigo y soja contra MAGyP y la pizarra de Rosario (BCR) como
// control grueso. Si algo se desvía más que su umbral (lib/reglas.mjs, escritos con su motivo), manda UN mail.
//   node vigia-numeros/vigia-numeros.mjs --seco [--detalle]   calcula sin mandar nada; con --detalle (sólo en una PC,
//     nunca en Actions) muestra además el mail que mandaría. En Actions se imprime SÓLO la línea de cantidades.
// Una comparación que no se pudo hacer es un aviso en sí mismo (INCOMPLETO): mail el mismo día y código de salida 1.
// CÓDIGOS DE SALIDA: 0 = verificación completa (con o sin desvíos, y si había desvío el mail salió) · 1 = INCOMPLETO
// (alguna comparación no se pudo hacer, incluido «ninguna»), ENVIO_FALLO (el mail no salió) o un error del vigía.
// Sin --seco: mail por SMTP con los secretos que ya usa el vigía de SATCHI (SATCHI_SMTP_*, SATCHI_VIGIA_DESTINO).
// No guarda estado: corre una vez por día y, mientras el desvío siga, avisa una vez por día.
// En el registro de Actions (público) van SÓLO cantidades; el detalle va en el mail. Ninguna clave ni dirección se imprime.
import { crearLector } from './lib/fuentes.mjs';
import { comparar, textoDe } from './lib/reglas.mjs';
import { mandar, desdeEntorno } from '../vigia/lib/correo.mjs';

export async function correr({ seco = true, detalle = false, urls, env = process.env, fetchFn = globalThis.fetch, mandarFn = mandar, log = console.log, hoy = new Date().toISOString().slice(0, 10) } = {}) {
  const lector = crearLector({ fetchFn, ...(urls ? { urls } : {}) });
  const app = await lector.app();
  const [bna, bcr, fob] = await Promise.all([
    lector.bna(), lector.bcr(),
    app && app.ok && app.magyp_fecha ? lector.magyp(app.magyp_fecha) : Promise.resolve({ ok: false, motivo: 'la app no trae fecha FOB' }),
  ]);
  const r = comparar({ app, bna, fob, bcr });
  const prueba = String(env.VIGIA_NUMEROS_MODO || 'prueba') !== 'produccion';
  const mail = r.desvios.length || r.incompleto ? textoDe(r, { prueba, hoy }) : null;
  const resumen = { modo: seco ? 'seco' : 'real', verificacion: r.incompleto ? 'INCOMPLETO' : 'completa', comparaciones: r.hechas.length, desvios: r.desvios.length, faltan: r.faltan,
    por_tipo: r.desvios.reduce((o, d) => ((o[d.tipo] = (o[d.tipo] || 0) + 1), o), {}), pedidos: lector.cuenta.pedidos, errores: lector.cuenta.errores,
    mail: seco ? (mail ? 'no se manda (--seco)' : 'nada que avisar') : (mail ? 'a mandar' : 'nada que avisar') };
  /* el resumen de cantidades se imprime ANTES de mandar: si el envío se cuelga o falla, el registro ya dice qué había */
  log(JSON.stringify(resumen));
  let envio = null;
  if (!seco && mail) {
    try { await mandarFn({ ...desdeEntorno(env), asunto: mail.asunto, cuerpo: mail.cuerpo }); envio = 'mandado'; }
    catch { envio = 'ENVIO_FALLO'; }                   // código fijo: el mensaje crudo puede traer el servidor o el certificado
    log(JSON.stringify({ envio }));
  }
  resumen.envio = envio;
  if (seco && detalle) log('\n--- comparado: ' + (r.hechas.join(', ') || 'nada') + ' · afuera: ' + r.afuera.length + (mail ? '\n--- lo que mandaría ---\nAsunto: ' + mail.asunto + '\n\n' + mail.cuerpo : ''));
  return { resumen, r, mail, envio };
}

const esPrincipal = import.meta.url === 'file://' + process.argv[1] || import.meta.url.endsWith(String(process.argv[1] || '').replace(/\\/g, '/'));
if (esPrincipal) {
  const a = process.argv.slice(2);
  /* VIGIA_NUMEROS_URLS: sólo para el test del CLI (servidor local); en Actions no se define */
  let urls; try { urls = process.env.VIGIA_NUMEROS_URLS ? JSON.parse(process.env.VIGIA_NUMEROS_URLS) : undefined; } catch { urls = undefined; }
  correr({ seco: a.includes('--seco'), detalle: a.includes('--detalle'), urls })
    .then((x) => { if (x.r.incompleto || x.resumen.comparaciones === 0 || x.envio === 'ENVIO_FALLO') process.exitCode = 1; })
    .catch((e) => { console.error('vigía de números: ' + String(e && e.message).slice(0, 120)); process.exitCode = 1; });
}
