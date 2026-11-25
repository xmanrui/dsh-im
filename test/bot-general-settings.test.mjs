import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { BotGeneralSettingsPage } from '../plugin-src/client/bot-general-settings.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';
const { act, create } = TestRenderer;
const result = (botId, busyMessageMode) => ({ ok: true, value: { bots: [{ botId, busyMessageMode }] } });
const text = (node) => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
async function mount(t, rpcCall, props = {}) {
  let view;
  await act(async () => { view = create(React.createElement(BotGeneralSettingsPage, {
    key: 'one', account: { botId: 'one' }, rpcCall, ...props,
  })); });
  t.after(async () => { await act(async () => view.unmount()); });
  return view;
}

test('general settings auto-saves changes, rolls back failures, and blocks edits while saving', async (t) => {
  const calls = [];
  let fail = true;
  let finishSave;
  const view = await mount(t, async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'connection.status') return result('one', undefined);
    if (fail) return { ok: false, error: { message: 'disk full' } };
    return new Promise((resolve) => { finishSave = () => resolve(result('one', payload.busyMessageMode)); });
  });
  const select = () => view.root.findByType('select');
  assert.equal(select().props.value, 'queue');
  assert.deepEqual(select().findAllByType('option').map((node) => node.props.value), ['queue', 'steer']);
  assert.equal(view.root.findAllByType('button').length, 0);
  await act(async () => select().props.onChange({ target: { value: 'queue' } }));
  assert.deepEqual(calls, [{ endpoint: 'connection.status', payload: {} }]);
  await act(async () => select().props.onChange({ target: { value: 'steer' } }));
  assert.match(text(view.root.findByProps({ role: 'alert' })), /disk full/);
  assert.equal(select().props.value, 'queue');
  assert.equal(select().props.disabled, false);
  fail = false;
  await act(async () => select().props.onChange({ target: { value: 'steer' } }));
  assert.deepEqual(calls.at(-1), { endpoint: 'bot.message-mode.set', payload: { botId: 'one', busyMessageMode: 'steer' } });
  assert.equal(select().props.disabled, true);
  await act(async () => select().props.onChange({ target: { value: 'queue' } }));
  assert.equal(calls.length, 3);
  await act(async () => finishSave());
  assert.equal(select().props.value, 'steer');
  assert.equal(select().props.disabled, false);
  assert.equal(view.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('Feishu panel switches read legacy defaults without writing and save independently of progress mode', async (t) => {
  const calls = [];
  let panels;
  const view = await mount(t, async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'bot.step-card-panels.set') panels = payload.stepCardPanels;
    return { ok: true, value: { bots: [{ botId: 'one', busyMessageMode: 'steer', stepPush: false, stepPushMode: 'post', stepCardPanels: panels }] } };
  }, { channel: 'feishu' });
  const switches = () => view.root.findAllByProps({ role: 'switch' });
  // Every channel gets the three shared reply-content switches; the Feishu
  // streaming-card panels follow them.
  assert.deepEqual(switches().map((node) => node.props.checked), [true, true, true, false, true]);
  assert.deepEqual(switches().slice(0, 3).map((node) => node.props['aria-label']), ['过程正文', '工具步骤', '思考过程']);
  assert.deepEqual(calls, [{ endpoint: 'connection.status', payload: {} }]);
  assert.equal(view.root.findByType('select').props.value, 'steer');
  assert.equal(switches()[3].props.disabled, false, 'can configure before using streaming cards');
  await act(async () => switches()[3].props.onChange({ target: { checked: true } }));
  await act(async () => switches()[4].props.onChange({ target: { checked: false } }));
  assert.deepEqual(calls.slice(1).map(({ payload }) => payload), [
    { botId: 'one', stepCardPanels: { thinkingExpanded: true, toolsExpanded: true } },
    { botId: 'one', stepCardPanels: { thinkingExpanded: true, toolsExpanded: false } },
  ]);
  assert.deepEqual(switches().map((node) => node.props.checked), [true, true, true, true, false]);
  assert.equal(view.root.findByType('select').props.value, 'steer');
  assert.equal(view.root.findAllByType('button').length, 0);
  for (const input of switches()) {
    assert.equal(input.props.className, 'dim-contextSwitch');
    assert.equal(view.root.findByProps({ htmlFor: input.props.id }).type, 'label');
  }
});

