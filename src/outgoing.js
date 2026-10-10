/**
 * Outgoing mail: message construction, threading headers, and delivery.
 *
 * Every message the channel sends carries two identities:
 *
 * - a **thread tag** in the subject (`[dsh-a3f9]`) and an `X-DSH-Session` header, which lets a
 *   human keep the thread alive even if their client drops `References`;
 * - a per-message **receipt id** (`X-DSH-Receipt`), so "we received this" and "we answered
 *   this" are two separately verifiable facts.
 *
 * Threading follows the convention with the fewest breakage modes: `In-Reply-To` points at the
 * direct parent, while `References` carries the whole chain. Clients that lose one still
 * usually keep the other, and the subject tag survives both.
 *
 * @module dsh-mail/outgoing
 */

import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SmtpClient, dotStuff, foldHeader, formatDate, sanitizeHeaderValue } from './smtp.js';

/** Extract the domain part of an address, falling back to a stable placeholder. */
export function domainOf(address) {
  const at = String(address).lastIndexOf('@');
  return at === -1 ? 'dsh.local' : String(address).slice(at + 1);
}

/** Generate a Message-ID that identifies this channel's traffic. */
export function newMessageId(from) {
  const random = randomUUID().replace(/-/g, '').slice(0, 16);
  return `<dsh.${random}@${domainOf(from)}>`;
}

/**
 * Strip an existing thread tag so a re-tagged subject never stacks tags.
 *
 * Matches the same tolerant shapes as {@link tagFromSubject}: the bracket may be missing and the
 * tag may be any length we issue, otherwise a client-mangled subject would accumulate tags.
 */
