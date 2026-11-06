import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  runWorkspaceCommand,
  workspaceSwitchFailureText,
} from '../../../src/channels/shared/workspace-command.mjs';
import {
  TELEGRAM_WORKSPACE_CARD,
  parseTelegramWorkspaceCallback,
} from '../../../src/channels/telegram/telegram-bridge.mjs';

async function workspaceFixture(count = 3) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-card-')));
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(root, `w${index}`);
    await mkdir(path);
    paths.push(path);
  }
  return { root, paths };
}

function stateFixture() {
  const seen = new Set();
  return {
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
  };
}

function bridgeFixture({
  paths,
  titles = {},
  current = paths[0],
  cardResult = 'ok',
  switchError = null,
  accessPolicy,
  parkSwitch = false,
} = {}) {
  const sent = [];
  const cards = [];
  const notices = [];
  const edits = [];
  const switches = [];
  let releaseSwitch = null;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state: stateFixture(),
    workspaceCard: TELEGRAM_WORKSPACE_CARD,
    accessPolicy,
    bot: {
      async sendText(_target, text) { sent.push(text); },
      async sendInteractionCard(_target, { text, markup }) {
        if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
        cards.push({ text, markup });
        return { providerMessageIds: [String(700 + cards.length)] };
      },
      async updateInteractionCard(_target, messageId, { markup }) {
        edits.push({ messageId, markup });
      },
      async answerInteractionCallback(queryId, text) {
        notices.push({ queryId, text });
      },
    },
    harness: {
      currentWorkspace: () => current,
      async listWorkspaces() { return [...paths]; },
      async listWorkspaceEntries() {
        return paths.map((path) => ({ path, title: titles[path] }));
      },
      async switchWorkspace(path) {
        switches.push(path);
        if (switchError) throw switchError;
        if (parkSwitch) await new Promise((resolve) => { releaseSwitch = resolve; });
        current = path;
        return path;
      },
      assertWorkspaceScope() {},
    },
    logger: { warn() {}, error() {} },
  });
  return {
    bridge,
    sent,
    cards,
    notices,
    edits,
    switches,
    finishSwitch: () => releaseSwitch?.(),
  };
}

let messageSeq = 0;
function message(content, overrides = {}) {
  messageSeq += 1;
  return {
    messageId: `msg-${messageSeq}`,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

function callback(data, overrides = {}) {
  return {
    messageId: `update-${messageSeq}`,
    callbackQueryId: 'cb-1',
    providerMessageId: 700,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    addressed: true,
    replyTarget: { chatId: 42 },
    data,
    ...overrides,
  };
}

function buttons(cards) {
  return (cards.at(-1)?.markup?.inline_keyboard ?? []).flat();
}

async function press(bridge, data, overrides = {}) {
  await bridge.acceptCallback(callback(data, overrides));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a bare /ws listing carries a machine-readable listing for card rendering', async (t) => {
  const { paths } = await workspaceFixture(2);
  const harness = {
    currentWorkspace: () => paths[0],
    async listWorkspaces() { return [...paths]; },
    async listWorkspaceEntries() {
      return [{ path: paths[0], title: 'wings' }, { path: paths[1], title: 'docker' }];
    },
  };
  for (const command of ['/ws', '/workspace', '/wsl', '/workspaces', '/workspacelist']) {
    const result = await runWorkspaceCommand(command, harness);
    assert.equal(result?.handled, true, `${command} is a handled command`);
    assert.deepEqual(result.listing, {
      current: paths[0],
      paths,
      titles: { [paths[0]]: 'wings', [paths[1]]: 'docker' },
    }, `${command} exposes the same listing`);
    // The text reply a channel without cards falls back to is unchanged.
    assert.match(result.message, /当前 Harness Host 上存在的工作区（2）/);
    assert.equal(result.messages.join(''), result.message);
  }
});

test('text /ws sends one inline-keyboard card instead of the text list', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, sent, cards } = bridgeFixture({
    paths,
    titles: { [paths[0]]: 'wings', [paths[1]]: 'docker-compose', [paths[2]]: 'blog' },
  });
  await bridge.accept(message('/ws'));
  assert.equal(cards.length, 1, 'exactly one card');
  assert.equal(sent.length, 0, 'no duplicate text list');
  assert.match(cards[0].text, /选择要切换的工作区（共 3 个）/);
  assert.equal(buttons(cards).length, 3);
  assert.match(buttons(cards)[0].text, /wings/);
  assert.match(buttons(cards)[0].text, /✓/, 'current workspace is marked');
  assert.doesNotMatch(buttons(cards)[1].text, /✓/);
});

