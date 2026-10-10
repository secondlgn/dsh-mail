/**
 * MIME decoding, quote stripping, and prompt rendering.
 *
 * These tests pin the behaviour that decides what the model actually reads: which part becomes
 * the body, which charset decodes it, and how much of the thread survives quote stripping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeHtmlEntities,
  decodeQuotedPrintable,
  extractBodyText,
  headerValue,
  htmlToText,
  messageIdsIn,
  parseHeaders,
  parseMessage,
  parseParameterized,
  addressesIn,
  stripQuotedReply,
} from '../src/mime.js';
import { tagFromSubject, tagSubject, stripSubjectTag, encodeHeaderText } from '../src/outgoing.js';
import { foldHeader, sanitizeHeaderValue } from '../src/smtp.js';

const CRLF = '\r\n';

/** Join header/body lines with CRLF for readable fixtures. */
function message(lines) {
  return lines.join(CRLF);
}

test('RFC 2047 encoded words decode for UTF-8 and GBK subjects', () => {
  const headers = parseHeaders(message([
    'Subject: =?UTF-8?B?5rWL6K+V5Li76aKY?=',
    'From: =?gb2312?B?1tC5+rP4v9o=?= <person@example.com>',
  ]));
  assert.equal(headerValue(headers, 'subject'), '测试主题');
  // GBK-encoded display name: only the address is authoritative, but it must not throw.
  assert.match(headerValue(headers, 'from'), /person@example\.com/);
  assert.deepEqual(addressesIn(headerValue(headers, 'from')), ['person@example.com']);
});

test('Q-encoded words with underscores and hex escapes decode', () => {
  const headers = parseHeaders('Subject: =?UTF-8?Q?hello_world_=E4=BD=A0=E5=A5=BD?=');
  assert.equal(headerValue(headers, 'subject'), 'hello world 你好');
});

test('folded headers are unfolded and repeated fields keep every value', () => {
  const headers = parseHeaders(message([
    'Subject: a long',
    '\tsubject value',
    'Received: from one',
    'Received: from two',
  ]));
  assert.equal(headerValue(headers, 'subject'), 'a long subject value');
  assert.equal(Array.isArray(headers.get('received')), true);
  assert.equal(headers.get('received').length, 2);
});

test('content-type parameters parse with quoted values', () => {
  const parsed = parseParameterized('multipart/mixed; boundary="abc=123"; charset=UTF-8');
  assert.equal(parsed.value, 'multipart/mixed');
  assert.equal(parsed.params.boundary, 'abc=123');
  assert.equal(parsed.params.charset, 'UTF-8');
});

test('quoted-printable decodes soft breaks and keeps non-escaped equals', () => {
  const decoded = decodeQuotedPrintable('a=\r\nb=3Dc d= e');
  assert.equal(decoded, 'ab=c d= e');
});

test('multipart/alternative prefers text/plain and decodes HTML on demand', () => {
  const raw = message([
    'From: person@example.com',
    'Subject: hi',
    'Content-Type: multipart/alternative; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'plain body',
    '--B',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>html <b>body</b></p>',
    '--B--',
    '',
  ]);
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, 'plain body');
  assert.match(parsed.html, /html/);
  const body = extractBodyText(parsed, raw);
  assert.equal(body.text, 'plain body');
  assert.equal(body.source, 'plain');
});

test('HTML-only mail is converted to readable text', () => {
  const raw = message([
    'From: person@example.com',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<div>hello&nbsp;<b>world</b></div><div>second line</div><br><ul><li>item</li></ul>',
  ]);
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, '');
  const body = extractBodyText(parsed, raw);
  assert.equal(body.source, 'html');
  assert.equal(body.text, 'hello world\nsecond line\nitem');
});

test('a message with an empty body yields empty text, never its own headers', () => {
  const raw = message(['From: person@example.com', 'Subject: no body', '', '']);
  const parsed = parseMessage(raw);
  const body = extractBodyText(parsed, raw);
  assert.equal(body.text, '');
});

