import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WecomHarnessBridge } from '../../../src/channels/wecom/wecom-bridge.mjs';
import { WecomRuntime } from '../../../src/channels/wecom/wecom-runtime.mjs';
import { wecomList, wecomTemplateCard } from '../../../src/channels/wecom/wecom-cards.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE, directAccessPolicy } from '../access-policy-fixture.mjs';

function setup({ harness = {}, accessPolicy } = {}) {
  const sent = [];
  const seen = new Set();
  let session = 'session-old';
  let sequence = 0;
  const state = {
    hasSeen: (id) => seen.has(id), markSeen: async (id) => { seen.add(id); },
    sessionFor: () => session, clearSession: async () => { session = null; },
    setSession: async (_key, id) => { session = id; },
  };
  const client = new EventEmitter();
  Object.assign(client, {
    connect: () => queueMicrotask(() => client.emit('authenticated')), disconnect() {},
    replyStream: async (_frame, _id, content) => sent.push({ type: 'text', content }),
    replyTemplateCard: async (_frame, card) => sent.push({ type: 'card', card }),
    replyWelcome: async (_frame, body) => sent.push({ type: 'welcome', card: body.template_card }),
    updateTemplateCard: async (_frame, card) => sent.push({ type: 'update', card }),
    sendMessage: async (chatId, body) => sent.push({ type: body.template_card ? 'card' : 'text',
      chatId, card: body.template_card, content: body.markdown?.content }),
  });
  harness = { ensureRunning: async () => {}, currentWorkspace: () => process.cwd(), ...harness };
  const bridge = new WecomHarnessBridge({ client, state, harness, accessPolicy, logger: { warn() {} } });
  const frame = (content = '/menu', overrides = {}) => ({
    headers: { req_id: `req-${++sequence}` },
    body: { msgid: `msg-${sequence}`, chattype: 'single', from: { userid: 'member-1' },
      msgtype: 'text', text: { content }, ...overrides },
  });
  const latest = () => sent.findLast((entry) => entry.card && entry.type !== 'update')?.card;
  const clickFrame = (label, overrides = {}, selected = {}, card = latest()) => {
    const button = (card.button_list ?? [card.submit_button]).find((item) => item.text.includes(label));
    assert.ok(button, `Missing button: ${label}`);
    return frame('', { msgtype: 'event', event: {
      eventtype: 'template_card_event', template_card_event: {
        card_type: card.card_type, task_id: card.task_id, event_key: button.key,
        selected_items: { selected_item: Object.entries(selected).map(([question_key, id]) => ({
          question_key, option_ids: { option_id: [String(id)] },
        })) },
      },
    }, ...overrides });
  };
  const click = (label, selected) => bridge.acceptEvent(clickFrame(label, {}, selected));
  return { client, bridge, state, harness, sent, frame, latest, clickFrame, click };
}

test('menu navigation, new session and status execute without invoking the model', async () => {
  const f = setup({ harness: { ask: () => assert.fail('menus must not call the model') } });
  await f.bridge.accept(f.frame('/m'));
  assert.equal(f.sent[0].card.select_list.length, 3);
  assert.ok(f.latest().button_selection);
  assert.equal(f.latest().button_list.length, 6);
  await f.click('新会话');
  assert.equal(f.state.sessionFor(), null);
  assert.match(f.sent.find((entry) => entry.content?.includes('已开启新会话')).content, /请发送你的问题/);
  await f.click('状态');
  assert.ok(f.sent.some((entry) => entry.content?.includes('连接正常')));
  assert.match(f.latest().main_title.title, /工作区与任务/);
});

test('welcome uses the same interactive menu and ignores duplicate and group enters', async () => {
  const f = setup();
  const enter = f.frame('', { msgtype: 'event', chattype: undefined, event: { eventtype: 'enter_chat' } });
  await Promise.all([f.bridge.acceptEvent(enter), f.bridge.acceptEvent(enter)]);
  assert.equal(f.sent.filter((item) => item.type === 'welcome').length, 1);
  assert.equal(f.sent[0].type, 'welcome');
  assert.equal(f.sent.length, 2);
  await f.bridge.acceptEvent(f.clickFrame('新会话', {}, {}, f.sent[0].card));
  assert.equal(f.state.sessionFor(), null);
  const count = f.sent.length;
  await f.bridge.acceptEvent(f.frame('', { chattype: 'group', chatid: 'group-1',
    msgtype: 'event', event: { eventtype: 'enter_chat' } }));
  assert.equal(f.sent.length, count);
});