test('every listing alias sends the same card mechanism', async () => {
  for (const command of ['/workspace', '/wsl', '/workspaces', '/workspacelist']) {
    const { paths } = await workspaceFixture(2);
    const { bridge, cards } = bridgeFixture({ paths });
    await bridge.accept(message(command));
    assert.equal(cards.length, 1, `${command} sends one card`);
    assert.ok(buttons(cards).length === 2, `${command} renders one button per workspace`);
  }
});

test('callback payload fits the 64-byte budget and parses back', async () => {
  const { paths } = await workspaceFixture(2);
  const { bridge, cards } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  for (const [index, button] of buttons(cards).entries()) {
    assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
    const parsed = parseTelegramWorkspaceCallback(button.callback_data);
    assert.equal(parsed?.index, index);
    assert.match(parsed.nonce, /^[A-Za-z0-9_-]{1,16}$/);
  }
});

test('a press switches the workspace and re-marks the pressed card', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, cards, edits, notices, switches, finishSwitch } = bridgeFixture({
    paths,
    parkSwitch: true,
    titles: { [paths[0]]: 'wings', [paths[1]]: 'docker-compose', [paths[2]]: 'blog' },
  });
  await bridge.accept(message('/ws'));
  const target = buttons(cards)[1].callback_data;
  const pressed = bridge.acceptCallback(callback(target));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The switch fixture parks until released; the handler must not be done yet.
  assert.equal(switches.length, 1);
  finishSwitch();
  await pressed;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(switches, [paths[1]]);
  assert.equal(edits.length, 1, 'the pressed card is updated in place');
  assert.match(edits[0].markup.inline_keyboard[1][0].text, /✓/);
  assert.doesNotMatch(edits[0].markup.inline_keyboard[0][0].text, /✓/);
  assert.match(notices.at(-1)?.text ?? '', /工作区已切换为/);
});

test('a second press while switching does not switch twice', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, cards, notices, switches, finishSwitch } = bridgeFixture({
    paths,
    parkSwitch: true,
  });
  await bridge.accept(message('/ws'));
  const data = buttons(cards)[2].callback_data;
  const first = bridge.acceptCallback(callback(data));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = bridge.acceptCallback(callback(data));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(switches.length, 1, 'only the first press switches');
  assert.match(notices.at(-1)?.text ?? '', /正在切换工作区/);
  finishSwitch();
  await Promise.all([first, second]);
});

test('a stale card cannot switch anything', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, switches, notices } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  await press(bridge, 'w1|doesnotexist|0');
  assert.deepEqual(switches, []);
  assert.match(notices.at(-1)?.text ?? '', /过期/);
});

test('a card from another conversation is rejected', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, cards, switches, notices } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  await press(bridge, buttons(cards)[0].callback_data, { conversationId: 'chat-b' });
  assert.deepEqual(switches, []);
  assert.match(notices.at(-1)?.text ?? '', /过期/);
});

test('a press without command permission switches nothing', async () => {
  const { paths } = await workspaceFixture(3);
  const policy = createAccessPolicy({
    direct: createAccessPolicyScope({
      mode: 'open',
      open: {
        defaultCanExecuteCommands: true,
        commandPermissionOverrides: [{ id: 'actor-b', canExecuteCommands: false }],
      },
      allowlist: { users: [] },
    }),
    group: createAccessPolicyScope({
      mode: 'open',
      open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    }),
  });
  const { bridge, cards, switches, notices } = bridgeFixture({
    paths,
    accessPolicy: { getSettings: () => policy },
  });
  await bridge.accept(message('/ws'));
  await press(bridge, buttons(cards)[0].callback_data, { senderId: 'actor-b' });
  assert.deepEqual(switches, []);
  assert.match(notices.at(-1)?.text ?? '', /权限|不能执行|没有/);
});

