/**
 * A throwaway TLS fixture: a self-signed certificate generated in-process, so the protocol
 * tests can exercise the real clients over the real TLS stack without shipping key material or
 * depending on an external `openssl` binary.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, X509Certificate } from 'node:crypto';
import { createServer } from 'node:tls';

/**
 * DER-encode one ASN.1 length.
 * @param {number} length
 */
function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Wrap content in one DER TLV triple. */
function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

/** Encode an OID from its dotted form. */
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const first = 40 * parts[0] + parts[1];
  const rest = parts.slice(2);
  const bytes = [first];
  for (const part of rest) {
    const stack = [];
    let value = part;
    do {
      stack.unshift(value & 0x7f);
      value >>= 7;
    } while (value > 0);
    for (let i = 0; i < stack.length - 1; i += 1) stack[i] |= 0x80;
    bytes.push(...stack);
  }
  return der(0x06, bytes);
}

/** Encode a DER integer. */
function derInteger(value) {
  const bytes = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  } while (remaining > 0);
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0);
  return der(0x02, bytes);
}

/** Encode a DER UTF8String. */
function derUtf8(value) {
  return der(0x0c, Buffer.from(value, 'utf8'));
}

/** Encode a DER SEQUENCE of already-encoded children. */
function derSequence(children) {
  return der(0x30, Buffer.concat(children));
}

/** Encode a DER SET of already-encoded children. */
function derSet(children) {
  return der(0x31, Buffer.concat(children));
}

/** Encode UTCTime for a date. */
function derTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

/** One `AttributeTypeAndValue` for a common name. */
function commonName(value) {
  return derSequence([oid('2.5.4.3'), derUtf8(value)]);
}

/** `[context]` explicit/implicit wrapper used by the extensions field. */
function contextTag(tagNumber, content, constructed = true) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([
    Buffer.from([(constructed ? 0xa0 : 0x80) | tagNumber]),
    derLength(body.length),
    body,
  ]);
}

/**
 * `[n]` EXPLICIT wrapper around already-encoded content.
 * @param {number} tagNumber
 * @param {Buffer} content
 */
function explicitTag(tagNumber, content) {
  return Buffer.concat([
    Buffer.from([0xa0 | tagNumber]),
    derLength(content.length),
    content,
  ]);
}

/** Derive the public key BIT STRING (unused bits octet + SubjectPublicKeyInfo). */
function bitString(content, unusedBits = 0) {
  return der(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
}

/**
 * Build a self-signed certificate for `localhost`.
 *
 * The DER is assembled by hand because Node ships no X.509 encoder and the fixture must not
 * depend on an external `openssl` binary. Only `subjectAltName` is emitted: OpenSSL's strict
 * X.509 parser rejects a hand-rolled `basicConstraints`, and hostname matching — the one thing
 * these tests need — is driven entirely by SAN.
 *
 * @returns {{ key: string, cert: string }}
 */
export function selfSignedCertificate() {
  // EC P-256 rather than RSA: a test server is created per case, and RSA-2048 key generation
  // is slow enough (and occasionally slow enough to look like a hang) to dominate the suite.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const name = derSequence([
    derSet([commonName('localhost')]),
  ]);

  const notBefore = new Date(Date.now() - 3600_000);
  const notAfter = new Date(Date.now() + 24 * 3600_000);
  const validity = derSequence([derTime(notBefore), derTime(notAfter)]);

  // dNSName is `[2]` IMPLICIT IA5String: the tag replaces the string's own tag.
  const dnsName = Buffer.concat([Buffer.from([0x82, 0x09]), Buffer.from('localhost', 'ascii')]);
  const subjectAltName = derSequence([
    oid('2.5.29.17'),
    der(0x04, derSequence([dnsName])),
  ]);
  const extensions = explicitTag(3, derSequence([subjectAltName]));

  // ecdsa-with-SHA256
  const signatureAlgorithm = derSequence([oid('1.2.840.10045.4.3.2')]);

  const tbsCertificate = derSequence([
    contextTag(0, derInteger(2), true),
    derInteger(serialNumber()),
    signatureAlgorithm,
    name,
    validity,
    name,
    spki,
    extensions,
  ]);

  const signature = sign('sha256', tbsCertificate, privateKey);
  const certificate = derSequence([
    tbsCertificate,
    signatureAlgorithm,
    bitString(signature),
  ]);

  const certPem = `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----\n`;
  // Sanity check: the certificate must parse, or the tests would fail confusingly deep in TLS.
  new X509Certificate(certPem);
  return { key: keyPem, cert: certPem };
}

/** A positive serial number; a fixed 0x1234 risks rejection by strict parsers. */
function serialNumber() {
  return 0x0100000000000000 + Math.floor(Math.random() * 0xffff);
}

/**
 * Start a TLS server that hands each connection to `handler`.
 *
 * Every socket is tracked so that `close()` is decisive: a test that fails mid-handshake would
 * otherwise leave a live socket holding the event loop open.
 *
 * @param {(socket: import('node:tls').TLSSocket) => void} handler
 * @returns {Promise<{ port: number, cert: string, close: () => Promise<void> }>}
 */
export async function startTlsServer(handler) {
  const { key, cert } = selfSignedCertificate();
  const sockets = new Set();
  const server = createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    cert,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

export const __internals = { der, derSequence, oid };
