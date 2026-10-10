/**
 * Minimal IMAP4rev1 client over implicit TLS.
 *
 * Scope is deliberately narrow: what the mail channel needs to poll one folder for new mail,
 * read a message, mark it seen, and fan out change notifications. There is no SASL, no
 * STARTTLS, and no destructive mailbox mutation — messages are only ever flagged `\Seen`, so
 * the mailbox stays fully readable for debugging.
 *
 * Commands are serialized: IMAP does not allow two tagged commands in flight on one
 * connection, and the single `#active` slot also gives continuation (`+`) and literal
 * handling an unambiguous target.
 *
 * @module dsh-mail/imap
 */

import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { connect as connectTls } from 'node:tls';

const CRLF = '\r\n';

/** Sentinel left in a response line where a `{n}` literal's bytes were consumed. */
const LITERAL_MARKER = '\u0001';

/** Quote one IMAP string argument. */
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render a command argument: atom-safe tokens stay bare, everything else is quoted. */
function atomize(value) {
  const text = String(value);
  return /^[A-Za-z0-9._\-*+]+$/.test(text) ? text : quote(text);
}

/**
 * Split one response line into tokens.
 *
 * Quoted strings lose their quotes, parenthesized lists are kept whole (they may nest, as in
 * `BODYSTRUCTURE`), and every other non-whitespace run is one token. Line noise like a literal
 * marker is deliberately left in place rather than treated as a delimiter, so `BODY[]` and the
 * token following a literal are never silently merged or split apart.
 */
function tokenizeLine(line) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  let parenDepth = 0;

  const push = () => {
    if (started || current.length > 0) tokens.push(current);
    current = '';
    started = false;
  };

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];

    if (inQuotes) {
      if (character === '\\' && i + 1 < line.length) {
        current += line[i + 1];
        i += 1;
        continue;
      }
      if (character === '"') {
        inQuotes = false;
        continue;
      }
      current += character;
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      started = true;
      continue;
    }

    if (character === '(') {
      parenDepth += 1;
      current += character;
      started = true;
      continue;
    }

    if (character === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      current += character;
      started = true;
      continue;
    }

    if (parenDepth === 0 && (character === ' ' || character === '\t')) {
      push();
      continue;
    }

    current += character;
  }

  push();
  return tokens;
}

/** Interpret one parenthesized flag list such as `(\Seen \Recent)`. */
function parseFlagList(token) {
  return token.replace(/^\(/, '').replace(/\)$/, '').split(/\s+/).filter((flag) => flag.length > 0);
}

/** One untagged response: the line segments around its literals, plus the literal payloads. */
class ResponseEntry {
  constructor(line, literals) {
    this.line = line;
    this.literals = literals;
    // A literal marker splits the response: tokens before and after it belong to different
    // segments and must never be tokenized together (the marker would otherwise be glued to
    // the following token, hiding a `FLAGS (...)` list or a closing paren).
    const segments = line.split(LITERAL_MARKER);
    this.segments = segments;
    this.segmentTokens = segments.map((segment) => tokenizeLine(segment));
    this.tokens = this.segmentTokens.flat();
  }
}

/** One in-flight tagged command. */
class ActiveCommand {
  constructor(tag, resolve, reject, options) {
    this.tag = tag;
    this.resolve = resolve;
    this.reject = reject;
    this.expectTagged = options.expectTagged !== false;
    this.entries = [];
    this.literals = [];
    this.pendingLiterals = [...(options.literals ?? [])];
    this.sawContinuation = false;
  }

  /** Attach one untagged response, preserving literal order. */
  push(entry) {
    this.entries.push(entry);
    this.literals.push(...entry.literals);
  }
}

/**
 * A single IMAP connection.
 *
 * @fires ImapConnection#exists
 * @fires ImapConnection#error
 * @fires ImapConnection#close
 */
