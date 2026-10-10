/**
 * Minimal SMTP submission client over implicit TLS.
 *
 * Covers the submission path the mail channel needs: EHLO, AUTH (PLAIN/LOGIN/CRAM-MD5),
 * MAIL/RCPT/DATA, and QUIT. There is no pipelining and no STARTTLS: port 465-style implicit
 * TLS is the deployment shape the channel targets, and one message per connection keeps the
 * failure semantics obvious.
 *
 * @module dsh-mail/smtp
 */

import { connect as connectTls } from 'node:tls';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';

const CRLF = '\r\n';

/** One SMTP reply: code plus the full server text. */
class Reply {
  constructor(code, text) {
    this.code = code;
    this.text = text;
  }

  get ok() {
    return this.code >= 200 && this.code < 300;
  }

  get isFinal() {
    return this.code >= 200;
  }
}

/** Escape a client-supplied string for use inside an SMTP command. */
export function sanitizeHeaderValue(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * RFC 5322 date-time for the `Date` header.
 *
 * The time-of-day fields must be the *local* ones, because that is the clock the appended offset
 * describes. Emitting UTC fields with a local offset (the previous behaviour) produced headers
 * such as `15:11:36 +0800` for a message actually sent at 23:11 local time, so every recipient's
 * client displayed the message hours in the past.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function formatDate(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${days[date.getDay()]}, ${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

/** Fold a header value onto continuation lines at whitespace, keeping every line within budget. */
export function foldHeader(name, value, { limit = 78 } = {}) {
  const single = `${name}: ${sanitizeHeaderValue(value)}`;
  if (single.length <= limit) return single;
  const words = sanitizeHeaderValue(value).split(/\s+/);
  const lines = [];
  let current = `${name}:`;
  for (const word of words) {
    if (`${current} ${word}`.length > limit && current.length > `${name}:`.length) {
      lines.push(current);
      current = ` ${word}`;
      continue;
    }
    current = `${current} ${word}`;
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Dot-stuff a message body and terminate it for the DATA command. */
export function dotStuff(message) {
  // Normalize line endings, drop any trailing newlines the message already carried, escape
  // leading dots, then add the terminator on its own line.
  const normalized = message.replace(/\r?\n/g, CRLF).replace(/(?:\r\n)+$/, '');
  const stuffed = normalized.replace(/^\./gm, '..');
  return `${stuffed}${CRLF}.${CRLF}`;
}

/**
 * One SMTP submission connection.
 *
 * The client is single-use by design: `send()` opens, authenticates, delivers, and quits.
 * A long-lived connection would need re-connect, keepalive, and pipeline recovery logic that
 * buys nothing at this message rate.
 */
export class SmtpClient {
  #socket;
  #buffer = '';
  #waiters = [];
  #closed = false;

  constructor(options) {
    this.options = options;
  }

  /** Open the TLS connection and read the banner. */
  async open() {
    const {
      host,
      port = 465,
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
      socket.setTimeout(connectTimeoutMs, () => socket.destroy(new Error('smtp: connect timeout')));
      socket.once('secureConnect', () => {
        socket.off('error', onError);
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('error', onError);
    });

    this.#socket.setNoDelay(true);
    this.#socket.setEncoding('utf8');
    this.#socket.on('data', (chunk) => this.#onData(chunk));
    this.#socket.on('error', (error) => this.#failAll(error));
    this.#socket.on('close', () => {
      this.#closed = true;
      this.#failAll(new Error('smtp: connection closed'));
    });

    const banner = await this.#readReply();
    if (banner.code !== 220) throw new Error(`smtp: unexpected banner: ${banner.text}`);
    return banner;
  }

  /**
   * Say EHLO and return the parsed extension lines.
   *
   * The reply's own status codes are stripped, so callers see plain capability text such as
   * `SIZE 35882577` or `AUTH PLAIN LOGIN`.
   *
   * @param {string} hostname
   * @returns {Promise<string[]>}
   */
  async ehlo(hostname = 'localhost') {
    const reply = await this.#command(`EHLO ${hostname}`);
    if (reply.code !== 250) throw new Error(`smtp: EHLO rejected: ${reply.text}`);
    return reply.text
      .split('\n')
      .slice(1) // the first line is the greeting, not an extension
      .map((line) => line.replace(/^\d{3}[ -]?/, '').trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Authenticate with the strongest mechanism the server offers.
   * @param {string} user
   * @param {string} password
   * @param {string[]} extensions - the EHLO extension lines.
   */
  async authenticate(user, password, extensions) {
    const authLine = extensions.find((line) => /^AUTH\b/i.test(line));
    const mechanisms = authLine === undefined
      ? []
      : authLine.replace(/^AUTH\s+/i, '').trim().toUpperCase().split(/\s+/);

    if (mechanisms.includes('CRAM-MD5')) return this.#authCramMd5(user, password);
    if (mechanisms.includes('PLAIN') || mechanisms.length === 0) return this.#authPlain(user, password);
    if (mechanisms.includes('LOGIN')) return this.#authLogin(user, password);
    throw new Error(`smtp: no supported AUTH mechanism (offered: ${mechanisms.join(', ') || 'none'})`);
  }

  /** `AUTH PLAIN` with an initial response. */
  async #authPlain(user, password) {
    const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64');
    const reply = await this.#command(`AUTH PLAIN ${token}`);
    if (!reply.ok) throw new Error(`smtp: AUTH PLAIN rejected: ${reply.text}`);
    return reply;
  }

  /** `AUTH LOGIN` with base64-encoded challenges. */
  async #authLogin(user, password) {
    const start = await this.#command('AUTH LOGIN');
    if (start.code !== 334) throw new Error(`smtp: AUTH LOGIN rejected: ${start.text}`);
    const userReply = await this.#command(Buffer.from(user, 'utf8').toString('base64'));
    if (userReply.code !== 334) throw new Error(`smtp: AUTH LOGIN username rejected: ${userReply.text}`);
    const passwordReply = await this.#command(Buffer.from(password, 'utf8').toString('base64'));
    if (!passwordReply.ok) throw new Error(`smtp: AUTH LOGIN rejected: ${passwordReply.text}`);
    return passwordReply;
  }

  /** `AUTH CRAM-MD5`, which avoids sending the password itself. */
  async #authCramMd5(user, password) {
    const challengeReply = await this.#command('AUTH CRAM-MD5');
    if (challengeReply.code !== 334) throw new Error(`smtp: AUTH CRAM-MD5 rejected: ${challengeReply.text}`);
    const challenge = Buffer.from(challengeReply.text.replace(/^334\s*/, '').trim(), 'base64');
    const digest = createHmac('md5', password).update(challenge).digest('hex');
    const response = Buffer.from(`${user} ${digest}`, 'utf8').toString('base64');
    const reply = await this.#command(response);
    if (!reply.ok) throw new Error(`smtp: AUTH CRAM-MD5 rejected: ${reply.text}`);
    return reply;
  }

  /**
   * Deliver one already-rendered message.
   *
   * @param {{ from: string, to: string[], message: string }} envelope
   */
  async send({ from, to, message }) {
    const mailFrom = await this.#command(`MAIL FROM:<${from}>`);
    if (!mailFrom.ok) throw new Error(`smtp: MAIL FROM rejected: ${mailFrom.text}`);

    for (const recipient of to) {
      const rcpt = await this.#command(`RCPT TO:<${recipient}>`);
      if (!rcpt.ok) throw new Error(`smtp: RCPT TO <${recipient}> rejected: ${rcpt.text}`);
    }

    const data = await this.#command('DATA');
    if (data.code !== 354) throw new Error(`smtp: DATA rejected: ${data.text}`);

    const accepted = await this.#write(dotStuff(message));
    if (!accepted.ok) throw new Error(`smtp: message rejected: ${accepted.text}`);
    return accepted;
  }

  /** Send `QUIT` and close the socket. */
  async close() {
    const socket = this.#socket;
    if (this.#closed || socket === undefined || socket.destroyed) return;
    this.#closed = true;
    if (socket.writable) {
      // Best effort: a server that already refused the connection owes us nothing, and waiting
      // for its QUIT reply would only delay teardown.
      try {
        await this.#command('QUIT');
      } catch {
        // Closing after QUIT frequently surfaces as a socket error, and a dead peer times out.
      }
    }
    socket.end();
    socket.destroy();
  }

  /* ---------------------------------------------------------------- *
   * Reply plumbing
   * ---------------------------------------------------------------- */

  /** Send one command line and await its final reply. */
  #command(line) {
    this.#socket.write(`${line}${CRLF}`);
    return this.#readReply();
  }

  /** Write a raw payload (the DATA body) and await its final reply. */
  #write(payload) {
    this.#socket.write(payload);
    return this.#readReply();
  }

  /** Await one complete SMTP reply, joining multiline continuations. */
  #readReply() {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined };
      const timeoutMs = this.options.replyTimeoutMs ?? 60000;
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index === -1) return;
        this.#waiters.splice(index, 1);
        reject(new Error('smtp: timed out waiting for a server reply'));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
      this.#drain();
    });
  }

  /** Feed socket data and satisfy any waiting reply. */
  #onData(chunk) {
    this.#buffer += chunk;
    this.#drain();
  }

  /** Extract the next complete reply, if one is buffered. */
  #drain() {
    if (this.#waiters.length === 0) return;
    const lines = this.#buffer.split(CRLF);
    // Keep the trailing partial line in the buffer.
    this.#buffer = lines.pop() ?? '';

    let index = 0;
    while (index < lines.length) {
      const first = lines[index];
      const match = first.match(/^(\d{3})([ -])(.*)$/);
      if (match === null) {
        index += 1;
        continue;
      }
      const code = Number(match[1]);
      const collected = [first];
      index += 1;
      if (match[2] === '-') {
        // Multiline reply: consume until the same code with a space separator.
        let closed = false;
        while (index < lines.length) {
          const line = lines[index];
          collected.push(line);
          index += 1;
          if (new RegExp(`^${code} `).test(line)) {
            closed = true;
            break;
          }
        }
        if (!closed) {
          // Incomplete multiline reply: restore and wait for more data.
          this.#buffer = `${[...collected, this.#buffer].join(CRLF)}`;
          return;
        }
      }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      waiter.resolve(new Reply(code, collected.join('\n')));
      if (this.#waiters.length === 0) return;
    }

    // Preserve any unparsed remainder for the next round.
    if (index < lines.length) this.#buffer = `${lines.slice(index).join(CRLF)}${CRLF}${this.#buffer}`;
  }

  /** Reject every waiting reply after a socket failure. */
  #failAll(error) {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export const __internals = { Reply };
