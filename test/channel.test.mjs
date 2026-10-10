/**
 * End-to-end channel behaviour.
 *
 * A real TLS IMAP server, a real TLS SMTP server, and a stub Host session controller are wired
 * together through the plugin's own `apply()`. This is where the design claims are checked:
 * whitelist enforcement, new-session creation, receipt contents, threading headers,
 * interruption of a running turn, attachments, and crash replay.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/index.js';
import { MailStore } from '../src/store.js';
import { startTlsServer } from './helpers/tls-fixture.mjs';

const CRLF = '\r\n';

/* ------------------------------------------------------------------ *
 * Scripted IMAP server
 * ------------------------------------------------------------------ */

/**
 * An IMAP server serving a fixed message set and recording what the client did.
 *
 * The message list is held by reference so a test can drop another message into the mailbox
 * while the channel is running, which is how the interrupt path is exercised.
 *
 * @param {{ messages?: Array<{ uid: number, raw: string }> }} [options]
 */
async function fakeImap({ messages = [] } = {}) {
  const visible = [...messages];
  const seen = [];
  const appended = [];
  const commands = [];

  const server = await startTlsServer((socket) => {
    socket.write(`* OK fake IMAP ready${CRLF}`);
    let buffer = '';
    let pendingAppend = null;

    const handle = (line) => {
      const tagged = line.match(/^(A\d{4})\s+([\s\S]*)$/);
      if (tagged === null) return;
      const [, tag, rest] = tagged;
      commands.push(rest);
      const upper = rest.toUpperCase();

      if (upper.startsWith('LOGIN')) {
        socket.write(`${tag} OK LOGIN completed${CRLF}`);
        return;
      }
      if (upper.startsWith('CAPABILITY')) {
        socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN ID SPECIAL-USE${CRLF}${tag} OK${CRLF}`);
        return;
      }
      if (upper.startsWith('ID')) {
        socket.write(`* ID ("name" "fake")${CRLF}${tag} OK ID completed${CRLF}`);
        return;
      }
      if (upper.startsWith('SELECT')) {
        socket.write(`* ${visible.length} EXISTS${CRLF}* OK [UIDVALIDITY 42] valid${CRLF}${tag} OK [READ-WRITE] SELECT${CRLF}`);
        return;
      }
      if (upper.startsWith('LIST')) {
        socket.write([
          `* LIST (\\HasNoChildren) "/" "INBOX"`,
          `* LIST (\\HasNoChildren \\Sent) "/" "Sent"`,
          `${tag} OK LIST${CRLF}`,
        ].join(CRLF));
        return;
      }
      if (upper.startsWith('UID SEARCH')) {
        const uids = visible.map((message) => message.uid).sort((left, right) => left - right);
        socket.write(`* SEARCH${uids.length > 0 ? ` ${uids.join(' ')}` : ''}${CRLF}${tag} OK SEARCH${CRLF}`);
        return;
      }
      if (upper.startsWith('UID FETCH')) {
        const uid = Number(rest.match(/UID FETCH (\d+)/i)?.[1] ?? 0);
        const raw = visible.find((message) => message.uid === uid)?.raw;
        if (raw === undefined) {
          socket.write(`${tag} NO no such message${CRLF}`);
          return;
        }
        const size = Buffer.byteLength(raw, 'utf8');
        socket.write(Buffer.concat([
          Buffer.from(`* 1 FETCH (UID ${uid} RFC822.SIZE ${size} FLAGS () BODY[] {${size}}${CRLF}`, 'utf8'),
          Buffer.from(raw, 'utf8'),
          Buffer.from(`${CRLF})${CRLF}${tag} OK FETCH completed${CRLF}`, 'utf8'),
        ]));
        return;
      }
      if (upper.startsWith('UID STORE')) {
        seen.push(Number(rest.match(/UID STORE (\d+)/i)?.[1] ?? 0));
        socket.write(`${tag} OK STORE${CRLF}`);
        return;
      }
      if (upper.startsWith('APPEND')) {
        // The literal size is on the command line; the payload is then consumed by byte count,
        // because a message body legitimately contains blank lines.
        pendingAppend = { tag, remaining: Number(rest.match(/\{(\d+)\}$/)?.[1] ?? 0), text: '' };
        socket.write(`+ Ready for literal data${CRLF}`);
        return;
      }
      if (upper.startsWith('LOGOUT')) {
        socket.write(`* BYE bye${CRLF}${tag} OK LOGOUT${CRLF}`);
        return;
      }
      socket.write(`${tag} BAD unknown${CRLF}`);
    };

    socket.on('data', (chunk) => {
      if (pendingAppend !== null) {
        const text = chunk.toString('utf8');
        pendingAppend.text += text;
        pendingAppend.remaining -= Buffer.byteLength(text, 'utf8');
        if (pendingAppend.remaining > 0) return;
        appended.push(pendingAppend.text.replace(/\r\n/g, '\n'));
        socket.write(`${pendingAppend.tag} OK APPEND completed${CRLF}`);
        pendingAppend = null;
        return;
      }
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf(CRLF);
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);
        handle(line);
      }
    });
  });

  return {
    ...server,
    seen,
    appended,
    commands,
    /** Add one message to the mailbox mid-run. */
    deliver(uid, raw) {
      visible.push({ uid, raw });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Scripted SMTP server
 * ------------------------------------------------------------------ */

/** An SMTP server that accepts everything and records each delivered message. */
async function fakeSmtp() {
  const delivered = [];
  const server = await startTlsServer((socket) => {
    socket.write(`220 fake SMTP ready${CRLF}`);
    let buffer = '';
    let inData = false;
    let current = [];
    let recipients = [];
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
            const raw = current.join('\n');
            const [headerText, wireBody = ''] = raw.split('\n\n');
            const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(headerText ?? '')?.[1]?.toLowerCase();
            // The channel sends base64 bodies; decode them so assertions can read the text.
            const body = encoding === 'base64'
              ? Buffer.from(wireBody.replace(/\s+/g, ''), 'base64').toString('utf8')
              : wireBody;
            delivered.push({ text: raw, body, headers: headerText ?? '', recipients: [...recipients] });
            current = [];
            recipients = [];
            socket.write(`250 2.0.0 Ok queued${CRLF}`);
            continue;
          }
          current.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write(['250-fake', '250-AUTH PLAIN', '250 8BITMIME'].join(CRLF) + CRLF);
          continue;
        }
        if (upper.startsWith('AUTH')) {
          socket.write(`235 2.7.0 Accepted${CRLF}`);
          continue;
        }
        if (upper.startsWith('MAIL FROM')) {
          socket.write(`250 2.1.0 Ok${CRLF}`);
          continue;
        }
        if (upper.startsWith('RCPT TO')) {
          recipients.push(line.replace(/^RCPT TO:</i, '').replace(/>$/, ''));
          socket.write(`250 2.1.5 Ok${CRLF}`);
          continue;
        }
        if (upper.startsWith('DATA')) {
          inData = true;
          socket.write(`354 go${CRLF}`);
          continue;
        }
        if (upper.startsWith('QUIT')) {
          socket.write(`221 bye${CRLF}`);
          socket.end();
          continue;
        }
        socket.write(`500 ?${CRLF}`);
      }
    });
  });
  return { ...server, delivered };
}

/* ------------------------------------------------------------------ *
 * Host stubs
 * ------------------------------------------------------------------ */

/**
 * Build a cordis-like context that records what the plugin registered.
 *
 * `sessionController` is a required injected service, so it must be present before `apply()`
 * runs — exactly as the Host guarantees it in a real profile.
 */
function stubContext({ sessions = new Map(), sessionController } = {}) {
  const listeners = new Map();
  const logs = { info: [], warn: [], debug: [], error: [] };
  const effects = [];
  // Set DSH_MAIL_TEST_TRACE=1 to surface the plugin's own logging; a failing end-to-end case is
  // otherwise hard to tell apart from a satisfied assertion.
  const trace = process.env.DSH_MAIL_TEST_TRACE === '1';
  const record = (level) => (...args) => {
    logs[level].push(args);
    if (trace) console.error(`[dsh-mail ${level}]`, ...args);
  };
  const context = {
    sessionController,
    logger: {
      info: record('info'),
      warn: record('warn'),
      debug: record('debug'),
      error: record('error'),
    },
    sessions: { get: (id) => sessions.get(id) },
    on: (event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    effect: (factory) => {
      const dispose = factory();
      effects.push(dispose);
      return () => {};
    },
    get: () => undefined,
  };
  return {
    context,
    logs,
    sessions,
    emit: (event, ...args) => {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    dispose: async () => {
      for (const dispose of effects.reverse()) await dispose();
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  };
}

/**
 * A session-controller stub that records prompts and cancellations.
 *
 * `ctx.sessions.get` answers for a session the channel is resuming, mirroring the Host, which
 * resolves a live Agent for any durable session id — so a replayed message keeps its session
 * instead of being mistaken for a vanished one.
 */
function stubController() {
  const prompts = [];
  const cancellations = [];
  const created = [];
  const sessions = new Map();
  let counter = 0;

  return {
    prompts,
    cancellations,
    created,
    sessions,
    /** Pretend a durable session already exists (used by the replay tests). */
    adopt(sessionId) {
      sessions.set(sessionId, makeSession(sessionId));
      return sessionId;
    },
    async create() {
      counter += 1;
      const sessionId = `session-${counter}`;
      created.push(sessionId);
      sessions.set(sessionId, makeSession(sessionId));
      return { sessionId };
    },
    async prompt(request) {
      prompts.push(request);
      return { accepted: true };
    },
    cancel(request) {
      cancellations.push(request.sessionId);
      return { accepted: true };
    },
    async list() {
      return { items: [] };
    },
  };
}

/** A minimal Session stand-in exposing what the plugin reads. */
function makeSession(id) {
  const events = [];
  return {
    id,
    snapshotEvents: () => events,
    appendAssistant(text) {
      events.push({
        type: 'assistant/message',
        seq: events.length + 1,
        data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
      });
    },
  };
}

/**
 * Build one inbound message.
 *
 * @param {{ from?: string, subject?: string, messageId?: string, body?: string,
 *   inReplyTo?: string, references?: string[], extra?: string[] }} input
 */
function mail({
  from = 'owner@example.com',
  subject = 'please summarise the repo',
  messageId = '<m1@example.com>',
  body = 'please summarise the repo',
  inReplyTo,
  references = [],
  extra = [],
}) {
  const headers = [
    `From: ${from}`,
    'To: agent@example.com',
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'Date: Mon, 1 Jan 2025 10:00:00 +0800',
    ...(inReplyTo === undefined ? [] : [`In-Reply-To: ${inReplyTo}`]),
    ...(references.length === 0 ? [] : [`References: ${references.join(' ')}`]),
    ...extra,
    'Content-Type: text/plain; charset=UTF-8',
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body.replace(/\n/g, CRLF)}${CRLF}`;
}

/** Configuration pointing the plugin at two fake servers and an isolated state directory. */
function pluginConfig({ imap, smtp, stateDir, attachmentsDir, extra = {} }) {
  return {
    enabled: true,
    imap: {
      host: '127.0.0.1',
      port: imap.port,
      secure: true,
      user: 'agent@example.com',
      password: 'secret',
      passwordEnv: 'DSH_MAIL_UNSET',
      mailbox: 'INBOX',
      sentMailbox: '',
      pollIntervalMs: 300,
      idle: false,
      maxIdleMs: 1000,
      rejectUnauthorized: false,
    },
    smtp: {
      host: '127.0.0.1',
      port: smtp.port,
      secure: true,
      user: 'agent@example.com',
      password: 'secret',
      passwordEnv: 'DSH_MAIL_UNSET',
      saveToSent: false,
      rejectUnauthorized: false,
    },
    allowFrom: ['owner@example.com'],
    selfAddresses: [],
    fromName: 'DSH Agent',
    tagPrefix: '[dsh-',
    workspaceDir: stateDir,
    stateDir,
    dshHome: stateDir,
    sendReceipt: true,
    sendResult: true,
    includeModePreamble: true,
    interruptSameThread: true,
    maxMessageBytes: 1024 * 1024,
    maxResultChars: 10000,
    attachments: { enabled: true, maxBytes: 1024 * 1024, maxCount: 5, dir: attachmentsDir },
    recovery: 'rerun',
    ...extra,
  };
}

/** Wait until `check()` is satisfied or the deadline passes. */
async function waitFor(check, { timeoutMs = 8000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Deep-merge `override` over `base`, the same way the plugin's own config layer does. */
function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    merged[key] = typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof base?.[key] === 'object' && base[key] !== null && !Array.isArray(base[key])
      ? mergeConfig(base[key], value)
      : value;
  }
  return merged;
}

/** Spin up a channel with isolated on-disk state. */
async function withChannel({ messages = [], extra = {}, run }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-e2e-'));
  const imap = await fakeImap({ messages });
  const smtp = await fakeSmtp();
  const controller = stubController();
  const host = stubContext({ sessions: controller.sessions, sessionController: controller });
  const config = mergeConfig(pluginConfig({
    imap,
    smtp,
    stateDir: join(directory, 'state'),
    attachmentsDir: join(directory, 'attachments'),
  }), extra);

  try {
    apply(host.context, config);
    await run({ imap, smtp, controller, host, config, directory });
  } finally {
    await host.dispose();
    await imap.close().catch(() => {});
    await smtp.close().catch(() => {});
    // A store write may still be settling; retry briefly rather than failing the test on it.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('the plugin advertises the DSH plugin shape', async () => {
  const module = await import('../src/index.js');
  assert.equal(module.name, 'dsh-mail');
  assert.deepEqual(module.inject, ['sessionController', 'sessions']);
  assert.equal(typeof module.apply, 'function');
  // `Config` is a schemastery schema inside a DSH install and an empty object otherwise; either
  // way the plugin must be loadable without the peer being resolvable, because a config-schema
  // import failure must never take the whole profile down.
  assert.equal(typeof module.Config, 'object');

  const merged = module.withDefaults({ imap: { host: 'h', user: 'u' }, allowFrom: ['a@b.c'] });
  assert.equal(merged.imap.host, 'h');
  assert.equal(merged.imap.port, 993, 'nested defaults are preserved');
  assert.equal(merged.smtp.saveToSent, true);
  assert.deepEqual(merged.allowFrom, ['a@b.c']);
  assert.equal(merged.attachments.maxCount, 10);
  assert.equal(merged.recovery, 'rerun');
  assert.equal(merged.agentPreset, '');

  // A partial nested override must not discard its siblings.
  const partial = module.withDefaults({ imap: { host: 'h2', user: 'u' }, smtp: { saveToSent: false }, attachments: { maxCount: 3 } });
  assert.equal(partial.imap.port, 993);
  assert.equal(partial.smtp.port, 465, 'a sibling default survives a partial smtp override');
  assert.equal(partial.smtp.saveToSent, false);
  assert.equal(partial.attachments.enabled, true);
  assert.equal(partial.attachments.maxCount, 3);
  assert.equal(partial.tagPrefix, '[dsh-');
});

test('an allowlisted new message creates a session, receives a receipt, and answers', async () => {
  await withChannel({
    messages: [{ uid: 1, raw: mail({}) }],
    run: async ({ smtp, controller, host }) => {
      const receipt = await waitFor(() => smtp.delivered.find((item) => item.body.includes('已收到')));
      assert.equal(receipt.recipients[0], 'owner@example.com');
      assert.match(receipt.headers, /Subject: \[dsh-[0-9a-f]{4}\]/);
      assert.match(receipt.body, /会话号: [0-9a-f]{4}/);
      assert.match(receipt.body, /回执号: [0-9a-f]{6}/);

      assert.equal(controller.created.length, 1);
      assert.equal(controller.prompts.length, 1);
      const prompt = controller.prompts[0];
      assert.equal(prompt.sessionId, 'session-1');
      assert.equal(prompt.mode, 'queue', 'a new session has nothing to interrupt');
      assert.match(prompt.content[0].text, /\[邮件模式\]/);
      assert.match(prompt.content[0].text, /please summarise the repo/);
      assert.match(prompt.content[0].text, /会话号: [0-9a-f]{4}/);

      // The turn ends: the answer is mailed back on the same thread.
      const session = controller.sessions.get('session-1');
      session.appendAssistant('the repository is small');
      host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

      const result = await waitFor(() => smtp.delivered.find((item) => item.body.includes('the repository is small')));
      assert.match(result.headers, /In-Reply-To: <m1@example\.com>/);
      assert.match(result.headers, /References: <m1@example\.com>/);
      assert.match(result.headers, /X-DSH-Session: [0-9a-f]{4}/);
      assert.equal(result.recipients[0], 'owner@example.com');
    },
  });
});

test('a message from outside the allowlist is never delivered to the agent', async () => {
  await withChannel({
    messages: [{ uid: 1, raw: mail({ from: 'stranger@evil.com', messageId: '<evil@example.com>' }) }],
    run: async ({ smtp, controller }) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(controller.prompts.length, 0);
      assert.equal(controller.created.length, 0);
      assert.equal(smtp.delivered.length, 0);
    },
  });
});

test('an auto-reply from the owner is dropped without acknowledgement', async () => {
  await withChannel({
    messages: [{ uid: 1, raw: mail({ extra: ['Auto-Submitted: auto-replied'] }) }],
    run: async ({ smtp, controller }) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(controller.prompts.length, 0);
      assert.equal(smtp.delivered.length, 0);
    },
  });
});

test('a reply to a running thread continues the session and interrupts the turn', async () => {
  await withChannel({
    messages: [{ uid: 1, raw: mail({}) }],
    run: async ({ smtp, controller, host, imap, config }) => {
      await waitFor(() => smtp.delivered.find((item) => item.body.includes('已收到')));
      const tag = smtp.delivered[0].text.match(/\[dsh-([0-9a-f]{4})\]/)[1];

      // The first turn is still running when the owner answers the same thread. The reference
      // chain is deliberately absent, so the subject tag alone has to resolve the session.
      host.emit('agent/status', { agent: { id: 'session-1' }, status: 'running' });
      imap.deliver(2, mail({
        subject: `Re: ${config.tagPrefix}${tag}] please summarise the repo`,
        messageId: '<m2@example.com>',
        body: 'follow up question',
      }));

      const second = await waitFor(() => (controller.prompts.length >= 2 ? controller.prompts[1] : undefined));
      assert.equal(second.sessionId, 'session-1', 'the reply stays in its own session');
      assert.match(second.content[0].text, /follow up question/);
      assert.equal(controller.created.length, 1, 'no second session was created');

      // The running turn was cancelled so the fresh prompt is picked up now.
      await waitFor(() => (controller.cancellations.length > 0 ? true : undefined));
      assert.deepEqual(controller.cancellations, ['session-1']);
    },
  });
});

test('a turn that ends while interrupted produces no result mail', async () => {
  await withChannel({
    messages: [{ uid: 1, raw: mail({}) }],
    run: async ({ smtp, controller, host }) => {
      await waitFor(() => smtp.delivered.find((item) => item.body.includes('已收到')));
      const deliveredBefore = smtp.delivered.length;

      const session = controller.sessions.get('session-1');
      session.appendAssistant('partial work');
      host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } });

      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(smtp.delivered.length, deliveredBefore, 'an interrupted turn owes no answer');
    },
  });
});

