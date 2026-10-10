/**
 * Volatile configuration handling.
 *
 * A field a schema marks `.volatile()` arrives as a reference — `Object.freeze({ get, [write] })` —
 * not as a plain value, and the key risk is silent: spreading such a reference yields `{ get }`
 * and drops the configuration entirely. These tests pin the unwrapping behaviour and prove the
 * plugin reads an edited value without a restart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, withDefaults } from '../src/index.js';

/** A stand-in for cosmokit's volatile reference: the enumerable surface is only `get`. */
function volatileRef(value) {
  let current = value;
  const ref = {
    get: () => current,
  };
  Object.defineProperty(ref, Symbol.for('cosmokit.volatile.write'), {
    value: (next) => {
      current = next;
    },
    enumerable: false,
  });
  return Object.freeze(ref);
}

/** Write a new snapshot into a reference made by {@link volatileRef}. */
function setRef(ref, value) {
  ref[Symbol.for('cosmokit.volatile.write')](value);
}

/** Wait until `check()` returns something truthy, or fail. */
async function waitFor(check, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A minimal cordis-like context. */
function stubContext() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  const listeners = new Map();
  const effects = [];
  return {
    logs,
    context: {
      logger: {
        info: (...args) => logs.info.push(args),
        warn: (...args) => logs.warn.push(args),
        error: (...args) => logs.error.push(args),
        debug: (...args) => logs.debug.push(args),
      },
      sessions: { get: () => undefined },
      sessionController: {
        async create() {
          return { sessionId: 'session-1' };
        },
        async prompt() {
          return { accepted: true };
        },
        cancel() {},
        async list() {
          return { items: [] };
        },
      },
      on: (event, handler) => {
        const list = listeners.get(event) ?? [];
        list.push(handler);
        listeners.set(event, list);
        return () => {};
      },
      effect: (factory) => {
        effects.push(factory());
        return () => {};
      },
      get: () => undefined,
    },
    emit: (event, ...args) => {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    dispose: async () => {
      for (const dispose of effects.reverse()) if (typeof dispose === 'function') await dispose();
    },
  };
}

/** A config where the editable fields are references, as the Loader supplies them. */
function volatileConfig(overrides = {}) {
  return {
    enabled: volatileRef(true),
    imap: volatileRef({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'agent@example.com',
      password: '',
      passwordEnv: 'DSH_MAIL_PASSWORD',
      mailbox: 'INBOX',
      sentMailbox: '',
      pollIntervalMs: 20000,
      idle: false,
      maxIdleMs: 240000,
      rejectUnauthorized: true,
    }),
    smtp: volatileRef({
      host: '',
      port: 465,
      secure: true,
      user: '',
      password: '',
      passwordEnv: 'DSH_MAIL_PASSWORD',
      saveToSent: false,
      rejectUnauthorized: true,
    }),
    allowFrom: volatileRef(['owner@example.com']),
    selfAddresses: volatileRef([]),
    fromName: volatileRef('DSH Agent'),
    tagPrefix: volatileRef('[dsh-'),
    workspaceDir: volatileRef(''),
    agentPreset: volatileRef(''),
    sendReceipt: volatileRef(true),
    sendResult: volatileRef(true),
    includeModePreamble: volatileRef(true),
    interruptSameThread: volatileRef(true),
    maxMessageBytes: volatileRef(1024 * 1024),
    maxResultChars: volatileRef(10000),
    attachments: volatileRef({ enabled: false, maxBytes: 1024, maxCount: 3, dir: '' }),
    recovery: volatileRef('rerun'),
    ...overrides,
  };
}

test('a volatile reference is never treated as a plain object', () => {
  // The whole hazard in one assertion: spreading the reference yields `{ get }`, not the config.
  const ref = volatileRef({ host: 'imap.example.com' });
  assert.deepEqual(Object.keys(ref), ['get'], 'the reference exposes only get');
  assert.equal(ref.get().host, 'imap.example.com');

  // withDefaults must keep the reference rather than replace it with a spread of itself.
  const merged = withDefaults({ imap: ref, allowFrom: volatileRef(['a@b.c']) });
  assert.equal(merged.imap, ref, 'the reference survives the merge by identity');
  assert.deepEqual(merged.allowFrom.get(), ['a@b.c']);
});

test('every editable field keeps working when supplied as a reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-volatile-'));
  const host = stubContext();
  try {
    // Applying must not throw on references, and must reach the startup log with real values.
    apply(host.context, volatileConfig({ stateDir: volatileRef(join(directory, 'state')) }));
    const startup = await waitFor(() => host.logs.info.find((entry) => String(entry[0]).includes('watching')));
    // Entry shape is the raw logger arguments: [format, host, user, allowlist].
    assert.equal(startup[1], 'imap.example.com', 'the IMAP host was unwrapped');
    assert.equal(startup[2], 'agent@example.com', 'the mailbox address was unwrapped');
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an edit made through the reference is picked up without a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-volatile-live-'));
  const host = stubContext();
  try {
    const config = volatileConfig({ stateDir: volatileRef(join(directory, 'state')) });
    apply(host.context, config);

    // What the settings service does on save: commit a new snapshot into the same reference.
    const before = host.logs.warn.length;
    setRef(config.imap, { ...config.imap.get(), host: 'imap.changed.example' });
    setRef(config.allowFrom, []);

    // The next poll cycle reads the live values; the connection is refused, which is the proof
    // that the new host was used rather than the one captured at mount time.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const warned = host.logs.warn.slice(before).map((entry) => entry.join(' ')).join('\n');
    assert.match(warned, /imap\.changed\.example|poll failed/, 'the channel acted on the edited config');
    assert.equal(config.imap.get().host, 'imap.changed.example');
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the idle fallback is tracked locally, not written back into the config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-volatile-idle-'));
  const host = stubContext();
  try {
    const config = volatileConfig({
      stateDir: volatileRef(join(directory, 'state')),
    });
    // `imap` is a frozen reference: assigning `config.imap.idle = false` would either throw in
    // strict mode or be silently lost, so the plugin must never do it.
    apply(host.context, config);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(config.imap.get().idle, false, 'the reference value is untouched');
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an empty allowFrom reference still admits nobody', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-volatile-allow-'));
  const host = stubContext();
  try {
    apply(host.context, volatileConfig({
      stateDir: volatileRef(join(directory, 'state')),
      allowFrom: volatileRef([]),
    }));
    const startup = await waitFor(() => host.logs.info.find((entry) => String(entry[0]).includes('watching')));
    assert.match(String(startup[3]), /nobody may drive/);
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
