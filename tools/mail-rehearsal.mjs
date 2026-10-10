/**
 * Read-only dress rehearsal against the real mailbox.
 *
 * Fetches the newest messages, runs the channel's own classifier and prompt renderer over them,
 * and prints what the channel *would* do. It sends nothing, writes no state, and never marks a
 * message seen, so it is safe to run against the live mailbox before enabling the plugin.
 *
 * Usage: node tools/mail-rehearsal.mjs <address> [passwordEnvName] [count]
 */

import { ImapConnection } from '../src/imap.js';
import { classifyInbound, renderPrompt } from '../src/inbound.js';
import { extractBodyText, headerValue, parseHeaders, parseMessage, splitHeaders } from '../src/mime.js';

const address = process.argv[2];
const passwordEnv = process.argv[3] ?? 'DSH_MAIL_PASSWORD';
const wanted = Number(process.argv[4] ?? 5);
if (address === undefined) {
  console.error('usage: node tools/mail-rehearsal.mjs <address> [passwordEnvName] [count]');
  process.exit(2);
}
const password = process.env[passwordEnv];
if (password === undefined || password.length === 0) {
  console.error(`error: $${passwordEnv} is not visible to this process`);
  process.exit(2);
}
const domain = address.slice(address.lastIndexOf('@') + 1);

const connection = new ImapConnection({
  host: `imap.${domain}`,
  port: 993,
  servername: `imap.${domain}`,
  commandTimeoutMs: 20000,
  connectTimeoutMs: 20000,
});
connection.on('error', () => {});

try {
  await connection.open();
  const capabilities = await connection.capabilities();
  await connection.login(address, password);
  if (capabilities.has('ID')) await connection.id({ name: 'dsh-mail', version: '0.1.0', vendor: 'dsh-mail' });
  const info = await connection.select('INBOX');
  console.log(`INBOX: ${info.exists} message(s), UIDVALIDITY ${info.uidValidity}\n`);

  const uids = await connection.uidSearch('ALL');
  const newest = uids.slice(-wanted);
  if (newest.length === 0) {
    console.log('mailbox is empty — nothing to rehearse.');
  }

  for (const uid of newest) {
    const { raw, size } = await connection.uidFetchBody(uid);
    const verdict = classifyInbound({
      raw,
      uid,
      lookupMessage: () => undefined,
      lookupTag: () => undefined,
      lookupOutgoing: () => undefined,
      allowFrom: [address],
      selfAddresses: [address],
      tagPrefix: '[dsh-',
    });

    const parsed = parseMessage(raw);
    const body = extractBodyText(parsed, raw, { stripQuotes: true });
    // Read the envelope straight from the headers: an ignored verdict deliberately carries no
    // `received` record, and the rehearsal needs to report what the message actually said.
    const headers = parseHeaders(splitHeaders(raw).headerText);
    console.log(`── uid ${uid} (${size} bytes) ─────────────────────────`);
    console.log(`  from        ${verdict.sender ?? headerValue(headers, 'from') ?? '(unparsed)'}`);
    console.log(`  subject     ${headerValue(headers, 'subject') ?? '(none)'}`);
    console.log(`  message-id  ${headerValue(headers, 'message-id') ?? '(none)'}`);
    console.log(`  parts       text=${parsed.text.length}B html=${parsed.html?.length ?? 0}B attachments=${parsed.attachments.length}`);
    console.log(`  body        source=${body.source} stripped=${body.stripped} len=${body.text.length}`);
    console.log(`  verdict     ${verdict.action}${verdict.reason === undefined ? '' : ` / ${verdict.reason}`}`);

    if (verdict.received !== undefined) {
      const prompt = renderPrompt(verdict.received, { isNew: verdict.action === 'new-session' });
      const preview = body.text.split('\n').slice(0, 4).join('\n              ');
      console.log(`  body head   ${preview}`);
      console.log(`  prompt      ${prompt.split('\n').length} lines, ${prompt.length} chars`);
    }
    console.log('');
  }

  await connection.close();
  console.log('rehearsal complete — nothing was sent, and no message was marked seen.');
} catch (error) {
  console.error(`rehearsal failed: ${error?.message ?? error}`);
  await connection.close().catch(() => {});
  process.exit(1);
}
