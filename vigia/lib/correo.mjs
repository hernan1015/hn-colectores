// HN AGRO · vigía de SATCHI · EL MAIL por SMTP, sin dependencias (node:tls / node:net).
// Puerto 465: TLS desde el principio. Otro puerto (587): STARTTLS obligatorio (si el servidor no lo ofrece, NO se
// manda la clave en claro: se corta). AUTH LOGIN. Todo sale de variables de entorno (secrets.* del workflow):
//   SATCHI_SMTP_HOST, SATCHI_SMTP_PORT, SATCHI_SMTP_USER, SATCHI_SMTP_PASS, SATCHI_SMTP_FROM (opcional = USER),
//   SATCHI_VIGIA_DESTINO (uno o varios, separados por coma). Nada de esto se escribe en los registros.
import net from 'node:net';
import tls from 'node:tls';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** encabezado con acentos (RFC 2047) */
const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=');

export function armarMensaje({ de, para, asunto, cuerpo, fecha = new Date(), id = Date.now().toString(36) }) {
  const lineas = String(cuerpo).replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l));
  return ['From: SATCHI vigía <' + de + '>', 'To: ' + para.join(', '), 'Subject: ' + enc(asunto), 'Date: ' + fecha.toUTCString(),
    'Message-ID: <vigia-' + id + '@hnagroapp.com>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64(lineas.join('\r\n')).replace(/.{76}/g, '$&\r\n')].join('\r\n');
}

export async function mandar({ host, port = 465, usuario, clave, de, para, asunto, cuerpo, tiempoMs = 20000, _conectar }) {
  if (!host || !usuario || !clave || !para || !para.length) throw new Error('faltan datos del SMTP o el destino');
  port = Number(port) || 465;
  let sock = await new Promise((res, rej) => {
    const s = _conectar ? _conectar(port) : (port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
    s.once(port === 465 && !_conectar ? 'secureConnect' : 'connect', () => res(s)); s.once('error', rej);
  });
  let buf = '';
  const tope = setTimeout(() => sock.destroy(new Error('tiempo')), tiempoMs);
  const esperar = () => new Promise((res, rej) => {
    const mirar = () => {
      const m = buf.match(/(^|\r\n)(\d{3}) [^\r\n]*\r\n/);
      if (m) { const i = buf.indexOf(m[0]) + m[0].length; const todo = buf.slice(0, i); buf = buf.slice(i); sock.off('data', alDato); sock.off('error', rej); res({ cod: +m[2], todo }); }
    };
    const alDato = (d) => { buf += d.toString('utf8'); mirar(); };
    sock.on('data', alDato); sock.once('error', rej); mirar();
  });
  const cmd = async (linea, esperado) => {
    if (linea != null) sock.write(linea + '\r\n');
    const r = await esperar();
    if (esperado && !esperado.includes(r.cod)) throw new Error('SMTP ' + r.cod + ' (esperaba ' + esperado.join('/') + ')');   // sin el texto: puede traer datos
    return r;
  };
  try {
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO hnagroapp.com', [250]);
    if (port !== 465) {
      if (!/STARTTLS/i.test(ehlo.todo)) throw new Error('el servidor no ofrece STARTTLS: no se manda la clave en claro');
      await cmd('STARTTLS', [220]);
      sock = await new Promise((res, rej) => { const s = tls.connect({ socket: sock, servername: host }, () => res(s)); s.once('error', rej); });
      ehlo = await cmd('EHLO hnagroapp.com', [250]);
    }
    await cmd('AUTH LOGIN', [334]);
    await cmd(b64(usuario), [334]);
    await cmd(b64(clave), [235]);
    await cmd('MAIL FROM:<' + de + '>', [250]);
    for (const p of para) await cmd('RCPT TO:<' + p + '>', [250, 251]);
    await cmd('DATA', [354]);
    await cmd(armarMensaje({ de, para, asunto, cuerpo }) + '\r\n.', [250]);
    await cmd('QUIT', [221]).catch(() => {});
    return { ok: true, destinatarios: para.length };
  } finally { clearTimeout(tope); sock.destroy(); }
}

export function desdeEntorno(env = process.env) {
  const para = String(env.SATCHI_VIGIA_DESTINO || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { host: env.SATCHI_SMTP_HOST, port: env.SATCHI_SMTP_PORT || 465, usuario: env.SATCHI_SMTP_USER, clave: env.SATCHI_SMTP_PASS,
    de: env.SATCHI_SMTP_FROM || env.SATCHI_SMTP_USER, para };
}
