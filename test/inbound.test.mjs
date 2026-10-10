/**
 * Inbound admission: whitelist, loop suppression, threading, and the session/original decision.
 *
 * These are the rules that decide "new session" versus "same session" and "ignore" versus "act",
 * so they are exercised against a table of realistic messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyInbound, detectLoop, IgnoreReason, renderPrompt, renderReceipt, Verdict } from '../src/inbound.js';
import { DeliveryMode } from '../src/session.js';

const CRLF = '\r\n';

/** Build a raw message from header lines and a body. */
function raw({ headers, body }) {
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body ?? ''}`;
}

/** A store stub backed by plain maps. */
function stubStore({ messages = {}, threads = {}, outgoing = {} } = {}) {
  return {
    lookupMessage: (messageId) => messages[messageId],
    lookupTag: (tag) => threads[tag],
    lookupOutgoing: (messageId) => outgoing[messageId],
  };
}

const ALLOW = ['owner@example.com'];
const SELF = ['agent@example.com'];

test('an allowlisted new message becomes a new session with a fresh thread tag', () => {
  const store = stubStore();
  const verdict = classifyInbound({
    raw: raw({
      headers: [
        'From: Owner <owner@example.com>',
        'To: agent@example.com',
        'Subject: Please summarise the repo',
        'Message-ID: <m1@example.com>',
      ],
      body: 'Please summarise the repo.',
    }),
    uid: 10,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...store,
  });

  assert.equal(verdict.action, Verdict.newSession);
  assert.equal(verdict.received.sender, 'owner@example.com');
  assert.equal(verdict.received.body, 'Please summarise the repo.');
  assert.match(verdict.tag, /^[0-9a-f]{4}$/);
  assert.match(verdict.received.receipt, /^[0-9a-f]{6}$/);
  assert.equal(verdict.sessionId, undefined);
});

test('a non-allowlisted sender is ignored before anything else happens', () => {
  const verdict = classifyInbound({
    raw: raw({
      headers: ['From: stranger@evil.com', 'Subject: hi', 'Message-ID: <x@evil.com>'],
      body: 'do things',
    }),
    uid: 1,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...stubStore(),
  });
  assert.equal(verdict.action, Verdict.ignore);
  assert.equal(verdict.reason, IgnoreReason.notAllowlisted);
  assert.equal(verdict.sender, 'stranger@evil.com');
});

test('a reply resolves its session through References to one of our own Message-IDs', () => {
  const store = stubStore({
    threads: { a3f9: 'session-1' },
    outgoing: { '<dsh.sent.1@example.com>': 'a3f9' },
  });
  const verdict = classifyInbound({
    raw: raw({
      headers: [
        'From: owner@example.com',
        'Subject: Re: anything at all',
        'Message-ID: <m2@example.com>',
        'In-Reply-To: <dsh.sent.1@example.com>',
        'References: <dsh.sent.0@example.com> <dsh.sent.1@example.com>',
      ],
      body: 'follow up',
    }),
    uid: 11,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...store,
  });
  assert.equal(verdict.action, Verdict.continueSession);
  assert.equal(verdict.sessionId, 'session-1');
  assert.equal(verdict.tag, 'a3f9');
});

test('a broken reference chain still continues the session via the subject tag', () => {
  const store = stubStore({ threads: { b001: 'session-2' } });
  const verdict = classifyInbound({
    raw: raw({
      headers: [
        'From: owner@example.com',
        'Subject: Re: [dsh-b001] original topic',
        'Message-ID: <m3@example.com>',
      ],
      body: 'continuing without headers',
    }),
    uid: 12,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...store,
  });
  assert.equal(verdict.action, Verdict.continueSession);
  assert.equal(verdict.sessionId, 'session-2');
});

test('a tag with no session mapping starts a new session rather than guessing', () => {
  const verdict = classifyInbound({
    raw: raw({
      headers: [
        'From: owner@example.com',
        'Subject: [dsh-ffff] unknown thread',
        'Message-ID: <m4@example.com>',
      ],
      body: 'body',
    }),
    uid: 13,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...stubStore(),
  });
  assert.equal(verdict.action, Verdict.newSession);
});

test('a completed Message-ID is a duplicate, an unfinished one is a replay', () => {
  const completed = classifyInbound({
    raw: raw({
      headers: ['From: owner@example.com', 'Message-ID: <m5@example.com>'],
      body: 'again',
    }),
    uid: 14,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...stubStore({ messages: { '<m5@example.com>': { stage: 'done', sessionId: 's', tag: 'c001' } } }),
  });
  assert.equal(completed.action, Verdict.duplicate);

  const unfinished = classifyInbound({
    raw: raw({
      headers: ['From: owner@example.com', 'Message-ID: <m6@example.com>'],
      body: 'again',
    }),
    uid: 15,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...stubStore({ messages: { '<m6@example.com>': { stage: 'running', sessionId: 's', tag: 'c002' } } }),
  });
  assert.equal(unfinished.action, Verdict.continueSession);
  assert.equal(unfinished.reason, 'unfinished-replay');
  assert.equal(unfinished.sessionId, 's');
});

test('loop suppression covers auto-replies, bulk, lists, reports, and our own mail', () => {
  const cases = [
    [['Auto-Submitted: auto-replied'], IgnoreReason.autoSubmitted],
    [['Precedence: bulk'], IgnoreReason.bulk],
    [['List-Id: <list.example.com>'], IgnoreReason.list],
    [['X-Autoreply: yes'], IgnoreReason.autoReplied],
    [['Content-Type: multipart/report; boundary="r"'], IgnoreReason.deliveryReport],
    [['Return-Path: <>'], IgnoreReason.selfSent],
  ];
  for (const [extra, reason] of cases) {
    const headers = new Map();
    for (const line of extra) {
      const colon = line.indexOf(':');
      headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    assert.equal(detectLoop(headers, { selfAddresses: SELF, sender: 'owner@example.com' }), reason, extra.join());
  }

  assert.equal(
    detectLoop(new Map(), { selfAddresses: SELF, sender: 'agent@example.com' }),
    IgnoreReason.selfSent,
  );
  assert.equal(detectLoop(new Map(), { selfAddresses: SELF, sender: 'owner@example.com' }), undefined);
});

test('an auto-reply from the allowlisted owner is still dropped', () => {
  const verdict = classifyInbound({
    raw: raw({
      headers: [
        'From: owner@example.com',
        'Auto-Submitted: auto-replied',
        'Message-ID: <m7@example.com>',
      ],
      body: 'I am away',
    }),
    uid: 16,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...stubStore(),
  });
  assert.equal(verdict.action, Verdict.ignore);
  assert.equal(verdict.reason, IgnoreReason.autoSubmitted);
});

test('an empty body after quote stripping is ignored', () => {
  const verdict = classifyInbound({
    raw: raw({
      headers: ['From: owner@example.com', 'Message-ID: <m8@example.com>'],
      body: '',
    }),
    uid: 17,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    ...stubStore(),
  });
  assert.equal(verdict.action, Verdict.ignore);
  assert.equal(verdict.reason, IgnoreReason.noContent);
});

test('oversized messages are refused', () => {
  const verdict = classifyInbound({
    raw: raw({
      headers: ['From: owner@example.com', 'Message-ID: <m9@example.com>'],
      body: 'x'.repeat(500),
    }),
    uid: 18,
    allowFrom: ALLOW,
    selfAddresses: SELF,
    maxBytes: 100,
    ...stubStore(),
  });
  assert.equal(verdict.action, Verdict.ignore);
  assert.equal(verdict.reason, IgnoreReason.tooLarge);
});

test('an empty allowlist drives nobody', () => {
  const verdict = classifyInbound({
    raw: raw({ headers: ['From: owner@example.com', 'Message-ID: <m10@example.com>'], body: 'hi' }),
    uid: 19,
    allowFrom: [],
    selfAddresses: SELF,
    ...stubStore(),
  });
  assert.equal(verdict.action, Verdict.ignore);
  assert.equal(verdict.reason, IgnoreReason.notAllowlisted);
});

test('the rendered prompt carries the mail framing, the body, and the receipt', () => {
  const received = {
    messageId: '<m1@example.com>',
    sender: 'owner@example.com',
    subject: 'hello',
    tag: 'a3f9',
    receipt: 'abc123',
    body: 'the actual request',
    stripped: true,
    removedChars: 42,
    emptyAfterStrip: false,
  };
  const prompt = renderPrompt(received, { isNew: true, attachmentPaths: [{ path: '/w/.dsh-mail/a3f9/x.pdf', bytes: 10 }] });
  assert.match(prompt, /\[邮件模式\]/);
  assert.match(prompt, /只输出纯文本/);
  assert.match(prompt, /新邮件/);
  assert.match(prompt, /会话号: a3f9/);
  assert.match(prompt, /回执号: abc123/);
  assert.match(prompt, /the actual request/);
  assert.match(prompt, /x\.pdf/);

  const bare = renderPrompt(received, { modePreamble: false });
  assert.equal(bare.includes('[邮件模式]'), false);
  assert.match(bare, /the actual request/);
});

test('the receipt hands the sender the thread tag', () => {
  const received = { tag: 'a3f9', receipt: 'abc123', sender: 'owner@example.com' };
  const receipt = renderReceipt(received, { isNew: true });
  assert.match(receipt, /会话号: a3f9/);
  assert.match(receipt, /回执号: abc123/);
  assert.match(receipt, /\[dsh-…\]/);
});

test('delivery modes are stable strings', () => {
  assert.equal(DeliveryMode.interrupt, 'interrupt');
  assert.equal(DeliveryMode.queue, 'queue');
});
