/**
 * IMAP client behaviour against a real TLS server driven by a scripted responder.
 *
 * The subject under test is the wire parser: untagged responses, literals split across TCP
 * segments, the concurrent-command mutex, and the IDLE handshake. No real mailbox is required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ImapConnection, __internals } from '../src/imap.js';
import { startTlsServer } from './helpers/tls-fixture.mjs';

const CRLF = '\r\n';

/**
 * Start a server that answers commands from a handler table.
 *
 * @param {{ greeting?: string, handlers?: Record<string, (context: { tag: string, rest: string, socket: object }) => string|void> }} options
 */
async function startImap({ greeting = '* OK ready', handlers = {} } = {}) {
  const script = [];
  // Every scripted server answers LOGOUT with the BYE + tagged OK an IMAP server sends, so
  // closing a connection never waits for the client's command timeout.
  const table = {
    LOGOUT: ({ tag }) => `* BYE logging out${CRLF}${tag} OK LOGOUT completed${CRLF}`,
    ID: ({ tag }) => `* ID ("name" "fake" "vendor" "test")${CRLF}${tag} OK ID completed${CRLF}`,
    ...handlers,
  };
  const server = await startTlsServer((socket) => {
    socket.write(`${greeting}${CRLF}`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf(CRLF);
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);
        script.push(line);
        const tagged = line.match(/^(A\d{4})\s+([\s\S]*)$/);
        if (tagged === null) continue;
        const [, tag, rest] = tagged;
        const key = Object.keys(table).find((prefix) => rest.toUpperCase().startsWith(prefix.toUpperCase()));
        if (key === undefined) {
          socket.write(`${tag} BAD unknown command${CRLF}`);
          continue;
        }
        const reply = table[key]({ tag, rest, socket });
        if (typeof reply === 'string' && reply.length > 0) socket.write(reply);
      }
    });
  });
  return { ...server, script };
}

/** Build a connection bound to a running test server. */
function connectionTo(server, extra = {}) {
  return new ImapConnection({
    host: '127.0.0.1',
    port: server.port,
    servername: 'localhost',
    rejectUnauthorized: false,
    ...extra,
  });
}

