/**
 * SMTP client and outgoing-message construction.
 *
 * The wire behaviour (multiline replies, AUTH mechanism choice, DATA framing) and the message
 * shape (threading headers, MIME attachments) are both verified here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SmtpClient, dotStuff, foldHeader, formatDate, sanitizeHeaderValue } from '../src/smtp.js';
import { Mailer, buildMessage, mediaTypeOf, newMessageId, stripSubjectTag, tagFromSubject, tagSubject } from '../src/outgoing.js';
import { startTlsServer } from './helpers/tls-fixture.mjs';

/** Decode the body a built message carries, whichever transfer encoding it used. */
function decodeBody(message) {
  const [headerText, rawBody = ''] = message.split('\r\n\r\n');
  const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(headerText)?.[1]?.toLowerCase();
  if (encoding === 'base64') return Buffer.from(rawBody.replace(/\s+/g, ''), 'base64').toString('utf8');
  return rawBody;
}

const CRLF = '\r\n';

/**
 * A scripted SMTP server: replies to EHLO, runs a real AUTH dance, and records DATA.
 *
 * @param {{ authMechanism?: string, failAt?: string }} [options]
 */
async function startSmtp({ authMechanism = 'PLAIN', failAt } = {}) {
  const transcript = [];
  /** Lines received inside DATA (the terminator is not recorded). */
  const body = [];
  const server = await startTlsServer((socket) => {
    socket.write(`220 test.local ESMTP ready${CRLF}`);
    let buffer = '';
    let inData = false;
    let authStep = 0;

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf(CRLF);
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write(failAt === 'data' ? `550 rejected${CRLF}` : `250 2.0.0 Ok queued${CRLF}`);
            continue;
          }
          body.push(line);
          continue;
        }

        transcript.push(line);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO')) {
          socket.write([
            '250-test.local greets you',
            '250-SIZE 35882577',
            `250-AUTH ${authMechanism}`,
            '250 8BITMIME',
          ].join(CRLF) + CRLF);
          continue;
        }

        // AUTH: the outgoing mechanism line starts the dance; continuation replies follow.
        if (upper.startsWith('AUTH ')) {
          authStep = 1;
          socket.write(authMechanism === 'CRAM-MD5'
            ? `334 PDE4OTYuNjk3MTcwOTUyQHBvc3RvZmZpY2U+${CRLF}`
            : authMechanism === 'LOGIN' && upper === 'AUTH LOGIN'
              ? `334 VXNlcm5hbWU6${CRLF}`
              : `235 2.7.0 Accepted${CRLF}`);
          continue;
        }
        if (authStep === 1 && authMechanism === 'LOGIN') {
          authStep = 2;
          socket.write(`334 UGFzc3dvcmQ6${CRLF}`);
          continue;
        }
        if (authStep >= 1) {
          authStep = 0;
          socket.write(`235 2.7.0 Accepted${CRLF}`);
          continue;
        }

        if (upper.startsWith('MAIL FROM')) {
          socket.write(failAt === 'mail' ? `550 sender rejected${CRLF}` : `250 2.1.0 Ok${CRLF}`);
          continue;
        }
        if (upper.startsWith('RCPT TO')) {
          socket.write(failAt === 'rcpt' ? `550 no such user${CRLF}` : `250 2.1.5 Ok${CRLF}`);
          continue;
        }
        if (upper.startsWith('DATA')) {
          inData = true;
          socket.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
          continue;
        }
        if (upper.startsWith('QUIT')) {
          socket.write(`221 2.0.0 Bye${CRLF}`);
          socket.end();
          continue;
        }
        socket.write(`500 unrecognized${CRLF}`);
      }
    });
  });
  return { ...server, transcript, body };
}

/** A client bound to a running test server. */
function clientTo(server) {
  return new SmtpClient({
    host: '127.0.0.1',
    port: server.port,
    servername: 'localhost',
    rejectUnauthorized: false,
    replyTimeoutMs: 400,
  });
}