export function stripSubjectTag(subject, prefix) {
  if (typeof subject !== 'string') return '';
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return subject
    .replace(new RegExp(`\\s*${escaped}\\s*[0-9a-fA-F]{3,16}\\]?`, 'g'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Prefix a subject with the thread tag, keeping any existing `Re:` markers. */
export function tagSubject(subject, tag, prefix = '[dsh-') {
  const base = stripSubjectTag(subject, prefix);
  const rePrefix = base.match(/^((?:Re|RE|回复|答复|返信)\s*:\s*)+/)?.[0] ?? '';
  const rest = base.slice(rePrefix.length).trim();
  return `${rePrefix}${prefix}${tag}]${rest.length > 0 ? ` ${rest}` : ''}`;
}

/**
 * Extract the thread tag from a subject, or `undefined` when absent.
 *
 * Deliberately tolerant, because the subject is whatever the reader's mail client produced:
 * the `Re:`/`回复:` prefixes, folding, re-encoding, and a client that drops the closing bracket
 * all happen in practice. The tag is only ever compared against our own thread table, so a
 * permissive match cannot bind a message to the wrong conversation — an unmatched tag starts a
 * new thread, which is the documented behaviour.
 *
 * @param {string} subject
 * @param {string} [prefix] - configured tag prefix, `[dsh-` by default.
 * @returns {string|undefined} the lower-cased tag.
 */
export function tagFromSubject(subject, prefix = '[dsh-') {
  if (typeof subject !== 'string' || subject.length === 0) return undefined;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Preferred: the configured prefix, case-insensitive, with the bracket optional. A client that
  // upper-cases the whole subject must not cost us the thread.
  const prefixed = subject.match(new RegExp(`${escaped}\\s*([0-9a-fA-F]{3,16})\\]?`, 'i'));
  if (prefixed !== null) return prefixed[1].toLowerCase();
  // Fallback for a client that dropped our prefix but kept the bracket. Kept narrow so an
  // unrelated bracketed token in someone's subject cannot be read as a session: the value must
  // be our exact tag width *and* contain a letter, which excludes `[12345]`, `[2024]`, `[1]`.
  const bracketed = subject.match(/\[([0-9a-f]{4}|[0-9a-f]{6})\]/i);
  if (bracketed === null || !/[a-f]/i.test(bracketed[1])) return undefined;
  return bracketed[1].toLowerCase();
}

/** Encode a header value as an RFC 2047 encoded word when it is not plain ASCII. */
export function encodeHeaderText(value) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/**
 * Encode one MIME parameter.
 *
 * ASCII values use the quoted form; anything else uses RFC 2231 extended syntax
 * (`name*=utf-8''...`), which is what mail clients expect for non-ASCII file names.
 *
 * @param {string} key
 * @param {string} value
 * @returns {string} the complete `key=value` pair.
 */
function encodeParameter(key, value) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(text)) return `${key}="${text.replace(/["\\]/g, '\\$&')}"`;
  return `${key}*=utf-8''${encodeURIComponent(text)}`;
}

/**
 * Encode a plain-text body for the wire.
 *
 * The payload is base64 rather than `8bit`, even though `8bit` is legal and smaller. Base64 is
 * pure ASCII, which makes the body immune to byte-level mangling in any encoding layer between
 * this process and the submission server — a failure mode that leaves the encoded-word *headers*
 * intact while destroying a multi-byte body, and that a provider is entitled to treat as an
 * invalid message and discard without notice. Base64 is also the standard way to carry UTF-8
 * through SMTP; the ~33% size cost is irrelevant at this message rate.
 *
 * @param {string} text
 * @returns {{ wrapped: string, lines: string[] }} the base64 payload and the entity headers.
 */
export function encodeTextBody(text) {
  const body = normalizeBody(text);
  const wrapped = Buffer.from(body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, `$1\r\n`)
    .replace(/\r\n$/, '');
  return {
    wrapped,
    lines: [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ],
  };
}

/**
 * Build the complete plain-text entity for a body.
 *
 * @param {string} text
 * @returns {string}
 */
export function textEntity(text) {
  const { wrapped, lines } = encodeTextBody(text);
  return `${lines.join('\r\n')}\r\n\r\n${wrapped}`;
}

/**
 * Build one MIME entity.
 *
 * Attachment parts carry `Content-Disposition` as well as the `name` parameter, because that is
 * where mail clients actually read the file name from; `name` alone renders as an unnamed part.
 *
 * @param {object} entity
 * @param {string} entity.contentType
 * @param {string} [entity.encoding] - `base64` or `8bit`.
 * @param {string} [entity.body]
 * @param {Buffer} [entity.data]
 * @param {string} [entity.name]
 * @param {boolean} [entity.attachment]
 * @returns {string}
 */
function renderEntity({ contentType, encoding = '8bit', body = '', data, name, attachment = false }) {
  const headers = [];
  if (name !== undefined && !contentType.includes('name=')) {
    headers.push(`Content-Type: ${contentType}; ${encodeParameter('name', name)}`);
  } else {
    headers.push(`Content-Type: ${contentType}`);
  }
  if (attachment && name !== undefined) {
    headers.push(`Content-Disposition: attachment; ${encodeParameter('filename', name)}`);
  }
  if (encoding === 'base64') {
    headers.push('Content-Transfer-Encoding: base64');
    const source = data ?? Buffer.from(body, 'utf8');
    const encoded = source.toString('base64').replace(/(.{76})/g, `$1\r\n`);
    return `${headers.join('\r\n')}\r\n\r\n${encoded}`;
  }
  headers.push('Content-Transfer-Encoding: 8bit');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * Assemble a complete RFC 5322 message.
 *
 * @param {object} input
 * @param {string} input.from - envelope/header sender address.
 * @param {string} [input.fromName]
 * @param {string} input.to
 * @param {string} input.subject
 * @param {string} input.text
 * @param {string} input.messageId
 * @param {string} [input.inReplyTo]
 * @param {string[]} [input.references]
 * @param {string} [input.tag]
 * @param {string} [input.receipt]
 * @param {Array<{ name: string, path?: string, data?: Buffer, mediaType?: string }>} [input.attachments]
 * @param {Date} [input.date]
 * @returns {Promise<string>}
 */
export async function buildMessage(input) {
  const {
    from,
    fromName,
    to,
    subject,
    text,
    messageId,
    inReplyTo,
    references = [],
    tag,
    receipt,
    attachments = [],
    date = new Date(),
  } = input;

  const headers = [];
  const fromHeader = fromName === undefined || fromName.length === 0
    ? from
    : `${encodeHeaderText(fromName)} <${from}>`;
  headers.push(foldHeader('From', fromHeader));
  headers.push(`To: ${sanitizeHeaderValue(to)}`);
  headers.push(foldHeader('Subject', encodeHeaderText(subject)));
  headers.push(`Date: ${formatDate(date)}`);
  headers.push(`Message-ID: ${messageId}`);
  if (inReplyTo !== undefined && inReplyTo.length > 0) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references.length > 0) headers.push(foldHeader('References', references.join(' ')));
  if (tag !== undefined) headers.push(`X-DSH-Session: ${tag}`);
  if (receipt !== undefined) headers.push(`X-DSH-Receipt: ${receipt}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Auto-Submitted: no');

  const textBody = encodeTextBody(text);

  if (attachments.length === 0) {
    headers.push(...textBody.lines);
    return `${headers.join('\r\n')}\r\n\r\n${textBody.wrapped}`;
  }

  const boundary = `dsh-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const chunks = [
    `--${boundary}`,
    `${textBody.lines.join('\r\n')}\r\n\r\n${textBody.wrapped}`,
  ];
  for (const attachment of attachments) {
    const data = attachment.data ?? await readFile(attachment.path);
    const name = attachment.name ?? basename(String(attachment.path ?? 'attachment'));
    chunks.push(`--${boundary}`);
    chunks.push(renderEntity({
      contentType: attachment.mediaType ?? 'application/octet-stream',
      encoding: 'base64',
      data,
      name,
      attachment: true,
    }));
  }
  chunks.push(`--${boundary}--`);
  return `${headers.join('\r\n')}\r\n\r\n${chunks.join('\r\n')}`;
}

/**
 * Guess a media type from a file name so attachments are not all octet-streams.
 *
 * @param {string} name
 * @returns {string}
 */
export function mediaTypeOf(name) {
  const extension = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const table = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', html: 'text/html', htm: 'text/html',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return table[extension] ?? 'application/octet-stream';
}

/** Normalize line endings and guarantee a trailing newline. */
export function normalizeBody(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return `${value.replace(/\r?\n/g, '\r\n').replace(/\r\n+$/, '')}\r\n`;
}

/** Content hash used to suppress duplicate outgoing bodies during crash replay. */
export function bodyDigest(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

/**
 * Delivers messages and keeps the mailbox's Sent folder in sync.
 *
 * One SMTP connection per message: at this message rate the reconnect cost is irrelevant, and
 * a failed delivery can never poison the next one.
 */
export class Mailer {
  #options;
  #logger;
  #onSent;

  /**
   * @param {object} options
   * @param {object} options.smtp - `{ host, port, user, password, secure }`.
   * @param {string} options.from - the mailbox address.
   * @param {string} [options.fromName]
   * @param {(message: string) => Promise<void>} [options.onSent] - Sent-folder sink (best effort).
   * @param {object} [options.logger]
   */
  constructor(options) {
    this.#options = options;
    this.#logger = options.logger;
    this.#onSent = options.onSent;
  }

  /**
   * Send one message.
   *
   * @param {{ to: string, subject: string, text: string, messageId: string, inReplyTo?: string,
   *   references?: string[], tag?: string, receipt?: string, attachments?: object[] }} input
   * @returns {Promise<{ messageId: string, accepted: boolean }>}
   */
  async send(input) {
    const message = await buildMessage({
      from: this.#options.from,
      fromName: this.#options.fromName,
      ...input,
    });

    const client = new SmtpClient({
      host: this.#options.smtp.host,
      port: this.#options.smtp.port ?? 465,
      secure: this.#options.smtp.secure !== false,
      servername: this.#options.smtp.servername,
      rejectUnauthorized: this.#options.smtp.rejectUnauthorized !== false,
      connectTimeoutMs: this.#options.smtp.connectTimeoutMs,
    });

    try {
      await client.open();
      const extensions = await client.ehlo(this.#options.smtp.ehloName ?? 'dsh.local');
      await client.authenticate(this.#options.smtp.user, this.#options.smtp.password, extensions);
      await client.send({ from: this.#options.from, to: [input.to], message });
    } finally {
      await client.close().catch(() => {});
    }

    const copiesToSent = this.#options.smtp.saveToSent !== false;
    if (copiesToSent && this.#onSent !== undefined) {
      try {
        await this.#onSent(message);
      } catch (error) {
        this.#logger?.warn('dsh-mail: could not append to Sent (%s)', error?.message ?? error);
      }
    }

    return { messageId: input.messageId, accepted: true };
  }
}

export const __internals = { renderEntity, encodeParameter, dotStuff };
