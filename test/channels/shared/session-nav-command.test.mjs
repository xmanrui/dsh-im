import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConversationStateStore } from '../../../src/channels/shared/conversation-state-store.mjs';
import { t } from '../../../src/channels/shared/i18n.mjs';
import {
  formatAge,
  isSessionNavCommand,
  runSessionNavCommand,
  runSessionNavTextCommand,
  tailMessages,
} from '../../../src/channels/shared/session-nav-command.mjs';
import { getImHostLanguage, setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { askInWorkspaceSession } from '../../../src/channels/shared/workspace-session.mjs';
import { createConversationSession, isNewCommand, newCommandTitle, startNewConversation } from '../../../src/channels/shared/new-command.mjs';
import { normalizeSessionTitle } from '../../../src/channels/shared/session-title.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
} from '../../../src/channels/shared/bot-workspace-store.mjs';
import { HarnessClient } from '../../../src/channels/shared/harness-client.mjs';
import {
  buttonPreviewSupported,
  channelCapabilities,
  documentSendSupported,
} from '../../../src/channels/shared/channel-capabilities.mjs';

const tempDirectories = new Set();

async function makeState() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-session-nav-'));
  tempDirectories.add(directory);
  return new ConversationStateStore(join(directory, 'state.json')).load();
}

test.after(async () => {
  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function userEvent(seq, text) {
  return { seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: text } };
}

function assistantAppend(seq, turn, text) {
  return { seq, type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: text } } };
}

function turnEnd(seq, turn) {
  return { seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } };
}

function toolEvent(seq) {
  return { seq, type: 'tool/call', surfaceOp: 'append', data: { name: 'bash' } };
}

function injectedUserEvent(seq, text) {
  return { seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'plugin:dsh-im' }, content: text } };
}

function readPage(all, { maxMessages, beforeSeq }) {
  const filtered = beforeSeq === undefined ? all : all.filter((event) => event.seq < beforeSeq);
  const page = filtered.slice(-maxMessages);
  return { events: page.map((event) => ({ event })), hasMore: filtered.length > page.length };
}

/**
 * A fixture harness that mirrors the real bot-scoped Harness surface used by the
 * session-navigation commands: bindWorkspaceSession persists the binding and
 * records the ring entry, workspaceSession returns the read/rename handles.
 */
async function createFixture({ histories = new Map() } = {}) {
  const state = await makeState();
  const key = 'direct:chat-1';
  const sessions = new Map();

  const harness = {
    async bindWorkspaceSession(k, sessionId) {
      const meta = sessions.get(sessionId);
      if (meta?.error) throw meta.error;
      await state.setSession(k, sessionId);
      await state.ensureSessionRing(k, sessionId, { title: meta?.title });
      return { sessionId, workspace: '/workspace', title: meta?.title ?? null, archived: meta?.archived === true };
    },
    workspaceSession(sessionId) {
      return {
        sessionId,
        async sessionExists() {
          return sessions.has(sessionId);
        },
        readHistory({ maxMessages, beforeSeq }) {
          return Promise.resolve(readPage(histories.get(sessionId) ?? [], { maxMessages, beforeSeq }));
        },
        async renameTitle(title) {
          const meta = sessions.get(sessionId) ?? {};
          meta.title = title;
          sessions.set(sessionId, meta);
          return title;
        },
      };
    },
    async renameSession(sessionId, title) {
      const meta = sessions.get(sessionId) ?? {};
      meta.title = title;
      sessions.set(sessionId, meta);
      return title;
    },
    async isSessionArchived(sessionId) {
      return sessions.get(sessionId)?.archived === true;
    },
  };

  const addSession = (sessionId, meta = {}) => sessions.set(sessionId, meta);
  // Bind like /session (or a first message) does: creates the ring entry.
  const bind = (sessionId) => harness.bindWorkspaceSession(key, sessionId);
  return { state, harness, key, addSession, bind, sessions, histories };
}

/** A harness for /fork: forks to 'child' and appends it on the non-navigation bind. */
function forkHarness(f) {
  return {
    ...f.harness,
    async forkSession() { return 'child'; },
    async bindWorkspaceSession(k, sessionId) {
      const meta = f.sessions.get(sessionId);
      await f.state.setSession(k, sessionId);
      const registered = await f.state.ensureSessionRing(k, sessionId, { title: meta?.title });
      if (registered?.entry) await f.state.appendRing(k, registered.entry.n);
      return { sessionId, workspace: '/workspace', title: meta?.title ?? null, archived: meta?.archived === true };
    },
    workspaceSession(sessionId) {
      return { ...f.harness.workspaceSession(sessionId), async isRunning() { return false; } };
    },
  };
}

test('isSessionNavCommand recognizes every command and alias, case-insensitively', () => {
  for (const command of ['/ls', '/list', '/go 3', '/prev', '/next', '/drop 2', '/title x', '/tail', '/peek 2 file']) {
    assert.equal(isSessionNavCommand(command), true, command);
    assert.equal(isSessionNavCommand(`  ${command.toUpperCase()}  `), true, command);
  }
  assert.equal(isSessionNavCommand('/history'), false);
  assert.equal(isSessionNavCommand('hello'), false);
});

test('/go binds, pushes the visit stack, and reports number, title and age', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'first' });
  f.addSession('s2', { title: 'second' });
  await f.bind('s1');
  await f.bind('s2');

  await runSessionNavCommand('/go 1', f.harness, f.state, f.key);
  const after = await runSessionNavCommand('/go 2', f.harness, f.state, f.key);
  assert.match(after.message, /已切换到会话 ●2/u);
  assert.match(after.message, /second/u);
  assert.equal(f.state.sessionFor(f.key), 's2');

  const ring = f.state.ringFor(f.key);
  assert.deepEqual(ring.entries.map((e) => e.n), [1, 2]);
  assert.deepEqual(ring.visits, [1, 2]);
  assert.equal(ring.visitIndex, 1);
});

test('/go to an unknown number explains how to list', async () => {
  const f = await createFixture();
  const result = await runSessionNavCommand('/go 7', f.harness, f.state, f.key);
  assert.match(result.message, /没有编号为 7 的会话/u);
});

test('/go to a gone session points at /drop', async () => {
  const f = await createFixture();
  const error = new Error('gone');
  error.code = 'session-not-found';
  f.addSession('s1', { error });
  await f.state.ensureSessionRing(f.key, 's1');
  const result = await runSessionNavCommand('/go 1', f.harness, f.state, f.key);
  assert.match(result.message, /\/drop 1/u);
});