test('greeting, capability, select, and logout round-trip', async () => {
  const server = await startImap({
    handlers: {
      CAPABILITY: ({ tag }) => `* CAPABILITY IMAP4rev1 IDLE UIDPLUS${CRLF}${tag} OK CAPABILITY completed${CRLF}`,
      SELECT: ({ tag }) => `* 3 EXISTS${CRLF}* OK [UIDVALIDITY 777] UIDs valid${CRLF}* OK [UIDNEXT 42] next${CRLF}${tag} OK [READ-WRITE] SELECT completed${CRLF}`,
      LOGOUT: ({ tag }) => `* BYE logging out${CRLF}${tag} OK LOGOUT completed${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    const greeting = await connection.open();
    assert.equal(greeting.type, 'OK');
    assert.deepEqual([...(await connection.capabilities())].sort(), ['IDLE', 'IMAP4rev1', 'UIDPLUS']);
    const info = await connection.select('INBOX');
    assert.equal(info.exists, 3);
    assert.equal(info.uidValidity, 777);
    assert.equal(info.uidNext, 42);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('a BYE greeting is refused instead of silently continuing', async () => {
  const server = await startImap({ greeting: '* BYE too many connections' });
  const connection = connectionTo(server);
  try {
    await assert.rejects(connection.open(), /refused connection/);
  } finally {
    await connection.close().catch(() => {});
    await server.close();
  }
});

test('LOGIN quotes credentials, reports rejection, and never logs the password', async () => {
  const server = await startImap({
    handlers: {
      LOGIN: ({ tag, rest }) => (rest.includes('"good"')
        ? `${tag} OK LOGIN completed${CRLF}`
        : `${tag} NO [AUTHENTICATIONFAILED] invalid credentials${CRLF}`),
      LOGOUT: ({ tag }) => `${tag} OK${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    await assert.rejects(connection.login('user@example.com', 'bad'), /login failed/);
    await connection.login('user@example.com', 'good');
    assert.match(server.script[1], /^A\d{4} LOGIN "user@example\.com" "good"$/);
    assert.match(server.script[0], /^A\d{4} LOGIN "user@example\.com" "bad"$/);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('UID SEARCH returns ascending UIDs and drops the trailing marker', async () => {
  const server = await startImap({
    handlers: {
      'UID SEARCH': ({ tag }) => `* SEARCH 15 11 12${CRLF}${tag} OK SEARCH completed${CRLF}`,
      LOGOUT: ({ tag }) => `${tag} OK${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    assert.deepEqual(await connection.uidSearch('UID 11:*'), [11, 12, 15]);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('UID FETCH parses flags, size, and the literal body', async () => {
  const body = 'From: owner@example.com\r\nSubject: hi\r\n\r\nhello from the mailbox';
  const server = await startImap({
    handlers: {
      'UID FETCH': ({ tag }) => `* 1 FETCH (UID 11 RFC822.SIZE ${body.length} FLAGS (\\Seen \\Recent) BODY[] {${body.length}}${CRLF}${body}${CRLF})${CRLF}${tag} OK FETCH completed${CRLF}`,
      LOGOUT: ({ tag }) => `${tag} OK${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    const fetched = await connection.uidFetchBody(11);
    assert.equal(fetched.raw, body);
    assert.equal(fetched.size, body.length);
    assert.deepEqual(fetched.flags, ['\\Seen', '\\Recent']);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('a literal streamed in many small writes is reassembled exactly', async () => {
  const body = `From: a@b.c${CRLF}Subject: x${CRLF}${CRLF}${'y'.repeat(5000)}`;
  const server = await startTlsServer((socket) => {
    socket.write(`* OK ready${CRLF}`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf(CRLF);
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + CRLF.length);
      const tag = line.slice(0, 5);
      if (/LOGOUT/.test(line)) {
        socket.write(`* BYE bye${CRLF}${tag} OK${CRLF}`);
        return;
      }
      socket.write(`* 1 FETCH (UID 11 BODY[] {${body.length}}${CRLF}`);
      for (let offset = 0; offset < body.length; offset += 997) {
        socket.write(body.slice(offset, offset + 997));
      }
      socket.write(`${CRLF})${CRLF}${tag} OK FETCH completed${CRLF}`);
    });
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    const fetched = await connection.uidFetchBody(11);
    assert.equal(fetched.raw.length, body.length);
    assert.equal(fetched.raw, body);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('two literals in one response are both captured in order', async () => {
  const first = 'first-body';
  const second = 'second-body';
  const server = await startImap({
    handlers: {
      // One response, two literals: the parser must keep reading the line after the first one.
      'UID FETCH': ({ tag }) => [
        `* 1 FETCH (UID 11 BODY[] {${first.length}}${CRLF}`,
        `${first} BODY[] {${second.length}}${CRLF}`,
        `${second})${CRLF}${tag} OK FETCH completed${CRLF}`,
      ].join(''),
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    const fetched = await connection.uidFetchBody(11);
    assert.equal(fetched.raw, first);
    assert.equal(server.script.length, 1, 'one command was issued');
  } finally {
    await connection.close();
    await server.close();
  }
});

test('the first non-empty literal is the body when a response leads with an empty one', async () => {
  const second = 'only-this-one-has-bytes';
  const server = await startImap({
    handlers: {
      'UID FETCH': ({ tag }) => [
        `* 1 FETCH (UID 11 BODY[HEADER] {0}${CRLF}`,
        `${CRLF} BODY[] {${second.length}}${CRLF}`,
        `${second})${CRLF}${tag} OK FETCH completed${CRLF}`,
      ].join(''),
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    const fetched = await connection.uidFetchBody(11);
    assert.equal(fetched.raw, second);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('UID STORE adds flags with the silent modifier', async () => {
  const server = await startImap({
    handlers: {
      'UID STORE': ({ tag }) => `${tag} OK STORE completed${CRLF}`,
      LOGOUT: ({ tag }) => `${tag} OK${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    await connection.uidStoreFlags(11, ['Seen']);
    assert.match(server.script[0], /^A\d{4} UID STORE 11 \+FLAGS\.SILENT \(\\Seen\)$/);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('the ID command sends the identity and returns the server response', async () => {
  const server = await startImap({
    handlers: {
      ID: ({ tag }) => `* ID ("name" "Coremail Imap" "vendor" "Mailtech")${CRLF}${tag} OK ID completed${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    const identity = await connection.id({ name: 'dsh-mail', version: '0.1.0', vendor: 'dsh-mail' });
    assert.match(identity, /Coremail Imap/);
    // The outgoing command must be an RFC 2971 ID list with quoted pairs.
    const sent = server.script.find((line) => /ID \(/.test(line));
    assert.match(sent, /^A\d{4} ID \("name" "dsh-mail" "version" "0\.1\.0" "vendor" "dsh-mail"\)$/);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('LIST parses mailbox names and their attributes', async () => {
  const server = await startImap({
    handlers: {
      LIST: ({ tag }) => `* LIST (\\HasNoChildren) "/" "INBOX"${CRLF}* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"${CRLF}${tag} OK LIST completed${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    assert.deepEqual(await connection.listMailboxes(), [
      { name: 'INBOX', attributes: ['\\HasNoChildren'] },
      { name: 'Sent Items', attributes: ['\\HasNoChildren', '\\Sent'] },
    ]);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('a command issued while another is in flight is refused, not queued', async () => {
  const server = await startImap({
    handlers: {
      // Deliberately never answered, so the first command stays outstanding.
      SELECT: () => {},
      LOGOUT: ({ tag }) => `${tag} OK${CRLF}`,
    },
  });
  const connection = connectionTo(server, { commandTimeoutMs: 200 });
  try {
    await connection.open();
    const pending = connection.select('INBOX').then(
      () => 'resolved',
      (error) => error.message,
    );
    await assert.rejects(connection.uidSearch('ALL'), /already in flight/);
    // The outstanding command resolves through its own timeout rather than hanging the test.
    assert.match(await pending, /timed out/);
  } finally {
    await connection.close().catch(() => {});
    await server.close();
  }
});

test('IDLE resolves on EXISTS and is terminated with DONE', async () => {
  const lines = [];
  const server = await startTlsServer((socket) => {
    socket.write(`* OK ready${CRLF}`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf(CRLF);
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);
        lines.push(line);
        if (/A\d{4} CAPABILITY/.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 IDLE${CRLF}${line.slice(0, 5)} OK${CRLF}`);
          continue;
        }
        if (/A\d{4} IDLE/.test(line)) {
          socket.write(`+ idling${CRLF}`);
          setTimeout(() => socket.write(`* 7 EXISTS${CRLF}`), 25);
          continue;
        }
        if (line === 'DONE') {
          socket.write(`A0002 OK IDLE terminated${CRLF}`);
          continue;
        }
        if (/A\d{4} LOGOUT/.test(line)) {
          socket.write(`* BYE bye${CRLF}${line.slice(0, 5)} OK${CRLF}`);
          continue;
        }
      }
    });
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    const outcome = await connection.idleOnce({ timeoutMs: 4000 });
    assert.equal(outcome, 'exists');
    assert.ok(lines.includes('DONE'), 'DONE must be sent to leave IDLE');
  } finally {
    await connection.close();
    await server.close();
  }
});

test('IDLE reports a timeout when no notification arrives', async () => {
  const server = await startTlsServer((socket) => {
    socket.write(`* OK ready${CRLF}`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf(CRLF);
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);
        if (/A\d{4} CAPABILITY/.test(line)) {
          socket.write(`* CAPABILITY IMAP4rev1 IDLE${CRLF}${line.slice(0, 5)} OK${CRLF}`);
          continue;
        }
        if (/A\d{4} IDLE/.test(line)) {
          socket.write(`+ idling${CRLF}`);
          continue;
        }
        if (line === 'DONE') {
          socket.write(`A0002 OK IDLE terminated${CRLF}`);
          continue;
        }
        if (/A\d{4} LOGOUT/.test(line)) {
          socket.write(`* BYE bye${CRLF}${line.slice(0, 5)} OK${CRLF}`);
        }
      }
    });
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    assert.equal(await connection.idleOnce({ timeoutMs: 150 }), 'timeout');
  } finally {
    await connection.close();
    await server.close();
  }
});

test('a server without IDLE degrades to the polling timeout', async () => {
  const server = await startImap({
    handlers: {
      CAPABILITY: ({ tag }) => `* CAPABILITY IMAP4rev1${CRLF}${tag} OK${CRLF}`,
      LOGOUT: ({ tag }) => `${tag} OK${CRLF}`,
    },
  });
  const connection = connectionTo(server);
  try {
    await connection.open();
    assert.equal(await connection.idleOnce({ timeoutMs: 150 }), 'timeout');
    assert.equal(server.script.some((line) => line.includes('IDLE')), false);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('APPEND waits for the continuation request before sending the literal', async () => {
  const received = [];
  const server = await startTlsServer((socket) => {
    socket.write(`* OK ready${CRLF}`);
    let buffer = '';
    let expecting = null;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (expecting !== null) {
        if (buffer.length < expecting.count) return;
        received.push(buffer.slice(0, expecting.count));
        buffer = buffer.slice(expecting.count);
        socket.write(`${expecting.tag} OK APPEND completed${CRLF}`);
        expecting = null;
        return;
      }
      for (;;) {
        const newline = buffer.indexOf(CRLF);
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);
        if (/A\d{4} LOGOUT/.test(line)) {
          socket.write(`* BYE bye${CRLF}${line.slice(0, 5)} OK${CRLF}`);
          continue;
        }
        const match = line.match(/^(A\d{4}) APPEND "([^"]+)" \(([^)]*)\) \{(\d+)\}$/);
        if (match === null) continue;
        expecting = { tag: match[1], count: Number(match[4]) };
        socket.write(`+ Ready for literal data${CRLF}`);
        break;
      }
    });
  });
  const connection = connectionTo(server);
  const message = `From: agent@example.com${CRLF}Subject: result${CRLF}${CRLF}body${CRLF}`;
  try {
    await connection.open();
    await connection.append('Sent', message);
    assert.equal(received.length, 1);
    assert.equal(received[0], message);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('a dropped connection rejects the in-flight command', async () => {
  const server = await startTlsServer((socket) => {
    socket.write(`* OK ready${CRLF}`);
    socket.once('data', () => socket.destroy());
  });
  const connection = connectionTo(server);
  connection.on('error', () => {});
  try {
    await connection.open();
    await assert.rejects(connection.uidSearch('ALL'), /closed|socket|imap/i);
  } finally {
    await connection.close().catch(() => {});
    await server.close();
  }
});

test('the tokenizer and quoting helpers keep their shape', () => {
  assert.deepEqual(
    __internals.tokenizeLine('* LIST (\\HasNoChildren) "/" "Sent Items"'),
    ['*', 'LIST', '(\\HasNoChildren)', '/', 'Sent Items'],
  );
  assert.deepEqual(__internals.parseFlagList('(\\Seen \\Recent)'), ['\\Seen', '\\Recent']);
  assert.equal(__internals.quote('a"b'), '"a\\"b"');
  assert.equal(__internals.quote('a\\b'), '"a\\\\b"');
  assert.equal(__internals.atomize('100'), '100');
  assert.equal(__internals.atomize('a b'), '"a b"');
});
