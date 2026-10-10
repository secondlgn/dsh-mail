/**
 * MIME decoding and mail-body extraction.
 *
 * Pure functions only: this module never touches the network or the filesystem, so the
 * header/quote/HTML behaviour that decides what the model actually reads can be verified
 * in isolation (see `test/mime.test.mjs`).
 *
 * @module dsh-mail/mime
 */

import { Buffer } from 'node:buffer';

/* ------------------------------------------------------------------ *
 * Encoded words (RFC 2047)
 * ------------------------------------------------------------------ */

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

/** Decode one Q-encoded payload into raw bytes. */
function decodeQPayload(payload) {
  const bytes = [];
  for (let i = 0; i < payload.length; i += 1) {
    const character = payload[i];
    if (character === '_') {
      bytes.push(0x20);
      continue;
    }
    if (character === '=' && i + 2 < payload.length + 1) {
      const hex = payload.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const encoded = Buffer.from(character, 'utf8');
    for (const byte of encoded) bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Decode a single encoded word's payload according to its encoding token. */
function decodeEncodedWord(charset, encoding, payload) {
  const raw = encoding.toUpperCase() === 'B'
    ? safeBase64ToBuffer(payload)
    : decodeQPayload(payload);
  return decodeBuffer(raw, charset);
}

/** Decode every encoded word in one header value, collapsing folding whitespace between them. */
function decodeHeaderValue(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .replace(ENCODED_WORD, (_match, charset, encoding, payload) => {
      try {
        return decodeEncodedWord(charset, encoding, payload);
      } catch {
        return _match;
      }
    })
    .replace(/\?=\s+=\?/g, '?==?');
}

/* ------------------------------------------------------------------ *
 * Buffer decoding
 * ------------------------------------------------------------------ */

const CHARSET_ALIASES = new Map([
  ['utf8', 'utf-8'],
  ['utf_8', 'utf-8'],
  ['unicode-1-1-utf-8', 'utf-8'],
  ['gb2312', 'gbk'],
  ['gb_2312', 'gbk'],
  ['gb2312-80', 'gbk'],
  ['chinese', 'gbk'],
  ['cp936', 'gbk'],
  ['ms936', 'gbk'],
  ['x-gbk', 'gbk'],
  ['ansi_x3.4-1968', 'ascii'],
  ['us-ascii', 'ascii'],
  ['latin1', 'iso-8859-1'],
  ['iso8859-1', 'iso-8859-1'],
  ['windows-1252', 'windows-1252'],
]);

/** Resolve a declared charset token onto a Node-supported label. */
function normalizeCharset(charset) {
  if (typeof charset !== 'string') return 'utf-8';
  const key = charset.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (key.length === 0) return 'utf-8';
  if (CHARSET_ALIASES.has(key)) return CHARSET_ALIASES.get(key);
  try {
    // Throws for labels Node does not know; the canonical form is what we hand to TextDecoder.
    return new TextDecoder(key).encoding;
  } catch {
    return 'utf-8';
  }
}

/** Decode a byte buffer under a declared charset, falling back to UTF-8 on failure. */
export function decodeBuffer(buffer, charset) {
  const label = normalizeCharset(charset);
  if (label === 'ascii') return buffer.toString('latin1');
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/** Base64-decode while tolerating whitespace and missing padding. */
function safeBase64ToBuffer(input) {
  const compact = input.replace(/[\s\r\n]+/g, '');
  const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Decode quoted-printable to raw bytes, honouring soft line breaks.
 *
 * @param {string} input
 * @returns {Buffer}
 */
export function quotedPrintableToBytes(input) {
  const bytes = [];
  const text = String(input).replace(/\r\n/g, '\n');
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character !== '=') {
      const encoded = Buffer.from(character === '\n' ? '\r\n' : character, 'utf8');
      for (const byte of encoded) bytes.push(byte);
      continue;
    }
    const next = text[i + 1];
    if (next === '\n') { // soft break
      i += 1;
      continue;
    }
    if (next === '\r' && text[i + 2] === '\n') {
      i += 2;
      continue;
    }
    const hex = text.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(0x3d); // a bare '=' that is not an escape stays literal
  }
  return Buffer.from(bytes);
}

/** Decode quoted-printable into text under the entity's declared charset. */
export function decodeQuotedPrintable(input, charset = 'utf-8') {
  return decodeBuffer(quotedPrintableToBytes(input), charset);
}

/* ------------------------------------------------------------------ *
 * Header parsing
 * ------------------------------------------------------------------ */

/** Split a raw message into its header block and the remaining body bytes. */
export function splitHeaders(raw) {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator !== -1) return { headerText: raw.slice(0, separator), body: raw.slice(separator + 4) };
  const lfSeparator = raw.indexOf('\n\n');
  if (lfSeparator !== -1) return { headerText: raw.slice(0, lfSeparator), body: raw.slice(lfSeparator + 2) };
  return { headerText: raw, body: '' };
}

/**
 * Parse a header block into a lower-case-keyed map.
 * Repeated fields (notably `received`) collapse into an array.
 */
export function parseHeaders(headerText) {
  const headers = new Map();
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing === undefined) headers.set(name, value);
    else if (Array.isArray(existing)) existing.push(value);
    else headers.set(name, [existing, value]);
  }
  return headers;
}

