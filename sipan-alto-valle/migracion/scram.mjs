#!/usr/bin/env node
// HN AGRO · el VERIFICADOR SCRAM-SHA-256 de la clave de `colector_estaciones` (0147b), para que la clave en texto
// plano NUNCA llegue a la base (ni a sus logs: `alter role … password '<texto>'` puede quedar en el log de sentencias).
// Postgres acepta el verificador tal cual en `password` (formato de pg_authid). Sin dependencias.
//
//   VERIF=$(CLAVE="$CLAVE" node sipan-alto-valle/migracion/scram.mjs)        # la clave entra SÓLO por la variable CLAVE
//   psql "$ADMIN_URL" -v clave="$VERIF" -f 0147b_rol_colector_estaciones.sql
//
// La clave se lee de la variable de entorno CLAVE (nunca de un argumento: quedaría en el historial). Sale sólo el
// verificador, por la salida estándar. Una clave de `openssl rand -base64 32` es ASCII: SASLprep no la cambia.
import crypto from 'node:crypto';

export const ITER = 4096;

export function claves(clave, sal, iter = ITER) {
  const salada = crypto.pbkdf2Sync(Buffer.from(clave, 'utf8'), sal, iter, 32, 'sha256');
  const clienteKey = crypto.createHmac('sha256', salada).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clienteKey).digest();
  const serverKey = crypto.createHmac('sha256', salada).update('Server Key').digest();
  return { clienteKey, storedKey, serverKey };
}

export function verificador(clave, { sal = crypto.randomBytes(16), iter = ITER } = {}) {
  if (typeof clave !== 'string' || clave.length < 24) throw new Error('falta CLAVE (o tiene menos de 24 caracteres)');
  if (!/^[\x21-\x7e]+$/.test(clave)) throw new Error('CLAVE tiene que ser ASCII imprimible (openssl rand -base64 32)');
  const { storedKey, serverKey } = claves(clave, sal, iter);
  return `SCRAM-SHA-256$${iter}:${sal.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  try { process.stdout.write(verificador(process.env.CLAVE)); }
  catch (e) { console.error(e.message); process.exit(2); }
}
