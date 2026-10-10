/**
 * A local TLS handshake through the fixture, so a broken certificate surfaces here rather than
 * as a confusing failure inside the IMAP or SMTP tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { connect as connectTls } from 'node:tls';

import { startTlsServer } from './helpers/tls-fixture.mjs';

test('the generated certificate is accepted for localhost', async () => {
  const server = await startTlsServer((socket) => {
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`));
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = connectTls({
        host: '127.0.0.1',
        port: server.port,
        servername: 'localhost',
        ca: [server.cert],
      });
      socket.once('secureConnect', () => socket.write('hello'));
      socket.once('error', reject);
      socket.once('data', (chunk) => {
        resolve(chunk.toString('utf8'));
        socket.destroy();
      });
    });
    assert.equal(response, 'echo:hello');
  } finally {
    await server.close();
  }
});

test('a certificate for another host name is rejected', async () => {
  const server = await startTlsServer(() => {});
  try {
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = connectTls({
        host: '127.0.0.1',
        port: server.port,
        servername: 'not-localhost.example',
        ca: [server.cert],
      });
      socket.once('secureConnect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    }), /altnames|Hostname|IP address/i);
  } finally {
    await server.close();
  }
});