test('/prev and /next walk the visit stack', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  f.addSession('s3', { title: 'three' });
  await f.bind('s1');
  await f.bind('s2');
  await f.bind('s3');
  await runSessionNavCommand('/go 1', f.harness, f.state, f.key);
  await runSessionNavCommand('/go 2', f.harness, f.state, f.key);
  await runSessionNavCommand('/go 3', f.harness, f.state, f.key);

  const back = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(back.message, /已切换到会话 ●2/u);
  assert.equal(f.state.sessionFor(f.key), 's2');

  const backAgain = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(backAgain.message, /已切换到会话 ●1/u);
  assert.equal(f.state.sessionFor(f.key), 's1');

  const forward = await runSessionNavCommand('/next', f.harness, f.state, f.key);
  assert.match(forward.message, /已切换到会话 ●2/u);
  assert.equal(f.state.sessionFor(f.key), 's2');

  const forwardToEnd = await runSessionNavCommand('/next', f.harness, f.state, f.key);
  assert.match(forwardToEnd.message, /已切换到会话 ●3/u);
  assert.equal(f.state.sessionFor(f.key), 's3');
});

test('/prev and /next report the ends only when the ring holds one entry', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'only' });
  await f.bind('s1');

  const atStart = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(atStart.message, /没有更早的会话/u);
  const atEnd = await runSessionNavCommand('/next', f.harness, f.state, f.key);
  assert.match(atEnd.message, /没有更晚的会话/u);
});

test('/prev falls back to the most recent other entry when the stack is empty', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'earlier' });
  f.addSession('s2', { title: 'current' });
  await f.bind('s1');
  await f.bind('s2');
  // s1 is bound first, so it is the previous entry by last activity.

  const back = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(back.message, /已切换到会话 ●1/u);
  assert.equal(f.state.sessionFor(f.key), 's1');
});

test('/drop refuses the current entry, alive or dead, and allows non-current', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  await f.bind('s1');
  await f.bind('s2');

  // s2 is current and alive: refuse.
  const refused = await runSessionNavCommand('/drop 2', f.harness, f.state, f.key);
  assert.match(refused.message, /当前会话，不能删除/u);

  // s1 is not current: drop it.
  const dropped = await runSessionNavCommand('/drop 1', f.harness, f.state, f.key);
  assert.match(dropped.message, /未被删除或归档/u);
  assert.equal(f.state.ringFor(f.key).entries.map((e) => e.n).includes(1), false);

  // A dead current entry (session deleted in Harness) is still refused.
  const dead = await createFixture();
  dead.addSession('gone', {});
  await dead.bind('gone');
  dead.sessions.delete('gone'); // simulate deletion in Harness
  const deadDrop = await runSessionNavCommand('/drop 1', dead.harness, dead.state, dead.key);
  assert.match(deadDrop.message, /当前会话，不能删除/u);
  assert.equal(dead.state.ringFor(f.key).entries.length, 1, 'the current entry stays listed');
});

test('/drop a dead current entry keeps it listed with ✕ and allows dropping after switching away', async () => {
  const f = await createFixture();
  f.addSession('gone', { title: 'dead', archived: true });
  f.addSession('other', { title: 'other' });
  await f.bind('gone');
  await f.bind('other');
  await runSessionNavCommand('/go 1', f.harness, f.state, f.key); // back to the archived entry

  // dead current: refuse to drop.
  const refused = await runSessionNavCommand('/drop 1', f.harness, f.state, f.key);
  assert.match(refused.message, /当前会话，不能删除/u);

  // it stays listed and is marked dead.
  const listed = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(listed.message, /✕ 1\./u);

  // switch away, then drop.
  await runSessionNavCommand('/go 2', f.harness, f.state, f.key);
  const dropped = await runSessionNavCommand('/drop 1', f.harness, f.state, f.key);
  assert.match(dropped.message, /未被删除或归档/u);
  assert.equal(f.state.ringFor(f.key).entries.map((e) => e.n).includes(1), false);
});

test('/title shows the current session and renames it, keeping the ring in sync', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'before' });
  await f.bind('s1');

  const show = await runSessionNavCommand('/title', f.harness, f.state, f.key);
  assert.match(show.message, /编号 ●1/u);
  assert.match(show.message, /before/u);

  const renamed = await runSessionNavCommand('/title after', f.harness, f.state, f.key);
  assert.match(renamed.message, /after/u);
  assert.equal(f.state.ringFor(f.key).entries[0].title, 'after');
});

test('/title renames a specific ring entry by number', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  await f.bind('s1');
  await f.bind('s2');

  const renamed = await runSessionNavCommand('/title 1 renamed-one', f.harness, f.state, f.key);
  assert.match(renamed.message, /renamed-one/u);
  assert.equal(f.state.ringFor(f.key).entries.find((e) => e.n === 1).title, 'renamed-one');
  assert.equal(f.state.ringFor(f.key).entries.find((e) => e.n === 2).title, 'two');
});

test('tailMessages keeps only user prompts and assistant finals, merging same-role fragments', () => {
  const events = [
    userEvent(1, '<dsh_im_source>x</dsh_im_source>\nreal question'),
    injectedUserEvent(2, 'plugin context'),
    toolEvent(3),
    assistantAppend(4, 0, 'four'),
    turnEnd(5, 0),
    userEvent(6, 'first fragment'),
    userEvent(7, 'second fragment'),
    assistantAppend(8, 1, 'tool step'),
    assistantAppend(9, 1, 'final answer'),
    turnEnd(10, 1),
  ];
  const messages = tailMessages(events);
  assert.deepEqual(messages, [
    { role: 'user', text: 'real question' },
    { role: 'assistant', text: 'four' },
    { role: 'user', text: 'first fragment\nsecond fragment' },
    { role: 'assistant', text: 'final answer' },
  ]);
});

test('/tail previews recent prompts and answers without changing the binding', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'topic' });
  f.histories.set('s1', [
    userEvent(1, 'what is 2+2'),
    toolEvent(2),
    assistantAppend(3, 0, 'four'),
    turnEnd(4, 0),
  ]);
  await f.bind('s1');

  const before = f.state.sessionFor(f.key);
  const result = await runSessionNavCommand('/tail', f.harness, f.state, f.key);
  assert.equal(result.hide, true, 'a preview is eligible for the Hide button');
  assert.match(result.message, /what is 2\+2/u);
  assert.match(result.message, /four/u);
  assert.doesNotMatch(result.message, /tool/u);
  assert.equal(f.state.sessionFor(f.key), before, '/tail must not change the binding');
});