test('attachments are described, not silently treated as the body', () => {
  const payload = Buffer.from('hello attachment').toString('base64');
  const raw = message([
    'From: person@example.com',
    'Content-Type: multipart/mixed; boundary="M"',
    '',
    '--M',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'body text',
    '--M',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    payload,
    '--M--',
    '',
  ]);
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, 'body text');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].name, 'report.pdf');
  assert.equal(parsed.attachments[0].mediaType, 'application/pdf');
  assert.equal(parsed.attachments[0].approxBytes, 16);
});

test('nested multiparts are walked without blowing the depth budget', () => {
  const raw = message([
    'Content-Type: multipart/mixed; boundary="OUT"',
    '',
    '--OUT',
    'Content-Type: multipart/alternative; boundary="IN"',
    '',
    '--IN',
    'Content-Type: text/plain',
    '',
    'inner plain',
    '--IN--',
    '--OUT--',
    '',
  ]);
  const parsed = parseMessage(raw);
  assert.equal(parsed.text, 'inner plain');
});

test('a malformed message still yields usable text', () => {
  const raw = 'From: person@example.com\r\nSubject: broken\r\n\r\njust text with no content-type';
  const parsed = parseMessage(raw);
  assert.match(parsed.text, /just text/);
});

test('quote stripping cuts Gmail-style and Outlook-style history', () => {
  const gmail = [
    '这是我的新回复。',
    '',
    'On Mon, 1 Jan 2025 at 10:00, Someone <a@b.com> wrote:',
    '> 旧的内容',
    '> 更多旧内容',
  ].join('\n');
  assert.equal(stripQuotedReply(gmail).text, '这是我的新回复。');

  const outlook = [
    '第一条新内容。',
    '',
    '-----Original Message-----',
    'From: a@b.com',
    'Sent: Monday',
    'Subject: old',
    '',
    'old body',
  ].join('\n');
  assert.equal(stripQuotedReply(outlook).text, '第一条新内容。');

  const chinese = [
    '中文回复内容',
    '',
    '在 2025年1月1日 10:00，someone 写道：',
    '> 引用',
  ].join('\n');
  assert.equal(stripQuotedReply(chinese).text, '中文回复内容');
});

test('quote stripping keeps a message that is only a quote', () => {
  const onlyQuote = '> quoted line\n> second line';
  const result = stripQuotedReply(onlyQuote);
  assert.equal(result.text, onlyQuote);
  assert.equal(result.stripped, false);
});

test('a lone greater-than inside prose does not truncate the message', () => {
  const body = 'use x > y as the condition';
  assert.equal(stripQuotedReply(body).text, body);
});

test('signature markers end the message but never empty it', () => {
  const withSignature = 'real content\n--\nSent from my phone';
  assert.equal(stripQuotedReply(withSignature).text, 'real content');
  assert.equal(stripQuotedReply('--\nleading marker').text, '--\nleading marker');
});

test('html entity decoding covers named, decimal, and hex references', () => {
  assert.equal(decodeHtmlEntities('a&amp;b &#65; &#x42; &unknown; &nbsp;c'), 'a&b A B &unknown;  c');
});

test('html to text drops script and style content', () => {
  const text = htmlToText('<style>p{color:red}</style><script>alert(1)</script><p>keep me</p>');
  assert.equal(text, 'keep me');
});

test('message ids are extracted from bracketed chains', () => {
  assert.deepEqual(messageIdsIn('<a@x> <b@y>'), ['<a@x>', '<b@y>']);
  assert.deepEqual(messageIdsIn('bare@id'), ['<bare@id>']);
  assert.deepEqual(messageIdsIn(''), []);
});

