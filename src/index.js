/**
 * dsh-mail — one dedicated mailbox per machine, email as a DSH session entry point.
 *
 * A new message starts a session; a reply continues the session it belongs to; a reply to a
 * *running* thread interrupts that turn and takes over. The plugin owns the mailbox: it polls
 * IMAP outbound-only (no inbound port, no public callback), answers only allowlisted senders,
 * and sends a receipt on admission plus a result when the turn ends.
 *
 * Delivery semantics are at-least-once: a crash between "prompt admitted" and "recorded as
 * done" replays the message, because a duplicated answer is cheaper than a lost request. The
 * reply-side deduplication in `AgentLink` keeps a replay from re-sending identical words.
 *
 * @module dsh-mail
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImapConnection } from './imap.js';
import { decodeAttachment, parseMessage } from './mime.js';
import { Mailer, newMessageId, tagSubject } from './outgoing.js';
import { classifyInbound, IgnoreReason, renderPrompt, renderReceipt, Verdict } from './inbound.js';
import { AgentLink, DeliveryMode, extractTurnResult, resultSubject, resultWorthSending } from './session.js';
import { MailStore, receiptId } from './store.js';

/** Plugin name used in logs and effect labels. */
export const name = 'dsh-mail';

/** Services the channel needs before it can start. */
export const inject = ['sessionController', 'sessions'];

/**
 * Configuration schema, projected by the Loader into the profile's config JSON Schema.
 *
 * `@deepseek-ai/schemastery` is a runtime-provided peer. When it cannot be resolved — which is
 * the case when this package is exercised outside a DSH install — the plugin still loads with
 * an empty schema instead of failing the whole profile at import time.
 */
export const Config = await loadConfigSchema();

/** Build the advertised Config schema, or an empty one when schemastery is unavailable. */
async function loadConfigSchema() {
  let z;
  try {
    ({ default: z } = await import('@deepseek-ai/schemastery'));
  } catch {
    return {};
  }
  return z.object({
    enabled: z.boolean().default(true),

    imap: z.object({
      host: z.string().required(),
      port: z.number().default(993),
      secure: z.boolean().default(true),
      user: z.string().required(),
      password: z.string().default(''),
      passwordEnv: z.string().default('DSH_MAIL_PASSWORD'),
      mailbox: z.string().default('INBOX'),
      sentMailbox: z.string().default(''),
      pollIntervalMs: z.number().default(20000),
      idle: z.boolean().default(true),
      maxIdleMs: z.number().default(240000),
      rejectUnauthorized: z.boolean().default(true),
    }),

    smtp: z.object({
      host: z.string().default(''),
      port: z.number().default(465),
      secure: z.boolean().default(true),
      user: z.string().default(''),
      password: z.string().default(''),
      passwordEnv: z.string().default('DSH_MAIL_PASSWORD'),
      saveToSent: z.boolean().default(true),
      rejectUnauthorized: z.boolean().default(true),
    }),

    /** Exact sender addresses allowed to drive the agent. Empty means nobody. */
    allowFrom: z.array(z.string()).default([]),

    /** Addresses that count as "us" for loop detection; the IMAP user is always included. */
    selfAddresses: z.array(z.string()).default([]),

    fromName: z.string().default('DSH Agent'),
    tagPrefix: z.string().default('[dsh-'),

    /** Working directory for sessions the channel creates. */
    workspaceDir: z.string().default(''),

    /** Optional agent preset for sessions the channel creates; empty uses the profile default. */
    agentPreset: z.string().default(''),

    /** Where plugin state lives; defaults to `<DSH_HOME>/mail`. */
    stateDir: z.string().default(''),
    dshHome: z.string().default(''),

    /** Acknowledge every admitted message immediately, before the turn runs. */
    sendReceipt: z.boolean().default(true),

    /** Send the assistant's answer back when a mail-initiated turn ends. */
    sendResult: z.boolean().default(true),

    /** Emit the email-mode framing plus the body as the prompt. */
    includeModePreamble: z.boolean().default(true),

    /** Interrupt the running turn when a reply belongs to that same thread. */
    interruptSameThread: z.boolean().default(true),

    /** Refuse messages larger than this. */
    maxMessageBytes: z.number().default(32 * 1024 * 1024),

    /** Cap on the answer text carried in one result email. */
    maxResultChars: z.number().default(60000),

    attachments: z.object({
      enabled: z.boolean().default(true),
      maxBytes: z.number().default(10 * 1024 * 1024),
      maxCount: z.number().default(10),
      dir: z.string().default(''),
    }),

    /** Crash recovery: replay unfinished messages, or leave them failed. */
    recovery: z.string().default('rerun'),
  });
}

