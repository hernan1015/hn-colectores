// Certificados DE PRUEBA para los tests del TLS (la 264), generados en cada corrida con el openssl del sistema (en
// Actions, el de ubuntu; en pc-nanci, el de Git). Nada se versiona: las claves privadas viven en una carpeta temporal
// que se borra al final. Sin red.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ossl = (dir, args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Arma: una CA de prueba, un certificado de servidor firmado por ella (SAN localhost y 127.0.0.1), OTRA CA que no
 *  firmó nada y un certificado que NO es de CA (CA:FALSE). Devuelve los PEM y `borrar()`. */
export function armarCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-264-'));
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  const ca = (nombre, cn) => ossl(dir, ['req', '-x509', ...ec, '-keyout', `${nombre}.key`, '-out', `${nombre}.crt`, '-days', '3',
    '-subj', `/CN=${cn}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  ca('ca', 'CA de prueba 264');
  ca('otra', 'Otra CA de prueba 264');
  ossl(dir, ['req', '-x509', ...ec, '-keyout', 'hoja.key', '-out', 'hoja.crt', '-days', '3', '-subj', '/CN=no soy CA',
    '-addext', 'basicConstraints=critical,CA:FALSE']);
  ossl(dir, ['req', ...ec, '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost']);
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  ossl(dir, ['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '2', '-extfile', 'ext.cnf']);
  const leer = (n) => fs.readFileSync(path.join(dir, n), 'utf8');
  const huellaOpenssl = (n) => ossl(dir, ['x509', '-in', n, '-noout', '-fingerprint', '-sha256']).trim().split('=').pop();
  return {
    dir,
    ca: leer('ca.crt'), otra: leer('otra.crt'), hoja: leer('hoja.crt'),
    srvCrt: leer('srv.crt'), srvKey: leer('srv.key'),
    archivo: (n) => path.join(dir, n),
    huellaOpenssl,
    borrar: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