test('subject tags round-trip and never stack', () => {
  assert.equal(tagSubject('Hello', 'a3f9'), '[dsh-a3f9] Hello');
  assert.equal(tagSubject('Re: Hello', 'a3f9'), 'Re: [dsh-a3f9] Hello');
  assert.equal(tagSubject('Re: [dsh-a3f9] Hello', 'a3f9'), 'Re: [dsh-a3f9] Hello');
  assert.equal(tagSubject('[dsh-b001] Other', 'a3f9'), '[dsh-a3f9] Other');
  assert.equal(tagFromSubject('Re: [dsh-A3F9] x'), 'a3f9');
  assert.equal(tagFromSubject('no tag here'), undefined);
  assert.equal(stripSubjectTag('[dsh-a3f9] Hi', '[dsh-'), 'Hi');
});

test('tag extraction tolerates the shapes mail clients actually produce', () => {
  // The tag is the whole reply-routing signal, so it has to survive client rewriting. Each case
  // below is either seen in the wild or one client edit away from a real subject.
  const cases = [
    ['Re: [dsh-a3f9] topic', 'a3f9'], // the canonical form
    ['[dsh-a3f9] topic', 'a3f9'], // the original message
    ['RE: [DSH-A3F9] topic', 'a3f9'], // a client upper-cased the whole subject
    ['回复: [dsh-a3f9] 主题', 'a3f9'], // localized reply prefix
    ['Re: Re: [dsh-a3f9] topic', 'a3f9'], // stacked reply prefixes
    ['[dsh- a3f9] topic', 'a3f9'], // a space slipped in after the prefix
    ['Re: [dsh-a3f9]topic', 'a3f9'], // no space after the tag
    ['Fwd: [dsh-a3f9] topic', 'a3f9'], // forwarded rather than replied
    ['[dsh-a3f9]', 'a3f9'], // tag only
  ];
  for (const [subject, expected] of cases) {
    assert.equal(tagFromSubject(subject), expected, `subject: ${subject}`);
  }

  // Brackets that are not one of our tags must never be mistaken for a session.
  assert.equal(tagFromSubject('[PATCH] something'), undefined);
  assert.equal(tagFromSubject('[12345] release notes'), undefined, 'length is wrong and it has no letter');
  assert.equal(tagFromSubject('[2024] annual report'), undefined, 'digits alone are not a tag');
  assert.equal(tagFromSubject('[b1] short'), undefined, 'too short to be one of ours');
  assert.equal(tagFromSubject('Re: totally unrelated'), undefined);
  // A bare bracketed tag still resolves when our prefix was lost in transit.
  assert.equal(tagFromSubject('[a3f9] orphaned prefix'), 'a3f9');
});

test('stripping a tag leaves the rest of the subject intact', () => {
  assert.equal(stripSubjectTag('Re: [dsh-a3f9] topic', '[dsh-'), 'Re: topic');
  assert.equal(stripSubjectTag('Re: [dsh-a3f9]topic', '[dsh-'), 'Re: topic');
  assert.equal(stripSubjectTag('[dsh-a3f9]', '[dsh-'), '');
  assert.equal(stripSubjectTag('no tag', '[dsh-'), 'no tag');
  // Re-tagging after a strip must not double the tag or drop the topic.
  assert.equal(tagSubject('Re: [dsh-a3f9] topic', 'b001'), 'Re: [dsh-b001] topic');
});

test('non-ASCII header values are encoded, folded headers stay within width', () => {
  assert.match(encodeHeaderText('中文主题'), /^=\?UTF-8\?B\?/);
  assert.equal(encodeHeaderText('plain'), 'plain');
  const folded = foldHeader('Subject', 'word '.repeat(40).trim(), { limit: 40 });
  for (const line of folded.split('\r\n')) assert.ok(line.length <= 40, `line too long: ${line.length}`);
  assert.equal(sanitizeHeaderValue('  spaced  '), 'spaced');
});

test('header values cannot inject new headers', () => {
  const folded = foldHeader('Subject', 'evil\r\nBcc: victim@example.com');
  assert.equal(folded.includes('\r\nBcc:'), false);
  assert.match(folded, /evil Bcc: victim@example\.com/);
});
