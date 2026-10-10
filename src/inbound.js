/**
 * Inbound admission: whitelist, loop suppression, threading, and body extraction.
 *
 * This module is the whole decision surface of the channel and is deliberately pure — it reads
 * the parsed message plus durable state and returns a verdict, never performing I/O of its own.
 * That keeps the rules that decide "new session or old session" and "ignore or act" testable
 * without a mailbox.
 *
 * @module dsh-mail/inbound
 */

import {
  addressesIn,
  extractBodyText,
  headerValue,
  messageIdsIn,
  parseHeaders,
  parseMessage,
  splitHeaders,
} from './mime.js';
import { tagFromSubject } from './outgoing.js';
import { receiptId, shortId } from './store.js';

/** Verdict kinds produced by {@link classifyInbound}. */
export const Verdict = {
  ignore: 'ignore',
  duplicate: 'duplicate',
  newSession: 'new-session',
  continueSession: 'continue-session',
};

/** Loop-suppression verdict reasons recorded for debugging. */
export const IgnoreReason = {
  notAllowlisted: 'not-allowlisted',
  noSender: 'no-sender',
  autoSubmitted: 'auto-submitted',
  autoReplied: 'auto-replied',
  bulk: 'bulk',
  list: 'list',
  selfSent: 'self-sent',
  deliveryReport: 'delivery-report',
  noContent: 'no-content',
  tooLarge: 'too-large',
};

/**
 * Detect mail that must never start a turn: machine-generated traffic and anything that could
 * bounce back into the channel and loop.
 *
 * @param {Map<string, string|string[]>} headers
 * @param {{ selfAddresses?: string[], sender?: string }} context
 * @returns {string|undefined} the ignore reason, or `undefined` when the message may proceed.
 */
export function detectLoop(headers, context = {}) {
  const autoSubmitted = headerValue(headers, 'auto-submitted');
  if (autoSubmitted !== undefined && !/^no$/i.test(autoSubmitted.trim())) return IgnoreReason.autoSubmitted;

  const precedence = headerValue(headers, 'precedence');
  if (precedence !== undefined && /^(bulk|junk|list|auto_reply)$/i.test(precedence.trim())) return IgnoreReason.bulk;

  const autoResponse = headerValue(headers, 'x-autoreply') ?? headerValue(headers, 'x-autorespond');
  if (autoResponse !== undefined) return IgnoreReason.autoReplied;

  if (headers.has('list-id') || headers.has('list-unsubscribe') || headers.has('list-post')) {
    return IgnoreReason.list;
  }

  const returnPath = headerValue(headers, 'return-path');
  if (returnPath !== undefined && /<>/.test(returnPath)) return IgnoreReason.selfSent;

  const contentType = headerValue(headers, 'content-type') ?? '';
  if (/^multipart\/report\b/i.test(contentType.trim())) return IgnoreReason.deliveryReport;

  const sender = context.sender;
  const selfAddresses = new Set((context.selfAddresses ?? []).map((address) => address.toLowerCase()));
  if (sender !== undefined && selfAddresses.has(sender.toLowerCase())) return IgnoreReason.selfSent;

  return undefined;
}

/**
 * Decide what to do with one inbound message.
 *
 * @param {object} input
 * @param {string} input.raw - the full message source.
 * @param {number} [input.uid] - the IMAP UID it arrived as.
 * @param {(messageId: string) => object|undefined} input.lookupMessage - durable message lookup.
 * @param {(tag: string) => string|undefined} input.lookupTag - thread-tag → session lookup.
 * @param {(messageId: string) => string|undefined} input.lookupOutgoing - our own Message-ID → tag.
 * @param {string[]} input.allowFrom - whitelisted sender addresses.
 * @param {string[]} input.selfAddresses - this mailbox's own addresses.
 * @param {string} [input.tagPrefix]
 * @param {number} [input.maxBytes] - refuse absurd payloads.
 * @returns {object} a verdict record.
 */