test('/tail preview respects the per-message and total character budgets', async () => {
  const f = await createFixture();
  const longLine = 'x'.repeat(500);
  const events = [];
  let seq = 1;
  let turn = 0;
  for (let i = 0; i < 60; i += 1) {
    events.push(userEvent(seq++, `q${i} ${longLine}`), assistantAppend(seq++, turn, longLine), turnEnd(seq++, turn));
    turn += 1;
  }
  f.addSession('s1', { title: 'long' });
  f.histories.set('s1', events);
  await f.bind('s1');

  const result = await runSessionNavCommand('/tail 1 50', f.harness, f.state, f.key);
  // count 50 (>10) → 1 line / ~100 chars per message, total capped near 4000 chars.
  assert.match(result.message, /还有 \d+ 条更早的消息/u);
  assert.ok(result.message.length <= 4_200, `preview too long: ${result.message.length}`);
});

test('/tail file exports a paged Markdown document', async () => {
  const f = await createFixture();
  const events = [];
  let seq = 1;
  let turn = 0;
  for (let i = 0; i < 3; i += 1) {
    events.push(userEvent(seq++, `question ${i}`), assistantAppend(seq++, turn, `answer ${i}`), turnEnd(seq++, turn));
    turn += 1;
  }
  f.addSession('s1', { title: 'topic' });
  f.histories.set('s1', events);
  await f.bind('s1');

  const result = await runSessionNavCommand('/tail 1 file', f.harness, f.state, f.key);
  assert.ok(result.document, 'an export returns a document');
  assert.equal(result.document.mediaType, 'text/markdown');
  assert.ok(result.document.content.startsWith(`# topic — ${t('导出标题：会话')} 1`));
  assert.ok(result.document.content.includes(`## ${t('导出角色：用户')}`));
  assert.ok(result.document.content.includes(`## ${t('导出角色：助手')}`));
  assert.match(result.document.content, /question 0/u);
  assert.match(result.document.content, /answer 2/u);
  assert.match(result.document.content, /消息数：6/u);
});

test('/tail file export notes truncation at the event cap', async () => {
  const f = await createFixture();
  const events = [];
  for (let i = 0; i < 60; i += 1) {
    events.push(userEvent(i * 3 + 1, `q${i}`), assistantAppend(i * 3 + 2, i, `a${i}`), turnEnd(i * 3 + 3, i));
  }
  f.addSession('s1', { title: 'big' });
  f.histories.set('s1', events);
  await f.bind('s1');

  const result = await runSessionNavCommand('/tail 1 file', f.harness, f.state, f.key, {
    tailExportEventCap: 20,
  });
  assert.match(result.document.content, /被截断/u);
});

function parseExport(content) {
  const lines = content.split('\n');
  const header = lines[0];
  assert.match(header, /^# /u, 'the first line is the fixed header');
  const blocks = [];
  let i = 1;
  while (i < lines.length) {
    // Role headings are localized, so match them through the same dictionary the
    // renderer uses instead of hard-coding the English words.
    const heading = lines[i].startsWith('## ') ? lines[i].slice(3) : null;
    const role = heading === null
      ? null
      : [t('导出角色：用户'), t('导出角色：助手')].includes(heading)
        ? [null, heading === t('导出角色：用户') ? 'user' : 'assistant']
        : null;
    if (!role) {
      i += 1;
      continue;
    }
    i += 1;
    if (lines[i] === '') i += 1;
    const delimiter = lines[i];
    assert.match(delimiter, /^(?:```+|~~~+)$/u, 'each block opens with a fence');
    i += 1;
    const body = [];
    while (i < lines.length && lines[i] !== delimiter) {
      body.push(lines[i]);
      i += 1;
    }
    assert.equal(lines[i], delimiter, 'each block closes with the same fence');
    i += 1;
    blocks.push({ role: role[1], body: body.join('\n') });
  }
  return { header, blocks };
}

test('/tail file export fences arbitrary Markdown bodies byte-for-byte', async () => {
  const bodies = [
    'plain text',
    '```js\nconsole.log("nested triple")\n```',
    '````\ncode in quadruple backticks\n````',
    '~~~\ncode in tildes\n~~~',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '```\nthis fence is never closed',
    'ends with backticks ```',
    '````\nbackticks and ~~~ tildes mixed',
  ];
  const f = await createFixture();
  const events = [];
  let seq = 1;
  bodies.forEach((body, index) => {
    events.push(userEvent(seq++, body), assistantAppend(seq++, index, `answer ${index}`), turnEnd(seq++, index));
  });
  // A hostile title must not break the fixed header layout.
  f.addSession('s1', { title: '# evil\n```trick\ntitle' });
  f.histories.set('s1', events);
  await f.bind('s1');

  const result = await runSessionNavCommand('/tail 1 file', f.harness, f.state, f.key);
  assert.ok(result.document);
  const { header, blocks } = parseExport(result.document.content);
  assert.ok(!header.includes('\n'), 'the sanitized title stays on one header line');
  assert.equal(blocks.length, bodies.length * 2);
  for (let i = 0; i < bodies.length; i += 1) {
    assert.equal(blocks[i * 2].role, 'user');
    assert.equal(blocks[i * 2].body, bodies[i], `body ${i} round-trips byte-for-byte`);
  }
});


test('capability matrix: buttons and file send are declared per channel', () => {
  assert.deepEqual(channelCapabilities('telegram'), { buttons: true, fileSend: true });
  assert.deepEqual(channelCapabilities('slack'), { buttons: false, fileSend: true });
  assert.deepEqual(channelCapabilities('discord'), { buttons: false, fileSend: true });
  assert.deepEqual(channelCapabilities('feishu'), { buttons: false, fileSend: false });
  assert.deepEqual(channelCapabilities('dingtalk'), { buttons: false, fileSend: false });
  assert.deepEqual(channelCapabilities('whatsapp'), { buttons: false, fileSend: false });
  assert.deepEqual(channelCapabilities('matrix'), { buttons: false, fileSend: false });
});

test('capability matrix: unsupported channels never send buttons or files', () => {
  assert.equal(documentSendSupported('slack', { sendFile() {} }), true);
  assert.equal(documentSendSupported('whatsapp', { sendFile() {} }), false, 'no file where unsupported');
  assert.equal(documentSendSupported('telegram', {}), false, 'no file without a send method');
  assert.equal(buttonPreviewSupported('telegram', { sendInteractionCard() {} }), true);
  assert.equal(buttonPreviewSupported('telegram', {}), false, 'no button without a card method');
  assert.equal(buttonPreviewSupported('discord', { sendInteractionCard() {} }), false, 'no button where unsupported');
});

test('runSessionNavTextCommand returns text and degrades a file export honestly', async () => {
  const f = await createFixture();
  assert.equal(await runSessionNavTextCommand('not a command', f.harness, f.state, f.key), null);

  const listed = await runSessionNavTextCommand('/ls', f.harness, f.state, f.key);
  assert.equal(listed.handled, true);
  assert.match(listed.message, /还没有会话/u);
  assert.equal(listed.document, undefined);

  f.addSession('s1', { title: 'topic' });
  await f.bind('s1');
  const exported = await runSessionNavTextCommand('/tail 1 file', f.harness, f.state, f.key);
  assert.match(exported.message, /不支持发送文件/u);
  assert.equal(exported.messages.length, 1);
});

test('/ls marks archived entries with ✕ like deleted ones', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'alive' });
  f.addSession('s2', { title: 'gone', archived: true });
  await f.bind('s1');                       // s1 is current
  await f.state.ensureSessionRing(f.key, 's2'); // archived entry, not current

  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(result.message, /● 1\./u, 'the live current entry shows the current marker');
  assert.match(result.message, /✕ 2\./u, 'the archived entry is marked dead');
});

