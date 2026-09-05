// Envoi d'e-mails (cahier des charges, Phase 4 : "envoi automatique du document
// généré par e-mail à l'utilisateur final").
//
// Aucune bibliothèque comme nodemailer n'étant disponible hors-ligne, ce module
// implémente un client SMTP minimal directement sur les modules natifs `net`/`tls`
// de Node : HELO/EHLO, AUTH LOGIN, MAIL FROM/RCPT TO/DATA, avec pièce jointe en
// MIME multipart/base64. Suffisant pour la plupart des relais SMTP (Gmail, SES,
// Mailgun, SendGrid SMTP, un serveur interne...).
//
// Configuration via variables d'environnement — l'envoi est simplement désactivé
// (no-op silencieux) si elles ne sont pas renseignées, pour ne jamais bloquer la
// génération de document si l'e-mail n'est pas configuré :
//   SMTP_HOST, SMTP_PORT (défaut 587), SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE ("true" pour SSL direct)

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}

function sendCommand(socket, command, expectedCodes) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      // Une réponse SMTP multi-ligne a "-" après le code sauf sur la dernière ligne.
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        socket.removeListener('data', onData);
        const code = parseInt(last.slice(0, 3), 10);
        if (expectedCodes && !expectedCodes.includes(code)) {
          reject(new Error(`SMTP: réponse inattendue à "${(command || '').split('\r\n')[0]}" : ${buffer.trim()}`));
        } else {
          resolve(buffer);
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    if (command !== null) socket.write(command + '\r\n');
  });
}

function buildMimeMessage({ from, to, subject, text, attachment }) {
  const boundary = 'empreinte_' + crypto.randomBytes(12).toString('hex');
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    ''
  ];
  if (attachment) {
    const base64 = attachment.buffer.toString('base64');
    const chunked = base64.match(/.{1,76}/g).join('\r\n');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mime}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      chunked,
      ''
    );
  }
  lines.push(`--${boundary}--`, '');
  // Un "." seul en début de ligne termine le message SMTP DATA : on double les
  // points existants en début de ligne pour éviter toute troncature (dot-stuffing).
  return lines.join('\r\n').replace(/\r\n\./g, '\r\n..');
}

async function connect() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';

  if (secure) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port }, () => resolve(socket));
      socket.once('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

async function upgradeToTls(socket, host) {
  const rejectUnauthorized = process.env.SMTP_ALLOW_SELF_SIGNED !== 'true';
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, host, rejectUnauthorized }, () => resolve(secureSocket));
    secureSocket.once('error', reject);
  });
}

/**
 * Envoie un e-mail avec pièce jointe optionnelle.
 * Ne lève jamais d'exception vers l'appelant : retourne { sent: boolean, error?: string }
 * pour ne jamais faire échouer la génération de document si l'e-mail échoue.
 */
async function sendMail({ to, subject, text, attachment }) {
  if (!isConfigured()) {
    return { sent: false, error: "SMTP non configuré (variables SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM absentes)." };
  }
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  let socket;
  try {
    socket = await connect();
    await sendCommand(socket, null, [220]); // bannière serveur
    await sendCommand(socket, `EHLO empreinte.local`, [250]);

    if (process.env.SMTP_SECURE !== 'true') {
      // La plupart des relais (port 587) démarrent en clair puis passent en TLS.
      await sendCommand(socket, 'STARTTLS', [220]);
      socket = await upgradeToTls(socket, host);
      await sendCommand(socket, `EHLO empreinte.local`, [250]);
    }

    await sendCommand(socket, 'AUTH LOGIN', [334]);
    await sendCommand(socket, Buffer.from(user).toString('base64'), [334]);
    await sendCommand(socket, Buffer.from(pass).toString('base64'), [235]);

    await sendCommand(socket, `MAIL FROM:<${from}>`, [250]);
    await sendCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
    await sendCommand(socket, 'DATA', [354]);

    const message = buildMimeMessage({ from, to, subject, text, attachment });
    await sendCommand(socket, message + '\r\n.', [250]);
    await sendCommand(socket, 'QUIT', [221]).catch(() => {}); // best-effort

    socket.end();
    return { sent: true };
  } catch (e) {
    if (socket) try { socket.destroy(); } catch (_) { /* déjà fermé */ }
    return { sent: false, error: e.message };
  }
}

module.exports = { sendMail, isConfigured };