export function classifyInbound(input) {
  const {
    raw,
    uid,
    lookupMessage,
    lookupTag,
    lookupOutgoing,
    allowFrom,
    selfAddresses,
    tagPrefix = '[dsh-',
    maxBytes = 32 * 1024 * 1024,
  } = input;

  if (typeof raw !== 'string' || raw.length === 0) {
    return { action: Verdict.ignore, reason: IgnoreReason.noContent, messageId: undefined, uid };
  }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return { action: Verdict.ignore, reason: IgnoreReason.tooLarge, messageId: undefined, uid };
  }

  const { headerText } = splitHeaders(raw);
  const headers = parseHeaders(headerText);

  const fromAddresses = addressesIn(headerValue(headers, 'from') ?? '');
  const sender = fromAddresses[0];
  if (sender === undefined) {
    return { action: Verdict.ignore, reason: IgnoreReason.noSender, messageId: undefined, uid };
  }

  const allowed = new Set(allowFrom.map((address) => address.toLowerCase()));
  if (!allowed.has(sender.toLowerCase())) {
    return { action: Verdict.ignore, reason: IgnoreReason.notAllowlisted, sender, uid };
  }

  const loopReason = detectLoop(headers, { selfAddresses, sender });
  if (loopReason !== undefined) {
    return { action: Verdict.ignore, reason: loopReason, sender, uid };
  }

  const messageId = messageIdsIn(headerValue(headers, 'message-id') ?? '')[0]
    ?? `<generated.${shortId(`${sender}:${uid ?? raw.length}:${raw.slice(0, 64)}`, 12)}@local>`;

  const previous = lookupMessage(messageId);
  if (previous !== undefined && previous.stage === 'done') {
    return {
      action: Verdict.duplicate,
      reason: 'already-completed',
      messageId,
      sender,
      uid,
      sessionId: previous.sessionId,
      tag: previous.tag,
      previous,
    };
  }

  const subject = headerValue(headers, 'subject') ?? '';
  const references = [
    ...messageIdsIn(headerValue(headers, 'references') ?? ''),
    ...messageIdsIn(headerValue(headers, 'in-reply-to') ?? ''),
  ];

  // Resolve the thread: our own outgoing ids first (exact chain), then the subject tag.
  let tag;
  let sessionId;
  for (const reference of references) {
    const referencedTag = lookupOutgoing(reference);
    if (referencedTag !== undefined) {
      tag = referencedTag;
      sessionId = lookupTag(referencedTag);
      if (sessionId !== undefined) break;
    }
  }
  if (sessionId === undefined) {
    const subjectTag = tagFromSubject(subject, tagPrefix);
    if (subjectTag !== undefined) {
      tag = subjectTag;
      sessionId = lookupTag(subjectTag);
    }
  }

  // A replay must keep the binding the previous process recorded, not re-derive it: the
  // thread map may have moved on, and the message belongs to the session it was already
  // admitted into.
  const replay = previous !== undefined;
  if (replay) {
    if (previous.tag !== undefined) tag = previous.tag;
    if (previous.sessionId !== undefined) sessionId = previous.sessionId;
  }

  const parsed = parseMessage(raw);
  const body = extractBodyText(parsed, raw, { stripQuotes: true });
  if (body.text.length === 0) {
    return { action: Verdict.ignore, reason: IgnoreReason.noContent, messageId, sender, uid, tag, sessionId };
  }

  // A message that resolved no session starts a new thread, which needs its own tag now: the
  // tag is the reply anchor, so the record, the prompt, and the receipt must agree on it.
  const startsNewThread = sessionId === undefined && !replay;
  const threadTag = startsNewThread ? shortId(`${messageId}:${Date.now()}`, 4) : tag;

  const received = {
    messageId,
    sender,
    uid,
    tag: threadTag,
    sessionId,
    subject,
    references,
    receipt: previous?.receipt ?? receiptId(),
    body: body.text,
    bodySource: body.source,
    stripped: body.stripped,
    removedChars: body.removedChars,
    emptyAfterStrip: body.emptyAfterStrip,
    attachments: parsed.attachments.map((attachment) => ({
      name: attachment.name,
      mediaType: attachment.mediaType,
      encoding: attachment.encoding,
      approxBytes: attachment.approxBytes,
    })),
    receivedAt: previous?.receivedAt ?? Date.now(),
  };

  if (replay) {
    return {
      action: Verdict.continueSession,
      reason: 'unfinished-replay',
      messageId,
      sender,
      uid,
      tag: threadTag,
      sessionId,
      received,
      previous,
    };
  }

  if (startsNewThread) {
    return { action: Verdict.newSession, messageId, sender, uid, tag: threadTag, sessionId: undefined, received };
  }

  return { action: Verdict.continueSession, messageId, sender, uid, tag: threadTag, sessionId, received };
}