/** Read one header as a decoded string, taking the last occurrence for repeated fields. */
export function headerValue(headers, name) {
  const raw = headers.get(name.toLowerCase());
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return decodeHeaderValue(value);
}

/** Split a structured header such as `To` into its address parts, respecting quoted strings. */
export function splitAddressList(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const parts = [];
  let current = '';
  let inQuotes = false;
  let angleDepth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character === '"' && value[i - 1] !== '\\') inQuotes = !inQuotes;
    else if (!inQuotes && character === '<') angleDepth += 1;
    else if (!inQuotes && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (character === ',' && !inQuotes && angleDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Extract the bare `local@domain` from one address part, or `undefined` when there is none. */
export function addressOf(part) {
  if (typeof part !== 'string') return undefined;
  const angled = part.match(/<([^>]*)>/);
  const candidate = (angled ? angled[1] : part).trim();
  const match = candidate.match(/[^\s<>",;:]+@[^\s<>",;:]+/);
  return match === null ? undefined : match[0].toLowerCase();
}

/** Extract every bare address from a structured header value. */
export function addressesIn(value) {
  return splitAddressList(value).map(addressOf).filter((address) => address !== undefined);
}

/** Parse a `Message-ID`-bearing header into the bracketed ids it contains. */
export function messageIdsIn(value) {
  if (typeof value !== 'string') return [];
  const ids = value.match(/<[^<>]+>/g);
  if (ids !== null) return ids.map((id) => id.trim());
  const bare = value.trim();
  return bare.length === 0 ? [] : [`<${bare.replace(/^<|>$/g, '')}>`];
}

/** Parse a `Content-Type`-style parameterized header into its value and parameters. */
export function parseParameterized(value) {
  if (typeof value !== 'string') return { value: '', params: {} };
  const segments = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character === '"' && value[i - 1] !== '\\') inQuotes = !inQuotes;
    if (character === ';' && !inQuotes) {
      segments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  segments.push(current);
  const [head, ...rest] = segments;
  const params = {};
  for (const segment of rest) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    const key = segment.slice(0, equals).trim().toLowerCase();
    let parameterValue = segment.slice(equals + 1).trim();
    if (parameterValue.startsWith('"') && parameterValue.endsWith('"') && parameterValue.length >= 2) {
      parameterValue = parameterValue.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    params[key] = decodeHeaderValue(parameterValue);
  }
  return { value: (head ?? '').trim().toLowerCase(), params };
}

/**
 * Parse a raw RFC 822 message into a part tree.
 *
 * The tree keeps only what the mail channel needs: headers, decoded text, and attachments
 * described by name and byte length (attachment bytes stay on the wire until download).
 *
 * @param {string} raw - the complete message source.
 * @param {{ maxDepth?: number, maxParts?: number }} [limits]
 * @returns {{ headers: Map<string,string|string[]>, parts: object[], text: string, html?: string, attachments: object[] }}
 */
export function parseMessage(raw, limits = {}) {
  const maxDepth = limits.maxDepth ?? 12;
  const maxParts = limits.maxParts ?? 64;
  const budget = { parts: maxParts };
  const root = parsePart(raw, 0, maxDepth, budget);
  const flattened = flattenParts(root);
  const textPart = flattened.find((part) => part.kind === 'text');
  const htmlPart = flattened.find((part) => part.kind === 'html');
  return {
    headers: root.headers,
    parts: flattened,
    text: textPart?.text ?? '',
    html: htmlPart?.text,
    attachments: flattened.filter((part) => part.kind === 'attachment'),
  };
}

/** Depth-first flatten of the part tree, keeping document order. */
function flattenParts(part) {
  const collected = [];
  const visit = (node) => {
    if (node.kind !== 'multipart') collected.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(part);
  return collected;
}

/** Parse one MIME entity, recursing into multipart children within the depth and count budget. */
function parsePart(raw, depth, maxDepth, budget) {
  const { headerText, body } = splitHeaders(raw);
  const headers = parseHeaders(headerText);
  const contentType = parseParameterized(headerValue(headers, 'content-type') ?? 'text/plain; charset=us-ascii');
  const encoding = (headerValue(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase().trim();

  if (contentType.value.startsWith('multipart/') && depth < maxDepth) {
    const boundary = contentType.params.boundary;
    if (boundary === undefined || boundary.length === 0) {
      return { kind: 'text', headers, text: decodeEntityText(body, encoding, 'utf-8') };
    }
    const children = [];
    for (const chunk of splitMultipart(body, boundary)) {
      if (budget.parts <= 0) break;
      budget.parts -= 1;
      children.push(parsePart(chunk, depth + 1, maxDepth, budget));
    }
    return { kind: 'multipart', subtype: contentType.value, headers, children };
  }

  const disposition = parseParameterized(headerValue(headers, 'content-disposition') ?? '');
  const name = disposition.params.filename
    ?? contentType.params.name
    ?? undefined;
  const isAttachment = disposition.value === 'attachment'
    || (name !== undefined && !contentType.value.startsWith('text/'));
  const charset = contentType.params.charset ?? 'utf-8';

  if (isAttachment) {
    return {
      kind: 'attachment',
      headers,
      name: name ?? 'unnamed',
      mediaType: contentType.value || 'application/octet-stream',
      encoding,
      body,
      approxBytes: approximateDecodedBytes(body, encoding),
    };
  }

  const decoded = decodeEntityText(body, encoding, charset);
  if (contentType.value === 'text/html') return { kind: 'html', headers, text: decoded };
  return { kind: 'text', headers, text: decoded };
}

/** Approximate the decoded byte length of one entity body without materializing it. */
function approximateDecodedBytes(body, encoding) {
  if (encoding === 'base64') {
    const compact = body.replace(/[\s\r\n]+/g, '');
    const padding = (compact.match(/=+$/) ?? [''])[0].length;
    return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
  }
  return Buffer.byteLength(body, 'utf8');
}

/**
 * Decode one attachment part into bytes.
 *
 * Attachment payloads are kept on the wire (as the raw entity body) until the channel decides
 * to download them, so this is the only place they are materialized.
 *
 * @param {{ body?: string, encoding?: string }} part - an `attachment` part from {@link parseMessage}.
 * @returns {Buffer}
 */
export function decodeAttachment(part) {
  const body = typeof part?.body === 'string' ? part.body : '';
  const encoding = (part?.encoding ?? 'base64').toLowerCase();
  if (encoding === 'base64') return safeBase64ToBuffer(body);
  if (encoding === 'quoted-printable') return quotedPrintableToBytes(body);
  return Buffer.from(body, 'binary');
}

/** Decode one entity body according to its transfer encoding, then its charset. */
function decodeEntityText(body, encoding, charset) {
  switch (encoding) {
    case 'base64':
      return decodeBuffer(safeBase64ToBuffer(body), charset);
    case 'quoted-printable':
      return decodeQuotedPrintable(body, charset);
    default:
      return decodeBuffer(Buffer.from(body, 'binary'), charset);
  }
}

/** Split a multipart body into its child entity sources, dropping the preamble and epilogue. */
export function splitMultipart(body, boundary) {
  const delimiter = `--${boundary}`;
  const chunks = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) break;
    const afterDelimiter = start + delimiter.length;
    if (body.startsWith('--', afterDelimiter)) break; // closing delimiter
    let partStart = afterDelimiter;
    if (body.startsWith('\r\n', partStart)) partStart += 2;
    else if (body.startsWith('\n', partStart)) partStart += 1;
    const next = body.indexOf(delimiter, partStart);
    const partEnd = next === -1 ? body.length : next;
    chunks.push(trimTrailingNewline(body.slice(partStart, partEnd)));
    cursor = partEnd;
  }
  return chunks;
}

/** Remove the single newline that belongs to the boundary delimiter. */
function trimTrailingNewline(value) {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

/* ------------------------------------------------------------------ *
 * HTML to text
 * ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const DROPPED_TAGS = new Set(['script', 'style', 'head', 'title', 'meta', 'link']);

const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '], ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['zwnj', ''],
  ['zwj', ''], ['ndash', '–'], ['mdash', '—'], ['lsquo', '‘'], ['rsquo', '’'],
  ['ldquo', '“'], ['rdquo', '”'], ['hellip', '…'], ['middot', '·'], ['bull', '•'],
  ['copy', '©'], ['reg', '®'], ['trade', '™'], ['laquo', '«'], ['raquo', '»'],
  ['times', '×'], ['divide', '÷'], ['deg', '°'], ['sect', '§'], ['para', '¶'],
]);

/** Decode the five predefined entities plus the common named and numeric references. */
export function decodeHtmlEntities(input) {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, decimal) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => ENTITIES.get(name.toLowerCase()) ?? match);
}

/** Convert one numeric reference to a character, ignoring out-of-range values. */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Turn an HTML body into readable plain text.
 *
 * A token scan rather than a chain of substitutions: each tag is classified once, so a `</div>`
 * followed by `<br>` yields one paragraph break instead of accumulating blank lines.
 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html.length === 0) return '';
  const BLOCK = 'BLOCK';
  const BREAK = 'BREAK';
  const blockTags = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
    'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);
  const dropped = new Set(['script', 'style', 'head', 'title', 'meta', 'link']);

  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const parts = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let cursor = 0;
  let match;
  let droppedDepth = 0;

  while ((match = tagPattern.exec(stripped)) !== null) {
    const text = stripped.slice(cursor, match.index);
    if (droppedDepth === 0) parts.push(text);
    cursor = match.index + match[0].length;

    const tagName = match[1].toLowerCase();
    const isClosing = match[0].startsWith('</');
    const selfClosing = /\/>$/.test(match[0]) || tagName === 'br' || tagName === 'hr' || tagName === 'img';

    if (dropped.has(tagName)) {
      if (isClosing) droppedDepth = Math.max(0, droppedDepth - 1);
      else if (!selfClosing) droppedDepth += 1;
      continue;
    }
    if (droppedDepth > 0) continue;

    if (tagName === 'br') {
      parts.push(BREAK);
      continue;
    }
    if (blockTags.has(tagName)) {
      parts.push(BLOCK);
      continue;
    }
  }
  if (droppedDepth === 0) parts.push(stripped.slice(cursor));

  const collapsed = parts
    .join('')
    // One block boundary is one newline; a run of them is a real paragraph break.
    .replace(new RegExp(`${BLOCK}(?:\\s|${BREAK}|${BLOCK})*`, 'g'), '\n\n')
    .replace(new RegExp(`${BREAK}(?:\\s|${BREAK})+`, 'g'), '\n')
    .replace(/\n\n/g, '\n')
    .replace(new RegExp(BLOCK, 'g'), '\n\n')
    .replace(new RegExp(BREAK, 'g'), '\n');

  return decodeHtmlEntities(collapsed)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Quote stripping
 * ------------------------------------------------------------------ */

/** Attribution lines such as `On <date>, <person> wrote:` or the localized equivalent. */
const ATTRIBUTION_PATTERNS = [
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  /^\s*On\b.{0,200}\bat\b.{0,200}:\s*$/i,
  /^\s*在\s*.{0,80}\s*写道[:：]\s*$/,
  /^\s*于\s*.{0,80}\s*写道[:：]\s*$/,
  /^\s*-{2,}\s*(原始邮件|转发邮件|Original Message)\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*={5,}\s*$/,
  /^\s*(From|发件人|差出人)\s*[:：]\s*.+$/i,
  /^\s*(Sent|发送时间|送信日時|Date)\s*[:：]\s*.+$/i,
  /^\s*(To|收件人|宛先)\s*[:：]\s*.+$/i,
  /^\s*(Subject|主题|件名)\s*[:：]\s*.+$/i,
  /^\s*Begin forwarded message:\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
];

/** Recognition helpers for the disposable footers mail providers append. */
const SIGNATURE_MARKERS = [
  /^\s*--\s*$/,
  /^\s*_{5,}\s*$/,
];

/** Decide whether one line opens an attribution block that ends the fresh content. */
function isAttributionLine(line) {
  return ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(line));
}