test('/ls appends an unavailable-current hint only when the current entry is dead', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'dead current', archived: true });
  await f.bind('s1');

  const dead = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(dead.message, /✕ 1\./u, 'the dead current entry is marked dead');
  assert.match(dead.message, /当前会话已失效/u, 'a dead current entry appends the hint');

  const healthy = await createFixture();
  healthy.addSession('s1', { title: 'fine' });
  await healthy.bind('s1');
  const live = await runSessionNavCommand('/ls', healthy.harness, healthy.state, healthy.key);
  assert.doesNotMatch(live.message, /当前会话已失效/u, 'a healthy list has no hint');
});

test('formatAge uses one localized unit, decimal point, and the documented boundaries', (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  const now = 1_000_000_000_000;

  setImHostLanguage('zh');
  assert.equal(formatAge(now - 89_000, now), '89 秒');
  assert.equal(formatAge(now - 90_000, now), '1.5 分');
  assert.equal(formatAge(now - 89 * 60_000, now), '89 分');
  assert.equal(formatAge(now - 90 * 60_000, now), '1.5 时');
  assert.equal(formatAge(now - 35 * 3_600_000, now), '35 时');
  assert.equal(formatAge(now - 36 * 3_600_000, now), '1.5 天');

  setImHostLanguage('en');
  assert.equal(formatAge(now - 90_000, now), '1.5 min');
  assert.equal(formatAge(now - 36 * 3_600_000, now), '1.5 d');

  setImHostLanguage('ru');
  assert.equal(formatAge(now - 90_000, now), '1.5 мин');
  assert.equal(formatAge(now - 70_000, now), '70 сек');
});

test('/ls renders the exact line format with a marker on every line', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'Тема 1' });
  f.addSession('s2', { title: 'Тема 2' });
  await f.bind('s1');
  await f.bind('s2'); // s2 is current

  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  const lines = result.message.split('\n\n');
  assert.equal(lines[0], '会话（/go N）：');
  assert.match(lines[1], /^⇄ 1\. .+, Тема 1$/u, 'the only other entry is reachable both ways');
  assert.match(lines[2], /^● 2\. .+, Тема 2$/u, 'the current entry carries the ● marker');
});

test('/ls lazily registers a pre-existing binding with its Host title', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  await state.setSession(key, 's-legacy'); // bound before the ring existed
  const harness = {
    currentWorkspace: () => '/workspace',
    async listWorkspaceSessions() {
      return { sessions: [{ sessionId: 's-legacy', title: 'Real Title', time: 1_000_000 }] };
    },
    workspaceSession(sessionId) {
      return { async sessionExists() { return sessionId === 's-legacy'; } };
    },
    async isSessionArchived() { return false; },
  };

  const result = await runSessionNavCommand('/ls', harness, state, key);
  assert.match(result.message, /● 1\./u);
  assert.match(result.message, /Real Title/u);
});

test('/title without a binding stores a pending title, consumed once', async () => {
  const f = await createFixture();
  const result = await runSessionNavCommand('/title Будущая тема', f.harness, f.state, f.key);
  assert.match(result.message, /已记住新会话标题/u);
  assert.equal(await f.state.takePendingTitle(f.key), 'Будущая тема');
  assert.equal(await f.state.takePendingTitle(f.key), null, 'the pending title is consumed once');
});

test('/title without arguments reads the Host title when the ring has none', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  await state.setSession(key, 's-host');
  await state.ensureSessionRing(key, 's-host'); // no title in the ring
  const harness = {
    currentWorkspace: () => '/workspace',
    async listWorkspaceSessions() {
      return { sessions: [{ sessionId: 's-host', title: 'Название из Host', time: 1_000_000 }] };
    },
    workspaceSession(sessionId) {
      return { async sessionExists() { return sessionId === 's-host'; } };
    },
    async isSessionArchived() { return false; },
  };

  const result = await runSessionNavCommand('/title', harness, state, key);
  assert.match(result.message, /Название из Host/u);
});

test('the pending title is applied to the next session and consumed once', async () => {
  let pendingTitle = 'Pending Title';
  const renamed = [];
  const state = {
    sessionFor: () => null,
    setSession: async () => true,
    clearSession: async () => {},
    takePendingTitle: async () => { const title = pendingTitle; pendingTitle = null; return title; },
    ensureSessionRing: async () => {},
  };
  const harness = {
    createSession: async () => 'new-session',
    ask: async () => 'answer',
    sessionExists: async () => false,
    conversationWorkspaceGeneration: () => null,
    renameSession: async (sessionId, title) => { renamed.push(title); },
  };

  await askInWorkspaceSession({ harness, state, key: 'direct:chat', text: 'hello' });
  assert.deepEqual(renamed, ['Pending Title']);
  assert.equal(pendingTitle, null, 'the pending title is consumed exactly once');
});

