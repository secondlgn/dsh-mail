/**
 * Binding mail threads to DSH sessions, delivering prompts, and returning results.
 *
 * Two rules drive the whole design:
 *
 * 1. **A reply is an interruption, but only for its own thread.** A message whose thread maps to
 *    the session that is currently running replaces that turn: it is delivered, then the active
 *    turn is cancelled so the fresh prompt is picked up immediately. A message for any *other*
 *    session is queued and never disturbs the running one.
 * 2. **A result is sent only for turns the mail channel started.** Turns a human typed into the
 *    GUI must not generate email, so sessions with no outstanding mail turn are ignored here.
 *
 * The channel talks to the Host through `ctx.sessionController` (the service behind the
 * generated `ctx.remote.session` namespace), which is the supported transport-independent entry
 * point for creating a session, admitting a prompt, and cancelling a turn.
 *
 * @module dsh-mail/session
 */

import { bodyDigest } from './outgoing.js';

/** How a prompt should be admitted into a running session. */
export const DeliveryMode = {
  /** Replace the active turn with the new prompt (a reply from the same thread). */
  interrupt: 'interrupt',
  /** Append to the pending inbox and let the current turn finish. */
  queue: 'queue',
};

/**
 * Narrow view of the Host session controller used by the channel.
 *
 * @typedef {object} SessionController
 * @property {(request: object) => Promise<{ sessionId: string }>} create
 * @property {(request: object, signal: AbortSignal) => Promise<{ accepted: true }>} prompt
 * @property {(request: { sessionId: string }) => { accepted: true }} cancel
 * @property {(request: object, signal: AbortSignal) => Promise<{ items: object[] }>} list
 */

/** One in-flight mail turn: which session, which thread, and what still needs to be sent. */
class PendingTurn {
  constructor({ sessionId, tag, received, replyTo, references, subject, round = 1 }) {
    this.sessionId = sessionId;
    this.tag = tag;
    this.received = received;
    this.replyTo = replyTo;
    this.references = references;
    this.subject = subject;
    this.round = round;
    /** Highest assistant-message seq already reported, so a replay does not resend old text. */
    this.lastResultSeq = received?.resultSeq ?? -1;
    this.startedAt = Date.now();
  }
}

/**
 * Owns the session side of the channel: creation, prompt admission, interruption, and the
 * bookkeeping that decides which turns owe an email.
 */
export class AgentLink {
  #sessionController;
  #logger;
  #running = new Set();
  #pending = new Map();
  #sentDigests = new Map();

  /**
   * @param {object} options
   * @param {SessionController} options.sessionController
   * @param {object} [options.logger]
   */
  constructor({ sessionController, logger }) {
    this.#sessionController = sessionController;
    this.#logger = logger;
  }

