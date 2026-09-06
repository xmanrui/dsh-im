import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import { QqHarnessBridge } from '../../../src/channels/qq/qq-bridge.mjs';
import { QqStateStore } from '../../../src/channels/qq/state-store.mjs';
import { QqMenuStore, QQ_MENU_TTL_MS, qqMenuView, qqMenuKeyboard, qqMenuText,
  parseQqMenuCommand, sendQqMenu } from '../../../src/channels/qq/qq-menu.mjs';
import { directAccessPolicy } from '../access-policy-fixture.mjs';

const key = 'c2c:owner';
const quiet = { warn() {}, error() {} };
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('Expected event did not arrive');
}
async function fixture(t, { rejection, policy, group = false } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'qq-menu-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const other = join(dir, 'other');
  await mkdir(other);
  const state = await new QqStateStore(join(dir, 'state.json')).load();
  const route = group ? 'group:group-one' : key;
  await state.setSession(route, 'session-original');
  let workspace = dir;
  let selected = { provider: 'provider', model: 'model-1' };
  let preset = null;
  let sequence = 0;
  const calls = [];
  const sent = [];
  const sessions = Array.from({ length: 9 }, (_, i) => ({
    sessionId: `session-${i}`, title: `会话 ${i}`, archived: i === 8,
  }));
  const catalog = () => ({ current: selected, routable: true, failures: [],
    groups: [{ id: 'provider', name: '模型提供方', models: Array.from({ length: 9 }, (_, i) => ({ id: `model-${i}`, name: `模型 ${i}` })) }] });
  const settings = () => ({ agentPreset: preset, agentPresetCatalog: {
    defaultId: 'standard', items: [{ id: 'standard', label: '标准模式' }, { id: '123', label: '数字预设' }],
  } });
  const harness = {
    currentWorkspace: () => workspace,
    ensureRunning: async () => {},
    listWorkspaces: async () => [workspace, other],
    listWorkspaceSessions: async () => ({ sessions }),
    sessionExists: async () => true,
    createSession: async () => 'session-new',
    ask: async (id, text) => { calls.push(['ask', id, text]); return '测试回复'; },
    listModels: async () => catalog(),
    agentPresetSettings: async () => settings(),
    updateAgentPreset: async (id) => { calls.push(['preset', id]); preset = id; return settings(); },
    switchWorkspace: async (path) => { calls.push(['workspace', path]); workspace = path; await state.clearSessions(); return path; },
    bindWorkspaceSession: async (route, id) => {
      calls.push(['bind', route, id]); await state.setSession(route, id);
      return { workspace, sessionId: id, title: id, archived: false };
    },
    executeCommand: async (id, cmd) => { calls.push(['compact', id, cmd]); return { result: { kind: 'success', text: 'Compacted 4 history items (~500 tokens).' } }; },
    workspaceSession: (id) => ({
      ask: (text, options) => harness.ask(id, text, options),
      sessionExists: async () => true, models: async () => catalog(), isRunning: async () => false, hasActiveTurn: async () => false,
      selectModel: async (selection) => { calls.push(['model', selection]); selected = selection; return { selected }; },
      stopActiveTurn: async (control) => { calls.push(['stop', control.key]); return true; },
      steerActiveTurn: async (text, control) => { calls.push(['steer', text, control.key]); return true; },
    }),
  };
  const bot = {
    sendText: async (target, text) => { sent.push({ target, text }); return { id: `reply-${sent.length}` }; },
    send: async (args) => {
      if (rejection && args.keyboard) throw rejection;
      sent.push({ ...args, text: args.markdown?.content ?? args.content });
      return { id: `reply-${sent.length}` };
    },
  };
  const bridge = new QqHarnessBridge({ bot, ownerUserOpenid: '*', harness, state, logger: quiet, accessPolicy: policy });
  const message = (content, overrides = {}) => {
    const id = `message-${++sequence}`;
    return { kind: group ? 'group' : 'c2c', groupOpenid: group ? 'group-one' : undefined,
      rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', senderId: 'owner', messageId: id,
      content, replyTarget: { scope: group ? 'group' : 'c2c', targetId: group ? 'group-one' : 'owner', msgId: id }, ...overrides };
  };
  const send = (text, overrides) => bridge.accept(message(text, overrides));
  const latestMenu = () => sent.findLast((entry) => entry.keyboard);
  const pick = (number, menu = latestMenu(), overrides) => send(menu.keyboard.content.rows.flatMap((r) => r.buttons)[number - 1].action.data, overrides);
  return { dir, other, route, state, calls, sent, harness, bridge, bot, send, message, pick, latestMenu, sessions };
}

