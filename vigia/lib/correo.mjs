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

/* [Codex n3-colectores-vigia-numeros, 2.ª vuelta] El diálogo no puede quedar colgado ni terminar «en silencio»:
   · una sola falla (`fallo`), que rechaza lo que esté esperando: el error del socket, el TEMPORIZADOR (que rechaza
     directo, no vía destroy) y el cierre del servidor (`end`/`close`) antes de terminar el diálogo;
   · `terminado` se pone sólo cuando el servidor aceptó el DATA (250): un cierre después de eso no es falla.
   Los mensajes de error son fijos (no copian lo que dice el servidor ni el sistema, que puede traer nombres o certificados). */
export async function mandar({ host, port = 465, usuario, clave, de, para, asunto, cuerpo, tiempoMs = 20000, _conectar }) {
  if (!host || !usuario || !clave || !para || !para.length) throw new Error('faltan datos del SMTP o el destino');
  port = Number(port) || 465;
  let terminado = false, fallado = false, rechazar;
  const fallo = new Promise((_, rej) => { rechazar = rej; });
  fallo.catch(() => {});                                            // nadie esperando: no es un rechazo sin atender
  const fallar = (msj) => { if (terminado || fallado) return; fallado = true; rechazar(new Error(msj)); };
  const tope = setTimeout(() => fallar('tiempo'), tiempoMs);
  let sock = null, buf = '', despertar = null;
  const mirar = () => {
    if (!despertar) return;
    const m = buf.match(/(^|\r\n)(\d{3}) [^\r\n]*\r\n/);
    if (m) { const i = buf.indexOf(m[0]) + m[0].length; const todo = buf.slice(0, i); buf = buf.slice(i); const d = despertar; despertar = null; d({ cod: +m[2], todo }); }
  };
  const alDato = (d) => { buf += d.toString('utf8'); mirar(); };
  const enganchar = (s) => {
    s.on('error', () => fallar('error de conexión'));
    s.on('end', () => fallar('el servidor cerró la conexión antes de terminar'));
    s.on('close', () => fallar('la conexión se cerró antes de terminar'));
  };
  const esperar = () => Promise.race([new Promise((res) => { despertar = res; mirar(); }), fallo]);
  const cmd = async (linea, esperado) => {
    if (linea != null) sock.write(linea + '\r\n');
    const r = await esperar();
    if (esperado && !esperado.includes(r.cod)) throw new Error('SMTP ' + r.cod + ' (esperaba ' + esperado.join('/') + ')');   // sin el texto: puede traer datos
    return r;
  };
  try {
    sock = await Promise.race([new Promise((res) => {
      const s = _conectar ? _conectar(port) : (port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
      enganchar(s);
      s.once(port === 465 && !_conectar ? 'secureConnect' : 'connect', () => res(s));
    }), fallo]);
    sock.on('data', alDato);
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO hnagroapp.com', [250]);
    if (port !== 465) {
      if (!/STARTTLS/i.test(ehlo.todo)) throw new Error('el servidor no ofrece STARTTLS: no se manda la clave en claro');
      await cmd('STARTTLS', [220]);
      sock.off('data', alDato);                                     // de acá en adelante el socket crudo lleva TLS: se lee el cifrado
      sock = await Promise.race([new Promise((res) => { const t = tls.connect({ socket: sock, servername: host }, () => res(t)); enganchar(t); }), fallo]);
      sock.on('data', alDato);
      ehlo = await cmd('EHLO hnagroapp.com', [250]);
    }
    await cmd('AUTH LOGIN', [334]);
    await cmd(b64(usuario), [334]);
    await cmd(b64(clave), [235]);
    await cmd('MAIL FROM:<' + de + '>', [250]);
    for (const p of para) await cmd('RCPT TO:<' + p + '>', [250, 251]);
    await cmd('DATA', [354]);
    await cmd(armarMensaje({ de, para, asunto, cuerpo }) + '\r\n.', [250]);
    terminado = true;                                               // el servidor ACEPTÓ el mensaje: lo que siga no es falla
    await Promise.race([cmd('QUIT', [221]), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
    return { ok: true, destinatarios: para.length };
  } finally { terminado = true; clearTimeout(tope); if (sock) sock.destroy(); }
}

export function desdeEntorno(env = process.env) {
  const para = String(env.SATCHI_VIGIA_DESTINO || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { host: env.SATCHI_SMTP_HOST, port: env.SATCHI_SMTP_PORT || 465, usuario: env.SATCHI_SMTP_USER, clave: env.SATCHI_SMTP_PASS,
    de: env.SATCHI_SMTP_FROM || env.SATCHI_SMTP_USER, para };
}
