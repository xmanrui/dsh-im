import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  ModelCatalogContext,
  ModelEditor,
} from '../plugin-src/client/model-setting.js';
import { AgentPresetEditor } from '../plugin-src/client/agent-preset.js';
import { WorkspaceEditor } from '../plugin-src/client/workspace-editor.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;
const MODEL = Object.freeze({ provider: 'openai', model: 'gpt-5' });
const REASONING = { efforts: [
  { id: 'off', name: 'Off', description: 'Fast responses without reasoning' },
  { id: 'high', name: 'High', description: 'Think through difficult problems' },
  { id: 'custom-max', name: 'Maximum', description: 'Spend more time reasoning' },
], defaultEffort: 'high' };
const CATALOG = Object.freeze({
  groups: Object.freeze([Object.freeze({
    id: 'openai', name: 'OpenAI', models: Object.freeze([
      Object.freeze({ id: 'gpt-5', name: 'GPT-5', reasoning: REASONING }),
      Object.freeze({ id: 'gpt-5-mini', name: 'GPT-5 mini' }),
    ]),
  })]),
  failures: Object.freeze([]),
});
const channels = await Promise.all([
  ['weixin', 'WeixinSettingsTab'], ['wecom', 'WecomSettingsTab'], ['feishu', 'FeishuSettingsTab'],
  ['dingtalk', 'DingtalkSettingsTab'], ['qq', 'QqSettingsTab'], ['slack', 'SlackSettingsTab'],
  ['telegram', 'TelegramSettingsTab'], ['discord', 'DiscordSettingsTab'], ['whatsapp', 'WhatsappSettingsTab'],
].map(async ([name, component]) => {
  const api = await import(`../plugin-src/client/channels/${name}/api.js`);
  const ui = await import(`../plugin-src/client/channels/${name}/index.js`);
  return {
    name,
    Settings: ui[component],
    normalize: api.normalizeBotsSnapshot ?? api.normalizeSnapshot,
    endpoints: Object.entries(api).find(([key]) => key.endsWith('_ENDPOINTS'))[1],
  };
}));

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function mockWindow(t) {
  const previous = globalThis.window;
  let nextId = 0;
  globalThis.window = {
    setInterval() { return ++nextId; }, clearInterval() {},
    setTimeout() { return ++nextId; }, clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return ++nextId; }, cancelAnimationFrame() {},
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

function snapshot(channel, models = [null, null]) {
  return {
    schemaVersion: 2,
    revision: 1,
    modelCatalog: CATALOG,
    bots: models.map((model, index) => ({
      botId: `${channel}_${index}`,
      configured: true,
      connected: true,
      state: 'connected',
      workspace: `/workspace/${index}`,
      agentPreset: '',
      model,
      bot: {
        name: `Bot ${index}`, username: `bot${index}`, idMasked: '123•••',
        accountIdMasked: '123•••', appIdMasked: 'cli•••', clientIdMasked: 'ding•••',
      },
      health: { status: 'healthy', summary: 'Connected', lastCheckedAt: 1_700_000_000_000 },
    })),
  };
}

async function mount(t, component, props) {
  let renderer;
  await act(async () => { renderer = create(React.createElement(component, props)); await flush(); });
  t.after(async () => { await act(async () => { renderer.unmount(); await flush(); }); });
  return renderer;
}

async function openMenu(root, label) {
  const row = root.findAllByType('button').find((node) => node.props['aria-label'] === label);
  await act(async () => { row.props.onClick({ currentTarget: null }); await flush(); });
}

async function choose(root, label) {
  const option = root.findAllByProps({ role: 'menuitemradio' })
    .find((node) => textOf(node).startsWith(label));
  assert.ok(option, `Missing choice: ${label}`);
  await act(async () => { option.props.onClick(); await flush(); });
}

test('ModelEditor lists provider groups, explains new-session semantics and clears unavailable values', async (t) => {
  const saved = [];
  const renderer = await mount(t, ModelCatalogContext.Provider, {
    value: CATALOG,
    children: React.createElement(ModelEditor, {
      model: { provider: 'removed', model: 'old-model' },
      onSave(value) { saved.push(value); },
    }),
  });
  assert.match(textOf(renderer.root), /removed\/old-model/u);
  assert.match(textOf(renderer.root.findByProps({ role: 'tooltip' })), /先发送 \/new/u);
  assert.match(textOf(renderer.root.findByProps({ role: 'status' })), /当前模型已不可用/u);
  await openMenu(renderer.root, '模型');
  assert.equal(renderer.root.findByProps({ role: 'group' }).props['aria-label'], 'OpenAI');
  assert.match(textOf(renderer.root), /GPT-5openai\/gpt-5/u);
  await choose(renderer.root, '跟随默认模型');
  assert.deepEqual(saved, [null]);
});

test('all nine client APIs preserve model selections and the public model catalog', () => {
  for (const channel of channels) {
    assert.equal(channel.endpoints.setModel, 'bot.model.set', channel.name);
    const selected = { ...MODEL, reasoningEffort: 'custom-max' };
    const raw = snapshot(channel.name, [selected, null]);
    const normalized = channel.normalize(raw);
    assert.deepEqual(normalized.bots[0].model, selected, channel.name);
    assert.equal(normalized.bots[1].model, null, channel.name);
    assert.deepEqual(normalized.modelCatalog, CATALOG, channel.name);
  }
});

test('all nine cards place model below workspace and save through bot.model.set', async (t) => {
  mockWindow(t);
  for (const channel of channels) await t.test(channel.name, async (t) => {
    let current = snapshot(channel.name);
    const calls = [];
    const rpcCall = async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      if (endpoint === 'connection.status') return { ok: true, value: current };
      assert.equal(endpoint, 'bot.model.set', channel.name);
      current = {
        ...current,
        revision: current.revision + 1,
        bots: current.bots.map((bot) => bot.botId === payload.botId
          ? { ...bot, model: payload.model }
          : bot),
      };
      return { ok: true, value: current };
    };
    const renderer = await mount(t, channel.Settings, { rpcCall });
    const first = () => renderer.root.findByProps({ 'data-bot-id': `${channel.name}_0` });
    const second = () => renderer.root.findByProps({ 'data-bot-id': `${channel.name}_1` });
    const editors = first().findAll((node) => (
      [WorkspaceEditor, ModelEditor, AgentPresetEditor].includes(node.type)
    ));
    assert.deepEqual(editors.map((node) => node.type), [
      WorkspaceEditor, ModelEditor, AgentPresetEditor,
    ], `${channel.name} editor order`);

    await openMenu(first(), '模型');
    await choose(first(), 'GPT-5openai/gpt-5');
    assert.deepEqual(calls.filter(({ endpoint }) => endpoint !== 'connection.status'), [{
      endpoint: 'bot.model.set',
      payload: { botId: `${channel.name}_0`, model: MODEL },
    }], channel.name);
    assert.deepEqual(first().findByType(ModelEditor).props.model, MODEL, channel.name);
    assert.equal(second().findByType(ModelEditor).props.model, null, channel.name);
    await openMenu(first(), '思考强度');
    assert.match(textOf(first()), /Think through difficult problems/u);
    await choose(first(), 'Maximum');
    assert.deepEqual(calls.filter(({ endpoint }) => endpoint === 'bot.model.set').at(-1).payload, {
      botId: `${channel.name}_0`, model: { ...MODEL, reasoningEffort: 'custom-max' },
    });
    assert.equal(first().findByType(ModelEditor).props.model.reasoningEffort, 'custom-max');
    assert.equal(second().findByType(ModelEditor).props.model, null);
    await openMenu(first(), '思考强度');
    assert.match(textOf(first().findByProps({ 'aria-checked': true })), /Maximum/u);
    await choose(first(), '跟随模型默认');
    assert.deepEqual(calls.filter(({ endpoint }) => endpoint === 'bot.model.set').at(-1).payload.model, MODEL);
  });
});