test('QQ main menu contains the agreed twelve actions without watches or reasoning selection', async (t) => {
  const f = await fixture(t);
  await f.send('/m');
  const menu = f.latestMenu();
  const buttons = menu.keyboard.content.rows.flatMap((r) => r.buttons);
  assert.equal(buttons.length, 12);
  assert.ok(menu.keyboard.content.rows.length <= 5);
  assert.ok(menu.keyboard.content.rows.every((r) => r.buttons.length <= 5));
  assert.doesNotMatch(menu.text, /关注|推理等级/);
  assert.match(menu.text, /标准模式/);
  for (const button of buttons) {
    assert.equal(button.action.type, 2);
    assert.equal(button.action.enter, true);
    assert.ok(parseQqMenuCommand(button.action.data).token);
  }
  assert.equal(f.calls.length, 0);
});

test('QQ numbered session pages select the displayed ID even after the catalog is reordered', async (t) => {
  const f = await fixture(t);
  await f.send('/m sessions');
  assert.doesNotMatch(f.latestMenu().text, /会话 8/);
  const first = f.latestMenu();
  f.sessions.reverse();
  await f.pick(7, first); // next page from the original list
  assert.match(f.latestMenu().text, /会话 6/);
  await f.send('1');
  assert.equal(f.state.sessionFor(key), 'session-6');
  await f.pick(1, first);
  assert.match(f.sent.at(-1).text, /过期/);
  assert.equal(f.calls.filter(([op]) => op === 'bind').length, 1);
});

test('QQ model and preset choices execute existing commands with stable IDs', async (t) => {
  const f = await fixture(t);
  await f.send('/m models');
  await f.pick(3);
  assert.deepEqual(f.calls.find(([op]) => op === 'model'), ['model', { provider: 'provider', model: 'model-2' }]);
  await f.send('/m presets');
  await f.pick(3);
  assert.deepEqual(f.calls.find(([op]) => op === 'preset'), ['preset', '123']);
  assert.match(f.sent.at(-1).text, /新会话/);
});

test('QQ workspace, new session, compact, stop, quick steer and custom steer work', async (t) => {
  const f = await fixture(t);
  await f.send('/m workspaces');
  await f.pick(2);
  assert.equal(f.harness.currentWorkspace(), f.other);
  await f.state.setSession(key, 'test-session');
  await f.send('/m'); await f.pick(8);
  assert.deepEqual(f.calls.find(([op]) => op === 'compact'), ['compact', 'test-session', '/compact']);
  await f.send('/m'); await f.pick(7);
  assert.deepEqual(f.calls.find(([op]) => op === 'stop'), ['stop', key]);
  await f.send('/m steer'); await f.pick(3);
  assert.deepEqual(f.calls.find(([op]) => op === 'steer'), ['steer', '总结当前进展', key]);
  await f.send('/m steer'); await f.pick(6);
  assert.match(f.latestMenu().text, /\/steer/);
  await f.send('/steer 自定义测试');
  assert.ok(f.calls.some(([op, text]) => op === 'steer' && text === '自定义测试'));
  await f.send('/m'); await f.pick(5);
  assert.equal(f.state.sessionFor(key), null);
});

test('QQ archive visibility survives reload and never archives a session', async (t) => {
  const f = await fixture(t);
  await f.send('/m'); await f.pick(10);
  assert.equal(f.state.includesArchivedSessions(), true);
  const restored = await new QqStateStore(join(f.dir, 'state.json')).load();
  assert.equal(restored.includesArchivedSessions(), true);
  assert.equal(restored.sessionFor(key), 'session-original');
  await f.send('/m sessions'); await f.pick(7);
  assert.match(f.latestMenu().text, /已归档/);
  assert.equal(f.calls.length, 0);
  await f.send('/m'); await f.pick(10);
  assert.equal(f.state.includesArchivedSessions(), false);
});