test('multiline EHLO replies are joined, codes stripped, and extensions parsed', async () => {
  const server = await startSmtp();
  const client = clientTo(server);
  try {
    await client.open();
    const extensions = await client.ehlo('dsh.local');
    assert.deepEqual(extensions, ['SIZE 35882577', 'AUTH PLAIN', '8BITMIME']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('an EHLO failure is reported rather than silently ignored', async () => {
  const server = await startTlsServer((socket) => {
    socket.write(`220 ready${CRLF}`);
    socket.once('data', () => socket.write(`550 go away${CRLF}`));
  });
  const client = clientTo(server);
  try {
    await client.open();
    await assert.rejects(client.ehlo(), /EHLO rejected/);
    // The server will not answer anything else, so tear the connection down instead of
    // waiting out the reply timeout inside close().
    await client.close();
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});

test('DATA dot-stuffs a body line that starts with a period', async () => {
  const server = await startSmtp();
  const client = clientTo(server);
  try {
    await client.open();
    await client.ehlo();
    await client.authenticate('agent@example.com', 'secret', ['AUTH PLAIN LOGIN']);
    await client.send({
      from: 'agent@example.com',
      to: ['owner@example.com'],
      message: `Subject: x${CRLF}${CRLF}.hidden line${CRLF}normal line`,
    });
    // The whole DATA payload is recorded, so the check is on the body lines it contains.
    assert.deepEqual(
      server.body.filter((line) => !line.startsWith('Subject:') && line.length > 0),
      ['..hidden line', 'normal line'],
    );
    assert.equal(server.body.includes('.'), false, 'the terminator is not part of the body');
  } finally {
    await client.close();
    await server.close();
  }
});

test('AUTH PLAIN is used when offered and the password rides in the token', async () => {
  const server = await startSmtp({ authMechanism: 'PLAIN' });
  const client = clientTo(server);
  try {
    await client.open();
    const extensions = await client.ehlo();
    await client.authenticate('agent@example.com', 'secret', extensions);
    const authLine = server.transcript.find((line) => line.startsWith('AUTH PLAIN'));
    assert.ok(authLine !== undefined);
    const token = Buffer.from(authLine.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
    assert.equal(token, '\u0000agent@example.com\u0000secret');
  } finally {
    await client.close();
    await server.close();
  }
});

test('AUTH LOGIN is chosen when PLAIN is unavailable', async () => {
  const server = await startSmtp({ authMechanism: 'LOGIN' });
  const client = clientTo(server);
  try {
    await client.open();
    const extensions = await client.ehlo();
    await client.authenticate('agent@example.com', 'secret', extensions);
    assert.equal(server.transcript.some((line) => line.startsWith('AUTH LOGIN')), true);
    // The username must be base64 rather than plaintext.
    assert.equal(server.transcript.some((line) => line === 'agent@example.com'), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('AUTH CRAM-MD5 never puts the password on the wire', async () => {
  const server = await startSmtp({ authMechanism: 'CRAM-MD5' });
  const client = clientTo(server);
  try {
    await client.open();
    const extensions = await client.ehlo();
    await client.authenticate('agent@example.com', 'secret', extensions);
    assert.equal(server.transcript.some((line) => line.includes('secret')), false);
    assert.equal(server.transcript.some((line) => line.startsWith('AUTH CRAM-MD5')), true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a server offering no supported mechanism is refused', async () => {
  const server = await startTlsServer((socket) => {
    socket.write(`220 ready${CRLF}`);
    socket.on('data', (chunk) => {
      const line = chunk.toString('utf8');
      if (/EHLO/i.test(line)) socket.write(`250-test.local${CRLF}250 AUTH XOAUTH2${CRLF}`);
      if (/QUIT/i.test(line)) socket.write(`221 Bye${CRLF}`);
    });
  });
  const client = clientTo(server);
  try {
    await client.open();
    const extensions = await client.ehlo();
    await assert.rejects(client.authenticate('a@b.c', 'x', extensions), /no supported AUTH mechanism/);
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});

test('a rejected sender or recipient surfaces as an error', async () => {
  const server = await startSmtp({ failAt: 'mail' });
  const client = clientTo(server);
  try {
    await client.open();
    await client.ehlo();
    await assert.rejects(
      client.send({ from: 'agent@example.com', to: ['owner@example.com'], message: 'x' }),
      /MAIL FROM rejected/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('a rejected recipient aborts before DATA', async () => {
  const server = await startSmtp({ failAt: 'rcpt' });
  const client = clientTo(server);
  try {
    await client.open();
    await client.ehlo();
    await assert.rejects(
      client.send({ from: 'agent@example.com', to: ['nobody@example.com'], message: 'x' }),
      /RCPT TO/,
    );
    assert.equal(server.transcript.some((line) => line.startsWith('DATA')), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a 5xx after DATA is reported as a rejection', async () => {
  const server = await startSmtp({ failAt: 'data' });
  const client = clientTo(server);
  try {
    await client.open();
    await client.ehlo();
    await assert.rejects(
      client.send({ from: 'agent@example.com', to: ['owner@example.com'], message: 'body' }),
      /message rejected/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('an unexpected banner is refused', async () => {
  const server = await startTlsServer((socket) => socket.write(`421 not now${CRLF}`));
  const client = clientTo(server);
  try {
    await assert.rejects(client.open(), /unexpected banner/);
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});

test('dotStuff escapes only the message\'s own leading dots', () => {
  assert.equal(dotStuff('.a\n..b\n'), `..a${CRLF}...b${CRLF}.${CRLF}`);
  assert.equal(dotStuff('plain\nbody'), `plain${CRLF}body${CRLF}.${CRLF}`);
  assert.equal(dotStuff(''), `${CRLF}.${CRLF}`);
});

test('header values cannot smuggle extra headers', () => {
  assert.equal(sanitizeHeaderValue('a\r\nBcc: x'), 'a Bcc: x');
  const folded = foldHeader('Subject', 'x\r\nX-Evil: 1');
  assert.equal(folded.includes('\r\nX-Evil'), false);
});

test('the Date header pairs local time with the local offset', () => {
  // The time-of-day and the offset must describe the same clock, so a date built from local
  // components round-trips exactly whatever the machine's zone is.
  const local = new Date(2025, 0, 2, 3, 4, 5); // 2 Jan 2025, 03:04:05 local
  const formatted = formatDate(local);
  assert.match(formatted, /^Thu, 02 Jan 2025 03:04:05 [+-]\d{4}$/);

  const offsetMinutes = -local.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const expectedOffset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}${String(absolute % 60).padStart(2, '0')}`;
  assert.ok(formatted.endsWith(expectedOffset), `${formatted} should end with ${expectedOffset}`);

  // A given instant must render its local wall clock; emitting UTC fields beside a local offset
  // (the previous bug) put the timestamp hours off for every recipient outside UTC.
  const instant = new Date('2025-06-15T00:00:00Z');
  assert.ok(
    formatted.includes(String(local.getHours()).padStart(2, '0')),
    'the hour must be the local hour',
  );
  assert.match(formatDate(instant), new RegExp(`\\b${String(instant.getHours()).padStart(2, '0')}:`));
});

test('buildMessage sets threading headers and never leaks a newline', async () => {
  const message = await buildMessage({
    from: 'agent@example.com',
    fromName: 'DSH Agent',
    to: 'owner@example.com',
    subject: tagSubject('Re: topic', 'a3f9'),
    text: 'hello',
    messageId: '<dsh.abc@example.com>',
    inReplyTo: '<parent@example.com>',
    references: ['<root@example.com>', '<parent@example.com>'],
    tag: 'a3f9',
    receipt: 'abc123',
  });
  assert.match(message, /^From: DSH Agent <agent@example\.com>\r\n/m);
  assert.match(message, /^Subject: Re: \[dsh-a3f9\] topic\r\n/m);
  assert.match(message, /^In-Reply-To: <parent@example\.com>\r\n/m);
  assert.match(message, /^References: <root@example\.com> <parent@example\.com>\r\n/m);
  assert.match(message, /^X-DSH-Session: a3f9\r\n/m);
  assert.match(message, /^X-DSH-Receipt: abc123\r\n/m);
  assert.match(message, /^Auto-Submitted: no\r\n/m);
  assert.match(message, /Content-Type: text\/plain; charset=UTF-8/);
  assert.equal(decodeBody(message), 'hello\r\n');
});

test('the text body is base64 so the wire stays pure ASCII', async () => {
  // Multi-byte text must survive any encoding layer between this process and the submission
  // server, so the entity is base64 rather than 8bit. This is the regression guard for that.
  const text = '收到，这是中文正文。\n- 要点一\n';
  const message = await buildMessage({
    from: 'agent@example.com',
    to: 'owner@example.com',
    subject: '中文主题',
    text,
    messageId: '<dsh.abc@example.com>',
  });
  assert.match(message, /^Content-Transfer-Encoding: base64\r\n/m);
  const [, rawBody = ''] = message.split('\r\n\r\n');
  assert.match(rawBody, /^[A-Za-z0-9+/=\r\n]+$/, 'the wire body must be pure ASCII');
  assert.equal(decodeBody(message), text.replace(/\n/g, '\r\n'));
});

test('the channel reads back its own base64 body unchanged', async () => {
  const text = '收到，这是中文正文。\n第二行：测试。\n- 要点一\n';
  const message = await buildMessage({
    from: 'agent@example.com',
    to: 'owner@example.com',
    subject: '中文主题',
    text,
    messageId: '<dsh.abc@example.com>',
  });
  const { parseMessage, extractBodyText } = await import('../src/mime.js');
  const body = extractBodyText(parseMessage(message), message, { stripQuotes: false });
  assert.equal(body.text, text.replace(/\n/g, '\r\n').trimEnd());
});

test('a non-ASCII subject is encoded and a long subject is folded', async () => {
  const message = await buildMessage({
    from: 'agent@example.com',
    to: 'owner@example.com',
    subject: `${'很长的主题 '.repeat(12)}`,
    text: 'x',
    messageId: '<dsh.abc@example.com>',
  });
  const subjectLines = message.split(CRLF).filter((line) => line.startsWith('Subject:') || line.startsWith(' '));
  assert.ok(subjectLines.some((line) => line.startsWith('Subject: =?UTF-8?B?')));
  assert.equal(subjectLines.some((line) => line.includes('很长的主题')), false);
});

test('attachments become a multipart body with base64 payloads', async () => {
  const message = await buildMessage({
    from: 'agent@example.com',
    to: 'owner@example.com',
    subject: 'with attachment',
    text: 'see attached',
    messageId: '<dsh.abc@example.com>',
    attachments: [{ name: 'report.txt', data: Buffer.from('attachment bytes'), mediaType: 'text/plain' }],
  });
  assert.match(message, /Content-Type: multipart\/mixed; boundary="dsh-/);
  assert.match(message, /Content-Type: text\/plain; name="report\.txt"/);
  // Mail clients read the file name from Content-Disposition, so it must be present.
  assert.match(message, /Content-Disposition: attachment; filename="report\.txt"/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  assert.match(message, new RegExp(Buffer.from('attachment bytes').toString('base64').slice(0, 12)));
  assert.equal(message.includes('--dsh-'), true);
});

test('a non-ASCII attachment name uses RFC 2231 encoding', async () => {
  const message = await buildMessage({
    from: 'agent@example.com',
    to: 'owner@example.com',
    subject: 's',
    text: 't',
    messageId: '<dsh.abc@example.com>',
    attachments: [{ name: '报告.txt', data: Buffer.from('x'), mediaType: 'text/plain' }],
  });
  assert.match(message, /filename\*=utf-8''%E6%8A%A5%E5%91%8A\.txt/);
  assert.equal(message.includes('报告.txt'), false);
});

test('mediaTypeOf maps the common extensions', () => {
  assert.equal(mediaTypeOf('a.txt'), 'text/plain');
  assert.equal(mediaTypeOf('a.PDF'), 'application/pdf');
  assert.equal(mediaTypeOf('sheet.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(mediaTypeOf('unknown.bin'), 'application/octet-stream');
  assert.equal(mediaTypeOf('noextension'), 'application/octet-stream');
});

test('newMessageId is unique and carries the sender domain', () => {
  const first = newMessageId('agent@example.com');
  const second = newMessageId('agent@example.com');
  assert.notEqual(first, second);
  assert.match(first, /^<dsh\.[0-9a-f]+@example\.com>$/);
});

test('subject helpers handle repeated tags and localized reply prefixes', () => {
  assert.equal(stripSubjectTag('Re: [dsh-a3f9] x', '[dsh-'), 'Re: x');
  assert.equal(tagSubject('回复: [dsh-b001] 主题', 'b001'), '回复: [dsh-b001] 主题');
  assert.equal(tagFromSubject('答复: [dsh-b001] 主题'), 'b001');
});

test('Mailer delivers through SMTP and reports the Sent-folder sink', async () => {
  const server = await startSmtp();
  const appended = [];
  const mailer = new Mailer({
    smtp: {
      host: '127.0.0.1',
      port: server.port,
      secure: true,
      user: 'agent@example.com',
      password: 'secret',
      rejectUnauthorized: false,
      saveToSent: true,
    },
    from: 'agent@example.com',
    fromName: 'DSH Agent',
    onSent: async (message) => {
      appended.push(message);
    },
  });
  const result = await mailer.send({
    to: 'owner@example.com',
    subject: '[dsh-a3f9] result',
    text: 'the answer',
    messageId: '<dsh.one@example.com>',
    tag: 'a3f9',
  });
  assert.equal(result.accepted, true);
  assert.equal(appended.length, 1);
  assert.equal(decodeBody(appended[0]), 'the answer\r\n');
  await server.close();
});

test('a failing Sent-folder sink does not fail the delivery', async () => {
  const server = await startSmtp();
  const warnings = [];
  const mailer = new Mailer({
    smtp: {
      host: '127.0.0.1',
      port: server.port,
      user: 'agent@example.com',
      password: 'secret',
      rejectUnauthorized: false,
    },
    from: 'agent@example.com',
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    onSent: async () => {
      throw new Error('mailbox full');
    },
  });
  const result = await mailer.send({ to: 'owner@example.com', subject: 's', text: 't', messageId: '<dsh.two@example.com>', tag: 'b001' });
  assert.equal(result.accepted, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not append to Sent/);
  await server.close();
});
