import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  CONTEXT_DIRECT_GUIDANCE_EXAMPLE,
  CONTEXT_ENHANCEMENT_FIELDS,
  CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH,
  CONTEXT_GROUP_GUIDANCE_EXAMPLE,
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
} from '../src/channels/shared/context-enhancement.mjs';
import { ContextEnhancementEditor, contextEnhancementLabel } from '../plugin-src/client/context-enhancement.js';
import { AgentPresetEditor } from '../plugin-src/client/agent-preset.js';
import { WorkspaceEditor } from '../plugin-src/client/workspace-editor.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;
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

function button(root, name) {
  const found = root.findAllByType('button').find((node) => textOf(node) === name);
  assert.ok(found, `missing button: ${name}`);
  return found;
}

function scope(root, kind) {
  return root.findAllByType('fieldset').find((node) => node.props['data-context-kind'] === kind);
}

function fields(root, kind) {
  const parent = kind ? scope(root, kind) : root;
  return parent.findAllByType('input').filter((node) => (
    typeof node.props.name === 'string'
    && CONTEXT_ENHANCEMENT_FIELDS.includes(node.props.name.replace(/^(?:group|direct)-/, ''))
  ));
}

function fieldNames(nodes) {
  return nodes.map((node) => node.props.name.replace(/^(?:group|direct)-/, ''));
}

function guidance(root, kind) {
  return scope(root, kind).findByType('textarea');
}

function scopeSwitch(root, kind) {
  return scope(root, kind).findByProps({ role: 'switch' });
}

function switchStates(root) {
  return ['group', 'direct'].map((kind) => scopeSwitch(root, kind).props.checked);
}

function tabs(root) {
  return root.findAllByProps({ role: 'tab' });
}

function panels(root) {
  return root.findAllByProps({ role: 'tabpanel' });
}