test('QQ old state files retain sessions and deduplication while defaulting to hidden archives', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'legacy.json'), JSON.stringify({ version: 1, sessions: { [key]: 'old' }, seenMessageIds: ['old-message'] }));
  const restored = await new QqStateStore(join(f.dir, 'legacy.json')).load();
  assert.equal(restored.includesArchivedSessions(), false);
  assert.equal(restored.sessionFor(key), 'old');
  assert.equal(restored.hasSeen('old-message'), true);
});

test('QQ definite keyboard rejection falls back to usable numbered text', async (t) => {
  const f = await fixture(t, { rejection: new ApiError('no keyboard permission', 403, '/messages', 40034090) });
  await f.send('/m');
  assert.match(f.sent.at(-1).text, /无法展示按钮/);
  await f.send('4');
  assert.match(f.sent.at(-1).text, /模型 0/);
  await f.send('2');
  assert.ok(f.calls.some(([op]) => op === 'model'));
});

test('QQ unknown delivery outcomes never cause a second menu delivery', async () => {
  let fallback = 0;
  const bot = { send: async () => { throw new Error('timeout'); }, sendText: async () => { fallback++; } };
  await assert.rejects(sendQqMenu(bot, {}, { title: '菜单', entries: [] }, 'token'), /timeout/);
  assert.equal(fallback, 0);
});

test('QQ stale context, repeated clicks, and other group members cannot apply an old selection', async (t) => {
  const f = await fixture(t, { group: true });
  await f.send('/m');
  const menu = f.latestMenu();
  await f.pick(5, menu, { senderId: 'other' });
  assert.equal(f.state.sessionFor(f.route), 'session-original');
  await f.state.setSession(f.route, 'changed-session');
  await f.pick(5, menu);
  assert.match(f.sent.at(-1).text, /会话或工作区已变化/);
  await f.send('/m');
  const fresh = f.latestMenu();
  await Promise.all([f.pick(5, fresh), f.pick(5, fresh)]);
  assert.equal(f.state.sessionFor(f.route), null);
  assert.equal(f.sent.filter((item) => item.text === '已开启新会话。请发送你的问题。').length, 1);
});

test('QQ menu selections enforce command permission again after it changes', async (t) => {
  const policy = directAccessPolicy({ users: [{ id: 'owner', canExecuteCommands: true }] });
  const f = await fixture(t, { policy });
  await f.send('/m');
  const menu = f.latestMenu();
  policy.getSettings().direct.allowlist.users[0].canExecuteCommands = false;
  for (const text of ['/m', '5', menu.keyboard.content.rows[1].buttons[1].action.data]) {
    await f.send(text);
    assert.match(f.sent.at(-1).text, /没有执行命令的权限/);
  }
  assert.equal(f.state.sessionFor(key), 'session-original');
  assert.equal(f.calls.length, 0);
});

test('QQ ordinary input exits number selection and batches keep numeric text', async (t) => {
  const f = await fixture(t);
  await f.send('/m');
  await f.send('普通消息');
  await f.send('5');
  assert.deepEqual(f.calls.filter(([op]) => op === 'ask').map((call) => call[2]), ['普通消息', '5']);
  await f.send('/m');
  await f.send('/batch');
  await f.send('/m');
  assert.match(f.sent.at(-1).text, /批量输入/);
  await f.send('5'); await f.send('/send');
  assert.match(f.calls.findLast(([op]) => op === 'ask')[2], /5/);
  assert.equal(f.state.sessionFor(key), 'session-original');
});