/** Decide whether one line is quoted content. */
function isQuotedLine(line) {
  return /^\s*>/.test(line) || /^\s*[|│]\s?/.test(line) || /^\s*&gt;/.test(line);
}

/**
 * Strip quoted history, attribution blocks, and provider footers from a reply body.
 *
 * Mail clients show the whole thread, but only the newly typed text belongs in the model's
 * context. The scan walks forward and cuts at the first line that clearly opens a quoted
 * region, so a reply that quotes *and then* continues writing keeps its fresh prose.
 *
 * @param {string} body - the decoded plain-text body.
 * @param {{ minRemainder?: number }} [options]
 * @returns {{ text: string, stripped: boolean, removedChars: number }}
 */
export function stripQuotedReply(body, options = {}) {
  const minRemainder = options.minRemainder ?? 1;
  if (typeof body !== 'string' || body.length === 0) {
    return { text: '', stripped: false, removedChars: 0 };
  }
  const normalized = body.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let cut = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isAttributionLine(line)) { cut = i; break; }
    if (isQuotedLine(line)) {
      // Ignore a single stray '>' inside prose; cut only on a run of quoted lines.
      const nextIsQuoted = isQuotedLine(lines[i + 1] ?? '');
      const previousIsQuoted = i > 0 && isQuotedLine(lines[i - 1]);
      if (nextIsQuoted || previousIsQuoted) { cut = previousIsQuoted ? i - 1 : i; break; }
    }
    if (SIGNATURE_MARKERS.some((pattern) => pattern.test(line)) && i > 0) {
      // A signature marker only ends the message when it is not the very first content.
      cut = i;
      break;
    }
  }

  const kept = lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const removed = normalized.length - kept.length;
  if (kept.length >= minRemainder) {
    return { text: kept, stripped: removed > 0, removedChars: Math.max(0, removed) };
  }
  return { text: normalized.trim(), stripped: false, removedChars: 0 };
}