function badge(root) {
  return textOf(root.findByProps({ className: 'dim-contextStatus' }));
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function open(root) {
  await act(async () => { root.findByProps({ className: 'dim-contextEntry' }).props.onClick(); });
}

async function click(root, label) {
  await act(async () => { button(root, label).props.onClick(); await flush(); });
}

async function clickScope(root, kind, label) {
  await act(async () => { button(scope(root, kind), label).props.onClick(); await flush(); });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mockWindow(t) {
  const previous = globalThis.window;
  const intervals = new Map();
  let nextId = 0;
  globalThis.window = {
    setInterval(callback, delay) { const id = ++nextId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout() { return ++nextId; }, clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return ++nextId; }, cancelAnimationFrame() {},
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  return { poll: () => [...intervals.values()].find(({ delay }) => delay === 15_000)?.callback() };
}

function snapshot(channel, configs = [undefined, undefined]) {
  return {
    revision: 1,
    bots: configs.map((config, index) => ({
      botId: `${channel}_${index}`, configured: true, connected: true, state: 'connected',
      workspace: `/workspace/${index}`, agentPreset: '', contextEnhancement: config,
      bot: {
        name: `Bot ${index}`, username: `bot${index}`, idMasked: '123•••',
        accountIdMasked: '123•••', appIdMasked: 'cli•••', clientIdMasked: 'ding•••',
      },
      health: { status: 'healthy', summary: 'Connected', lastCheckedAt: 1_700_000_000_000 },
    })),
  };
}

async function mount(t, component, props, options) {
  let renderer;
  await act(async () => { renderer = create(React.createElement(component, props), options); await flush(); });
  t.after(async () => { await act(async () => { renderer.unmount(); await flush(); }); });
  return renderer;
}

test('context settings default to off with sender ID and empty guidance, and explain the guidance', async (t) => {
  assert.equal(contextEnhancementLabel(undefined), '未开启');
  for (const [groupEnabled, directEnabled, label] of [
    [false, false, '未开启'], [true, false, '仅群聊'],
    [false, true, '仅私聊'], [true, true, '群聊和私聊'],
  ]) {
    const config = {
      group: { ...DEFAULT_CONTEXT_ENHANCEMENT_CONFIG.group, enabled: groupEnabled },
      direct: { ...DEFAULT_CONTEXT_ENHANCEMENT_CONFIG.direct, enabled: directEnabled },
    };
    assert.equal(contextEnhancementLabel(config), label);
  }
  const saved = [];
  const renderer = await mount(t, ContextEnhancementEditor, { onSave: (value) => saved.push(value) });
  const entry = renderer.root.findByProps({ className: 'dim-contextEntry' });
  assert.equal(entry.props.disabled, false);
  assert.equal(entry.props['aria-haspopup'], 'dialog');
  await open(renderer.root);
  const contextHelp = renderer.root.findByProps({ 'aria-label': '查看上下文增强说明' });
  const contextTooltip = renderer.root.findByProps({ id: contextHelp.props['aria-describedby'] });
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-describedby'], contextTooltip.props.id);
  assert.match(textOf(contextTooltip), /选择在哪些会话中启用.*不查询平台 API/);
  assert.equal(renderer.root.findAllByType('p').some((node) => textOf(node).startsWith('选择在哪些会话中启用')), false);
  assert.deepEqual(tabs(renderer.root).map(textOf), ['私聊', '群聊']);
  assert.deepEqual(tabs(renderer.root).map((node) => node.props['aria-selected']), [true, false]);
  assert.deepEqual(tabs(renderer.root).map((node) => node.props.tabIndex), [0, -1]);
  assert.deepEqual(panels(renderer.root).map((node) => node.props.hidden), [false, true]);
  assert.deepEqual(tabs(renderer.root).map((node) => node.props['aria-controls']), panels(renderer.root).map((node) => node.props.id));
  let prevented = false;
  await act(async () => {
    tabs(renderer.root)[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  });
  assert.equal(prevented, true);
  assert.deepEqual(tabs(renderer.root).map((node) => node.props['aria-selected']), [false, true]);
  assert.deepEqual(panels(renderer.root).map((node) => node.props.hidden), [true, false]);
  await act(async () => { tabs(renderer.root)[1].props.onKeyDown({ key: 'Home', preventDefault() {} }); });
  assert.deepEqual(tabs(renderer.root).map((node) => node.props['aria-selected']), [true, false]);
  assert.deepEqual(renderer.root.findAllByProps({ className: 'dim-contextSwitchRow' }).map(textOf), ['启用', '启用']);
  assert.deepEqual(renderer.root.findAllByType('label').filter((node) => (
    typeof node.props.htmlFor === 'string' && node.props.htmlFor.endsWith('-guidance')
  )).map(textOf), ['增强提示词', '增强提示词']);
  assert.deepEqual(switchStates(renderer.root), [false, false]);
  assert.ok(renderer.root.findAllByType('textarea').every((node) => node.props.rows === 4));
  for (const kind of ['group', 'direct']) {
    assert.deepEqual(fieldNames(fields(renderer.root, kind)), CONTEXT_ENHANCEMENT_FIELDS);
    assert.deepEqual(fieldNames(fields(renderer.root, kind).filter((node) => node.props.checked)), ['senderId']);
  }
  assert.deepEqual(renderer.root.findAllByProps({ className: 'dim-contextFieldKey' }).map(textOf), [
    ...CONTEXT_ENHANCEMENT_FIELDS, ...CONTEXT_ENHANCEMENT_FIELDS,
  ]);
  const fieldsHelp = renderer.root.findByProps({ 'aria-label': '查看群聊来源字段说明' });
  const fieldsTooltip = renderer.root.findByProps({ id: fieldsHelp.props['aria-describedby'] });
  assert.match(textOf(fieldsTooltip), /增强提示词中请使用字段名（如 senderId、conversationType）.*不会额外查询或补全/);
  assert.equal(renderer.root.findAllByType('p').some((node) => textOf(node).startsWith('增强提示词中请使用字段名')), false);
  assert.equal(guidance(renderer.root, 'group').props.value, '');
  assert.equal(guidance(renderer.root, 'direct').props.value, '');
  assert.equal(guidance(renderer.root, 'group').props.placeholder, CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  assert.equal(guidance(renderer.root, 'direct').props.placeholder, CONTEXT_DIRECT_GUIDANCE_EXAMPLE);
  const help = renderer.root.findByProps({ 'aria-label': '查看群聊增强提示词使用说明' });
  const tooltip = renderer.root.findByProps({ id: help.props['aria-describedby'] });
  assert.equal(help.props.type, 'button');
  assert.equal(help.props['aria-describedby'], tooltip.props.id);
  assert.match(textOf(tooltip), /使用说明.*dsh_im_source.*生效规则.*清空并保存.*隐私提示.*会话历史.*使用示例.*群聊/s);
  assert.equal(textOf(tooltip.findByProps({ className: 'dim-contextTooltipExample' })), CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  assert.equal(guidance(renderer.root, 'group').props['aria-describedby'], tooltip.props.id);
  assert.equal(renderer.root.findAllByType('p').some((node) => /只需填写正文|发送者标识可能包含/.test(textOf(node))), false);
  const senderNameHelp = renderer.root.findByProps({ 'aria-label': '查看群聊发送者昵称字段说明' });
  const senderNameTooltip = renderer.root.findByProps({ id: senderNameHelp.props['aria-describedby'] });
  assert.equal(senderNameHelp.props.type, 'button');
  assert.equal(senderNameHelp.parent.props.className, 'dim-contextHelp dim-contextFieldHelp');
  assert.equal(senderNameHelp.parent.parent.props.className, 'dim-contextFieldText');
  assert.match(textOf(senderNameTooltip), /不是每个渠道.*dsh_im_source.*省略 senderName/s);
  const conversationTitleHelp = renderer.root.findByProps({ 'aria-label': '查看群聊会话标题字段说明' });
  const conversationTitleTooltip = renderer.root.findByProps({ id: conversationTitleHelp.props['aria-describedby'] });
  assert.equal(conversationTitleHelp.props.type, 'button');
  assert.equal(conversationTitleHelp.parent.props.className, 'dim-contextHelp dim-contextFieldHelp');
  assert.match(textOf(conversationTitleTooltip), /不是每个渠道.*dsh_im_source.*省略 conversationTitle/s);
  assert.deepEqual(saved, []);
});

test('switches, fields, and guidance are local drafts until Save; Cancel and close discard them', async (t) => {
  const saved = [];
  const renderer = await mount(t, ContextEnhancementEditor, { onSave: (value) => saved.push(value) });
  for (const dismiss of ['取消', 'close', 'escape', 'backdrop']) {
    await open(renderer.root);
    await act(async () => { scopeSwitch(renderer.root, 'group').props.onChange({ target: { checked: true } }); });
    assert.deepEqual(switchStates(renderer.root), [true, false]);
    await act(async () => { scopeSwitch(renderer.root, 'direct').props.onChange({ target: { checked: true } }); });
    assert.deepEqual(switchStates(renderer.root), [true, true]);
    await act(async () => {
      scopeSwitch(renderer.root, 'group').props.onChange({ target: { checked: false } });
      fields(renderer.root, 'group')[0].props.onChange({ target: { checked: false } });
    });
    assert.deepEqual(switchStates(renderer.root), [false, true]);
    await clickScope(renderer.root, 'group', '清空');
    assert.equal(badge(renderer.root), '未开启');
    assert.equal(guidance(renderer.root, 'group').props.value, '');
    assert.deepEqual(saved, []);
    await act(async () => {
      if (dismiss === 'close') renderer.root.findByProps({ 'aria-label': '关闭弹窗' }).props.onClick();
      else if (dismiss === 'escape') renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({
        key: 'Escape', preventDefault() {}, stopPropagation() {},
      });
      else if (dismiss === 'backdrop') {
        const target = {};
        renderer.root.findByProps({ className: 'dim-contextBackdrop' }).props.onMouseDown({ target, currentTarget: target });
      } else button(renderer.root, dismiss).props.onClick();
      await flush();
    });
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
    await open(renderer.root);
    assert.deepEqual(switchStates(renderer.root), [false, false]);
    for (const kind of ['group', 'direct']) {
      assert.deepEqual(fieldNames(fields(renderer.root, kind).filter((node) => node.props.checked)), ['senderId']);
      assert.equal(guidance(renderer.root, kind).props.value, '');
    }
    await click(renderer.root, '取消');
  }
  assert.deepEqual(saved, []);
});

test('Save submits one complete config, preserves explicit empty fields/guidance, and fills the example alone', async (t) => {
  let saved;
  const calls = [];
  function Fixture() {
    const [config, setConfig] = React.useState(undefined);
    return React.createElement(ContextEnhancementEditor, {
      config,
      onSave(value) { saved = value; calls.push(value); setConfig(value); },
    });
  }
  const renderer = await mount(t, Fixture);
  await open(renderer.root);
  await act(async () => { scopeSwitch(renderer.root, 'group').props.onChange({ target: { checked: true } }); });
  // Read each freshly rendered checkbox so every independent edit uses the current draft.
  for (const name of CONTEXT_ENHANCEMENT_FIELDS) {
    await act(async () => {
      scope(renderer.root, 'group').findByProps({ name: `group-${name}` }).props.onChange({ target: { checked: false } });
    });
  }
  await clickScope(renderer.root, 'group', '清空');
  await click(renderer.root, '保存');
  assert.equal(calls.length, 1);
  assert.deepEqual(saved, {
    group: { enabled: true, fields: [], guidance: '' },
    direct: { enabled: false, fields: ['senderId'], guidance: '' },
  });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  assert.equal(badge(renderer.root), '仅群聊');
  await open(renderer.root);
  assert.ok(fields(renderer.root, 'group').every((node) => !node.props.checked));
  assert.deepEqual(fieldNames(fields(renderer.root, 'direct').filter((node) => node.props.checked)), ['senderId']);
  assert.equal(guidance(renderer.root, 'group').props.value, '');
  assert.equal(guidance(renderer.root, 'group').props.placeholder, CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  await clickScope(renderer.root, 'group', '填入示例');
  assert.equal(guidance(renderer.root, 'group').props.value, CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  assert.equal(guidance(renderer.root, 'direct').props.value, '');
  assert.ok(fields(renderer.root, 'group').every((node) => !node.props.checked));
  assert.deepEqual(switchStates(renderer.root), [true, false]);
  await click(renderer.root, '取消');
  const reloaded = await mount(t, ContextEnhancementEditor, { config: JSON.parse(JSON.stringify(saved)) });
  await open(reloaded.root);
  assert.equal(guidance(reloaded.root, 'group').props.value, '');
  assert.equal(guidance(reloaded.root, 'direct').props.value, '');
  assert.ok(fields(reloaded.root, 'group').every((node) => !node.props.checked));
  assert.deepEqual(fieldNames(fields(reloaded.root, 'direct').filter((node) => node.props.checked)), ['senderId']);
});

test('failed atomic saves retain the draft, lock edits and duplicate submits, and can be retried', async (t) => {
  const request = deferred();
  const calls = [];
  const renderer = await mount(t, ContextEnhancementEditor, {
    config: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
    onSave(value) { calls.push(value); return calls.length === 1 ? request.promise : undefined; },
  });
  await open(renderer.root);
  await act(async () => {
    scopeSwitch(renderer.root, 'direct').props.onChange({ target: { checked: true } });
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'local draft' } });
  });
  const saveButton = button(renderer.root, '保存');
  await act(async () => { saveButton.props.onClick(); saveButton.props.onClick(); await flush(); });
  assert.equal(calls.length, 1);
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-busy'], true);
  assert.ok(renderer.root.findAllByType('input').every((node) => node.props.disabled));
  assert.ok(renderer.root.findAllByType('button').every((node) => node.props.disabled || node.props.className === 'dim-contextEntry'));
  await act(async () => {
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'do not commit' } });
    renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    button(renderer.root, '取消').props.onClick();
  });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1);
  assert.equal(guidance(renderer.root, 'direct').props.value, 'local draft');
  assert.equal(badge(renderer.root), '未开启');
  request.reject(new Error('Save rejected'));
  await act(async () => { await flush(); });
  assert.equal(textOf(renderer.root.findByProps({ role: 'alert' })), 'Save rejected');
  assert.equal(guidance(renderer.root, 'direct').props.value, 'local draft');
  assert.deepEqual(switchStates(renderer.root), [false, true]);
  assert.equal(badge(renderer.root), '未开启');
  await click(renderer.root, '保存');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
});

test('Weixin displays and saves only its supported direct scope', async (t) => {
  const saved = [];
  const renderer = await mount(t, ContextEnhancementEditor, {
    groupSupported: false,
    config: {
      group: { enabled: true, fields: ['botId'], guidance: 'preserve group' },
      direct: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG.direct,
    },
    onSave(value) { saved.push(value); },
  });
  assert.equal(badge(renderer.root), '未开启');
  await open(renderer.root);
  assert.deepEqual(tabs(renderer.root).map((node) => node.props['aria-selected']), [true, false]);
  assert.deepEqual(panels(renderer.root).map((node) => node.props.hidden), [false, true]);
  const group = scopeSwitch(renderer.root, 'group');
  assert.equal(group.props.checked, false);
  assert.equal(group.props.disabled, true);
  const groupNotice = renderer.root.findByProps({ id: group.props['aria-describedby'] });
  assert.equal(textOf(groupNotice), '（当前渠道不支持群聊）');
  assert.equal(groupNotice.props.className, 'dim-contextUnavailable');
  assert.equal(groupNotice.parent.props.className, 'dim-contextSwitchLabel');
  assert.ok(scope(renderer.root, 'group').findAllByType('input').every((node) => node.props.disabled));
  assert.equal(guidance(renderer.root, 'group').props.disabled, true);
  await act(async () => { tabs(renderer.root)[1].props.onClick(); });
  assert.deepEqual(panels(renderer.root).map((node) => node.props.hidden), [true, false]);
  await act(async () => {
    group.props.onChange({ target: { checked: true } });
    tabs(renderer.root)[0].props.onClick();
  });
  await act(async () => {
    scopeSwitch(renderer.root, 'direct').props.onChange({ target: { checked: true } });
  });
  await click(renderer.root, '保存');
  assert.equal(saved[0].group.enabled, false);
  assert.deepEqual(saved[0].group.fields, ['botId']);
  assert.equal(saved[0].group.guidance, 'preserve group');
  assert.equal(saved[0].direct.enabled, true);
});

test('dialog traps Tab and external focus, cancels with Escape, and restores entry focus', async (t) => {
  const previous = globalThis.document;
  const listeners = new Map();
  const document = { activeElement: null, addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } };
  globalThis.document = document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const focusable = () => ({ focus() { document.activeElement = this; } });
  const entry = focusable();
  const first = focusable();
  const last = focusable();
  const dialog = { ...focusable(), contains(node) { return [this, first, last].includes(node); }, querySelectorAll() { return [first, last]; } };
  const renderer = await mount(t, ContextEnhancementEditor, {}, {
    createNodeMock(element) {
      if (element.props.className === 'dim-contextEntry') return entry;
      if (element.props.role === 'dialog') return dialog;
      return {};
    },
  });
  await open(renderer.root);
  assert.equal(document.activeElement, dialog);
  const keydown = (shiftKey) => {
    let prevented = false;
    renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  };
  keydown(false);
  assert.equal(document.activeElement, first);
  keydown(true);
  assert.equal(document.activeElement, last);
  keydown(false);
  assert.equal(document.activeElement, first);
  listeners.get('focusin')({ target: {} });
  assert.equal(document.activeElement, dialog);
  await act(async () => {
    renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    await flush();
  });
  assert.equal(document.activeElement, entry);
  assert.equal(listeners.has('focusin'), false);
});

