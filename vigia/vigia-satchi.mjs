#!/usr/bin/env node
// HN AGRO · VIGÍA DE SATCHI (piloto: crecidas y focos de calor). Corre en GitHub Actions cada 15 min (ver
// vigia.workflow.yml.txt y LEEME.md). Lee SATCHI público, decide qué es NUEVO contra lo ya avisado y manda UN mail.
//   node vigia/vigia-satchi.mjs --seco [--estado archivo.json] [--ahora ISO] [--todo]
//     --seco   calcula y MUESTRA lo que avisaría: sin mail y sin tocar la base (el estado: el archivo o vacío)
//     --todo   lee también el pronóstico aunque no sea su hora (va cada 3 h: es lo que tarda el INA en renovarlo)
// Sin --seco: estado en Supabase (SATCHI_VIGIA_SUPABASE_URL/_KEY) y mail por SMTP (SATCHI_SMTP_*, SATCHI_VIGIA_DESTINO).
// En el registro (público) van SÓLO cantidades; el detalle va en el mail. Ninguna clave ni dirección se imprime.
import { crearLector } from './lib/fuentes.mjs';
import { escalasEnEvacuacion, escalasFueraDeEvacuacion, pronosticoQueCruza, pronosticoQueNoCruza, focosGrandes, nuevos, textoDe } from './lib/reglas.mjs';
import { estadoDeArchivo, crearEstadoSupabase } from './lib/estado.mjs';
import { mandar, desdeEntorno } from './lib/correo.mjs';

export async function correr({ seco = true, estadoArchivo = null, ahoraMs = Date.now(), todo = false, env = process.env, fetchFn = globalThis.fetch, mandarFn = mandar, log = console.log } = {}) {
  const lector = crearLector({ fetchFn, base: env.SATCHI_VIGIA_BASE || undefined });
  const provincias = String(env.SATCHI_VIGIA_PROVINCIAS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const horaProno = new Date(ahoraMs).getUTCHours() % 3 === 0 && new Date(ahoraMs).getUTCMinutes() < 15;
  const [escalas, focos] = await Promise.all([lector.leer('ina', { parte: 'escalas' }), lector.leer('focos', { zona: 'pais' })]);
  const prono = (todo || horaProno) ? await lector.leer('ina', { parte: 'prono' }) : null;
  const faltan = [];
  if (!escalas || escalas.ok === false || !escalas.parana || !escalas.parana.ok) faltan.push('escalas');
  if (!focos || focos.ok === false) faltan.push('focos');
  if (prono && (prono.ok === false || !Array.isArray(prono.ciudades))) faltan.push('prono');
  const candidatos = [
    ...(faltan.includes('escalas') ? [] : escalasEnEvacuacion(escalas)),
    ...(prono && !faltan.includes('prono') && !faltan.includes('escalas') ? pronosticoQueCruza(prono, escalas, ahoraMs) : []),
    ...(faltan.includes('focos') ? [] : focosGrandes(focos, provincias)),
  ];
  const almacen = seco ? null : crearEstadoSupabase({ url: env.SATCHI_VIGIA_SUPABASE_URL, clave: env.SATCHI_VIGIA_SUPABASE_KEY, fetchFn });
  const estado = seco ? estadoDeArchivo(estadoArchivo) : await almacen.leer(ahoraMs);
  const avisar = nuevos(candidatos, estado, ahoraMs);
  /* lo que dejó de cruzar (con lectura): se rearma, para avisar de nuevo si vuelve a cruzar */
  const rearmar = [...(faltan.includes('escalas') ? [] : escalasFueraDeEvacuacion(escalas)),
    ...(prono && !faltan.length ? pronosticoQueNoCruza(prono, escalas, ahoraMs) : [])].filter((k) => estado.get(k) && estado.get(k).activo);
  const prueba = String(env.SATCHI_VIGIA_MODO || 'prueba') !== 'produccion';
  const mail = avisar.length ? textoDe(avisar, { prueba, ahoraMs }) : null;
  let mandado = null;
  if (!seco) {
    if (mail) { mandado = await mandarFn({ ...desdeEntorno(env), asunto: mail.asunto, cuerpo: mail.cuerpo }); await almacen.avisado(avisar, ahoraMs); }
    await almacen.rearmar(rearmar, ahoraMs);
  }
  const resumen = { modo: seco ? 'seco' : 'real', faltan, candidatos: candidatos.length, avisos: avisar.length, rearmados: rearmar.length,
    por_tipo: avisar.reduce((o, a) => ((o[a.tipo] = (o[a.tipo] || 0) + 1), o), {}), prono_leido: !!prono,
    pedidos: lector.cuenta.pedidos, invocaciones: lector.cuenta.invocaciones, invocacion_sin_saber: lector.cuenta.sin_saber, kb: Math.round(lector.cuenta.bytes / 1024),
    mail: seco ? (mail ? 'no se manda (--seco)' : 'nada que avisar') : (mandado ? 'mandado' : 'nada que avisar') };
  log(JSON.stringify(resumen));
  if (seco && mail) log('\n--- lo que mandaría ---\nAsunto: ' + mail.asunto + '\n\n' + mail.cuerpo);
  return { resumen, avisar, mail, candidatos };
}

const esPrincipal = import.meta.url === 'file://' + process.argv[1] || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (esPrincipal) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  correr({ seco: a.includes('--seco'), estadoArchivo: val('--estado'), ahoraMs: val('--ahora') ? Date.parse(val('--ahora')) : Date.now(), todo: a.includes('--todo') })
    .then((r) => { if (r.resumen.faltan.length === 3) process.exitCode = 2; })
    .catch((e) => { console.error('vigía: ' + String(e && e.message).slice(0, 120)); process.exitCode = 1; });
}
