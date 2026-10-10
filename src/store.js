/**
 * Durable state for the mail channel.
 *
 * Three small JSON documents are the entire memory of the channel:
 *
 * - `messages` — every inbound message the channel has decided to act on, keyed by Message-ID,
 *   with the session it belongs to, its receipt id, and how far it got.
 * - `threads`  — the session mapping both directions: thread tag → session, and our own
 *   outgoing Message-IDs → thread tag, so a reply chain can always be resolved.
 * - `cursor`   — the polling watermark: the last UID consumed, plus the UIDVALIDITY it
 *   belonged to (a changed UIDVALIDITY invalidates the UID space, never the Message-ID map).
 *
 * Writes are atomic (temp file + fsync + rename) and serialized per file, because a crash
 * between "delivered to the agent" and "recorded as delivered" decides whether the message is
 * replayed — and replay beats a lost mail (see the recovery policy in the README).
 *
 * @module dsh-mail/store
 */

import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Stable short id derived from a string, used for thread tags and receipt ids. */
export function shortId(input, length = 4) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, length);
}

/** A random, collision-resistant receipt id shown to the human. */
export function receiptId() {
  return randomUUID().replace(/-/g, '').slice(0, 6);
}

/** Read a JSON document, returning the fallback when it is absent or unreadable. */
async function readJson(path, fallback) {
  try {
    const text = await readFile(path, 'utf8');
    if (text.trim().length === 0) return fallback;
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Replace a file atomically, durably, with owner-only permissions where the platform allows. */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await writeFile(handle, text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Serialize writes per path so concurrent mutations cannot interleave. */
class WriteQueue {
  #tail = Promise.resolve();

  /** Run `operation` after every previously queued write settled. */
  run(operation) {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

/**
 * The channel's durable state.
 *
 * All mutating methods persist before resolving, so a caller that has awaited a mutation can
 * rely on it surviving a crash.
 */
export class MailStore {
  #dir;
  #messagesPath;
  #threadsPath;
  #cursorPath;
  #messages = { version: 1, items: {} };
  #threads = { version: 1, byTag: {}, outgoing: {} };
  #cursor = { version: 1, uidValidity: null, lastUid: 0, mailbox: 'INBOX' };
  #queues = new Map();

  constructor(directory) {
    this.#dir = directory;
    this.#messagesPath = join(directory, 'messages.json');
    this.#threadsPath = join(directory, 'threads.json');
    this.#cursorPath = join(directory, 'cursor.json');
  }

  /** Absolute directory holding the state documents. */
  get directory() {
    return this.#dir;
  }

  /** Load all three documents from disk. */
  async load() {
    await mkdir(this.#dir, { recursive: true });
    this.#messages = await readJson(this.#messagesPath, { version: 1, items: {} });
    this.#threads = await readJson(this.#threadsPath, { version: 1, byTag: {}, outgoing: {} });
    this.#cursor = await readJson(this.#cursorPath, { version: 1, uidValidity: null, lastUid: 0, mailbox: 'INBOX' });
    this.#messages.items ??= {};
    this.#threads.byTag ??= {};
    this.#threads.outgoing ??= {};
    return this;
  }

  /** Queue one write for a specific document. */
  #queue(name, operation) {
    let queue = this.#queues.get(name);
    if (queue === undefined) {
      queue = new WriteQueue();
      this.#queues.set(name, queue);
    }
    return queue.run(operation);
  }

  /* --------------------------- messages --------------------------- */

  /** Read one inbound-message record. */
  message(messageId) {
    return this.#messages.items[messageId];
  }

  /** Insert or update one inbound-message record. */
  async putMessage(messageId, patch) {
    const previous = this.#messages.items[messageId] ?? {};
    const next = { ...previous, ...patch, messageId, updatedAt: Date.now() };
    this.#messages.items[messageId] = next;
    await this.#queue('messages', () => writeJsonAtomic(this.#messagesPath, this.#messages));
    return next;
  }

  /** All records still short of `done`, used by crash recovery. */
  unfinished() {
    return Object.values(this.#messages.items).filter((item) => item.stage !== 'done');
  }

  /** Drop records older than the retention window to keep the document bounded. */
  async pruneMessages({ retentionMs = 90 * 24 * 3600 * 1000, keepUnfinished = true } = {}) {
    const cutoff = Date.now() - retentionMs;
    let removed = 0;
    for (const [key, value] of Object.entries(this.#messages.items)) {
      if (keepUnfinished && value.stage !== 'done') continue;
      if ((value.updatedAt ?? 0) < cutoff) {
        delete this.#messages.items[key];
        removed += 1;
      }
    }
    if (removed > 0) await this.#queue('messages', () => writeJsonAtomic(this.#messagesPath, this.#messages));
    return removed;
  }

  /* --------------------------- threads ---------------------------- */

  /** Look up the session bound to one thread tag. */
  sessionForTag(tag) {
    return this.#threads.byTag[tag]?.sessionId;
  }

  /** Look up the thread tag bound to one of our own outgoing Message-IDs. */
  tagForOutgoing(messageId) {
    return this.#threads.outgoing[messageId];
  }

  /** Bind a thread tag to a session, keeping the record idempotent. */
  async bindThread(tag, { sessionId, subject, createdAt }) {
    const previous = this.#threads.byTag[tag];
    this.#threads.byTag[tag] = {
      sessionId,
      subject: subject ?? previous?.subject,
      createdAt: previous?.createdAt ?? createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await this.#queue('threads', () => writeJsonAtomic(this.#threadsPath, this.#threads));
    return this.#threads.byTag[tag];
  }

  /** Record one of our own outgoing Message-IDs so replies to it resolve to the thread. */
  async recordOutgoing(messageId, tag) {
    this.#threads.outgoing[messageId] = tag;
    const entries = Object.entries(this.#threads.outgoing);
    // Bound the map: keep the most recent 2000 bindings.
    if (entries.length > 2000) {
      for (const [key] of entries.slice(0, entries.length - 2000)) delete this.#threads.outgoing[key];
    }
    await this.#queue('threads', () => writeJsonAtomic(this.#threadsPath, this.#threads));
  }

  /** Every known thread, for diagnostics and the status command. */
  threads() {
    return { ...this.#threads.byTag };
  }

  /** How many messages this thread has already admitted, used for the round counter. */
  countByThread(tag) {
    let count = 0;
    for (const item of Object.values(this.#messages.items)) {
      if (item.tag === tag) count += 1;
    }
    return count;
  }

  /* --------------------------- cursor ----------------------------- */

  /** Current polling watermark. */
  get cursor() {
    return { ...this.#cursor };
  }

  /**
   * Advance the polling watermark.
   *
   * A changed `UIDVALIDITY` resets the UID space: the watermark restarts so the server's new
   * UID numbering is never mistaken for "already seen". Message identity is still decided by
   * Message-ID, so a reset cannot replay an already completed message.
   */
  async advanceCursor({ uidValidity, lastUid, mailbox }) {
    if (uidValidity !== undefined && uidValidity !== null && uidValidity !== this.#cursor.uidValidity) {
      this.#cursor.uidValidity = uidValidity;
      this.#cursor.lastUid = 0;
    }
    if (mailbox !== undefined) this.#cursor.mailbox = mailbox;
    if (lastUid !== undefined && lastUid > this.#cursor.lastUid) this.#cursor.lastUid = lastUid;
    await this.#queue('cursor', () => writeJsonAtomic(this.#cursorPath, this.#cursor));
    return this.cursor;
  }
}

export const __internals = { readJson, writeJsonAtomic, WriteQueue };