test('all context dialog copy and validation errors localize without translating the saved body', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const saved = [];
  const renderer = await mount(t, ContextEnhancementEditor, { groupSupported: false, onSave: (value) => saved.push(value) });
  assert.equal(badge(renderer.root), 'Not enabled');
  await open(renderer.root);
  assert.doesNotMatch(textOf(renderer.root), /[\p{Script=Han}]/u);
  assert.equal(guidance(renderer.root, 'direct').props.value, '');
  assert.equal(guidance(renderer.root, 'direct').props.placeholder, en[CONTEXT_DIRECT_GUIDANCE_EXAMPLE]);
  assert.equal(guidance(renderer.root, 'direct').props.maxLength, CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH);
  const localizedExample = textOf(scope(renderer.root, 'direct').findByProps({ className: 'dim-contextTooltipExample' }));
  assert.equal(localizedExample, en[CONTEXT_DIRECT_GUIDANCE_EXAMPLE]);
  await clickScope(renderer.root, 'direct', 'Use example');
  assert.equal(guidance(renderer.root, 'direct').props.value, localizedExample);
  await clickScope(renderer.root, 'direct', 'Clear');
  await act(async () => {
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'x'.repeat(CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH + 1) } });
  });
  await click(renderer.root, 'Save');
  assert.match(textOf(renderer.root.findByProps({ role: 'alert' })), /Guidance must not exceed 8000 characters/);
  assert.deepEqual(saved, []);
});