/**
 * Render the model-facing prompt for one received message.
 *
 * The framing tells the model it is writing mail, not chatting in a terminal, because the
 * delivery format decides how readable the answer is: plain text, email-width lines, no
 * markdown furniture, and no meta-commentary about the transport itself.
 *
 * @param {object} received - the record produced by {@link classifyInbound}.
 * @param {{ turn?: number, isNew?: boolean, bodyText?: string, attachmentPaths?: object[], modePreamble?: boolean }} [options]
 * @returns {string}
 */
export function renderPrompt(received, options = {}) {
  const {
    turn,
    isNew = false,
    bodyText,
    attachmentPaths = [],
    modePreamble = true,
  } = options;
  const lines = [];
  if (modePreamble) {
    lines.push(
      '[邮件模式]',
      '- 这是一封邮件，不是终端对话框。收件人用邮件客户端阅读，请按邮件排版输出。',
      '- 只输出纯文本：不要 markdown 表格、不要代码围栏装饰、不要粘贴超长日志。',
      '- 行宽控制在 78 字符以内，段落之间空一行，需要分点时用「- 」开头的短行。',
      '- 不要提及邮箱、插件、IMAP、会话号等实现细节，也不要复述这段提示。',
      '- 需要交付文件时说明文件路径即可；只有收件人明确要求时才把文件作为附件发送。',
      `- ${isNew ? '这是一封新邮件，本次回答会在会话结束时作为结果回信发出。' : `这是会话 ${received.tag} 的续接（第 ${turn ?? '?'} 轮）。`}`,
      '',
    );
  }
  lines.push(
    `发件人: ${received.sender}`,
    `主题: ${received.subject || '(无主题)'}`,
    `会话号: ${received.tag}`,
    `回执号: ${received.receipt}`,
  );
  if (received.stripped) {
    lines.push(`（已剥离引用的历史邮件，约 ${received.removedChars} 字符）`);
  }
  if (received.emptyAfterStrip) {
    lines.push('（引文剥离后正文为空，以下是原始全文）');
  }
  if (attachmentPaths.length > 0) {
    lines.push('', '附件已保存到工作区：');
    for (const attachment of attachmentPaths) {
      lines.push(`- ${attachment.path}${attachment.skipped === true ? `（未下载：${attachment.reason}）` : ` (${attachment.bytes} 字节)`}`);
    }
  }
  lines.push('', '---', '', bodyText ?? received.body);
  return lines.join('\n');
}

/**
 * Render the receipt acknowledgement sent back as soon as a message is admitted.
 *
 * The receipt exists so the sender learns the thread tag immediately: from then on they can
 * keep the thread alive by leaving `[dsh-xxxx]` in the subject even if their client drops
 * `References`.
 */
export function renderReceipt(received, { isNew }) {
  return [
    isNew ? '已收到，开始处理。' : '已收到，继续处理该会话。',
    '',
    `会话号: ${received.tag}`,
    `回执号: ${received.receipt}`,
    '',
    isNew
      ? '回复这封邮件即可继续同一个会话（请保留主题里的 [dsh-…] 标签）。'
      : '结果会在处理完成后回信。',
  ].join('\n');
}

export { messageIdsIn, addressesIn };