test('menu selection is acknowledged before slow catalog RPC and repeated clicks execute once', async () => {
  let calls = 0;
  const f = setup({ harness: {
    listWorkspaceSessions: async () => {
      if (calls > 0) assert.equal(f.sent.at(-1).type, 'update');
      calls += 1;
      return { sessions: Array.from({ length: 11 }, (_, i) => ({ sessionId: `id-${i}`, title: `Session ${i}` })) };
    },
  } });
  await f.bridge.accept(f.frame('/menu sessions'));
  const event = f.clickFrame('下一页');
  await Promise.all([f.bridge.acceptEvent(event), f.bridge.acceptEvent(event)]);
  assert.equal(calls, 2);
  assert.equal(f.latest().button_selection.option_list[0].text, 'Session 10');
});

test('session dropdown keeps exact IDs across pagination and reuses session binding', async () => {
  let bound;
  const f = setup({ harness: {
    listWorkspaceSessions: async () => ({ sessions: Array.from({ length: 25 }, (_, i) => ({
      sessionId: `id-${i}`, title: `会话 ${i}`,
    })) }),
    bindWorkspaceSession: async (_key, id) => {
      bound = id;
      return { workspace: process.cwd(), sessionId: id, title: id };
    },
  } });
  await f.bridge.accept(f.frame('/menu sessions'));
  await f.click('下一页');
  assert.match(f.latest().main_title.desc, /2 \/ 3/);
  await f.click('应用选择', { choice: 4 });
  assert.equal(bound, 'id-14');
  assert.ok(f.sent.some((entry) => entry.content?.includes('当前聊天已绑定会话')));
});

test('real nested selector callback applies session, model and numeric preset IDs in order', async () => {
  const applied = [];
  let current = { provider: 'provider', model: 'old' };
  let agentPreset = null;
  const catalog = () => ({ current, failures: [], groups: [{ id: 'provider', name: 'Provider',
    models: [{ id: 'old', name: 'Old' }, { id: 'new', name: 'New' }] }] });
  const settings = () => ({ agentPreset, agentPresetCatalog: {
    defaultId: 'standard', items: [{ id: 'standard', label: 'Standard' }, { id: '123', label: 'Numeric preset' }],
  } });
  const f = setup({ harness: {
    listWorkspaceSessions: async () => ({ sessions: [
      { sessionId: 'session-old', title: 'Old session' }, { sessionId: 'session-new', title: 'New session' },
    ] }),
    bindWorkspaceSession: async (key, id) => {
      applied.push(['session', id]);
      await f.state.setSession(key, id);
      return { workspace: process.cwd(), sessionId: id, title: id };
    },
    workspaceSession: (id) => ({
      sessionExists: async () => true, isRunning: async () => false, hasActiveTurn: async () => false,
      models: async () => catalog(),
      selectModel: async (selection) => {
        applied.push(['model', id, selection.model]);
        current = selection;
        return { selected: selection };
      },
    }),
    agentPresetSettings: async () => settings(),
    updateAgentPreset: async (value) => { agentPreset = value; applied.push(['preset', value]); return settings(); },
  } });
  await f.bridge.accept(f.frame());
  const card = f.sent[0].card;
  await f.bridge.acceptEvent(f.clickFrame('应用设置', {}, { session: 1, model: 1, preset: 2 }, card));
  assert.deepEqual(applied, [['session', 'session-new'], ['model', 'session-new', 'new'], ['preset', '123']]);
  const updated = f.sent.findLast((item) => item.card?.select_list)?.card;
  assert.deepEqual(updated.select_list.map((item) => item.option_list[0].text),
    ['New session', 'New (provider)', 'Numeric preset']);
  assert.equal(f.sent.find((item) => item.type === 'update').card.button_list[0].text, '重新打开菜单');
});

test('malformed selector payload is rejected without changing settings', async () => {
  const f = setup({ harness: { updateAgentPreset: () => assert.fail('invalid selections must not run') } });
  for (const selected_items of [false, { selected_item: {} },
    { selected_item: [{ question_key: 'preset', option_ids: { option_id: ['0', '1'] } }] },
    { selected_item: [{ question_key: 'preset', option_ids: { option_id: ['99'] } }] }]) {
    await f.bridge.accept(f.frame());
    const card = f.sent.findLast((item) => item.card?.select_list).card;
    const event = f.clickFrame('应用设置', {}, {}, card);
    event.body.event.template_card_event.selected_items = selected_items;
    await f.bridge.acceptEvent(event);
    assert.match(f.sent.at(-1).content, /请选择一个选项/);
  }
});

test('flat SDK selector arrays remain supported and acknowledgement failures do not block commands', async () => {
  const f = setup({ harness: {
    listWorkspaceSessions: async () => ({ sessions: [{ sessionId: 'exact-id', title: 'Session' }] }),
    bindWorkspaceSession: async (key, id) => {
      await f.state.setSession(key, id);
      return { workspace: process.cwd(), sessionId: id, title: id };
    },
  } });
  f.client.updateTemplateCard = async () => { throw { errcode: 42045, errmsg: 'update rejected' }; };
  await f.bridge.accept(f.frame('/menu sessions'));
  const event = f.clickFrame('应用选择');
  event.body.event.template_card_event.selected_items = [{ question_key: 'choice', option_ids: ['0'] }];
  await f.bridge.acceptEvent(event);
  assert.equal(f.state.sessionFor(), 'exact-id');
});