test('fallback /prev appends history so the way back is marked with ←', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  await f.bind('s1');
  await f.bind('s2');
  await runSessionNavCommand('/go 2', f.harness, f.state, f.key); // visits [2]

  const back = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(back.message, /已切换到会话 ●1/u);

  const listed = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(listed.message, /● 1\./u);
  assert.match(listed.message, /⇄ 2\./u, 'the only other entry is reachable both ways');

  const backAgain = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(backAgain.message, /已切换到会话 ●2/u, 'a second /prev returns to the entry left behind');
});

test('/prev uses the single no-title wording', async () => {
  const f = await createFixture();
  f.addSession('s1');
  f.addSession('s2');
  await f.bind('s1');
  await f.bind('s2');
  const back = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(back.message, /无标题/u);
  assert.doesNotMatch(back.message, /暂无标题/u);
});

test('/new eagerly creates a session, /title survives the first message, and it is droppable', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  const renamed = [];
  const harness = {
    canChooseSessionId: true,
    async prepareConversationDirectory() { return null; },
    async createSession(opts) { return opts.sessionId ?? 'eager-session'; },
    async bindWorkspaceSession(k, sessionId) {
      await state.setSession(k, sessionId);
      await state.ensureSessionRing(k, sessionId);
      return { sessionId, title: null, archived: false };
    },
    async listWorkspaceSessions() { return { sessions: [] }; },
    workspaceSession(sessionId) {
      return {
        sessionId,
        async sessionExists() { return sessionId === state.sessionFor(key); },
        async ask() { return 'answer'; },
      };
    },
    async isSessionArchived() { return false; },
    async renameSession(sessionId, title) { renamed.push({ sessionId, title }); },
  };

  const created = await createConversationSession({ state, harness, key });
  assert.ok(created.sessionId, 'a session is created eagerly');
  assert.equal(state.sessionFor(key), created.sessionId);

  // /title right after /new works on the eager session directly.
  const titled = await runSessionNavCommand('/title My Title', harness, state, key);
  assert.match(titled.message, /My Title/u);
  assert.deepEqual(renamed, [{ sessionId: created.sessionId, title: 'My Title' }]);
  assert.equal(state.ringFor(key).entries[0].userTitled, true, 'the user title is tracked');

  // The first message reuses the eager session and does not auto-rename it.
  const askHarness = { ...harness, sessionExists: async () => true, ask: async () => 'answer', conversationWorkspaceGeneration: () => null };
  const firstMessage = await askInWorkspaceSession({ harness: askHarness, state, key, text: 'hello' });
  assert.equal(firstMessage.sessionId, created.sessionId, 'the eager session is reused');
  assert.equal(renamed.length, 1, 'no automatic rename overwrote the user title');

  // /ls shows the eager session with its user title.
  const listed = await runSessionNavCommand('/ls', harness, state, key);
  assert.match(listed.message, /● 1\./u);
  assert.match(listed.message, /My Title/u);
});

test('/ls surfaces the Host fallback title when the ring has none', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  await state.setSession(key, 's-host');
  await state.ensureSessionRing(key, 's-host'); // no title in the ring
  const harness = {
    currentWorkspace: () => '/workspace',
    async listWorkspaceSessions() {
      return { sessions: [{ sessionId: 's-host', title: 'Fallback Title', time: 1_000_000 }] };
    },
    workspaceSession(sessionId) { return { async sessionExists() { return sessionId === 's-host'; } }; },
    async isSessionArchived() { return false; },
  };

  const result = await runSessionNavCommand('/ls', harness, state, key);
  assert.match(result.message, /Fallback Title/u);
  assert.doesNotMatch(result.message, /无标题/u);
});

test('the ring survives a store reload (persistence)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-session-nav-persist-'));
  tempDirectories.add(directory);
  const path = join(directory, 'state.json');
  const first = await new ConversationStateStore(path).load();
  await first.setSession('direct:chat-1', 's1');
  await first.ensureSessionRing('direct:chat-1', 's1', { title: 'one' });
  await first.navigateRing('direct:chat-1', 1);

  const reloaded = await new ConversationStateStore(path).load();
  const ring = reloaded.ringFor('direct:chat-1');
  assert.deepEqual(ring.entries.map((e) => e.n), [1]);
  assert.equal(ring.entries[0].sessionId, 's1');
  assert.deepEqual(ring.visits, [1]);
  assert.equal(ring.visitIndex, 0);
});

test('/next does not report success when the binding did not change', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  await state.setSession(key, 's-archived');
  await state.ensureSessionRing(key, 's-archived', { title: 'archived' });
  await state.ensureSessionRing(key, 's-live', { title: 'live' });
  const harness = {
    async bindWorkspaceSession() {
      // A bot-scoped bind that returns success without actually switching (the
      // scoped setSession refused the write on a stale scope).
      return { sessionId: 's-live', workspace: '/workspace', title: null, archived: false };
    },
    workspaceSession() { return { async sessionExists() { return true; } }; },
    async isSessionArchived(sessionId) { return sessionId === 's-archived'; },
  };

  const result = await runSessionNavCommand('/next', harness, state, key);
  assert.doesNotMatch(result.message, /已切换到会话/u, 'no success message on an uncommitted bind');
  assert.match(result.message, /工作区或机器人状态已发生变化/u);
});

test('/go surfaces a failed adopt instead of a success message', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  await state.ensureSessionRing(key, 's-gone');
  const error = new Error('adopt failed');
  error.code = 'session-not-found';
  const harness = {
    async bindWorkspaceSession() { throw error; },
  };

  const result = await runSessionNavCommand('/go 1', harness, state, key);
  assert.doesNotMatch(result.message, /已切换到会话/u);
  assert.match(result.message, /\/drop 1/u);
});

test('/prev steps over a dead entry to the nearest live one', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'live-old' });
  f.addSession('s2', { title: 'dead', archived: true });
  f.addSession('s3', { title: 'live-current' });
  await f.bind('s1');
  await f.bind('s2');
  await f.bind('s3'); // s3 is current; s2 is the most recent other but dead

  const back = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(back.message, /已切换到会话 ●1/u, '/prev skips the dead entry 2');
  assert.equal(f.state.sessionFor(f.key), 's1');
});