/** Defaults mirroring the Config schema, applied when the Loader did not already do so. */
const DEFAULTS = {
  enabled: true,
  fromName: 'DSH Agent',
  tagPrefix: '[dsh-',
  workspaceDir: '',
  agentPreset: '',
  stateDir: '',
  dshHome: '',
  sendReceipt: true,
  sendResult: true,
  includeModePreamble: true,
  interruptSameThread: true,
  maxMessageBytes: 32 * 1024 * 1024,
  maxResultChars: 60000,
  recovery: 'rerun',
  imap: {
    port: 993,
    secure: true,
    password: '',
    passwordEnv: 'DSH_MAIL_PASSWORD',
    mailbox: 'INBOX',
    sentMailbox: '',
    pollIntervalMs: 20000,
    idle: true,
    maxIdleMs: 240000,
    rejectUnauthorized: true,
  },
  smtp: {
    host: '',
    port: 465,
    secure: true,
    user: '',
    password: '',
    passwordEnv: 'DSH_MAIL_PASSWORD',
    saveToSent: true,
    rejectUnauthorized: true,
  },
  allowFrom: [],
  selfAddresses: [],
  attachments: { enabled: true, maxBytes: 10 * 1024 * 1024, maxCount: 10, dir: '' },
};

/**
 * Merge caller configuration over the defaults.
 *
 * Nested sections are merged key by key rather than replaced wholesale: a patch entry that sets
 * one field inside `imap` or `smtp` (for example only `saveToSent`) must not silently discard
 * the host, port, and mailbox beside it. The Loader normally supplies a fully defaulted object;
 * this keeps the plugin correct when it is driven directly.
 *
 * @param {object} rawConfig
 * @returns {object}
 */
export function withDefaults(rawConfig) {
  const config = rawConfig ?? {};
  const merge = (base, override) => {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override ?? {})) {
      if (value === undefined) continue;
      merged[key] = isPlainObject(value) && isPlainObject(base?.[key])
        ? merge(base[key], value)
        : value;
    }
    return merged;
  };
  const merged = merge(DEFAULTS, config);
  merged.allowFrom = config.allowFrom ?? DEFAULTS.allowFrom;
  merged.selfAddresses = config.selfAddresses ?? DEFAULTS.selfAddresses;
  return merged;
}

/** Whether a value is a mergeable plain object rather than an array or class instance. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve `<DSH_HOME>` without importing a DSH-internal package. */
function resolveHome(config) {
  if (typeof config.dshHome === 'string' && config.dshHome.length > 0) return config.dshHome;
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME;
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
}

/** Read a credential from config, falling back to the configured environment variable. */
function resolveSecret(inline, envName) {
  if (typeof inline === 'string' && inline.length > 0) return inline;
  if (typeof envName === 'string' && envName.length > 0 && process.env[envName] !== undefined) {
    return process.env[envName];
  }
  return '';
}