test('all nine APIs preserve canonical, empty, absent and damaged context configurations', () => {
  for (const channel of channels) {
    assert.equal(channel.endpoints.setContextEnhancement, 'bot.context-enhancement.set');
    const empty = {
      group: { enabled: true, fields: [], guidance: '' },
      direct: { enabled: false, fields: ['senderId'], guidance: '' },
    };
    const raw = snapshot(channel.name, [undefined, empty]);
    const normalized = channel.normalize(raw);
    assert.deepEqual(normalized.bots[0].contextEnhancement, DEFAULT_CONTEXT_ENHANCEMENT_CONFIG, channel.name);
    assert.deepEqual(normalized.bots[1].contextEnhancement, empty, channel.name);
    const canonical = channel.normalize(snapshot(channel.name, [{
      group: { enabled: false, fields: ['botId', 'channel', 'botId'], guidance: ' \n ' },
      direct: { enabled: true, fields: [], guidance: 'direct only' },
    }]));
    assert.deepEqual(canonical.bots[0].contextEnhancement, {
      group: { enabled: false, fields: ['channel', 'botId'], guidance: '' },
      direct: { enabled: true, fields: [], guidance: 'direct only' },
    }, channel.name);
    const legacy = channel.normalize(snapshot(channel.name, [{
      groupEnabled: true, directEnabled: false, fields: ['botId'], guidance: 'legacy',
    }]));
    assert.deepEqual(legacy.bots[0].contextEnhancement, {
      group: { enabled: true, fields: ['botId'], guidance: 'legacy' },
      direct: { enabled: false, fields: ['botId'], guidance: 'legacy' },
    }, channel.name);
    const damaged = channel.normalize(snapshot(channel.name, [{ groupEnabled: 'true', fields: ['secret'] }]));
    assert.equal(damaged.bots[0].contextEnhancement.group.enabled, false, channel.name);
    assert.equal(damaged.bots[0].contextEnhancement.direct.enabled, false, channel.name);
    assert.deepEqual(raw.bots[1].contextEnhancement, empty);
  }
});