test('Feishu panel save failure rolls back both values and pending saves block repeat edits', async (t) => {
  let fail = true;
  let finish;
  let writes = 0;
  const view = await mount(t, async (endpoint, payload) => {
    if (endpoint === 'connection.status') return result('one', 'queue');
    writes += 1;
    if (fail) return { ok: false, error: { message: 'disk full' } };
    return new Promise((resolve) => { finish = () => resolve({ ok: true, value: { bots: [{ botId: 'one', stepCardPanels: payload.stepCardPanels }] } }); });
  }, { channel: 'feishu' });
  const switches = () => view.root.findAllByProps({ role: 'switch' });
  await act(async () => switches()[4].props.onChange({ target: { checked: false } }));
  assert.deepEqual(switches().map((node) => node.props.checked), [true, true, true, false, true]);
  assert.match(text(view.root.findByProps({ role: 'alert' })), /disk full/);
  fail = false;
  await act(async () => switches()[4].props.onChange({ target: { checked: false } }));
  assert.ok(switches().every((node) => node.props.disabled));
  await act(async () => switches()[3].props.onChange({ target: { checked: true } }));
  assert.equal(writes, 2);
  await act(async () => finish());
  assert.deepEqual(switches().map((node) => node.props.checked), [true, true, true, false, false]);
  assert.equal(view.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('panel switches stay disabled after load failure and never appear on other channels', async (t) => {
  const view = await mount(t, async () => { throw new Error('offline'); }, { channel: 'feishu' });
  assert.ok(view.root.findAllByProps({ role: 'switch' }).every((node) => node.props.disabled));
  await act(async () => view.update(React.createElement(BotGeneralSettingsPage, {
    key: 'telegram', channel: 'telegram', account: { botId: 'two' }, rpcCall: async () => result('two', 'queue'),
  })));
  // Reply content is shared by every channel; the card panels are Feishu-only.
  assert.deepEqual(view.root.findAllByProps({ role: 'switch' }).map((node) => node.props['aria-label']),
    ['过程正文', '工具步骤', '思考过程']);
});

test('Feishu panel labels translate and late saves cannot change another bot', async (t) => {
  setImTranslator((source) => en[source] ?? source);
  t.after(() => setImTranslator(null));
  let finish;
  const view = await mount(t, async (endpoint) => endpoint === 'connection.status'
    ? result('one', 'queue') : new Promise((resolve) => { finish = resolve; }), { channel: 'feishu' });
  assert.deepEqual(view.root.findAllByProps({ role: 'switch' }).map((node) => node.props['aria-label']),
    ['Process prose', 'Tool steps', 'Reasoning', 'Expand thinking', 'Expand tool summaries']);
  await act(async () => view.root.findAllByProps({ role: 'switch' })[0].props.onChange({ target: { checked: true } }));
  await act(async () => view.update(React.createElement(BotGeneralSettingsPage, {
    key: 'two', channel: 'feishu', account: { botId: 'two' },
    rpcCall: async () => ({ ok: true, value: { bots: [{ botId: 'two', stepCardPanels: { thinkingExpanded: false, toolsExpanded: false } }] } }),
  })));
  await act(async () => finish({ ok: true, value: { bots: [{ botId: 'one', stepCardPanels: { thinkingExpanded: true, toolsExpanded: true } }] } }));
  assert.deepEqual(view.root.findAllByProps({ role: 'switch' }).map((node) => node.props.checked),
    [true, true, true, false, false]);
});

test('failed initial load cannot overwrite server settings and can be retried', async (t) => {
  let fail = true;
  const view = await mount(t, async () => {
    if (fail) throw new Error('offline');
    return result('one', 'steer');
  });
  assert.equal(view.root.findByType('select').props.disabled, true);
  fail = false;
  await act(async () => view.root.findAllByType('button').find((button) => text(button) === '重新读取').props.onClick());
  assert.equal(view.root.findByType('select').props.value, 'steer');
  assert.equal(view.root.findByType('select').props.disabled, false);
});

test('switching bot discards the old pending response; labels translate to English', async (t) => {
  setImTranslator((source) => en[source] ?? source);
  t.after(() => setImTranslator(null));
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const view = await mount(t, () => pending);
  await act(async () => view.update(React.createElement(BotGeneralSettingsPage, {
    key: 'two', account: { botId: 'two' }, rpcCall: async () => result('two', 'steer'),
  })));
  await act(async () => resolve(result('one', 'queue')));
  assert.equal(view.root.findByType('select').props.value, 'steer');
  assert.equal(view.root.findByType('select').props['aria-label'], 'Message handling');
  assert.equal(view.root.findAllByType('button').length, 0);
});

test('reply content switches save the whole set and survive a reload', async (t) => {
  let stored = { narration: true, tools: false, thinking: true };
  const calls = [];
  const view = await mount(t, async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'bot.reply-content.set') stored = payload.replyContent;
    return { ok: true, value: { bots: [{ botId: 'one', busyMessageMode: 'queue', replyContent: stored }] } };
  }, { channel: 'telegram' });
  const switches = () => view.root.findAllByProps({ role: 'switch' });
  assert.deepEqual(switches().map((node) => node.props.checked), [true, false, true]);
  await act(async () => switches()[0].props.onChange({ target: { checked: false } }));
  assert.deepEqual(calls.at(-1), {
    endpoint: 'bot.reply-content.set',
    payload: { botId: 'one', replyContent: { narration: false, tools: false, thinking: true } },
  });
  assert.deepEqual(switches().map((node) => node.props.checked), [false, false, true]);
  assert.equal(view.root.findAllByProps({ role: 'alert' }).length, 0);
});