test('card delivery failure falls back to the text list', async () => {
  const { paths } = await workspaceFixture(2);
  const { bridge, sent, cards } = bridgeFixture({ paths, cardResult: 'fail' });
  await bridge.accept(message('/ws'));
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /当前 Harness Host 上存在的工作区（2）/);
});

test('too many workspaces fall back to the text list', async () => {
  const { paths } = await workspaceFixture(21);
  const { bridge, sent, cards } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /当前 Harness Host 上存在的工作区（21）/);
});

test('a switch failure reuses the typed command failure text', async () => {
  const { paths } = await workspaceFixture(3);
  const error = new Error('目录已不可用');
  error.code = 'workspace-not-found';
  const { bridge, cards, notices, switches } = bridgeFixture({ paths, switchError: error });
  await bridge.accept(message('/ws'));
  await press(bridge, buttons(cards)[1].callback_data);
  assert.equal(switches.length, 1);
  // The card path and the typed command share one mapping, so the same failure
  // cannot be worded differently depending on how the user asked for it.
  assert.equal(notices.at(-1)?.text, workspaceSwitchFailureText(error));
  assert.match(notices.at(-1)?.text ?? '', /用法：\/workspace 工作区序号或绝对路径/);
});

test('a newer picker retires the previous card in the same conversation', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, cards, edits, switches } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  const staleData = buttons(cards)[0].callback_data;
  await bridge.accept(message('/ws'));
  assert.equal(cards.length, 2);
  // The replacement retires the old keyboard immediately: an old "current"
  // marker must not stay pressable after a newer list is on screen.
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, '701');
  assert.deepEqual(edits[0].markup, { inline_keyboard: [] });
  await press(bridge, staleData);
  assert.deepEqual(switches, [], 'a superseded card cannot switch');
});

test('pressing the workspace that is already current is an idempotent receipt', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, cards, notices, switches } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  await press(bridge, buttons(cards)[0].callback_data);
  assert.deepEqual(switches, []);
  assert.match(notices.at(-1)?.text ?? '', /已经在工作区/);
});

test('a picker can return to its marked workspace after a typed switch', async () => {
  const { paths } = await workspaceFixture(2);
  const { bridge, cards, edits, notices, switches } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  const originalWorkspace = buttons(cards)[0].callback_data;
  await bridge.accept(message('/ws 2'));
  assert.deepEqual(switches, [paths[1]]);

  await press(bridge, originalWorkspace, { providerMessageId: 701 });

  assert.deepEqual(switches, [paths[1], paths[0]]);
  assert.equal(notices.at(-1)?.text, `工作区已切换为：${paths[0]}`);
  assert.equal(edits.at(-1)?.messageId, '701');
  assert.match(edits.at(-1)?.markup.inline_keyboard[0][0].text ?? '', /✓/);
  assert.doesNotMatch(edits.at(-1)?.markup.inline_keyboard[1][0].text ?? '', /✓/);
});

test('a picker can return to its marked workspace after another chat switches', async () => {
  const { paths } = await workspaceFixture(2);
  const { bridge, cards, edits, notices, switches } = bridgeFixture({ paths });
  await bridge.accept(message('/ws'));
  const originalWorkspace = buttons(cards)[0].callback_data;
  const otherChat = { conversationId: 'chat-b', replyTarget: { chatId: 43 } };
  await bridge.accept(message('/ws', otherChat));
  await press(bridge, buttons(cards)[1].callback_data, {
    ...otherChat, providerMessageId: 702,
  });
  assert.deepEqual(switches, [paths[1]]);

  await press(bridge, originalWorkspace, { providerMessageId: 701 });

  assert.deepEqual(switches, [paths[1], paths[0]]);
  assert.equal(notices.at(-1)?.text, `工作区已切换为：${paths[0]}`);
  assert.equal(edits.at(-1)?.messageId, '701');
  assert.match(edits.at(-1)?.markup.inline_keyboard[0][0].text ?? '', /✓/);
});

test('/ws with an argument keeps the direct-switch text behavior', async () => {
  const { paths } = await workspaceFixture(3);
  const { bridge, sent, cards } = bridgeFixture({ paths });
  await bridge.accept(message('/ws 2'));
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /工作区已切换为/);
});
