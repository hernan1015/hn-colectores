#!/usr/bin/env node
// HN AGRO · serie de imágenes GOES-19 FDCF en R2, cada 10 min, con 30 días rotando · 8/11/2026. Ver LEEME.md.
// Dos modos (MODO):
//   serie  (por defecto) guarda las imágenes que falten de las últimas HORAS h, actualiza los índices y rota.
//   evento               copia t0 ± 6 h de goes-serie/ a goes-eventos/<EVENTO>/ con su manifiesto (sin rotación).
// env: R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET (secrets; nunca se imprimen)
//      HORAS (serie, 3; 1 a 24) · EVENTO, LAT, LON, T0 (evento; T0 en UTC, AAAA-MM-DDTHH:MMZ)
// Salida: 0 bien · 1 hubo faltantes o algún error parcial · 2 no se pudo correr (configuración, R2 sin listar…).
import fs from 'node:fs';
import { r2 as clienteR2, codigoDe } from './lib/r2.mjs';
import { listarHora, bajar } from './lib/noaa.mjs';
import { correrSerie } from './lib/serie.mjs';
import { copiarEvento } from './lib/evento.mjs';

const env = process.env;
const t0 = Date.now();
const publicar = (txt) => { console.log(txt); if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, txt + '\n'); };

let r2;
try { r2 = clienteR2({ cuenta: env.R2_ACCOUNT_ID, clave: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, deposito: env.R2_BUCKET }); }
catch (e) { console.error('no se pudo correr: ' + codigoDe(e)); process.exit(2); }

let res;
try {
  if ((env.MODO || 'serie') === 'evento') {
    res = await copiarEvento({ r2 }, { evento: env.EVENTO, lat: env.LAT, lon: env.LON, t0: env.T0 });
    publicar([
      `### GOES · ventana del evento \`${res.evento || '?'}\` · ${new Date().toISOString().slice(0, 16)}Z`,
      `- copiadas: **${res.copiadas}** (${res.metodo}) · ya estaban: ${res.ya_estaban} · pendientes: ${res.pendientes} · faltan: **${res.faltan.length}**`,
      res.faltan.length ? `- faltan: ${res.faltan.slice(0, 20).map((f) => `${f.turno} (${f.motivo})`).join(', ')}${res.faltan.length > 20 ? ' …' : ''}` : '',
      res.completo ? '- ventana completa' : '- ventana NO completa (volver a correr con los mismos datos después de t0 + 6 h 30 min)',
      ...res.avisos.map((a) => `- aviso: ${a}`), ...res.errores.map((a) => `- error: ${a}`),
    ].filter(Boolean).join('\n'));
  } else {
    res = await correrSerie({ r2, noaa: { listarHora: (ms) => listarHora(ms), bajar: (o) => bajar(o) }, log: (s) => console.log(s) }, { horas: env.HORAS || undefined });
    publicar([
      `### GOES-19 FDCF · serie en R2 · ${new Date().toISOString().slice(0, 16)}Z`,
      `- ventana: ${res.ventana_h} h · guardadas: **${res.guardadas}** (${(res.bytes_subidos / 1e6).toFixed(1)} MB) · ya estaban: ${res.ya_estaban} · pendientes: ${res.pendientes}`,
      `- faltantes: **${res.faltantes.length}**${res.faltantes.length ? ' · ' + res.faltantes.map((f) => `${f.turno} (${f.motivo})`).join(', ') : ''}`,
      `- rotación: ${res.borradas} borradas (más de 30 días, sólo goes-serie/) · ${Math.round((Date.now() - t0) / 1000)} s`,
      ...res.avisos.map((a) => `- aviso: ${a}`), ...res.errores.map((a) => `- error: ${a}`),
    ].join('\n'));
  }
} catch (e) { console.error('FALLÓ LA CORRIDA: ' + codigoDe(e)); process.exit(2); }
process.exit(res.codigo);