test('cards enforce live command permissions and reject cross-conversation callbacks', async () => {
  let allowed = true;
  const f = setup({ accessPolicy: {
    getSettings: () => directAccessPolicy({ users: [
      { id: 'member-1', canExecuteCommands: allowed },
      { id: 'member-other', canExecuteCommands: true },
    ] }).getSettings(),
  } });
  await f.bridge.accept(f.frame());
  const event = f.clickFrame('新会话');
  await f.bridge.acceptEvent(f.clickFrame('新会话', { from: { userid: 'member-other' } }));
  assert.equal(f.state.sessionFor(), 'session-old');
  allowed = false;
  await f.bridge.acceptEvent(event);
  await f.bridge.accept(f.frame('/menu'));
  assert.equal(f.state.sessionFor(), 'session-old');
  assert.equal(f.sent.at(-1).content, COMMAND_PERMISSION_DENIED_MESSAGE);
});

test('stale workspace and unknown card clicks provide recovery without changing sessions', async () => {
  let workspace = process.cwd();
  const f = setup({ harness: { currentWorkspace: () => workspace } });
  await f.bridge.accept(f.frame());
  const event = f.clickFrame('新会话');
  workspace = '/tmp';
  await f.bridge.acceptEvent(event);
  assert.equal(f.state.sessionFor(), 'session-old');
  assert.ok(f.sent.some((entry) => entry.content?.includes('工作区已变化')));
  await f.bridge.acceptEvent(f.frame('', { msgtype: 'event', event: {
    eventtype: 'template_card_event', task_id: 'old-process-card', event_key: '0',
  } }));
  assert.match(f.sent.at(-1).content, /菜单已过期/);
});

test('menu and new-session buttons respond while a question is running', async () => {
  let finish;
  const f = setup({ harness: {
    sessionExists: async () => true,
    ask: async () => new Promise((resolve) => { finish = resolve; }),
  } });
  const pending = f.bridge.accept(f.frame('测试问题'));
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await f.bridge.accept(f.frame());
  await f.click('新会话');
  assert.equal(f.state.sessionFor(), 'session-old');
  assert.ok(f.sent.some((entry) => entry.content?.includes('当前任务仍在运行')));
  finish('完成');
  await pending;
});

test('failed card delivery keeps text commands usable', async () => {
  const f = setup();
  f.client.replyTemplateCard = async () => { throw new Error('card unavailable'); };
  f.client.sendMessage = async () => { throw new Error('card unavailable'); };
  await f.bridge.accept(f.frame());
  assert.match(f.sent.at(-1).content, /新会话：\/new/);
  assert.match(f.sent.at(-1).content, /\/stop/);
});

test('all list pages stay within WeCom button limits', () => {
  for (const page of [0, 1, 2, 10000]) {
    const menu = wecomList({ title: '列表', section: 'sessions', page,
      entries: Array.from({ length: 12 }, (_, i) => [`item ${i}`, `/session ${i}`]) });
    const card = wecomTemplateCard(menu, 'test-task');
    assert.ok(card.button_list.length <= 6);
    assert.ok(card.button_selection.option_list.length <= 10);
    assert.equal(card.button_list.at(-1).text, '返回');
  }
});

test('model menu works immediately after new without constructing an empty session handle', async () => {
  const f = setup({ harness: {
    workspaceSession: (id) => { assert.ok(id); return {}; },
    listModels: async () => ({ groups: [{ id: 'provider', models: [{ id: 'model', name: 'Model' }] }] }),
  } });
  await f.bridge.accept(f.frame('/new'));
  await f.bridge.accept(f.frame('/menu models'));
  assert.match(f.latest().button_selection.option_list[0].text, /Model/);
  assert.equal(f.state.sessionFor(), null);
});

test('runtime dispatches real SDK welcome and card events', async () => {
  const f = setup();
  const runtime = new WecomRuntime({ config: { botId: 'test', remoteBotId: 'test' }, secret: 'test',
    client: f.client, state: f.state, harness: f.harness, createClient: () => f.client });
  await runtime.start();
  const enter = f.frame('', { msgtype: 'event', event: { eventtype: 'enter_chat' } });
  await f.client.listeners('event.enter_chat')[0](enter);
  assert.equal(f.sent[0].type, 'welcome');
  await f.client.listeners('event.template_card_event')[0](f.clickFrame('新会话', {}, {}, f.sent[0].card));
  assert.equal(f.state.sessionFor(), null);
  await runtime.stop();
});