  /** Sessions the Host reports as running, for diagnostics. */
  get runningSessions() {
    return [...this.#running];
  }

  /** Mail turns currently awaiting a result, keyed by session id. */
  get pendingTurns() {
    return new Map(this.#pending);
  }

  /** Seed the running set from the Host's own view, so a restart does not lose it. */
  async refreshRunning() {
    try {
      const value = await this.#sessionController.list({}, AbortSignal.timeout(5000));
      for (const item of value.items ?? []) {
        const id = String(item.sessionId);
        if (item.running === true) this.#running.add(id);
        else this.#running.delete(id);
      }
    } catch (error) {
      this.#logger?.debug?.('dsh-mail: could not read session list (%s)', error?.message ?? error);
    }
    return this.#running;
  }

  /** Record a Host status change. */
  noteStatus(sessionId, status) {
    const id = String(sessionId);
    if (status === 'running') this.#running.add(id);
    else this.#running.delete(id);
  }

  /** Whether the Host currently has an active turn for this session. */
  isRunning(sessionId) {
    return this.#running.has(String(sessionId));
  }

  /** Register the mail turn a session owes an email for. */
  expectResult(sessionId, pending) {
    this.#pending.set(String(sessionId), pending);
  }

  /** Drop a pending record without sending (used when delivery itself failed). */
  clearPending(sessionId) {
    this.#pending.delete(String(sessionId));
  }

  /** Read and clear the pending record for one session. */
  takePending(sessionId) {
    const id = String(sessionId);
    const pending = this.#pending.get(id);
    if (pending !== undefined) this.#pending.delete(id);
    return pending;
  }

  /** Reattach a pending record after a failed send so the next turn retries. */
  restorePending(sessionId, pending) {
    this.#pending.set(String(sessionId), pending);
  }

  /**
   * Suppress an outgoing body that was already sent for this thread.
   *
   * Replay after a crash is deliberate, but re-sending the *same words* is not: this is the
   * cost-control half of the at-least-once policy.
   *
   * @returns {boolean} `true` when the caller should skip sending.
   */
  isDuplicateOutgoing(tag, text) {
    const digest = `${tag}:${bodyDigest(text)}`;
    return this.#sentDigests.has(digest);
  }

  /** Remember one outgoing body as sent. */
  noteOutgoingSent(tag, text) {
    const digest = `${tag}:${bodyDigest(text)}`;
    this.#sentDigests.set(digest, Date.now());
    if (this.#sentDigests.size > 500) {
      const oldest = [...this.#sentDigests.entries()].sort((left, right) => left[1] - right[1])[0];
      if (oldest !== undefined) this.#sentDigests.delete(oldest[0]);
    }
  }

  /**
   * Create a fresh session for a new mail thread.
   *
   * @param {{ cwd?: string, agentPreset?: string }} options
   * @returns {Promise<string>} the new session id.
   */
  async createSession({ cwd, agentPreset } = {}) {
    const request = {};
    if (cwd !== undefined) request.cwd = cwd;
    if (agentPreset !== undefined && agentPreset.length > 0) request.agentPreset = agentPreset;
    const value = await this.#sessionController.create(request);
    return String(value.sessionId);
  }

  /**
   * Deliver one received message into its session and arrange for the result email.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} input.tag
   * @param {string} input.prompt - the rendered model-facing prompt.
   * @param {object} input.received - the admission record (identity for the reply headers).
   * @param {string} input.replyTo - the Message-ID the result must reply to.
   * @param {string[]} input.references - the reference chain for the result.
   * @param {string} input.subject - the untagged subject.
   * @param {string} [input.mode] - `interrupt` (default) or `queue`.
   * @param {string} [input.requestId]
   * @returns {Promise<{ delivered: boolean, mode: string, interrupted: boolean }>}
   */
  async deliver({
    sessionId,
    tag,
    prompt,
    received,
    replyTo,
    references,
    subject,
    round = 1,
    mode = DeliveryMode.interrupt,
    requestId,
  }) {
    const id = String(sessionId);
    const running = this.isRunning(id);

    let admittedMode = running && mode === DeliveryMode.interrupt ? 'steer' : 'queue';
    let admitted = false;
    let usedCancelFallback = false;

    if (admittedMode === 'steer') {
      try {
        await this.#admit(id, prompt, 'steer', requestId);
        admitted = true;
      } catch (error) {
        this.#logger?.debug?.('dsh-mail: steer rejected, falling back to queue+cancel (%s)', error?.message ?? error);
        admittedMode = 'queue';
      }
    }

    if (!admitted) {
      await this.#admit(id, prompt, 'queue', requestId);
      admittedMode = 'queue';
    }

    // A reply to a running thread replaces the turn: queue it, then cancel what is running so
    // the queued prompt is picked up now rather than after the abandoned work finishes.
    if (running && mode === DeliveryMode.interrupt) {
      try {
        this.#sessionController.cancel({ sessionId: id });
        usedCancelFallback = admittedMode !== 'steer';
      } catch (error) {
        this.#logger?.warn('dsh-mail: could not cancel the running turn (%s)', error?.message ?? error);
      }
    }

    this.expectResult(id, new PendingTurn({
      sessionId: id,
      tag,
      received,
      replyTo,
      references,
      subject,
      round,
    }));

    return { delivered: true, mode: admittedMode, interrupted: running && mode === DeliveryMode.interrupt, usedCancelFallback };
  }

  /** Admit one prompt through the Host controller. */
  async #admit(sessionId, prompt, mode, requestId) {
    const request = {
      requestId: requestId ?? `dsh-mail-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode,
      content: [{ type: 'text', text: prompt }],
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('dsh-mail: prompt admission timed out')), 30000);
    timeout.unref?.();
    try {
      await this.#sessionController.prompt(request, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Extract the assistant text that a just-finished turn committed.
 *
 * The channel reads the committed session log rather than the assistant stream: the log is the
 * durable record, and a stream can be abandoned by an interruption.
 *
 * @param {{ snapshotEvents: () => object[] }} session
 * @param {{ sinceSeq?: number }} [options]
 * @returns {{ text: string, seq: number|undefined, truncated: boolean }}
 */
export function extractTurnResult(session, options = {}) {
  const { sinceSeq = -1 } = options;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return { text: '', seq: undefined, truncated: false };
  }

  let latest;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    if (typeof event.seq === 'number' && event.seq <= sinceSeq) continue;
    latest = event;
  }
  if (latest === undefined) return { text: '', seq: undefined, truncated: false };

  const blocks = latest.data?.message?.content ?? [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return { text, seq: typeof latest.seq === 'number' ? latest.seq : undefined, truncated: latest.data?.interrupted === true };
}

/** Judge whether a turn-ending reason should produce a result email. */
export function resultWorthSending(reason) {
  const kind = reason?.kind;
  if (kind === 'interrupted' || kind === 'forked') return false;
  return true;
}

/** Prefix a result subject with the outcome marker when the turn did not simply complete. */
export function resultSubject(baseSubject, reason) {
  const kind = reason?.kind;
  if (kind === 'completed' || kind === undefined) return baseSubject;
  const label = kind === 'error' ? '[出错] ' : kind === 'aborted' ? '[已取消] ' : kind === 'max-tokens' ? '[已截断] ' : `[${kind}] `;
  return `${label}${baseSubject}`;
}

export const __internals = { PendingTurn };