test('all nine cards save through their existing RPC path, isolate bots and preserve explicit empty on reload', async (t) => {
  mockWindow(t);
  for (const channel of channels) await t.test(channel.name, async (t) => {
    let current = snapshot(channel.name);
    const calls = [];
    const rpcCall = async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      if (endpoint === 'connection.status') return { ok: true, value: current };
      assert.equal(endpoint, 'bot.context-enhancement.set');
      current = { ...current, revision: 2, bots: current.bots.map((bot) => bot.botId === payload.botId
        ? { ...bot, contextEnhancement: payload.config } : bot) };
      return { ok: true, value: current };
    };
    const renderer = await mount(t, channel.Settings, { rpcCall });
    const first = () => renderer.root.findByProps({ 'data-bot-id': `${channel.name}_0` });
    const second = () => renderer.root.findByProps({ 'data-bot-id': `${channel.name}_1` });
    const editors = first().findAll((node) => [WorkspaceEditor, AgentPresetEditor, ContextEnhancementEditor].includes(node.type));
    assert.deepEqual(editors.map((node) => node.type), [WorkspaceEditor, AgentPresetEditor, ContextEnhancementEditor]);
    assert.equal(badge(first()), '未开启');
    await open(first());
    await act(async () => { scopeSwitch(first(), 'direct').props.onChange({ target: { checked: true } }); });
    for (const name of CONTEXT_ENHANCEMENT_FIELDS) await act(async () => {
      scope(first(), 'direct').findByProps({ name: `direct-${name}` }).props.onChange({ target: { checked: false } });
    });
    await clickScope(first(), 'direct', '清空');
    assert.deepEqual(calls.map((call) => call.endpoint), ['connection.status']);
    assert.equal(badge(first()), '未开启');
    assert.equal(badge(second()), '未开启');
    await click(first(), '保存');
    const mutations = calls.filter((call) => call.endpoint !== 'connection.status');
    assert.deepEqual(mutations, [{ endpoint: 'bot.context-enhancement.set', payload: {
      botId: `${channel.name}_0`, config: {
        group: { enabled: false, fields: ['senderId'], guidance: '' },
        direct: { enabled: true, fields: [], guidance: '' },
      },
    } }]);
    assert.equal(badge(first()), '仅私聊');
    assert.equal(badge(second()), '未开启');
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
    assert.equal(current.bots[0].workspace, '/workspace/0');
    const reloaded = await mount(t, channel.Settings, { rpcCall });
    await open(reloaded.root.findByProps({ 'data-bot-id': `${channel.name}_0` }));
    assert.equal(guidance(reloaded.root, 'direct').props.value, '');
    assert.ok(fields(reloaded.root, 'direct').every((node) => !node.props.checked));
    assert.deepEqual(fieldNames(fields(reloaded.root, 'group').filter((node) => node.props.checked)), ['senderId']);
  });
});