/**
 * Extract the model-facing body text of one parsed message.
 *
 * Prefers `text/plain`, falls back to HTML converted to text, and finally to the message's own
 * body content so that an unparseable mail still reaches the model with an explicit marker
 * rather than silently becoming empty. The header block is never used as a fallback: a message
 * with an empty body must be recognized as empty, not answered with its own headers.
 *
 * @param {object} parsed - the result of {@link parseMessage}.
 * @param {string} raw - the original message source, used to recover unparsed body bytes.
 * @param {{ stripQuotes?: boolean }} [options]
 * @returns {{ text: string, source: 'plain'|'html'|'raw', stripped: boolean, removedChars: number, emptyAfterStrip: boolean }}
 */
export function extractBodyText(parsed, raw, options = {}) {
  const stripQuotes = options.stripQuotes !== false;
  let source = 'raw';
  let candidate = parsed.text;
  if (typeof candidate === 'string' && candidate.trim().length > 0) source = 'plain';
  else if (typeof parsed.html === 'string' && parsed.html.trim().length > 0) {
    candidate = htmlToText(parsed.html);
    source = 'html';
  } else {
    candidate = splitHeaders(raw).body;
  }

  if (!stripQuotes) {
    return {
      text: candidate.trim(),
      source,
      stripped: false,
      removedChars: 0,
      emptyAfterStrip: candidate.trim().length === 0,
    };
  }

  const result = stripQuotedReply(candidate, { minRemainder: 1 });
  const emptyAfterStrip = result.text.length === 0;
  if (emptyAfterStrip) {
    return { text: candidate.trim(), source, stripped: false, removedChars: 0, emptyAfterStrip: true };
  }
  return {
    text: result.text,
    source,
    stripped: result.stripped,
    removedChars: result.removedChars,
    emptyAfterStrip: false,
  };
}

export const __internals = {
  decodeQPayload,
  safeBase64ToBuffer,
  isQuotedLine,
  isAttributionLine,
  normalizeCharset,
  BLOCK_TAGS,
  DROPPED_TAGS,
};
