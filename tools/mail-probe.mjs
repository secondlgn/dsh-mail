/**
 * Verify the configured mailbox credentials against the real servers.
 *
 * Read-only: it authenticates, lists mailboxes (and identifies the Sent folder), and for SMTP
 * confirms AUTH succeeds. It never sends mail and never prints the password.
 *
 * Usage: node tools/mail-probe.mjs <address> [passwordEnvName]
 */

import { ImapConnection } from '../src/imap.js';
import { SmtpClient } from '../src/smtp.js';

const address = process.argv[2];
const passwordEnv = process.argv[3] ?? 'DSH_MAIL_PASSWORD';
if (address === undefined) {
  console.error('usage: node tools/mail-probe.mjs <address> [passwordEnvName]');
  process.exit(2);
}

const domain = address.slice(address.lastIndexOf('@') + 1);
const password = process.env[passwordEnv];
if (password === undefined || password.length === 0) {
  console.error(`error: $${passwordEnv} is not visible to this process`);
  process.exit(2);
}

// Common provider host names; the domain's own subdomains cover the rest.
const imapHost = `imap.${domain}`;
const smtpHost = `smtp.${domain}`;

/** Run one step with a hard timeout so a hung server cannot stall the probe. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

let failures = 0;
const report = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

/* ------------------------------- IMAP ------------------------------- */

let seenMailboxes = [];
try {
  const connection = new ImapConnection({
    host: imapHost,
    port: 993,
    servername: imapHost,
    commandTimeoutMs: 20000,
  });
  connection.on('error', () => {});
  await withTimeout(connection.open(), 20000, 'imap open');
  const capabilities = await withTimeout(connection.capabilities(), 20000, 'imap capability');
  await withTimeout(connection.login(address, password), 20000, 'imap login');
  // NetEase and similar providers refuse SELECT until the client has identified itself.
  if (capabilities.has('ID')) {
    const identity = await withTimeout(
      connection.id({ name: 'dsh-mail', version: '0.1.0', vendor: 'dsh-mail' }),
      20000,
      'imap id',
    );
    report(true, 'ID command accepted', identity ?? '(no server ID)');
  }
  const info = await withTimeout(connection.select('INBOX'), 20000, 'imap select');
  seenMailboxes = await withTimeout(connection.listMailboxes(), 20000, 'imap list');

  report(true, `IMAP login ${imapHost}:993`);
  report(true, 'INBOX selected', `${info.exists} message(s), UIDVALIDITY ${info.uidValidity}`);
  report(true, 'capabilities', [...capabilities].slice(0, 8).join(' ') || '(none)');
  await connection.close();
} catch (error) {
  report(false, `IMAP ${imapHost}:993`, error?.message ?? String(error));
}

if (seenMailboxes.length > 0) {
  const sent = seenMailboxes.find((box) => box.attributes.includes('\\Sent'))
    ?? seenMailboxes.find((box) => /^(sent|sent items|已发送|已发送邮件)$/i.test(box.name));
  report(sent !== undefined, 'Sent folder discovered', sent === undefined
    ? seenMailboxes.map((box) => `${box.name}[${box.attributes.join('')}]`).join(', ')
    : `${sent.name} (${sent.attributes.join(' ')}${sent.attributes.length === 0 ? 'no attribute' : ''})`);
}

/* ------------------------------- SMTP ------------------------------- */

try {
  const client = new SmtpClient({
    host: smtpHost,
    port: 465,
    servername: smtpHost,
    replyTimeoutMs: 20000,
    connectTimeoutMs: 20000,
  });
  await withTimeout(client.open(), 20000, 'smtp open');
  const extensions = await withTimeout(client.ehlo('dsh.local'), 20000, 'smtp ehlo');
  await withTimeout(client.authenticate(address, password, extensions), 20000, 'smtp auth');
  report(true, `SMTP login ${smtpHost}:465`);
  report(true, 'extensions', extensions.slice(0, 6).join(' | '));
  await client.close().catch(() => {});
} catch (error) {
  report(false, `SMTP ${smtpHost}:465`, error?.message ?? String(error));
}

console.log('');
console.log(failures === 0
  ? 'All checks passed — the credentials work and the plugin can be enabled.'
  : `${failures} check(s) failed; the credentials or host names need attention.`);
process.exit(failures === 0 ? 0 : 1);