test('/next steps over a dead entry in the forward direction', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'current' });
  f.addSession('s2', { title: 'dead', archived: true });
  f.addSession('s3', { title: 'live-forward' });
  await f.bind('s1');
  await f.bind('s2');
  await f.bind('s3');
  await runSessionNavCommand('/go 1', f.harness, f.state, f.key);

  const next = await runSessionNavCommand('/next', f.harness, f.state, f.key);
  assert.match(next.message, /已切换到会话 ●3/u, '/next skips the dead entry 2');
  assert.equal(f.state.sessionFor(f.key), 's3');
});

test('/prev reports no earlier session only when every other entry is dead', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'dead-old', archived: true });
  f.addSession('s2', { title: 'current' });
  await f.bind('s1');
  await f.bind('s2'); // s2 is current

  const back = await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  assert.match(back.message, /没有更早的会话/u);
});

test('/ls uses the plain ✕ glyph (U+2715) for dead entries and the hint', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'dead', archived: true });
  await f.bind('s1');

  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.ok(result.message.includes('\u2715'), 'uses the plain ✕ glyph');
  assert.ok(!result.message.includes('\u2715\uFE0F'), 'never the VS16 emoji variation');
});

test('/new eagerly creates a session and sets it as the ring current position', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  const harness = {
    canChooseSessionId: true,
    async prepareConversationDirectory() { return null; },
    async createSession(opts) { return opts.sessionId ?? 'new-session'; },
    async listWorkspaceSessions() { return { sessions: [] }; },
    workspaceSession() { return { async sessionExists() { return true; } }; },
    async isSessionArchived() { return false; },
  };

  await createConversationSession({ state, harness, key });
  const ring = state.ringFor(key);
  assert.equal(ring.entries.length, 1);
  assert.equal(ring.visits[ring.visitIndex], ring.entries[0].n, 'the new entry is the visit current');
});

test('/session adopt sets the adopted entry as the ring current position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-session-adopt-'));
  tempDirectories.add(root);
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: root,
    ungroupedWorkspace: root,
  }).load();
  await workspaces.ensure('bot');
  const client = new HarnessClient({ apiProxy: {}, workspace: root, ungroupedWorkspace: root });
  client.ensureRunning = async () => true;
  client.rpc = async (method) => {
    if (method === 'workspace.list') {
      return { items: [{ workspaceId: 'im', path: root, sessionIds: ['existing'] }], archivedSessionIds: [] };
    }
    if (method === 'session.list') {
      return { items: [{ sessionId: 'existing', cwd: root, projections: { values: { title: 'Existing' } } }] };
    }
    if (method === 'session.create') return { sessionId: 'existing' };
    throw new Error(`unexpected rpc ${method}`);
  };
  const scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });

  await scope.harness.bindWorkspaceSession('direct:chat-1', 'existing');
  const ring = state.ringFor('direct:chat-1');
  assert.equal(ring.entries.length, 1);
  assert.equal(ring.visits[ring.visitIndex], ring.entries[0].n, 'the adopted session is the visit current');
});

test('/ls markers track /prev and /next targets after a /go jump back', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  f.addSession('s3', { title: 'three' });
  await f.bind('s1');
  await f.bind('s2');
  await f.bind('s3');
  await runSessionNavCommand('/go 1', f.harness, f.state, f.key);
  await runSessionNavCommand('/go 2', f.harness, f.state, f.key);
  await runSessionNavCommand('/go 3', f.harness, f.state, f.key);
  await runSessionNavCommand('/go 2', f.harness, f.state, f.key); // jump back → [1, 2], current 2

  const listed = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(listed.message, /● 2\./u, 'current is entry 2');
  assert.match(listed.message, /⇄ 1\./u, '/prev and /next both reach entry 1 here');

  await runSessionNavCommand('/prev', f.harness, f.state, f.key);
  const afterPrev = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(afterPrev.message, /● 1\./u, 'current is entry 1');
  assert.match(afterPrev.message, /⇄ 2\./u, '/prev and /next both reach entry 2 here');
});

test('/ls repairs a desynchronised visit stack before rendering', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  await f.bind('s1');
  await f.bind('s2'); // s2 current, but the visit stack is empty (desynchronised)

  const listed = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  const ring = f.state.ringFor(f.key);
  assert.equal(ring.visits[ring.visitIndex], 2, 'the visit stack is repaired to the current entry');
  assert.match(listed.message, /● 2\./u, '● is on the current entry');
});

test('/ls markers use exact code points with no VS16', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'ordinary' });
  f.addSession('s2', { title: 'dead', archived: true });
  f.addSession('s3', { title: 'current' });
  await f.bind('s1');
  await f.bind('s2');
  await f.bind('s3');

  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.ok(result.message.includes('\u25CF'), '● U+25CF');
  assert.ok(result.message.includes('\u2715'), '✕ U+2715');
  assert.ok(result.message.includes('\u21C4'), '⇄ U+21C4');
  assert.ok(!result.message.includes('\uFE0F'), 'no VS16 anywhere');
});

test('/ls uses ←, → and · code points when the current sits mid-trail', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'back' });
  f.addSession('s2', { title: 'current' });
  f.addSession('s3', { title: 'forward' });
  f.addSession('s4', { title: 'ordinary' });
  await f.bind('s1');
  await f.bind('s2');
  await f.bind('s3');
  await f.bind('s4');
  // Build a mid-trail directly so last-activity fallback cannot collapse both
  // directions onto one entry: visits [1,2,3,4], cursor on 2, binding s2.
  await f.state.navigateRing(f.key, 1);
  await f.state.navigateRing(f.key, 2);
  await f.state.navigateRing(f.key, 3);
  await f.state.navigateRing(f.key, 4);
  await f.state.stepRingTo(f.key, 2);
  await f.state.setSession(f.key, 's2');

  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(result.message, /← 1\./u, '← U+2190');
  assert.match(result.message, /● 2\./u, '● U+25CF');
  assert.match(result.message, /→ 3\./u, '→ U+2192');
  assert.match(result.message, /· 4\./u, '· U+00B7');
  assert.ok(!result.message.includes('\uFE0F'), 'no VS16 anywhere');
});

test('/ls empty state points at /new, not /session', async () => {
  const f = await createFixture();
  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(result.message, /\/new/u);
  assert.doesNotMatch(result.message, /\/session/u);
});