/** Sanitize one attachment file name so it cannot escape the attachment directory. */
function safeFileName(name, index) {
  const base = String(name ?? `attachment-${index}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  const trimmed = base.replace(/^\.+/, '').slice(0, 120);
  return trimmed.length > 0 ? trimmed : `attachment-${index}`;
}

/** Strip angle brackets for header values that want the bare id. */
function bareId(messageId) {
  return String(messageId).replace(/^<|>$/g, '');
}

/**
 * Plugin entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - normalized plugin config.
 */
export function apply(ctx, rawConfig) {
  const config = withDefaults(rawConfig);
  if (config.enabled === false) {
    ctx.logger?.info('dsh-mail: disabled by configuration');
    return;
  }

  const stateDir = config.stateDir.length > 0 ? config.stateDir : join(resolveHome(config), 'mail');
  const workspaceDir = config.workspaceDir.length > 0 ? config.workspaceDir : process.cwd();
  const attachmentRoot = config.attachments.dir.length > 0
    ? config.attachments.dir
    : join(workspaceDir, '.dsh-mail', 'attachments');

  const imapPassword = resolveSecret(config.imap.password, config.imap.passwordEnv);
  const smtpPassword = resolveSecret(config.smtp.password, config.smtp.passwordEnv);
  const selfAddresses = [...new Set([
    config.imap.user,
    config.smtp.user,
    ...config.selfAddresses,
  ].filter((address) => typeof address === 'string' && address.includes('@')))];

  const lifecycle = new AbortController();
  const store = new MailStore(stateDir);
  const agentLink = new AgentLink({ sessionController: ctx.sessionController, logger: ctx.logger });
  const mailer = new Mailer({
    smtp: {
      host: config.smtp.host.length > 0 ? config.smtp.host : config.imap.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user.length > 0 ? config.smtp.user : config.imap.user,
      password: smtpPassword,
      saveToSent: config.smtp.saveToSent,
      rejectUnauthorized: config.smtp.rejectUnauthorized,
      ehloName: 'dsh.local',
    },
    from: config.smtp.user.length > 0 ? config.smtp.user : config.imap.user,
    fromName: config.fromName,
    logger: ctx.logger,
    onSent: async (message) => {
      const connection = await ensureImap();
      const mailbox = await resolveSentMailbox(connection);
      if (mailbox === undefined) {
        ctx.logger?.debug?.('dsh-mail: no Sent mailbox on this server; the copy was not appended');
        return;
      }
      try {
        await connection.append(mailbox.name, message, { flags: ['\\Seen'] });
      } catch (error) {
        ctx.logger?.warn('dsh-mail: appending to "%s" failed (%s)', mailbox.name, error?.message ?? error);
      }
    },
  });

  let imap;
  let inFlight = false;
  let nextAllowedPoll = 0;
  /** Last total message count the server reported, used to force a search after a hint. */
  let lastKnownExists = 0;

  /* ---------------------------------------------------------------- *
   * Mailbox connection management
   * ---------------------------------------------------------------- */

  /** Open and prepare one IMAP connection, selecting the configured mailbox. */
  async function openImap() {
    const connection = new ImapConnection({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      rejectUnauthorized: config.imap.rejectUnauthorized,
    });
    connection.on('error', (error) => {
      ctx.logger?.debug?.('dsh-mail: imap connection error (%s)', error?.message ?? error);
    });
    await connection.open();
    await connection.login(config.imap.user, imapPassword);

    // Providers that police third-party clients (notably NetEase) refuse mailbox access until
    // the client identifies itself, so announce the identity before selecting anything.
    try {
      const capabilities = await connection.capabilities();
      if (capabilities.has('ID')) {
        await connection.id({ name: 'dsh-mail', version: '0.1.0', vendor: 'dsh-mail' });
      }
    } catch (error) {
      ctx.logger?.debug?.('dsh-mail: ID command failed (%s)', error?.message ?? error);
    }

    const info = await connection.select(config.imap.mailbox);
    lastKnownExists = info.exists;
    return { connection, info };
  }

  /** Return a usable connection, reconnecting when the previous one died. */
  async function ensureImap() {
    if (imap !== undefined && imap.connected !== false) return imap;
    if (imap !== undefined) await imap.close().catch(() => {});
    const opened = await openImap();
    imap = opened.connection;
    return imap;
  }

  /**
   * Discover the Sent folder once, so results are visible in the human's mailbox.
   *
   * `\Sent` is the RFC 6154 special-use attribute and the only reliable signal; the name-based
   * fallback covers servers that advertise the attribute but not the capability, or neither.
   */
  let sentMailboxCache;
  async function resolveSentMailbox(connection) {
    if (config.imap.sentMailbox.length > 0) return config.imap.sentMailbox;
    if (sentMailboxCache !== undefined) return sentMailboxCache;
    try {
      const names = await connection.listMailboxes();
      sentMailboxCache = names.find((entry) => entry.attributes.includes('\\Sent'))
        ?? names.find((entry) => /^(sent|sent items|sent messages|已发送|已发送邮件|已寄郵件|送信済み)$/i.test(entry.name))
        ?? names.find((entry) => /sent/i.test(entry.name));
      if (sentMailboxCache !== undefined) ctx.logger?.info('dsh-mail: results are copied to "%s"', sentMailboxCache.name);
    } catch (error) {
      ctx.logger?.debug?.('dsh-mail: could not list mailboxes (%s)', error?.message ?? error);
      sentMailboxCache = undefined;
    }
    return sentMailboxCache;
  }

  /* ---------------------------------------------------------------- *
   * Outgoing helpers
   * ---------------------------------------------------------------- */

  /** Send one plain-text message and record its Message-ID against the thread. */
  async function sendThreaded({
    to,
    subject,
    text,
    tag,
    replyTo,
    references,
    receipt,
  }) {
    const messageId = newMessageId(config.smtp.user.length > 0 ? config.smtp.user : config.imap.user);
    await mailer.send({
      to,
      subject,
      text,
      messageId,
      inReplyTo: replyTo,
      references,
      tag,
      receipt,
    });
    await store.recordOutgoing(messageId, tag);
    return messageId;
  }

  /** Send the immediate acknowledgement that hands the sender their thread tag. */
  async function sendReceipt(received, { isNew, inReplyTo, references, subject }) {
    if (config.sendReceipt !== true) return;
    const displaySubject = tagSubject(subject, received.tag, config.tagPrefix);
    await sendThreaded({
      to: received.sender,
      subject: displaySubject,
      text: renderReceipt(received, { isNew }),
      tag: received.tag,
      replyTo: inReplyTo,
      references,
      receipt: received.receipt,
    });
  }

  /* ---------------------------------------------------------------- *
   * Inbound pipeline
   * ---------------------------------------------------------------- */

  /** Download attachments for one message into the workspace, respecting the configured caps. */
  async function saveAttachments(received, parsed) {
    if (config.attachments.enabled !== true) return [];
    const attachments = parsed.attachments ?? [];
    if (attachments.length === 0) return [];

    const targetDir = join(attachmentRoot, received.tag);
    await mkdir(targetDir, { recursive: true });
    const saved = [];
    let index = 0;
    for (const attachment of attachments) {
      index += 1;
      if (saved.filter((item) => item.skipped !== true).length >= config.attachments.maxCount) {
        saved.push({ name: attachment.name, skipped: true, reason: '超过数量上限' });
        continue;
      }
      if ((attachment.approxBytes ?? 0) > config.attachments.maxBytes) {
        saved.push({ name: attachment.name, skipped: true, reason: '超过单附件大小上限' });
        continue;
      }
      try {
        const data = decodeAttachment(attachment);
        const name = safeFileName(attachment.name, index);
        const path = join(targetDir, name);
        await writeFile(path, data);
        saved.push({ name, path, bytes: data.length, skipped: false });
      } catch (error) {
        saved.push({ name: attachment.name, skipped: true, reason: `解码失败: ${error?.message ?? error}` });
      }
    }
    return saved;
  }

  /** Handle one admitted message: bind the thread, create a session, deliver, acknowledge. */
  async function dispatch(verdict, raw) {
    const { received } = verdict;
    const isNew = verdict.action === Verdict.newSession;

    let sessionId = verdict.sessionId;
    if (isNew) {
      sessionId = await agentLink.createSession({
        cwd: workspaceDir,
        agentPreset: config.agentPreset.length > 0 ? config.agentPreset : undefined,
      });
      // A tag identifies a thread for its whole life. If one is already bound, keep the binding
      // and surface the conflict instead of silently moving the conversation to a new session.
      const binding = await store.bindThreadOnce(received.tag, { sessionId, subject: received.subject });
      if (binding.rebound) {
        ctx.logger?.error(
          'dsh-mail: thread %s is already bound to session %s; refusing to move it to %s. '
          + 'The new session is left unreferenced — inspect the thread table before trusting this thread.',
          received.tag,
          binding.previousSessionId,
          binding.sessionId,
        );
        sessionId = binding.previousSessionId;
      }
    }
    // A reply is delivered to the session the thread is bound to, full stop.
    //
    // There is deliberately no `ctx.sessions.get()` existence check here. That lookup only sees
    // sessions currently live in memory, so after every DSH restart it reported a perfectly
    // durable session as "gone" and started a new one — which also re-bound the tag, splitting
    // one thread across two sessions. Admitting a prompt to a cold session is the supported
    // path: the controller resumes it.
    if (sessionId === undefined) {
      throw new Error(`dsh-mail: no session for thread ${received.tag}`);
    }

    await store.putMessage(received.messageId, { ...received, sessionId, stage: 'received' });

    // Attachments land in the workspace before the model is told about them.
    let attachmentPaths = [];
    if (config.attachments.enabled === true) {
      try {
        const parsed = parseMessage(raw);
        attachmentPaths = await saveAttachments(received, parsed);
        if (attachmentPaths.length > 0) {
          ctx.logger?.info('dsh-mail: %d attachment(s) saved for thread %s', attachmentPaths.length, received.tag);
        }
      } catch (error) {
        ctx.logger?.warn('dsh-mail: attachments for %s could not be saved (%s)', received.messageId, error?.message ?? error);
      }
    }

    const references = [...received.references, received.messageId]
      .filter((value, position, all) => value !== undefined && all.indexOf(value) === position);
    const round = store.countByThread(received.tag) + 1;

    await agentLink.deliver({
      sessionId,
      tag: received.tag,
      prompt: renderPrompt(received, {
        isNew,
        turn: round,
        bodyText: received.body,
        attachmentPaths,
        modePreamble: config.includeModePreamble !== false,
      }),
      received,
      replyTo: received.messageId,
      references,
      subject: received.subject,
      round,
      // Only a reply inside the same thread interrupts; a new session has nothing to interrupt.
      mode: config.interruptSameThread !== false ? DeliveryMode.interrupt : DeliveryMode.queue,
    });

    await store.putMessage(received.messageId, {
      ...received,
      sessionId,
      stage: 'dispatched',
      dispatchedAt: Date.now(),
    });

    await sendReceipt(received, {
      isNew,
      inReplyTo: received.messageId,
      references,
      subject: received.subject,
    }).catch((error) => {
      ctx.logger?.warn('dsh-mail: receipt for %s could not be sent (%s)', received.messageId, error?.message ?? error);
    });

    ctx.logger?.info(
      'dsh-mail: %s from %s → session %s (thread %s, receipt %s)',
      isNew ? 'new mail' : 'reply',
      received.sender,
      sessionId,
      received.tag,
      received.receipt,
    );
  }

  /** Classify and act on one fetched message. */
  async function processMessage(uid, raw) {
    const verdict = classifyInbound({
      raw,
      uid,
      lookupMessage: (messageId) => store.message(messageId),
      lookupTag: (tag) => store.sessionForTag(tag),
      lookupOutgoing: (messageId) => store.tagForOutgoing(messageId),
      allowFrom: config.allowFrom,
      selfAddresses,
      tagPrefix: config.tagPrefix,
      maxBytes: config.maxMessageBytes,
    });

    switch (verdict.action) {
      case Verdict.ignore:
        ctx.logger?.debug?.('dsh-mail: ignoring uid %s (%s)', uid, verdict.reason);
        return;
      case Verdict.duplicate:
        ctx.logger?.debug?.('dsh-mail: uid %s duplicates a completed message (%s)', uid, verdict.messageId);
        return;
      case Verdict.continueSession:
        if (verdict.reason === 'unfinished-replay' && config.recovery !== 'rerun') {
          await store.putMessage(verdict.messageId, { stage: 'failed', failure: 'skipped by recovery policy' });
          return;
        }
        if (verdict.reason === 'unfinished-replay') {
          ctx.logger?.warn('dsh-mail: replaying unfinished message %s after restart', verdict.messageId);
        }
        await dispatch(verdict, raw);
        return;
      case Verdict.newSession:
        await dispatch(verdict, raw);
        return;
      default:
        ctx.logger?.warn('dsh-mail: unknown verdict %s', verdict.action);
    }
  }

  /* ---------------------------------------------------------------- *
   * Poll loop
   * ---------------------------------------------------------------- */

  /** One poll cycle: reconnect as needed, fetch everything new, and advance the watermark. */
  async function pollOnce() {
    const connection = await ensureImap();
    const info = await connection.select(config.imap.mailbox);
    await store.advanceCursor({ uidValidity: info.uidValidity, mailbox: config.imap.mailbox });

    const cursor = store.cursor;
    const criteria = cursor.lastUid > 0
      ? `UID ${cursor.lastUid + 1}:*`
      : 'ALL';

    let uids = await connection.uidSearch(criteria);
    // `UID n:*` always matches the last message even when it is older than n; drop those.
    uids = uids.filter((uid) => cursor.lastUid === 0 || uid > cursor.lastUid);
    if (uids.length > 200) uids = uids.slice(-200);

    for (const uid of uids) {
      if (lifecycle.signal.aborted) return;
      try {
        const { raw } = await connection.uidFetchBody(uid);
        await processMessage(uid, raw);
      } catch (error) {
        ctx.logger?.warn('dsh-mail: uid %s could not be processed (%s)', uid, error?.message ?? error);
      } finally {
        await store.advanceCursor({ lastUid: uid }).catch(() => {});
        await connection.uidStoreFlags(uid, ['Seen']).catch(() => {});
      }
    }

    return uids.length;
  }

  /** Wait for a mailbox hint or the poll interval, whichever comes first. */
  async function waitForWork() {
    const interval = Math.max(2000, config.imap.pollIntervalMs);
    if (config.imap.idle !== true) {
      await sleep(interval, lifecycle.signal);
      return;
    }
    const connection = imap;
    if (connection === undefined || connection.connected === false) {
      await sleep(interval, lifecycle.signal);
      return;
    }
    try {
      await connection.idleOnce({ timeoutMs: Math.min(Math.max(interval, 1000), config.imap.maxIdleMs) });
    } catch (error) {
      ctx.logger?.debug?.('dsh-mail: IDLE unavailable, falling back to polling (%s)', error?.message ?? error);
      config.imap.idle = false;
      await sleep(interval, lifecycle.signal);
    }
  }

  /** The long-running poll loop, restarted only by the plugin lifecycle. */
  async function loop() {
    // Recover anything the previous process left half-done before touching new mail.
    await recoverUnfinished();
    await agentLink.refreshRunning();

    while (!lifecycle.signal.aborted) {
      const now = Date.now();
      if (now < nextAllowedPoll) {
        await sleep(Math.min(nextAllowedPoll - now, 5000), lifecycle.signal);
        continue;
      }
      if (inFlight) {
        await sleep(1000, lifecycle.signal);
        continue;
      }
      inFlight = true;
      try {
        await pollOnce();
      } catch (error) {
        nextAllowedPoll = Date.now() + 30000;
        ctx.logger?.warn('dsh-mail: poll failed (%s); retrying in 30s', error?.message ?? error);
        await imap?.close().catch(() => {});
        imap = undefined;
      } finally {
        inFlight = false;
      }
      if (lifecycle.signal.aborted) return;
      try {
        await waitForWork();
      } catch (error) {
        ctx.logger?.debug?.('dsh-mail: idle wait ended (%s)', error?.message ?? error);
        await sleep(2000, lifecycle.signal);
      }
    }
  }

  /** Re-dispatch messages that never reached `done` before the previous process exited. */
  async function recoverUnfinished() {
    const unfinished = store.unfinished();
    if (unfinished.length === 0) return;
    if (config.recovery !== 'rerun') {
      for (const item of unfinished) {
        await store.putMessage(item.messageId, { stage: 'failed', failure: 'recovery policy is not rerun' }).catch(() => {});
      }
      ctx.logger?.info('dsh-mail: %d unfinished message(s) left marked failed by recovery policy', unfinished.length);
      return;
    }
    ctx.logger?.warn('dsh-mail: replaying %d unfinished message(s) from the previous run', unfinished.length);
    for (const item of unfinished) {
      if (lifecycle.signal.aborted) return;
      try {
        const connection = await ensureImap();
        if (item.uid === undefined) {
          ctx.logger?.warn('dsh-mail: cannot replay %s without a UID', item.messageId);
          await store.putMessage(item.messageId, { stage: 'failed', failure: 'no uid recorded' });
          continue;
        }
        const { raw } = await connection.uidFetchBody(item.uid);
        await processMessage(item.uid, raw);
      } catch (error) {
        ctx.logger?.warn('dsh-mail: replay of %s failed (%s)', item.messageId, error?.message ?? error);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Result delivery
   * ---------------------------------------------------------------- */

  /** Send the assistant's answer for one finished mail turn. */
  async function sendResult(session, event) {
    const pending = agentLink.takePending(session.id);
    if (pending === undefined) return;

    const reason = event.data?.reason;
    if (!resultWorthSending(reason)) {
      // The turn was replaced by a newer message; that message owns the next result.
      ctx.logger?.debug?.('dsh-mail: turn for %s ended as %s; no result mail', session.id, reason?.kind);
      return;
    }

    if (config.sendResult !== true) {
      await store.putMessage(pending.received.messageId, { stage: 'done', completedAt: Date.now() });
      return;
    }

    const outcome = extractTurnResult(session, { sinceSeq: pending.lastResultSeq ?? -1 });
    let text = outcome.text;
    if (typeof config.maxResultChars === 'number' && config.maxResultChars > 0 && text.length > config.maxResultChars) {
      text = `${text.slice(0, config.maxResultChars)}\n\n[结果过长已截断]`;
    }
    if (text.trim().length === 0) {
      text = '（本次处理没有产生文本输出。可回复本邮件继续该会话。）';
    }

    const tag = pending.tag;
    const subject = tagSubject(resultSubject(pending.subject, reason), tag, config.tagPrefix);
    const references = [...(pending.references ?? []), pending.replyTo]
      .filter((value, position, all) => value !== undefined && all.indexOf(value) === position);

    if (agentLink.isDuplicateOutgoing(tag, text)) {
      ctx.logger?.info('dsh-mail: suppressing duplicate result mail for thread %s', tag);
      agentLink.restorePending(session.id, pending);
      return;
    }

    try {
      await sendThreaded({
        to: pending.received.sender,
        subject,
        text,
        tag,
        replyTo: pending.replyTo,
        references,
        receipt: receiptId(),
      });
      agentLink.noteOutgoingSent(tag, text);
      await store.putMessage(pending.received.messageId, {
        stage: 'done',
        completedAt: Date.now(),
        resultSeq: outcome.seq,
      });
      ctx.logger?.info('dsh-mail: result for thread %s sent to %s', tag, pending.received.sender);
    } catch (error) {
      ctx.logger?.warn('dsh-mail: result mail for thread %s failed (%s)', tag, error?.message ?? error);
      agentLink.restorePending(session.id, pending);
      await store.putMessage(pending.received.messageId, {
        stage: 'failed',
        failure: String(error?.message ?? error),
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  ctx.on('agent/status', (payload) => {
    agentLink.noteStatus(payload.agent.id, payload.status);
  });

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    void sendResult(session, event).catch((error) => {
      ctx.logger?.warn('dsh-mail: result delivery failed (%s)', error?.message ?? error);
    });
  });

  const started = store.load()
    .then(() => {
      ctx.logger?.info(
        'dsh-mail: watching %s as %s (allowlist: %s)',
        config.imap.host,
        config.imap.user,
        config.allowFrom.length > 0 ? config.allowFrom.join(', ') : '(empty — nobody may drive the agent)',
      );
      if (imapPassword.length === 0) {
        ctx.logger?.warn('dsh-mail: no IMAP password found (config.imap.password or $%s)', config.imap.passwordEnv);
      }
      return loop();
    })
    .catch((error) => {
      ctx.logger?.error('dsh-mail: channel stopped (%s)', error?.stack ?? error);
    });

  ctx.effect(() => () => {
    lifecycle.abort(new Error('dsh-mail stopped'));
    void started.finally(() => imap?.close().catch(() => {}));
  }, 'dsh-mail.lifecycle');
}

/** Sleep that resolves early when the lifecycle aborts. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    handle.unref?.();
    function onAbort() {
      clearTimeout(handle);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export { Verdict, IgnoreReason, DeliveryMode };
