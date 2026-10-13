import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';

// A small, fixed X.509 profile. No shell, certificate store or external CA is
// involved: trust is established explicitly through the out-of-band SHA256 pin.
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  const bytes = []; let size = body.length;
  do { bytes.unshift(size & 255); size >>>= 8; } while (size);
  return Buffer.concat([Buffer.from([tag, ...(body.length < 128 ? [body.length] : [128 | bytes.length, ...bytes])]), body]);
};
const sequence = (...parts) => der(0x30, ...parts);
const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
const algorithm = () => sequence(oid('2a8648ce3d040302'));
const pem = (label, value) => `-----BEGIN ${label}-----\n${value.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
export const certificatePin = raw => createHash('sha256').update(raw).digest('hex');

export function createPeerCertificate(deviceId) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = sequence(der(0x31, sequence(oid('550403'), der(0x0c, `Netzwerk-Kompass ${deviceId}`))));
  const serial = randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1;
  const validity = sequence(der(0x18, '20200101000000Z'), der(0x18, '21200101000000Z'));
  const tbs = sequence(der(0xa0, der(0x02, [2])), der(0x02, serial), algorithm(), subject, validity, subject,
    publicKey.export({ type: 'spki', format: 'der' }));
  const raw = sequence(tbs, algorithm(), der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', raw), pin: certificatePin(raw) };
}

export function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Connect and verify the peer pin BEFORE writing even the first HTTP byte.
// checkServerIdentity alone is not invoked for a self-signed chain by Node.
export function pinnedRequest({ address, port, pin }, route, body, { signal } = {}) {
  if (!isPrivateAddress(address) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/i.test(pin)) return Promise.reject(new Error('Ungültige LAN-Adresse, Port oder Zertifikat-Fingerabdruck.'));
  const payload = Buffer.from(JSON.stringify(body));
  if (payload.length > 98304) return Promise.reject(new Error('Peer-Anfrage ist zu groß.'));
  return new Promise((resolve, reject) => {
    let settled = false, request;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      request?.destroy(); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('Peer-Verbindung beendet.'));
    const socket = tls.connect({ host: address, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => finish(new Error('Peer-Verbindung antwortet nicht.')), 8000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.on('error', error => finish(new Error(`Verschlüsselte Peer-Verbindung fehlgeschlagen (${error.code || 'TLS'}).`)));
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      if (!certificate.raw || certificatePin(certificate.raw) !== pin.toLowerCase()) return finish(new Error('Zertifikat-Fingerabdruck stimmt nicht überein.'));
      const agent = new https.Agent({ keepAlive: true });
      agent.createConnection = () => socket;
      request = https.request({ method: 'POST', host: address, port, path: route, agent,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, connection: 'keep-alive' } }, response => {
        const parts = []; let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 98304) finish(new Error('Peer-Antwort ist zu groß.')); else parts.push(chunk); });
        response.on('error', () => finish(new Error('Peer-Antwort abgebrochen.')));
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
            if (response.statusCode !== 200) throw new Error(result.error || `Peer-Anfrage fehlgeschlagen (${response.statusCode}).`);
            finish(null, result);
          } catch (error) { finish(error); }
        });
      });
      request.on('error', () => finish(new Error('Peer-Anfrage abgebrochen.')));
      request.end(payload);
    });
  });
}