test('/new <title> titles the new session and marks it user-titled', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  const renames = [];
  const harness = {
    canChooseSessionId: true,
    async prepareConversationDirectory() { return null; },
    async createSession(opts) { return opts.sessionId ?? 'new-session'; },
    async listWorkspaceSessions() { return { sessions: [] }; },
    workspaceSession() {
      return { async sessionExists() { return true; }, async renameTitle(title) { renames.push(title); } };
    },
    async isSessionArchived() { return false; },
  };

  const receipt = await startNewConversation({ state, harness, key, title: 'Hello world' });
  const ring = state.ringFor(key);
  assert.equal(ring.entries.length, 1);
  assert.equal(ring.entries[0].title, 'Hello world');
  assert.equal(ring.entries[0].userTitled, true, 'the inline title is user-titled');
  assert.deepEqual(renames, ['Hello world'], 'the Host session is renamed');
  assert.match(receipt, /会话 ●1：Hello world/u);
});

test('/new without a title keeps the untitled behaviour', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  const renames = [];
  const harness = {
    canChooseSessionId: true,
    async prepareConversationDirectory() { return null; },
    async createSession(opts) { return opts.sessionId ?? 'new-session'; },
    async listWorkspaceSessions() { return { sessions: [] }; },
    workspaceSession() {
      return { async sessionExists() { return true; }, async renameTitle(title) { renames.push(title); } };
    },
    async isSessionArchived() { return false; },
  };

  const receipt = await startNewConversation({ state, harness, key });
  const ring = state.ringFor(key);
  assert.equal(ring.entries.length, 1);
  assert.equal(ring.entries[0].title, undefined);
  assert.equal(ring.entries[0].userTitled, undefined);
  assert.deepEqual(renames, []);
  assert.doesNotMatch(receipt, /会话 \d+：/u);
});

test('/new reports an error and keeps the previous binding when eager create fails', async () => {
  const state = await makeState();
  const key = 'direct:chat-1';
  await state.setSession(key, 'previous');
  const harness = {
    canChooseSessionId: true,
    async prepareConversationDirectory() { return null; },
    async createSession() { throw new Error('create failed'); },
    async listWorkspaceSessions() { return { sessions: [] }; },
    workspaceSession() { return { async sessionExists() { return true; } }; },
    async isSessionArchived() { return false; },
  };

  const receipt = await startNewConversation({ state, harness, key });
  assert.equal(state.sessionFor(key), 'previous', 'the previous binding is kept, not cleared');
  assert.doesNotMatch(receipt, /已开启全新/u, 'no success line on a failed create');
  assert.match(receipt, /暂时无法创建新会话/u);
});

test('a user-titled entry keeps its title when a later bind passes a different Host title', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'Host' });
  await f.bind('s1');
  await runSessionNavCommand('/title 1 Custom', f.harness, f.state, f.key);
  f.addSession('s1', { title: 'Auto' });
  await f.bind('s1');
  const entry = f.state.ringFor(f.key).entries[0];
  assert.equal(entry.title, 'Custom', 'a user-titled entry is never overwritten');
  assert.equal(entry.userTitled, true);
});

test('a non-user-titled entry still follows the Host title', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'First' });
  await f.bind('s1');
  f.addSession('s1', { title: 'Second' });
  await f.bind('s1');
  const entry = f.state.ringFor(f.key).entries[0];
  assert.equal(entry.title, 'Second', 'a non-user-titled entry follows the Host title');
});

test('/new title is free text, not a number prefix', async () => {
  assert.equal(isNewCommand('/new 123'), true);
  assert.equal(newCommandTitle('/new 123'), '123');
  assert.equal(newCommandTitle('/new    '), null, 'empty after trimming is not a title');
  assert.equal(newCommandTitle('/new   Hello   world  '), 'Hello world');
});

test('normalizeSessionTitle trims, collapses and truncates over-long titles', () => {
  assert.equal(normalizeSessionTitle('  a   b  '), 'a b');
  assert.equal(normalizeSessionTitle('   '), null);
  const long = normalizeSessionTitle('x'.repeat(200));
  assert.ok(long.length < 200, 'over-long titles are truncated');
});

test('/fork <title> binds the child, ends the visit stack on it, and applies the title', async () => {
  const f = await createFixture();
  f.addSession('parent', { title: 'Parent' });
  f.addSession('child', { title: 'Child' });
  await f.bind('parent');
  const harness = forkHarness(f);

  const result = await runSessionNavCommand('/fork 我的分支', harness, f.state, f.key);
  assert.equal(f.state.sessionFor(f.key), 'child');
  const ring = f.state.ringFor(f.key);
  const child = ring.entries.find((entry) => entry.sessionId === 'child');
  assert.equal(ring.visits[ring.visitIndex], child.n, 'the visit stack ends on the child');
  assert.equal(child.title, '我的分支');
  assert.equal(child.userTitled, true);
  assert.equal(f.sessions.get('child').title, '我的分支', 'the Host session is renamed');
  assert.match(result.message, /从会话 ⇄1 分支到会话 ●2：我的分支/u);
});

test('/fork without a title derives " (fork)" from the parent title', async () => {
  const f = await createFixture();
  f.addSession('parent', { title: 'Parent' });
  f.addSession('child');
  await f.bind('parent');
  const harness = forkHarness(f);

  const result = await runSessionNavCommand('/fork', harness, f.state, f.key);
  const ring = f.state.ringFor(f.key);
  const child = ring.entries.find((entry) => entry.sessionId === 'child');
  assert.equal(child.title, 'Parent (fork)');
  assert.equal(child.userTitled, undefined, 'a derived title is not user-titled');
  assert.match(result.message, /Parent \(fork\)/u);
});

test('/fork derives "no title (fork)" when the parent has no title', async () => {
  const f = await createFixture();
  f.addSession('parent');
  f.addSession('child');
  await f.bind('parent');
  const harness = forkHarness(f);

  await runSessionNavCommand('/fork', harness, f.state, f.key);
  const ring = f.state.ringFor(f.key);
  const child = ring.entries.find((entry) => entry.sessionId === 'child');
  assert.equal(child.title, '无标题 (fork)');
});

test('/fork refuses while the current turn is running', async () => {
  const f = await createFixture();
  f.addSession('parent', { title: 'Parent' });
  f.addSession('child');
  await f.bind('parent');
  let forked = false;
  const harness = {
    ...f.harness,
    async forkSession() { forked = true; return 'child'; },
    workspaceSession(sessionId) {
      return { ...f.harness.workspaceSession(sessionId), async isRunning() { return true; } };
    },
  };

  const result = await runSessionNavCommand('/fork', harness, f.state, f.key);
  assert.match(result.message, /仍在生成回复/u);
  assert.equal(forked, false, 'the fork RPC must not run while the turn is running');
});