test('unfinished messages from a previous run are replayed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-replay-'));
  const imap = await fakeImap({ messages: [{ uid: 7, raw: mail({ messageId: '<replay@example.com>' }) }] });
  const smtp = await fakeSmtp();
  const controller = stubController();
  const host = stubContext({ sessions: controller.sessions, sessionController: controller });

  const stateDir = join(directory, 'state');
  const store = await new MailStore(stateDir).load();
  await store.bindThread('c001', { sessionId: 'session-9', subject: 'replayed thread' });
  await store.putMessage('<replay@example.com>', {
    messageId: '<replay@example.com>', uid: 7, tag: 'c001', sessionId: 'session-9', stage: 'running',
  });
  // Deliberately NOT adopted into the live session map: a session that survived a restart is
  // durable but cold, and the channel must still route the replay into it.
  try {
    apply(host.context, pluginConfig({
      imap, smtp, stateDir, attachmentsDir: join(directory, 'attachments'),
    }));
    // The replay re-fetches the message and dispatches it into its original session.
    const prompt = await waitFor(() => controller.prompts[0]);
    assert.equal(prompt.sessionId, 'session-9');
    assert.equal(controller.created.length, 0, 'a cold session must be resumed, never replaced');
    assert.match(prompt.content[0].text, /会话号: c001/);
    assert.match(prompt.content[0].text, /续接/);
    assert.match(prompt.content[0].text, /please summarise the repo/);
  } finally {
    await host.dispose();
    await imap.close().catch(() => {});
    await smtp.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovery policy other than rerun marks the message failed instead', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-noreplay-'));
  const imap = await fakeImap({ messages: [{ uid: 7, raw: mail({ messageId: '<replay@example.com>' }) }] });
  const smtp = await fakeSmtp();
  const controller = stubController();
  const host = stubContext({ sessions: controller.sessions, sessionController: controller });

  const stateDir = join(directory, 'state');
  const store = await new MailStore(stateDir).load();
  await store.putMessage('<replay@example.com>', {
    messageId: '<replay@example.com>', uid: 7, tag: 'c001', sessionId: 'session-9', stage: 'running',
  });

  try {
    apply(host.context, pluginConfig({
      imap, smtp, stateDir, attachmentsDir: join(directory, 'attachments'), extra: { recovery: 'mark-failed' },
    }));
    await waitFor(async () => {
      const reloaded = await new MailStore(stateDir).load();
      return reloaded.message('<replay@example.com>').stage === 'failed' ? true : undefined;
    });
    assert.equal(controller.prompts.length, 0);
    assert.equal(controller.created.length, 0);
  } finally {
    await host.dispose();
    await imap.close().catch(() => {});
    await smtp.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('attachments are written into the workspace and named in the prompt', async () => {
  const attachmentBody = Buffer.from('hello attachment').toString('base64');
  const raw = [
    'From: owner@example.com',
    'To: agent@example.com',
    'Subject: with a file',
    'Message-ID: <attach@example.com>',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'look at the attached file',
    '--B',
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    attachmentBody,
    '--B--',
    '',
  ].join(CRLF);

  await withChannel({
    messages: [{ uid: 1, raw }],
    run: async ({ controller, config }) => {
      const prompt = await waitFor(() => controller.prompts[0]);
      assert.match(prompt.content[0].text, /look at the attached file/);
      assert.match(prompt.content[0].text, /附件已保存到工作区/);
      assert.match(prompt.content[0].text, /notes\.txt/);

      const directories = await readdir(config.attachments.dir, { withFileTypes: true });
      assert.equal(directories.length, 1, 'one directory per thread');
      const written = await readdir(join(config.attachments.dir, directories[0].name));
      assert.deepEqual(written, ['notes.txt']);
      assert.equal(
        await readFile(join(config.attachments.dir, directories[0].name, 'notes.txt'), 'utf8'),
        'hello attachment',
      );
    },
  });
});

test('the message is flagged seen but never deleted', async () => {
  await withChannel({
    messages: [{ uid: 4, raw: mail({}) }],
    run: async ({ imap, controller }) => {
      await waitFor(() => controller.prompts[0]);
      await waitFor(() => (imap.seen.includes(4) ? true : undefined));
      assert.deepEqual(imap.seen, [4]);
      assert.equal(imap.commands.some((command) => /\\Deleted/i.test(command)), false);
    },
  });
});

test('a reply to a thread whose session is cold keeps that session', async () => {
  // The reported failure: after a DSH restart the bound session is durable but no longer live in
  // the in-memory store, and the channel used to read that as "session gone" and fork the thread
  // into a brand new conversation. The tag must win over any liveness probe.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-cold-'));
  const imap = await fakeImap({ messages: [] });
  const smtp = await fakeSmtp();
  const controller = stubController();
  const host = stubContext({ sessions: controller.sessions, sessionController: controller });

  const stateDir = join(directory, 'state');
  const store = await new MailStore(stateDir).load();
  // A thread established by a previous run, with its session deliberately absent from memory.
  await store.bindThread('a3f9', { sessionId: 'session-cold', subject: 'earlier topic' });
  await store.recordOutgoing('<dsh.earlier@163.com>', 'a3f9');

  try {
    apply(host.context, pluginConfig({ imap, smtp, stateDir, attachmentsDir: join(directory, 'attachments') }));
    // The reader answers by keeping the tag in the subject, with no usable reference chain.
    imap.deliver(1, mail({
      subject: 'Re: [dsh-a3f9] earlier topic',
      messageId: '<cold@example.com>',
      body: 'continuing the old thread',
    }));

    const prompt = await waitFor(() => controller.prompts[0]);
    assert.equal(prompt.sessionId, 'session-cold', 'the reply must land in the bound session');
    assert.equal(controller.created.length, 0, 'no new session may be created');

    // And the thread table must still point at the original session.
    const reloaded = await new MailStore(stateDir).load();
    assert.equal(reloaded.sessionForTag('a3f9'), 'session-cold');
  } finally {
    await host.dispose();
    await imap.close().catch(() => {});
    await smtp.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('a tag is never re-pointed at a different session', async () => {
  // Even if something upstream concludes "new session", the tag is the thread's identity and the
  // binding must not move — moving it is what split one conversation across two sessions.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-rebind-'));
  const imap = await fakeImap({ messages: [] });
  const smtp = await fakeSmtp();
  const controller = stubController();
  const host = stubContext({ sessions: controller.sessions, sessionController: controller });

  const stateDir = join(directory, 'state');
  const store = await new MailStore(stateDir).load();

  try {
    // Two different sessions claiming the same tag: the first binding wins.
    const first = await store.bindThreadOnce('b001', { sessionId: 'session-one', subject: 's' });
    assert.equal(first.rebound, false);
    const second = await store.bindThreadOnce('b001', { sessionId: 'session-two', subject: 's' });
    assert.deepEqual(second, { rebound: true, previousSessionId: 'session-one', sessionId: 'session-two' });

    const reloaded = await new MailStore(stateDir).load();
    assert.equal(reloaded.sessionForTag('b001'), 'session-one', 'the established binding is kept');
  } finally {
    await host.dispose();
    await imap.close().catch(() => {});
    await smtp.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('a completed message is not re-delivered on the next poll', async () => {
  await withChannel({
    messages: [{ uid: 1, raw: mail({}) }],
    run: async ({ smtp, controller, host }) => {
      await waitFor(() => smtp.delivered.find((item) => item.body.includes('已收到')));
      const session = controller.sessions.get('session-1');
      session.appendAssistant('done');
      host.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
      await waitFor(() => smtp.delivered.find((item) => item.body.includes('done')));

      const promptsAfterFirst = controller.prompts.length;
      // Several poll cycles pass with the same message still present in the mailbox.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(controller.prompts.length, promptsAfterFirst, 'the watermark suppresses a re-delivery');
    },
  });
});

test('saveToSent appends the outgoing message to the mailbox the server advertises', async () => {
  await withChannel({
    messages: [{ uid: 1, raw: mail({}) }],
    extra: { smtp: { saveToSent: true } },
    run: async ({ imap, smtp, controller }) => {
      await waitFor(() => smtp.delivered.find((item) => item.body.includes('已收到')));
      // The IMAP stub advertises an implicit Sent mailbox, so the copy is appended there.
      await waitFor(() => (imap.appended.length > 0 ? true : undefined));
      // The appended copy is a whole message; decode the base64 body before matching.
      const appendedBody = Buffer.from(
        imap.appended[0].split('\n\n')[1]?.replace(/\s+/g, '') ?? '',
        'base64',
      ).toString('utf8');
      assert.match(appendedBody, /已收到/);
      assert.equal(imap.commands.some((command) => /APPEND/i.test(command)), true);
      assert.equal(controller.prompts.length, 1);
    },
  });
});