test('model changes clear the previous effort; selecting the same model preserves it', async (t) => {
  const saved = [];
  const renderer = await mount(t, ModelCatalogContext.Provider, {
    value: CATALOG,
    children: React.createElement(ModelEditor, {
      model: { ...MODEL, reasoningEffort: 'high' }, onSave(value) { saved.push(value); },
    }),
  });
  await openMenu(renderer.root, '模型');
  await choose(renderer.root, 'GPT-5openai/gpt-5');
  assert.deepEqual(saved, []);
  await openMenu(renderer.root, '模型');
  await choose(renderer.root, 'GPT-5 mini');
  assert.deepEqual(saved, [{ provider: 'openai', model: 'gpt-5-mini' }]);
});

test('unavailable effort stays visible and can be reset even when reasoning metadata disappears', async (t) => {
  const saved = [];
  const renderer = await mount(t, ModelCatalogContext.Provider, {
    value: CATALOG,
    children: React.createElement(ModelEditor, {
      model: { provider: 'openai', model: 'gpt-5-mini', reasoningEffort: 'legacy-max' },
      onSave(value) { saved.push(value); },
    }),
  });
  assert.match(textOf(renderer.root), /legacy-max/u);
  assert.match(textOf(renderer.root.findByProps({ role: 'status' })), /思考强度已不可用/u);
  await openMenu(renderer.root, '思考强度');
  await choose(renderer.root, '跟随模型默认');
  assert.deepEqual(saved, [{ provider: 'openai', model: 'gpt-5-mini' }]);
});

test('default or non-reasoning models explain the disabled effort control', async (t) => {
  for (const model of [null, { provider: 'openai', model: 'gpt-5-mini' }]) {
    const renderer = await mount(t, ModelCatalogContext.Provider, {
      value: CATALOG, children: React.createElement(ModelEditor, { model }),
    });
    assert.equal(renderer.root.findByProps({ 'aria-label': '思考强度' }).props.disabled, true);
    assert.match(textOf(renderer.root), model ? /未提供可调节/u : /先选择模型/u);
  }
});

test('failed saves keep the selection and allow retry, with duplicate saves locked', async (t) => {
  let reject;
  let calls = 0;
  const renderer = await mount(t, ModelCatalogContext.Provider, {
    value: CATALOG,
    children: React.createElement(ModelEditor, {
      model: { ...MODEL, reasoningEffort: 'high' },
      onSave() { calls += 1; return new Promise((_, fail) => { reject = fail; }); },
    }),
  });
  await openMenu(renderer.root, '思考强度');
  const maximum = renderer.root.findAllByProps({ role: 'menuitemradio' })
    .find((node) => textOf(node).startsWith('Maximum'));
  await act(async () => { maximum.props.onClick(); maximum.props.onClick(); await flush(); });
  assert.equal(calls, 1);
  assert.equal(maximum.props.disabled, true);
  await act(async () => { reject(new Error('Save failed')); await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ role: 'alert' })), 'Save failed');
  assert.match(textOf(renderer.root.findByProps({ 'aria-checked': true })), /^High/u);
  assert.equal(maximum.props.disabled, false);
});

test('English model and effort settings translate defaults and explanatory text', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const renderer = await mount(t, ModelCatalogContext.Provider, {
    value: CATALOG, children: React.createElement(ModelEditor, { model: MODEL }),
  });
  assert.match(textOf(renderer.root), /Model default · High/u);
  await openMenu(renderer.root, 'Reasoning effort');
  assert.match(textOf(renderer.root), /Use the default reasoning effort from the model or provider/u);
});