test('/fork refuses when the Host has no fork primitive', async () => {
  const f = await createFixture();
  f.addSession('parent', { title: 'Parent' });
  await f.bind('parent');

  const result = await runSessionNavCommand('/fork', f.harness, f.state, f.key);
  assert.match(result.message, /不支持会话分支/u);
});

test('/fork surfaces fork-unavailable and archived-parent errors', async () => {
  const unavailable = new Error('no completed turn');
  unavailable.code = 'session/fork-unavailable';
  const f1 = await createFixture();
  f1.addSession('parent', { title: 'Parent' });
  await f1.bind('parent');
  const h1 = {
    ...f1.harness,
    async forkSession() { throw unavailable; },
    workspaceSession(sessionId) {
      return { ...f1.harness.workspaceSession(sessionId), async isRunning() { return false; } };
    },
  };
  assert.match((await runSessionNavCommand('/fork', h1, f1.state, f1.key)).message, /没有已完成的回合/u);

  const archived = new Error('archived');
  archived.code = 'session-archived';
  const f2 = await createFixture();
  f2.addSession('parent', { title: 'Parent', archived: true });
  await f2.bind('parent');
  const h2 = {
    ...f2.harness,
    async forkSession() { throw archived; },
    workspaceSession(sessionId) {
      return { ...f2.harness.workspaceSession(sessionId), async isRunning() { return false; } };
    },
  };
  assert.match((await runSessionNavCommand('/fork', h2, f2.state, f2.key)).message, /已不存在或已归档/u);
});

test('/fork maps harness-api-not-found to the no-primitive message', async () => {
  const f = await createFixture();
  f.addSession('parent', { title: 'Parent' });
  await f.bind('parent');
  const error = new Error('unknown session.fork');
  error.code = 'harness-api-not-found';
  const harness = {
    ...f.harness,
    async forkSession() { throw error; },
    workspaceSession(sessionId) {
      return { ...f.harness.workspaceSession(sessionId), async isRunning() { return false; } };
    },
  };

  const result = await runSessionNavCommand('/fork', harness, f.state, f.key);
  assert.match(result.message, /不支持会话分支/u);
});

test('/ls draws no arrows for a single live entry', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'only' });
  await f.bind('s1');

  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(result.message, /● 1\./u);
  assert.doesNotMatch(result.message, /←|→|⇄/u, 'no arrows with a single live entry');
});

test('/ls skips a dead neighbour and points the arrow at the next live entry', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'dead', archived: true });
  f.addSession('s2', { title: 'live' });
  f.addSession('s3', { title: 'current' });
  await f.bind('s1');
  await f.bind('s2');
  await f.bind('s3');

  const result = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(result.message, /✕ 1\./u, 'the dead neighbour stays dead');
  assert.match(result.message, /⇄ 2\./u, 'both directions skip the dead entry to the live one');
  assert.match(result.message, /● 3\./u);
});

test('/go N <text> binds then asks with the remainder', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  await f.bind('s1');
  await f.bind('s2');

  const result = await runSessionNavCommand('/go 1 привет', f.harness, f.state, f.key);
  assert.equal(f.state.sessionFor(f.key), 's1');
  assert.equal(result.askText, 'привет');
  assert.match(result.message, /已切换到会话 ●1/u);
});

test('/prev <text> switches and asks, preserving multi-line text', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  await f.bind('s1');
  await f.bind('s2');

  const result = await runSessionNavCommand('/prev line1\nline2', f.harness, f.state, f.key);
  assert.equal(f.state.sessionFor(f.key), 's1');
  assert.equal(result.askText, 'line1\nline2');
});

test('/next <text> switches and asks', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  f.addSession('s2', { title: 'two' });
  await f.bind('s1');
  await f.bind('s2');
  await f.state.navigateRing(f.key, 1);
  await f.state.navigateRing(f.key, 2);
  await f.state.stepRingTo(f.key, 1);
  await f.state.setSession(f.key, 's1');

  const result = await runSessionNavCommand('/next go on', f.harness, f.state, f.key);
  assert.equal(f.state.sessionFor(f.key), 's2');
  assert.equal(result.askText, 'go on');
});

test('a failed /go bind sends no prompt', async () => {
  const f = await createFixture();
  const error = new Error('gone');
  error.code = 'session-not-found';
  f.addSession('s1', { error });
  await f.state.ensureSessionRing(f.key, 's1');

  const result = await runSessionNavCommand('/go 1 привет', f.harness, f.state, f.key);
  assert.equal(result.askText, undefined, 'no prompt is returned on a failed switch');
  assert.match(result.message, /\/drop 1/u);
});

test('/go N with empty text behaves as a plain switch', async () => {
  const f = await createFixture();
  f.addSession('s1', { title: 'one' });
  await f.bind('s1');

  const result = await runSessionNavCommand('/go 1', f.harness, f.state, f.key);
  assert.equal(result.askText, undefined);
  assert.match(result.message, /已切换到会话 ●1/u);
});

test('/ls always shows the bound entry exactly once, inside or outside the window', async () => {
  const f1 = await createFixture();
  for (let i = 1; i <= 22; i += 1) {
    f1.addSession(`s${i}`, { title: `S${i}` });
    await f1.bind(`s${i}`);
  }
  await f1.state.setSession(f1.key, 's1');
  await f1.state.appendRing(f1.key, 1);
  const outside = await runSessionNavCommand('/ls', f1.harness, f1.state, f1.key);
  assert.match(outside.message, /…/u, 'a bound entry outside the window is separated');
  assert.equal((outside.message.match(/● 1\. /gu) ?? []).length, 1, 'bound entry shown once when outside');

  const f2 = await createFixture();
  for (let i = 1; i <= 22; i += 1) {
    f2.addSession(`s${i}`, { title: `S${i}` });
    await f2.bind(`s${i}`);
  }
  await f2.state.setSession(f2.key, 's22');
  await f2.state.appendRing(f2.key, 22);
  const inside = await runSessionNavCommand('/ls', f2.harness, f2.state, f2.key);
  assert.doesNotMatch(inside.message, /…/u, 'no separator when the bound entry is in the window');
  assert.equal((inside.message.match(/● 22\. /gu) ?? []).length, 1, 'bound entry shown once when inside');
});