test('all nine settings fence stale polls and reconcile against the actual saved response', async (t) => {
  const timers = mockWindow(t);
  for (const channel of channels) await t.test(channel.name, async (t) => {
    const oldRead = deferred();
    const original = snapshot(channel.name);
    let current = original;
    let reads = 0;
    const actual = {
      group: { enabled: false, fields: ['senderId'], guidance: '' },
      direct: { enabled: true, fields: ['botId'], guidance: '' },
    };
    const rpcCall = async (endpoint) => {
      if (endpoint === 'connection.status') {
        reads += 1;
        return reads === 2 ? oldRead.promise : { ok: true, value: current };
      }
      assert.equal(endpoint, 'bot.context-enhancement.set');
      current = snapshot(channel.name, [actual, undefined]);
      return { ok: true, value: current };
    };
    const renderer = await mount(t, channel.Settings, { rpcCall });
    await act(async () => { void timers.poll(); await flush(); });
    assert.equal(reads, 2);
    const first = () => renderer.root.findByProps({ 'data-bot-id': `${channel.name}_0` });
    await open(first());
    // The server response, not an optimistic copy of this draft, is authoritative.
    await click(first(), '保存');
    assert.equal(badge(first()), '仅私聊');
    oldRead.resolve({ ok: true, value: original });
    await act(async () => { await flush(); });
    assert.equal(badge(first()), '仅私聊');
    await open(first());
    assert.deepEqual(fieldNames(fields(first(), 'direct').filter((node) => node.props.checked)), ['botId']);
    assert.equal(guidance(first(), 'direct').props.value, '');
  });
});