export class ImapConnection extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #tagCounter = 0;
  #active = null;
  #greeting;
  #greetingWaiters = [];
  #literalNeed = null;
  #partialLine = null;
  #partialLiterals = [];
  #closed = false;
  #capabilities;

  constructor(options) {
    super();
    this.options = options;
    this.connected = false;
  }

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */

  /** Open the TLS connection and consume the server greeting. */
  async open() {
    const {
      host,
      port = 993,
      servername,
      rejectUnauthorized = true,
      connectTimeoutMs = 30000,
    } = this.options;

    this.#socket = await new Promise((resolve, reject) => {
      const socket = connectTls({ host, port, servername: servername ?? host, rejectUnauthorized });
      const onError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(connectTimeoutMs, () => socket.destroy(new Error('imap: connect timeout')));
      socket.once('secureConnect', () => {
        socket.off('error', onError);
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('error', onError);
    });

    this.connected = true;
    this.#socket.setNoDelay(true);
    this.#socket.on('data', (chunk) => this.#onData(chunk));
    this.#socket.on('error', (error) => this.#failAll(error));
    this.#socket.on('close', () => {
      this.#closed = true;
      this.connected = false;
      this.#failAll(new Error('imap: connection closed'));
      this.emit('close');
    });

    const greeting = await this.#waitForGreeting();
    if (greeting.type === 'BYE') throw new Error(`imap: server refused connection: ${greeting.line}`);
    return greeting;
  }

  /** Authenticate with `LOGIN`. */
  async login(user, password) {
    const result = await this.#run(`LOGIN ${quote(user)} ${quote(password)}`);
    if (result.type !== 'OK') throw new Error(`imap: login failed: ${result.text}`);
    return result;
  }

  /**
   * Send the `ID` command (RFC 2971) that several providers require before any mailbox access.
   *
   * NetEase (163/126/yeah) answers `SELECT` with `NO [Unsafe Login]` until the client has
   * identified itself, so this is mandatory there and harmless (guarded by the capability)
   * everywhere else.
   *
   * @param {Record<string, string>} [info] - client identity fields.
   * @returns {Promise<string|undefined>} the server's own ID response, if any.
   */
  async id(info = { name: 'dsh-mail', version: '0.1.0', vendor: 'dsh-mail' }) {
    const pairs = Object.entries(info)
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([key, value]) => `${quote(key)} ${quote(value)}`)
      .join(' ');
    const result = await this.#run(`ID (${pairs})`);
    const line = result.entries.map((entry) => entry.line).find((text) => /^\*\s+ID\b/i.test(text));
    return line;
  }

  /** Read (and cache) the advertised capability set. */
  async capabilities() {
    if (this.#capabilities !== undefined) return this.#capabilities;
    const result = await this.#run('CAPABILITY');
    const features = [];
    for (const entry of result.entries) {
      if (entry.segments.length > 1) continue; // a literal-backed entry is not a capability line
      const metadata = entry.segments[0] ?? '';
      const match = metadata.match(/^\*\s+CAPABILITY\s+(.*)$/i);
      if (match === null) continue;
      // Capability names are ASCII words (`IMAP4rev1` mixes case; `OK`/`completed` do not
      // appear on this line at all), so a word-shape filter is enough without guessing case.
      for (const token of match[1].split(/\s+/)) {
        if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(token)) features.push(token);
      }
    }
    this.#capabilities = new Set(features);
    return this.#capabilities;
  }

  /** Select a mailbox for read access. */
  async select(mailbox = 'INBOX') {
    const result = await this.#run(`SELECT ${quote(mailbox)}`);
    if (result.type !== 'OK') throw new Error(`imap: SELECT ${mailbox} failed: ${result.text}`);
    const info = { exists: 0, uidValidity: undefined, uidNext: undefined, readOnly: false };
    for (const entry of result.entries) {
      const exists = entry.line.match(/^\*\s+(\d+)\s+EXISTS\s*$/i);
      if (exists !== null) info.exists = Number(exists[1]);
      const validity = entry.line.match(/\[UIDVALIDITY\s+(\d+)\]/i);
      if (validity !== null) info.uidValidity = Number(validity[1]);
      const uidNext = entry.line.match(/\[UIDNEXT\s+(\d+)\]/i);
      if (uidNext !== null) info.uidNext = Number(uidNext[1]);
      if (/\[READ-ONLY\]/i.test(entry.line)) info.readOnly = true;
    }
    return info;
  }

  /** Search UIDs with an IMAP search expression (e.g. `UID 12:*` or `ALL`). */
  async uidSearch(criteria) {
    const result = await this.#run(`UID SEARCH ${criteria}`);
    if (result.type !== 'OK') throw new Error(`imap: UID SEARCH failed: ${result.text}`);
    const uids = [];
    for (const entry of result.entries) {
      if (!/^\*\s+SEARCH\b/i.test(entry.line)) continue;
      for (const token of entry.tokens.slice(2)) {
        const value = Number(token);
        if (Number.isInteger(value) && value > 0) uids.push(value);
      }
    }
    return uids.sort((left, right) => left - right);
  }

  /**
   * Fetch one message's UID, size, flags, and full source.
   *
   * The metadata is read with targeted patterns rather than a general token walk: a FETCH
   * response nests parenthesized lists, so only the segment *before* the literal is inspected
   * and each field is matched explicitly.
   */
  async uidFetchBody(uid) {
    const result = await this.#run(`UID FETCH ${uid} (UID RFC822.SIZE FLAGS BODY.PEEK[])`);
    if (result.type !== 'OK') throw new Error(`imap: UID FETCH ${uid} failed: ${result.text}`);

    let flags;
    let size;
    for (const entry of result.entries) {
      const metadata = entry.segments[0] ?? '';
      const sizeMatch = metadata.match(/RFC822\.SIZE\s+(\d+)/i);
      if (sizeMatch !== null) size = Number(sizeMatch[1]);
      const flagsMatch = metadata.match(/FLAGS\s+\(([^)]*)\)/i);
      if (flagsMatch !== null) flags = parseFlagList(`(${flagsMatch[1]})`);
    }

    const raw = result.literals.find((item) => item.length > 0);
    if (raw === undefined) throw new Error(`imap: UID FETCH ${uid} returned no body literal`);
    return { raw, flags: flags ?? [], size };
  }

  /** Add flags to one message; the channel only ever adds `\Seen`. */
  async uidStoreFlags(uid, flags, { silent = true } = {}) {
    const list = flags.map((flag) => (flag.startsWith('\\') ? flag : `\\${flag}`)).join(' ');
    const result = await this.#run(`UID STORE ${uid} +FLAGS${silent ? '.SILENT' : ''} (${list})`);
    if (result.type !== 'OK') throw new Error(`imap: UID STORE ${uid} failed: ${result.text}`);
    return result;
  }

  /**
   * List mailboxes with the attributes each one advertises.
   *
   * The attributes matter: `\Sent` (RFC 6154 special-use) is the only reliable way to identify
   * the sent folder, because its name is localized by every provider.
   *
   * @returns {Promise<Array<{ name: string, attributes: string[] }>>}
   */
  async listMailboxes() {
    const result = await this.#run('LIST "" "*"');
    const mailboxes = [];
    for (const entry of result.entries) {
      const match = entry.line.match(/^\*\s+LIST\s+\(([^)]*)\)\s+"[^"]*"\s+(.*)$/i);
      if (match === null) continue;
      const attributes = match[1].split(/\s+/).filter((attribute) => attribute.length > 0);
      let name = match[2].trim();
      if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
      mailboxes.push({ name, attributes });
    }
    return mailboxes;
  }

  /**
   * IDLE until a mailbox change or the timeout, whichever comes first.
   *
   * The tagged completion belongs to the IDLE command itself, so it is resolved by the parser
   * through the command's own `resolve`/`reject` slots: the promise exists before the command is
   * written, and it settles only after `DONE` has been acknowledged.
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<'exists'|'timeout'>}
   */
  async idleOnce({ timeoutMs = 240000 } = {}) {
    const capabilities = await this.capabilities();
    if (!capabilities.has('IDLE')) return 'timeout';
    if (this.#active !== null) throw new Error('imap: a command is already in flight');

    const tag = this.#nextTag();

    /** Resolved by the parser when the tagged completion for IDLE arrives. */
    const completed = new Promise((resolve, reject) => {
      const command = new ActiveCommand(tag, resolve, reject, { expectTagged: true });
      command.finish = resolve;
      command.abort = reject;
      this.#active = command;
    });

    let notifyTimeout;
    const changed = new Promise((resolve) => {
      const onExists = () => {
        this.off('exists', onExists);
        resolve('exists');
      };
      this.on('exists', onExists);
      notifyTimeout = () => {
        this.off('exists', onExists);
        resolve('timeout');
      };
    });

    this.#socket.write(`${tag} IDLE${CRLF}`);

    const timer = setTimeout(() => notifyTimeout?.(), timeoutMs);
    timer.unref?.();

    let outcome;
    try {
      outcome = await changed;
    } finally {
      clearTimeout(timer);
    }

    // Leave IDLE: DONE produces the tagged completion of the IDLE command.
    this.#socket.write(`DONE${CRLF}`);
    await completed;
    return outcome;
  }

  /** Append a raw message to a mailbox (best effort, used for the Sent folder). */
  async append(mailbox, rawMessage, { flags = ['\\Seen'] } = {}) {
    const payload = Buffer.from(rawMessage, 'utf8');
    const flagList = flags.length > 0 ? `(${flags.join(' ')}) ` : '';
    const prefix = `APPEND ${quote(mailbox)} ${flagList}{${payload.length}}`;
    const result = await this.#run(prefix, { literals: [payload] });
    if (result.type !== 'OK') throw new Error(`imap: APPEND ${mailbox} failed: ${result.text}`);
    return result;
  }

  /** `LOGOUT` and tear the socket down. */
  async close() {
    if (this.#closed || this.#socket === undefined || this.#socket.destroyed) return;
    try {
      await this.#run('LOGOUT');
    } catch {
      // A dropped connection during LOGOUT is normal.
    }
    this.#closed = true;
    this.#socket.end();
    this.#socket.destroy();
  }

  /* ---------------------------------------------------------------- *
   * Protocol plumbing
   * ---------------------------------------------------------------- */

  /** Allocate the next command tag. */
  #nextTag() {
    this.#tagCounter += 1;
    return `A${String(this.#tagCounter).padStart(4, '0')}`;
  }

  /** Issue one tagged command, serialized against any command already in flight. */
  async #run(text, options = {}) {
    if (this.#closed) throw new Error('imap: connection is closed');
    if (this.#active !== null) throw new Error('imap: a command is already in flight');

    const tag = this.#nextTag();
    const literals = options.literals ?? [];

    return new Promise((resolve, reject) => {
      const command = new ActiveCommand(tag, resolve, reject, options);
      command.pendingLiterals = [...literals];
      this.#active = command;

      const timedOut = setTimeout(() => {
        if (this.#active === command) {
          this.#active = null;
          reject(new Error(`imap: command timed out: ${tag} ${text.slice(0, 40)}`));
        }
      }, options.timeoutMs ?? this.options.commandTimeoutMs ?? 30000);
      timedOut.unref?.();

      command.finish = (value) => {
        clearTimeout(timedOut);
        resolve(value);
      };
      command.abort = (error) => {
        clearTimeout(timedOut);
        reject(error);
      };

      if (literals.length === 0) {
        this.#socket.write(`${tag} ${text}${CRLF}`);
        return;
      }
      // Wait for the continuation request before sending the literal payload.
      this.#socket.write(`${tag} ${text}${CRLF}`);
    });
  }

  /** Resolve with the greeting once the server has sent it. */
  #waitForGreeting() {
    if (this.#greeting !== undefined) return Promise.resolve(this.#greeting);
    return new Promise((resolve) => this.#greetingWaiters.push(resolve));
  }

  /** Feed socket bytes into the incremental parser. */
  #onData(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    this.#drain();
  }

  /** Consume every complete protocol unit currently buffered. */
  #drain() {
    for (;;) {
      if (this.#literalNeed !== null) {
        if (this.#buffer.length < this.#literalNeed) return;
        const literal = this.#buffer.subarray(0, this.#literalNeed).toString('utf8');
        this.#buffer = this.#buffer.subarray(this.#literalNeed);
        this.#partialLiterals.push(literal);
        this.#literalNeed = null;
        continue;
      }

      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) return;
      let lineBytes = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d) {
        lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
      }
      const line = lineBytes.toString('utf8');

      // Everything after a literal continues the same logical line, so an in-progress line
      // keeps accumulating here — which is what lets a response carry several literals.
      const composed = this.#partialLine === null ? line : this.#partialLine + line;

      const literalMatch = composed.match(/\{(\d+)\}$/);
      if (literalMatch !== null) {
        this.#partialLine = `${composed.slice(0, literalMatch.index)}${LITERAL_MARKER}`;
        this.#literalNeed = Number(literalMatch[1]);
        continue;
      }

      const literals = this.#partialLiterals;
      this.#partialLine = null;
      this.#partialLiterals = [];
      this.#route(composed, literals);
    }
  }

  /** Dispatch one complete response line. */
  #route(line, literals) {
    if (line.length === 0) return;

    if (this.#greeting === undefined && /^\*\s+(OK|PREAUTH|BYE)\b/i.test(line)) {
      const type = line.match(/^\*\s+(OK|PREAUTH|BYE)\b/i)[1].toUpperCase();
      this.#greeting = { type, line };
      for (const resolve of this.#greetingWaiters.splice(0)) resolve(this.#greeting);
      return;
    }

    const exists = line.match(/^\*\s+(\d+)\s+EXISTS\s*$/i);
    if (exists !== null) this.emit('exists', Number(exists[1]));

    const active = this.#active;
    if (active === null) return;

    const tagged = line.match(/^(A\d{4})\s+(OK|NO|BAD)\b([\s\S]*)$/i);
    if (tagged !== null && tagged[1].toUpperCase() === active.tag) {
      active.push(new ResponseEntry(line, literals));
      this.#active = null;
      active.finish?.({
        type: tagged[2].toUpperCase(),
        text: line,
        entries: active.entries,
        literals: active.literals,
      });
      return;
    }

    if (line.startsWith('+')) {
      active.sawContinuation = true;
      if (active.pendingLiterals.length > 0) {
        const payload = active.pendingLiterals.shift();
        this.#socket.write(payload);
        this.#socket.write(CRLF);
      }
      return;
    }

    if (active.expectTagged) active.push(new ResponseEntry(line, literals));
  }

  /** Reject the in-flight command and report the failure. */
  #failAll(error) {
    const active = this.#active;
    this.#active = null;
    if (active !== null) active.abort?.(error);
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }
}

export const __internals = { quote, atomize, tokenizeLine, parseFlagList };