test('QQ menus do not consume pending answers; stop remains immediate during a running prompt', async (t) => {
  const f = await fixture(t);
  const answered = deferred();
  let result;
  f.harness.ask = async (sessionId, text, options) => {
    await options.onInteraction({ kind: 'question', interactionId: 'menu-question', rpcId: 'menu-question', sessionId,
      payload: { questions: [{ id: 'environment', question: '请选择环境', options: [{ label: '测试环境' }] }] },
      respond: async (response) => { result = response; answered.resolve(); return { accepted: true }; },
    });
    await answered.promise;
    return '已完成';
  };
  const prompt = f.send('启动问题');
  await eventually(() => f.sent.some((item) => item.text.includes('请选择环境')));
  await f.send('/m');
  const menu = f.latestMenu();
  await f.pick(5, menu);
  assert.match(f.sent.at(-1).text, /当前任务仍在运行/);
  await f.send('1'); await prompt;
  assert.deepEqual(result.value.answer.answers[0].selected, ['测试环境']);

  const running = deferred();
  f.harness.ask = async () => { await running.promise; return '结束'; };
  const active = f.send('运行测试');
  await f.send('/m'); await f.pick(7);
  assert.ok(f.calls.some(([op]) => op === 'stop'));
  running.resolve(); await active;
});

test('QQ menu store expires, caps tracking, and rejects unavailable or invalid choices', () => {
  let now = 0;
  const store = new QqMenuStore({ now: () => now });
  const context = { workspace: 'workspace', sessionId: 'session' };
  const entry = store.begin('route', 'actor', context);
  const view = { entries: [{ label: '新会话', action: { text: '/new' } }] };
  assert.match(store.take('route', 'actor', 1, entry.token, context).error, /过期/);
  store.publish('route', 'actor', entry, view);
  assert.match(store.take('route', 'actor', 8, entry.token, context).error, /编号/);
  now = QQ_MENU_TTL_MS;
  assert.match(store.take('route', 'actor', 1, entry.token, context).error, /过期/);
  for (let i = 0; i < 256; i++) store.begin('route', `actor-${i}`, context);
  assert.equal(store.has('route', 'actor'), false);
});

test('QQ queued menu actions recheck running work before changing the session', async (t) => {
  const f = await fixture(t);
  const selecting = deferred();
  const selected = deferred();
  const running = deferred();
  const originalSession = f.harness.workspaceSession;
  f.harness.workspaceSession = (id) => ({ ...originalSession(id), selectModel: async (selection) => {
    selecting.resolve();
    await selected.promise;
    return { selected: selection };
  } });
  await f.send('/m models');
  const changeModel = f.pick(1);
  await selecting.promise;
  await f.send('/m');
  const originalSessionFor = f.state.sessionFor.bind(f.state);
  let selectionClaimed = false;
  f.state.sessionFor = (route) => { selectionClaimed = true; return originalSessionFor(route); };
  const changeSession = f.pick(5);
  await eventually(() => selectionClaimed);
  f.harness.ask = async () => { await running.promise; return '完成'; };
  const prompt = f.send('继续原会话');
  selected.resolve();
  await changeModel;
  await changeSession;
  assert.equal(f.state.sessionFor(key), 'session-original');
  assert.ok(f.sent.some((item) => item.text.includes('当前任务仍在运行')));
  running.resolve();
  await prompt;
});

test('QQ status, help and partial catalogs retain usable navigation and escape Markdown labels', async (t) => {
  const f = await fixture(t);
  await f.send('/m status');
  assert.match(f.latestMenu().text, /连接正常/);
  await f.send('/m help');
  assert.match(f.latestMenu().text, /15 分钟/);
  f.harness.listModels = async () => { throw new Error('catalog down'); };
  f.harness.workspaceSession = () => ({ models: f.harness.listModels });
  await f.send('/m');
  assert.equal(f.latestMenu().keyboard.content.rows.flatMap((r) => r.buttons).length, 12);
  assert.match(f.latestMenu().text, /部分设置暂未加载/);
  const view = { title: '菜单', entries: [{ label: '[标题](https://example.invalid)', action: { kind: 'command', text: '/new' } }] };
  assert.ok(qqMenuText(view).includes('[标题]'));
  await sendQqMenu(f.bot, {}, view, 'token');
  assert.ok(f.sent.at(-1).text.includes('\\[标题\\]'));
});