test('all nine settings ignore an older concurrent bot mutation after context settings are saved', async (t) => {
  mockWindow(t);
  for (const channel of channels) await t.test(channel.name, async (t) => {
    const reconnect = deferred();
    const original = snapshot(channel.name);
    let current = original;
    const rpcCall = async (endpoint, payload) => {
      if (endpoint === 'connection.status') return { ok: true, value: current };
      if (endpoint === 'bot.reconnect') return reconnect.promise;
      assert.equal(endpoint, 'bot.context-enhancement.set');
      current = snapshot(channel.name, [payload.config, undefined]);
      return { ok: true, value: current };
    };
    const renderer = await mount(t, channel.Settings, { rpcCall });
    const first = () => renderer.root.findByProps({ 'data-bot-id': `${channel.name}_0` });
    const second = renderer.root.findByProps({ 'data-bot-id': `${channel.name}_1` });
    await act(async () => { button(second, '检查连接').props.onClick(); await flush(); });
    await open(first());
    await act(async () => { scopeSwitch(first(), 'direct').props.onChange({ target: { checked: true } }); });
    await click(first(), '保存');
    assert.equal(badge(first()), '仅私聊');
    reconnect.resolve({ ok: true, value: original });
    await act(async () => { await flush(); });
    assert.equal(badge(first()), '仅私聊');
    assert.equal(first().findByProps({ className: 'dim-contextEntry' }).props.disabled, false);
  });
});

