#!/usr/bin/env node
// HN AGRO · arma el JWT del rol `colector_estaciones` (0147b) para el secreto SIPAN_SUPABASE_JWT. Lo corre local UNA vez,
// en su PC, y lo pega directo en `gh secret set` (ver PRENDER.md, paso 3). Sin dependencias (HS256 con node:crypto).
//
//   SUPABASE_JWT_SECRET='<el Legacy JWT secret del proyecto>' node sipan-alto-valle/migracion/firmar-jwt.mjs [--dias 365] \
//     | gh secret set SIPAN_SUPABASE_JWT -R hernan1015/hn-colectores
//
// El secreto del proyecto se lee SÓLO de la variable de entorno (nunca de un argumento, que queda en el historial) y no
// se guarda. El JWT sale por la salida estándar y nada más; el aviso va por la de errores.
// El rol va fijo: este script no puede firmar service_role ni ningún otro.
import crypto from 'node:crypto';

export function firmar({ secreto, dias = 365, ahora = Date.now(), ref = null }) {
  if (!secreto || secreto.length < 32) throw new Error('falta SUPABASE_JWT_SECRET (o es muy corto)');
  if (!(dias >= 1 && dias <= 730)) throw new Error('dias entre 1 y 730');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(ahora / 1000);
  const carga = { role: 'colector_estaciones', iss: 'supabase', iat, exp: iat + dias * 86400, ...(ref ? { ref } : {}) };
  const sinFirma = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(carga);
  return sinFirma + '.' + crypto.createHmac('sha256', secreto).update(sinFirma).digest('base64url');
}

if (import.meta.url.endsWith(String(process.argv[1] || '').replace(/\\/g, '/'))) {
  const i = process.argv.indexOf('--dias');
  const dias = i > 0 ? +process.argv[i + 1] : 365;
  try {
    process.stdout.write(firmar({ secreto: process.env.SUPABASE_JWT_SECRET, dias }));
    console.error(`\nJWT del rol colector_estaciones, vence en ${dias} días. Anotá la fecha para renovarlo.`);
  } catch (e) { console.error(e.message); process.exit(2); }
}
