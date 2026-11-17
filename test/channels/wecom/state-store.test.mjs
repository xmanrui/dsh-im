import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WecomStateStore } from '../../../src/channels/wecom/state-store.mjs';

const EMPTY = { version: 1, sessions: {}, seenMessageIds: [] };

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-wecom-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  return { path, store: new WecomStateStore(path) };
}

test('WeCom loads a state file written before authors existed without rewriting it', async (t) => {
  const f = await fixture(t);
  const bytes = JSON.stringify({
    ...EMPTY, sessions: { 'direct:member-one': 'session-1' }, seenMessageIds: ['message-1'],
  });
  await fs.writeFile(f.path, bytes);
  await f.store.load();
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes);
  assert.equal(f.store.authorFor('direct:member-one'), null);
});

test('WeCom persists the last conversation author and drops malformed records', async (t) => {
  const f = await fixture(t);
  await f.store.load();
  await f.store.rememberAuthor('group:wr-chat-one', { senderId: 'wo-speaker' });
  await f.store.rememberAuthor('direct:wo-member-two', {
    senderId: 'wo-speaker-two', senderName: 'Speaker Two', isBot: false,
  });
  assert.deepEqual(f.store.authorFor('group:wr-chat-one'), {
    senderId: 'wo-speaker', isBot: false,
    at: f.store.snapshot().authors['group:wr-chat-one'].at,
  });
  assert.equal(await f.store.rememberAuthor('group:wr-chat-one', { senderName: 'no id' }), null);
  const reloaded = await new WecomStateStore(f.path).load();
  assert.equal(reloaded.authorFor('direct:wo-member-two').senderName, 'Speaker Two');
  assert.equal(reloaded.authorFor('group:wr-chat-one').senderId, 'wo-speaker');
});

test('WeCom keeps at most the authors of the most recent conversations', async (t) => {
  const f = await fixture(t);
  await f.store.load();
  for (let index = 0; index < 502; index += 1) {
    await f.store.rememberAuthor(`group:wr-chat-${index}`, { senderId: `wo-speaker-${index}` });
  }
  const authors = f.store.snapshot().authors;
  assert.equal(Object.keys(authors).length, 500);
  assert.equal(authors['group:wr-chat-0'], undefined);
  assert.equal(authors['group:wr-chat-1'], undefined);
  assert.equal(authors['group:wr-chat-2'].senderId, 'wo-speaker-2');
});