test('all nine failed save RPCs keep runtime state and drafts intact through status reconciliation', async (t) => {
  mockWindow(t);
  for (const channel of channels) await t.test(channel.name, async (t) => {
    const original = snapshot(channel.name);
    const calls = [];
    const rpcCall = async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      if (endpoint === 'connection.status') return { ok: true, value: original };
      assert.equal(endpoint, 'bot.context-enhancement.set');
      return { ok: false, error: { code: 'context-enhancement-invalid', message: 'Save rejected' } };
    };
    const renderer = await mount(t, channel.Settings, { rpcCall });
    const first = () => renderer.root.findByProps({ 'data-bot-id': `${channel.name}_0` });
    await open(first());
    await act(async () => { scopeSwitch(first(), 'direct').props.onChange({ target: { checked: true } }); });
    await clickScope(first(), 'direct', '清空');
    await click(first(), '保存');
    assert.equal(badge(first()), '未开启');
    assert.equal(scopeSwitch(first(), 'direct').props.checked, true);
    const dialog = first().findByProps({ role: 'dialog' });
    assert.equal(guidance(first(), 'direct').props.value, '');
    assert.ok(textOf(dialog.findByProps({ role: 'alert' })));
    assert.equal(original.bots[0].contextEnhancement, undefined);
    assert.equal(calls.filter((call) => call.endpoint !== 'connection.status').length, 1);
    await click(first(), '取消');
    await open(first());
    assert.equal(scopeSwitch(first(), 'direct').props.checked, false);
    assert.equal(guidance(first(), 'direct').props.value, '');
  });
});

test('the approved neutral entry and theme-aware modal keep responsive labels and touch targets', async () => {
  const styles = await readFile(new URL('../plugin-src/client/styles.js', import.meta.url), 'utf8');
  assert.match(styles, /\.dim-contextEntry \{[^}]*min-height: 40px;[^}]*minmax\(0, 1fr\)[^}]*border-radius: 8px;[^}]*font-size: 13px;/);
  assert.match(styles, /\.dim-contextStatus\[data-active="true"\] \{[^}]*--dsw-alias-state-business-primary/);
  assert.match(styles, /\.dim-contextDialog \{[^}]*width: min\(450px, 100%\);[^}]*overflow-y: auto;[^}]*border-radius: 12px;[^}]*--dsw-alias-bg-layer-3/);
  assert.match(styles, /\.dim-contextTabs \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*border-radius: 8px;/);
  assert.match(styles, /\.dim-contextTab\[aria-selected="true"\] \{[^}]*--dsw-alias-state-business-primary[^}]*box-shadow:/);
  assert.match(styles, /\.dim-contextTabPanel\[hidden\] \{[^}]*display: none;/);
  assert.match(styles, /\.dim-contextFields \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.dim-contextGuidance textarea \{[^}]*min-height: 88px;/);
  assert.match(styles, /\.dim-contextGuidance textarea::placeholder \{[^}]*--dsw-alias-label-tertiary[^}]*opacity: 1;/);
  assert.match(styles, /\.dim-contextFieldKey \{[^}]*ui-monospace/);
  assert.match(styles, /\.dim-contextFieldText \{[^}]*grid-template-columns: max-content max-content;[^}]*column-gap: 5px;/);
  assert.match(styles, /\.dim-contextField \{[^}]*position: relative;/);
  assert.match(styles, /\.dim-contextFieldHelp \{[^}]*position: static;/);
  assert.match(styles, /\.dim-contextTooltip\.dim-contextFieldTooltip \{[^}]*right: 0;[^}]*left: auto;/);
  assert.match(styles, /\.dim-contextField:nth-child\(odd\) \.dim-contextFieldTooltip \{[^}]*right: auto;[^}]*left: 0;/);
  assert.match(styles, /@media \(pointer: coarse\) \{\s*\.dim-contextEntry[^}]*min-height: 44px;/);
  assert.match(styles, /\.dim-contextLabel \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.dim-contextTooltip \{[^}]*opacity: 0;[^}]*visibility: hidden;/);
  assert.match(styles, /\.dim-contextTooltip\.dim-contextGuidanceTooltip \{[^}]*bottom: calc\(100% \+ 7px\);[^}]*overflow-y: auto;/);
  assert.match(styles, /\.dim-contextHeader \{[^}]*position: relative;/);
  assert.match(styles, /\.dim-contextLegend \{[^}]*position: relative;[^}]*inline-flex/);
  assert.match(styles, /\.dim-contextHelp:hover \.dim-contextTooltip, \.dim-contextHelp:focus-within \.dim-contextTooltip \{[^}]*opacity: 1;[^}]*visibility: visible;/);
  const office = await readFile(new URL('../plugin-src/client/channels/office/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(office, /ContextEnhancement|context-enhancement/);
});
