/**
 * Durable state: atomic writes, cursor semantics, and the thread mapping.
 *
 * The cursor rules matter most: a changed `UIDVALIDITY` invalidates the UID space, and message
 * identity must survive that reset through the Message-ID map rather than the watermark.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MailStore, receiptId, shortId } from '../src/store.js';

/** Create an isolated state directory for one test. */
async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-test-'));
  try {
    const store = await new MailStore(directory).load();
    await run(store, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a fresh store starts empty and creates its directory', async () => {
  await withStore(async (store, directory) => {
    assert.deepEqual(store.unfinished(), []);
    assert.deepEqual(store.threads(), {});
    assert.equal(store.cursor.lastUid, 0);
    assert.equal(store.cursor.uidValidity, null);
    const files = await readdir(directory);
    assert.equal(files.some((name) => name.endsWith('.tmp')), false);
  });
});

test('messages round-trip and unfinished ones are reported', async () => {
  await withStore(async (store, directory) => {
    await store.putMessage('<a@x>', { stage: 'done', tag: 'a3f9', sessionId: 's1' });
    await store.putMessage('<b@x>', { stage: 'dispatched', tag: 'a3f9', sessionId: 's1' });
    await store.putMessage('<c@x>', { stage: 'running', tag: 'b001', sessionId: 's2' });

    assert.equal(store.message('<a@x>').stage, 'done');
    assert.deepEqual(store.unfinished().map((item) => item.messageId).sort(), ['<b@x>', '<c@x>']);
    assert.equal(store.countByThread('a3f9'), 2);

    // A separate instance reads what the first one wrote.
    const reloaded = await new MailStore(directory).load();
    assert.equal(reloaded.message('<a@x>').stage, 'done');
    assert.equal(reloaded.message('<b@x>').sessionId, 's1');
  });
});

test('putMessage merges rather than replacing a record', async () => {
  await withStore(async (store) => {
    await store.putMessage('<a@x>', { stage: 'received', body: 'hello' });
    await store.putMessage('<a@x>', { stage: 'done' });
    const record = store.message('<a@x>');
    assert.equal(record.stage, 'done');
    assert.equal(record.body, 'hello');
    assert.ok(record.updatedAt > 0);
  });
});

test('threads bind in both directions and reject duplicates', async () => {
  await withStore(async (store, directory) => {
    await store.bindThread('a3f9', { sessionId: 'session-1', subject: 'topic' });
    await store.recordOutgoing('<dsh.one@example.com>', 'a3f9');

    assert.equal(store.sessionForTag('a3f9'), 'session-1');
    assert.equal(store.tagForOutgoing('<dsh.one@example.com>'), 'a3f9');
    assert.equal(store.sessionForTag('ffff'), undefined);

    // Re-binding the same tag keeps the original creation time.
    await store.bindThread('a3f9', { sessionId: 'session-2' });
    const reloaded = await new MailStore(directory).load();
    assert.equal(reloaded.sessionForTag('a3f9'), 'session-2');
    assert.equal(reloaded.threads().a3f9.subject, 'topic');
  });
});

test('the outgoing map is bounded so state cannot grow without limit', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 2100; i += 1) {
      await store.recordOutgoing(`<dsh.${i}@example.com>`, 'a3f9');
    }
    const known = store.tagForOutgoing('<dsh.2099@example.com>');
    assert.equal(known, 'a3f9');
    // The oldest bindings are evicted.
    assert.equal(store.tagForOutgoing('<dsh.0@example.com>'), undefined);
  });
});

test('a changed UIDVALIDITY resets the watermark', async () => {
  await withStore(async (store) => {
    await store.advanceCursor({ uidValidity: 100, lastUid: 50 });
    assert.equal(store.cursor.lastUid, 50);
    assert.equal(store.cursor.uidValidity, 100);

    // Same validity: the watermark only moves forward.
    await store.advanceCursor({ lastUid: 40 });
    assert.equal(store.cursor.lastUid, 50);
    await store.advanceCursor({ lastUid: 60 });
    assert.equal(store.cursor.lastUid, 60);

    // New validity: the UID space restarted, so the watermark does too.
    await store.advanceCursor({ uidValidity: 200 });
    assert.equal(store.cursor.uidValidity, 200);
    assert.equal(store.cursor.lastUid, 0);
  });
});

test('concurrent mutations do not corrupt the document', async () => {
  await withStore(async (store, directory) => {
    await Promise.all(
      Array.from({ length: 25 }, (_value, index) => store.putMessage(`<m${index}@x>`, { stage: 'done', tag: 'a3f9' })),
    );
    const text = await readFile(join(directory, 'messages.json'), 'utf8');
    const parsed = JSON.parse(text);
    assert.equal(Object.keys(parsed.items).length, 25);
    const files = await readdir(directory);
    assert.equal(files.some((name) => name.endsWith('.tmp')), false, 'no temporary file is left behind');
  });
});

test('pruning drops old completed records but keeps unfinished ones', async () => {
  await withStore(async (store) => {
    await store.putMessage('<old-done@x>', { stage: 'done' });
    await store.putMessage('<old-open@x>', { stage: 'running' });
    // Backdate both records.
    store.message('<old-done@x>').updatedAt = 1;
    store.message('<old-open@x>').updatedAt = 1;

    const removed = await store.pruneMessages({ retentionMs: 1000 });
    assert.equal(removed, 1);
    assert.equal(store.message('<old-done@x>'), undefined);
    assert.equal(store.message('<old-open@x>').stage, 'running');
  });
});

test('a corrupt document is rejected rather than silently ignored', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-test-'));
  try {
    await new MailStore(directory).load();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'messages.json'), '{ not json', 'utf8');
    await assert.rejects(new MailStore(directory).load(), /JSON|Unexpected/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shortId is stable and receiptId is unique', () => {
  assert.equal(shortId('same-input'), shortId('same-input'));
  assert.equal(shortId('same-input').length, 4);
  assert.notEqual(shortId('a'), shortId('b'));
  const first = receiptId();
  const second = receiptId();
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{6}$/);
});
