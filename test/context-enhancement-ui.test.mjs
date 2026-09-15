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
import { en, localizeText, setImTranslator } from '../plugin-src/client/i18n.js';

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

/** The shared "?" whose accessible name is `label`, and the panel it opens. */
function helpTip(root, label) {
  const tips = root.findAll((node) => node.props?.['aria-label'] === label);
  assert.equal(tips.length, 1, `exactly one help trigger: ${label}`);
  const [tip] = tips;
  assert.equal(tip.type, 'button');
  assert.equal(tip.props.className, 'dim-helpButton');
  // The id alone also matches the HelpTip element itself, so ask for the host
  // element that actually carries the tooltip role.
  const panel = root.findByProps({ id: tip.props['aria-describedby'], role: 'tooltip' });
  assert.ok(panel.props.className.split(/\s+/).includes('dim-helpPanel'), `${label}: the shared panel`);
  return { tip, panel };
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

async function clickScope(root, kind, label) {
  await act(async () => { button(scope(root, kind), label).props.onClick(); await flush(); });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/* The region saves a settled edit after a short pause of its own. These two ticks
   straddle that pause without ever waiting on the wall clock: the component schedules on
   globalThis, and that timer is mocked for the whole test. */
const PAUSE_UNSETTLED = 100;
const PAUSE_SETTLED = 1_000;
/* Longer than the two seconds the "saved" note lingers. */
const SAVED_NOTE_LINGER = 2_500;

function fakeTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return {
    /** Move component time forward by `ms` and let every promise it settles run. */
    async advance(ms) {
      await act(async () => {
        t.mock.timers.tick(ms);
        await flush();
      });
    },
  };
}

function footerText(root) {
  return textOf(root.findByProps({ className: 'dim-contextFooter' }));
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
  // A disclosure, not a dialog trigger: it points at the region it expands.
  assert.equal(entry.props['aria-expanded'], false);
  assert.equal(entry.props['aria-haspopup'], undefined, 'an inline disclosure does not claim a dialog');
  await open(renderer.root);
  // The dialog's description is the shared "?" panel again. The region points at
  // it and so does the button that opens it, so the relationship survives without
  // a stacked paragraph and neither reference is left dangling.
  const dialogDescriptionId = renderer.root.findByProps({ className: 'dim-contextPanel' }).props['aria-describedby'];
  assert.ok(dialogDescriptionId, 'the dialog keeps an accessible description');
  const dialogHelp = helpTip(renderer.root, '查看上下文增强说明');
  assert.equal(dialogHelp.panel.props.id, dialogDescriptionId, 'the dialog points at the "?" panel');
  assert.match(textOf(dialogHelp.panel), /选择在哪些会话中启用.*不查询平台 API/);
  // It hangs off the strip that names the scope, after the tabs. Compared by
  // props, never by instance identity: a failing identity assert would try to
  // print two fiber graphs and take the whole run down with it.
  const stripRow = renderer.root.findByProps({ className: 'dim-contextTabsRow' });
  const stripTip = stripRow.children.at(-1);
  assert.equal(stripTip.props.id, dialogDescriptionId, 'the "?" hangs off the tab strip, after the tabs');
  assert.equal(stripTip.props.label, '查看上下文增强说明');
  // The button sits BESIDE the strip, never inside it: a tablist's only permitted
  // children are tabs, so a stray button there would break the role for a screen reader.
  const scopeStrip = renderer.root.findByProps({ 'aria-label': '上下文增强范围' });
  assert.equal(scopeStrip.children.length, 2, 'the tablist owns exactly its two tabs');
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
  // Each switch names its own scope, so the row states what it writes rather than relying on
  // the reader to connect it to the highlighted tab above.
  assert.deepEqual(renderer.root.findAllByProps({ className: 'dim-contextSwitchRow' }).map(textOf), ['启用私聊', '启用群聊']);
  assert.deepEqual(
    renderer.root.findAllByProps({ className: 'dim-contextSwitchScope' }).map(textOf),
    ['私聊', '群聊'],
    'the scope tag carries the same localised name as the tab',
  );
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
  // The fields convention is the shared "?" now: the section legend carries the
  // rule that covers every field, and the three fields with a caveat of their own
  // carry theirs. Both are read on hover or focus instead of being stacked under
  // the control they explain. One legend per scope panel, so there are two.
  const legendHelp = helpTip(renderer.root, '查看群聊来源字段说明');
  assert.match(
    textOf(legendHelp.panel),
    /增强提示词中请使用字段名（如 senderId、conversationType）.*不会额外查询或补全/,
  );
  assert.match(
    textOf(legendHelp.panel),
    /某字段在当前渠道或当前消息中不存在时，即使已勾选，<dsh_im_source> 中也会省略/,
  );
  // The "?" hangs off the legend title, to its right.
  const legendRow = scope(renderer.root, 'group').findByProps({ className: 'dim-contextLegend' }).children[0];
  assert.equal(legendRow.props.className, 'dim-helpRow', 'the legend title and its "?" share one row');
  assert.equal(textOf(legendRow.children[0]), '来源字段');
  assert.equal(legendRow.children.at(-1).props.id, legendHelp.panel.props.id, 'the row ends in the tip');
  assert.equal(
    textOf(helpTip(renderer.root, '查看私聊来源字段说明').panel),
    textOf(legendHelp.panel),
    'each scope states the same legend copy once',
  );
  assert.equal(guidance(renderer.root, 'group').props.value, '');
  assert.equal(guidance(renderer.root, 'direct').props.value, '');
  assert.equal(guidance(renderer.root, 'group').props.placeholder, CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  assert.equal(guidance(renderer.root, 'direct').props.placeholder, CONTEXT_DIRECT_GUIDANCE_EXAMPLE);
  const guidanceHelp = helpTip(renderer.root, '查看群聊增强提示词使用说明');
  assert.equal(guidanceHelp.panel.props.className, 'dim-helpPanel dim-helpPanelTop',
    'the guidance panel still opens upward');
  assert.match(textOf(guidanceHelp.panel), /使用说明.*dsh_im_source.*生效规则.*清空并保存.*隐私提示.*会话历史.*使用示例.*群聊/s);
  assert.equal(textOf(guidanceHelp.panel.findByProps({ className: 'dim-helpExample' })), CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  assert.equal(guidance(renderer.root, 'group').props['aria-describedby'], guidanceHelp.panel.props.id);
  assert.equal(renderer.root.findAllByType('p').some((node) => /只需填写正文|发送者标识可能包含/.test(textOf(node))), false);
  // Every field used to open its caveat with the same sentence and close it with
  // the same sentence, differing only in the middle. That shared half is stated
  // once, on the section legend above the fields, so each field carries only the
  // clause that is actually about that field - now inside that field's own panel.
  const caveats = [];
  for (const [kind, scopeName] of [['group', '群聊'], ['direct', '私聊']]) {
    for (const [field, name, text] of [
      ['conversationTitle', '会话标题', '钉钉群聊会带上群名。'],
      ['chatId', '会话标识', '用于区分不同的群组或私聊；飞书群聊会带上群 ID。'],
      ['threadId', '话题标识', '飞书话题群的消息会带上话题 ID，用于区分同一群组内的不同话题。'],
    ]) {
      const label = `查看${scopeName}${name}字段说明`;
      const fieldHelp = helpTip(renderer.root, label);
      assert.equal(textOf(fieldHelp.panel), text, `${kind}/${field}: the caveat moved verbatim`);
      const row = scope(renderer.root, kind).findAllByProps({ className: 'dim-helpRow' })
        .find((node) => node.children.at(-1).props?.label === label);
      assert.ok(row, `${kind}/${field}: the "?" shares the field name's row`);
      const nameLabel = row.children[0];
      assert.equal(nameLabel.props.className, 'dim-contextFieldName', `${kind}/${field}: the row starts with the field name`);
      assert.ok(nameLabel.props.htmlFor.endsWith(`-field-${field}`), `${kind}/${field}: the name keeps its control`);
      caveats.push(text);
    }
  }
  assert.equal(caveats.length, 6, 'three fields carry a caveat, and there are two scopes');
  assert.deepEqual([...new Set(caveats)].sort(), [
    '钉钉群聊会带上群名。',
    '用于区分不同的群组或私聊；飞书群聊会带上群 ID。',
    '飞书话题群的消息会带上话题 ID，用于区分同一群组内的不同话题。',
  ].sort());
  assert.ok(
    caveats.every((text) => !/不是每个渠道都能提供/.test(text)),
    'the shared sentence is no longer repeated under every field',
  );
  assert.equal(
    renderer.root.findAll((node) => node.props?.className === 'dim-helpButton'
      && String(node.props['aria-describedby']).includes('-field-')).length,
    6,
    'only the fields with a caveat of their own carry a "?"',
  );
  assert.deepEqual(saved, []);
});

test('the footer is a status line with no buttons, and states saving, saved and idle', async (t) => {
  const timers = fakeTimers(t);
  const gate = deferred();
  const renderer = await mount(t, ContextEnhancementEditor, {
    config: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
    onSave: () => gate.promise,
  });
  await open(renderer.root);
  const footer = () => renderer.root.findByProps({ className: 'dim-contextFooter' });
  assert.equal(footer().props.role, 'status', 'the one thing a form without Save owes the reader');
  assert.equal(footer().findAllByType('button').length, 0, 'nothing to confirm and nothing to cancel');
  assert.equal(footerText(renderer.root), '更改会自动保存');
  // The pair is gone from the region, not merely moved out of the footer.
  assert.deepEqual(
    renderer.root.findAllByType('button').filter((node) => ['保存', '取消'].includes(textOf(node))).map(textOf),
    [],
  );
  await act(async () => { scopeSwitch(renderer.root, 'direct').props.onChange({ target: { checked: true } }); });
  await timers.advance(PAUSE_SETTLED);
  assert.equal(footerText(renderer.root), '保存中…', 'a save in flight says so');
  assert.equal(footer().props.role, 'status', 'and the live region survives the state change');
  gate.resolve();
  await act(async () => { await flush(); });
  assert.equal(footerText(renderer.root), '已保存');
  await timers.advance(SAVED_NOTE_LINGER);
  assert.equal(footerText(renderer.root), '更改会自动保存', 'and it returns to the standing rule');
});

test('every edit saves itself after a short pause, and closing flushes a pause still pending', async (t) => {
  const timers = fakeTimers(t);
  const calls = [];
  function Fixture() {
    const [config, setConfig] = React.useState(undefined);
    return React.createElement(ContextEnhancementEditor, {
      config,
      onSave(value) { calls.push(value); setConfig(value); },
    });
  }
  const renderer = await mount(t, Fixture);
  await open(renderer.root);
  // Four independent edits inside one pause. They reach the controls immediately and
  // collapse into a single save - a save per keystroke is what the pause exists to stop.
  await act(async () => {
    scopeSwitch(renderer.root, 'group').props.onChange({ target: { checked: true } });
    scopeSwitch(renderer.root, 'direct').props.onChange({ target: { checked: true } });
    scopeSwitch(renderer.root, 'group').props.onChange({ target: { checked: false } });
  });
  // A field edit mutates the selection its own render captured, so it gets its own commit.
  await act(async () => {
    scope(renderer.root, 'group').findByProps({ name: 'group-senderId' }).props.onChange({ target: { checked: false } });
  });
  assert.deepEqual(switchStates(renderer.root), [false, true]);
  assert.equal(guidance(renderer.root, 'group').props.value, '');
  await timers.advance(PAUSE_UNSETTLED);
  assert.deepEqual(calls, [], 'an edit is deferred, not submitted on the keystroke');
  await timers.advance(PAUSE_SETTLED);
  assert.equal(calls.length, 1, 'four edits inside one pause are one save');
  assert.deepEqual(calls[0], {
    group: { enabled: false, fields: [], guidance: '' },
    direct: { enabled: true, fields: ['senderId'], guidance: '' },
  });
  assert.equal(renderer.root.findAllByProps({ className: 'dim-contextPanel' }).length, 1,
    'an auto-saving region stays open: there is no confirm step to dismiss it');

  // Both closes that remain - the trigger and Escape - discard nothing now. What they owe
  // the reader is that an edit still inside the pause is flushed before the region goes.
  for (const close of ['toggle', 'escape']) {
    const typed = close + ' kept';
    const before = calls.length;
    await act(async () => {
      guidance(renderer.root, 'direct').props.onChange({ target: { value: typed } });
    });
    assert.equal(calls.length, before, close + ': still inside the pause');
    await act(async () => {
      if (close === 'toggle') renderer.root.findByProps({ className: 'dim-contextEntry' }).props.onClick();
      else renderer.root.findByProps({ className: 'dim-contextPanel' }).props.onKeyDown({
        key: 'Escape', preventDefault() {}, stopPropagation() {},
      });
      await flush();
    });
    assert.equal(renderer.root.findAllByProps({ className: 'dim-contextPanel' }).length, 0,
      close + ': collapses the region');
    assert.equal(calls.length, before + 1, close + ': the pending edit is flushed, not dropped');
    assert.equal(calls.at(-1).direct.guidance, typed, close + ': the last edit is what lands');
    await open(renderer.root);
    assert.equal(guidance(renderer.root, 'direct').props.value, typed, close + ': what a reopened region shows');
    assert.deepEqual(switchStates(renderer.root), [false, true], close + ': the flushed config is complete');
    await timers.advance(SAVED_NOTE_LINGER);
  }
});

test('a change submits one complete config, preserves explicit empty fields/guidance, and the example alone changes guidance', async (t) => {
  const timers = fakeTimers(t);
  const calls = [];
  function Fixture() {
    const [config, setConfig] = React.useState(undefined);
    return React.createElement(ContextEnhancementEditor, {
      config,
      onSave(value) { calls.push(value); setConfig(value); },
    });
  }
  const renderer = await mount(t, Fixture);
  await open(renderer.root);
  await act(async () => { scopeSwitch(renderer.root, 'group').props.onChange({ target: { checked: true } }); });
  // Read each freshly rendered checkbox so every independent edit uses the current draft.
  for (const name of CONTEXT_ENHANCEMENT_FIELDS) {
    await act(async () => {
      scope(renderer.root, 'group').findByProps({ name: 'group-' + name }).props.onChange({ target: { checked: false } });
    });
  }
  await clickScope(renderer.root, 'group', '清空');
  await timers.advance(PAUSE_SETTLED);
  // One settled editing session is one save, and it carries the whole config: the empty
  // field set and the empty guidance are explicit choices, not omissions.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    group: { enabled: true, fields: [], guidance: '' },
    direct: { enabled: false, fields: ['senderId'], guidance: '' },
  });
  const explicitlyEmpty = JSON.parse(JSON.stringify(calls[0]));
  assert.equal(renderer.root.findAllByProps({ className: 'dim-contextPanel' }).length, 1);
  assert.equal(badge(renderer.root), '仅群聊');
  assert.ok(fields(renderer.root, 'group').every((node) => !node.props.checked));
  assert.deepEqual(fieldNames(fields(renderer.root, 'direct').filter((node) => node.props.checked)), ['senderId']);
  assert.equal(guidance(renderer.root, 'group').props.value, '');
  assert.equal(guidance(renderer.root, 'group').props.placeholder, CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  await clickScope(renderer.root, 'group', '填入示例');
  assert.equal(guidance(renderer.root, 'group').props.value, CONTEXT_GROUP_GUIDANCE_EXAMPLE);
  assert.equal(guidance(renderer.root, 'direct').props.value, '');
  assert.ok(fields(renderer.root, 'group').every((node) => !node.props.checked));
  assert.deepEqual(switchStates(renderer.root), [true, false]);
  await timers.advance(PAUSE_SETTLED);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    group: { enabled: true, fields: [], guidance: CONTEXT_GROUP_GUIDANCE_EXAMPLE },
    direct: { enabled: false, fields: ['senderId'], guidance: '' },
  }, 'filling the example writes guidance and nothing else');
  const reloaded = await mount(t, ContextEnhancementEditor, { config: explicitlyEmpty });
  await open(reloaded.root);
  assert.equal(guidance(reloaded.root, 'group').props.value, '');
  assert.equal(guidance(reloaded.root, 'direct').props.value, '');
  assert.ok(fields(reloaded.root, 'group').every((node) => !node.props.checked));
  assert.deepEqual(fieldNames(fields(reloaded.root, 'direct').filter((node) => node.props.checked)), ['senderId']);
});

test('one save is in flight at a time, and edits made during it are queued rather than dropped', async (t) => {
  const timers = fakeTimers(t);
  const gates = [];
  const calls = [];
  const editorProps = {
    config: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
    onSave(value) {
      calls.push(value);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  };
  const renderer = await mount(t, ContextEnhancementEditor, editorProps);
  await open(renderer.root);
  await act(async () => {
    scopeSwitch(renderer.root, 'direct').props.onChange({ target: { checked: true } });
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'first' } });
  });
  await timers.advance(PAUSE_SETTLED);
  assert.equal(calls.length, 1);
  assert.equal(renderer.root.findByProps({ className: 'dim-contextPanel' }).props['aria-busy'], true);
  // The deliberate decision this round: a save in flight does NOT lock the controls. A save
  // now starts after almost every pause, and disabling the box being typed in would take
  // the caret away mid-sentence. Serialising the writes is the part that needs a guard.
  assert.ok(renderer.root.findAllByType('input').every((node) => !node.props.disabled),
    'a save in flight leaves the inputs alone');
  assert.equal(guidance(renderer.root, 'direct').props.disabled, false, 'nor the box being typed in');
  assert.ok(renderer.root.findAllByType('button').every((node) => !node.props.disabled),
    'nor the buttons');
  // ...and it stays unlocked when the CARD marks itself busy for that very same RPC. That is
  // the flag that actually flips in the app, and taking it at face value is what dimmed the
  // whole region to 40% and left the guidance box unable to accept a keystroke.
  await act(async () => {
    renderer.update(React.createElement(ContextEnhancementEditor, { ...editorProps, disabled: true }));
  });
  assert.equal(guidance(renderer.root, 'direct').props.disabled, false,
    'the card being busy for our own save does not lock the box');
  assert.ok(renderer.root.findAllByType('input').every((node) => !node.props.disabled));
  await act(async () => {
    renderer.update(React.createElement(ContextEnhancementEditor, editorProps));
  });
  // Two more edits while that save is in flight. When their pause elapses the writer is
  // busy, so it queues instead of dropping the edit or submitting the same config twice.
  await act(async () => {
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'second' } });
  });
  await timers.advance(PAUSE_SETTLED);
  assert.equal(calls.length, 1, 'a save already in flight is not submitted twice');
  await act(async () => {
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'last' } });
  });
  await timers.advance(PAUSE_SETTLED);
  assert.equal(calls.length, 1, 'and the queued one waits for the writer to be free');
  gates[0].resolve();
  await act(async () => { await flush(); });
  assert.equal(calls.length, 2, 'the queued save follows the one in flight');
  assert.equal(calls[1].direct.guidance, 'last', 'what lands is the last state, not the queued snapshot');
  assert.equal(calls[1].direct.enabled, true);
  gates[1].resolve();
  await act(async () => { await flush(); });
  assert.equal(renderer.root.findByProps({ className: 'dim-contextPanel' }).props['aria-busy'], false);
  await timers.advance(SAVED_NOTE_LINGER);
});

test('a failed save surfaces the error and keeps the draft, and the next change retries it', async (t) => {
  const timers = fakeTimers(t);
  const calls = [];
  const delivered = [];
  const renderer = await mount(t, ContextEnhancementEditor, {
    config: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
    onSave(value) {
      calls.push(value);
      if (calls.length === 1) return Promise.reject(new Error('Save rejected'));
      delivered.push(value);
    },
  });
  await open(renderer.root);
  await act(async () => {
    scopeSwitch(renderer.root, 'direct').props.onChange({ target: { checked: true } });
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'local draft' } });
  });
  await timers.advance(PAUSE_SETTLED);
  assert.equal(calls.length, 1);
  assert.equal(textOf(renderer.root.findByProps({ role: 'alert' })), 'Save rejected');
  // The draft is only the working copy the controls render from, so a rejected save does
  // not roll it back - and with no Save button to press again, the next change retries.
  assert.equal(guidance(renderer.root, 'direct').props.value, 'local draft');
  assert.deepEqual(switchStates(renderer.root), [false, true]);
  assert.equal(badge(renderer.root), '未开启');
  assert.deepEqual(delivered, []);
  await act(async () => {
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'retry' } });
  });
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0, 'the next edit clears the error');
  await timers.advance(PAUSE_SETTLED);
  assert.equal(calls.length, 2, 'and submits again');
  assert.deepEqual(delivered, [{
    group: { enabled: false, fields: ['senderId'], guidance: '' },
    direct: { enabled: true, fields: ['senderId'], guidance: 'retry' },
  }]);
});

test('Weixin displays and saves only its supported direct scope', async (t) => {
  const timers = fakeTimers(t);
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
  await timers.advance(PAUSE_SETTLED);
  assert.equal(saved.length, 1, 'the unsupported scope is stripped from the one config that lands');
  assert.equal(saved[0].group.enabled, false);
  assert.deepEqual(saved[0].group.fields, ['botId']);
  assert.equal(saved[0].group.guidance, 'preserve group');
  assert.equal(saved[0].direct.enabled, true);
});

test('an inline panel cancels with Escape, keeps focus flowing, and restores entry focus', async (t) => {
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
      if (element.props.className === 'dim-contextPanel') return dialog;
      return {};
    },
  });
  await open(renderer.root);
  assert.equal(document.activeElement, dialog);
  const keydown = (shiftKey) => {
    let prevented = false;
    renderer.root.findByProps({ className: 'dim-contextPanel' }).props.onKeyDown({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
    // NOT trapped. The trap only existed because the dialog covered the page; inline the
    // panel is part of the page and Tab should flow through it like anywhere else.
    assert.equal(prevented, false);
  };
  // Tab is never intercepted. The panel is part of the page, so the browser moves focus
  // on its own and the component must not move it. Three presses, no movement by us.
  keydown(false);
  assert.equal(document.activeElement, dialog, 'Tab is not intercepted');
  keydown(true);
  assert.equal(document.activeElement, dialog, 'Shift+Tab is not intercepted either');
  keydown(false);
  assert.equal(document.activeElement, dialog);
  // And there is no focusin guard: an inline panel must not pull focus back when the
  // user moves on. The listener that used to do it is not installed at all.
  assert.equal(listeners.has('focusin'), false);
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-contextPanel' }).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    await flush();
  });
  assert.equal(document.activeElement, entry, 'closing returns focus to the trigger');
});

test('all context dialog copy and validation errors localize without translating the saved body', async (t) => {
  const timers = fakeTimers(t);
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const saved = [];
  const renderer = await mount(t, ContextEnhancementEditor, { groupSupported: false, onSave: (value) => saved.push(value) });
  assert.equal(badge(renderer.root), 'Not enabled');
  await open(renderer.root);
  // Nothing the region renders is still Chinese, status line included.
  assert.doesNotMatch(textOf(renderer.root), /[\p{Script=Han}]/u);
  // And the status line gets there the same way every other string does: through the
  // shared localizer, so it is pinned to the localizer's answer, not to a literal.
  assert.equal(footerText(renderer.root), localizeText('更改会自动保存'));
  assert.equal(footerText(renderer.root), 'Changes save automatically');
  assert.equal(guidance(renderer.root, 'direct').props.value, '');
  assert.equal(guidance(renderer.root, 'direct').props.placeholder, en[CONTEXT_DIRECT_GUIDANCE_EXAMPLE]);
  assert.equal(guidance(renderer.root, 'direct').props.maxLength, CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH);
  const localizedExample = textOf(scope(renderer.root, 'direct').findByProps({ className: 'dim-helpExample' }));
  assert.equal(localizedExample, en[CONTEXT_DIRECT_GUIDANCE_EXAMPLE]);
  await clickScope(renderer.root, 'direct', 'Use example');
  assert.equal(guidance(renderer.root, 'direct').props.value, localizedExample);
  await timers.advance(PAUSE_SETTLED);
  assert.deepEqual(saved.at(-1).direct.guidance, localizedExample,
    'the localised body is saved verbatim, not re-translated');
  await clickScope(renderer.root, 'direct', 'Clear');
  await timers.advance(PAUSE_SETTLED);
  assert.equal(guidance(renderer.root, 'direct').props.value, '');
  assert.equal(saved.at(-1).direct.guidance, '');
  const accepted = saved.length;
  await act(async () => {
    guidance(renderer.root, 'direct').props.onChange({ target: { value: 'x'.repeat(CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH + 1) } });
  });
  await timers.advance(PAUSE_SETTLED);
  assert.match(textOf(renderer.root.findByProps({ role: 'alert' })), /Guidance must not exceed 8000 characters/);
  assert.equal(saved.length, accepted, 'an invalid draft never reaches the server');
  assert.equal(guidance(renderer.root, 'direct').props.value.length, CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH + 1,
    'and the rejected draft is still the working copy');
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
    const timers = fakeTimers(t);
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
    assert.deepEqual(calls.map((call) => call.endpoint), ['connection.status'],
      'nothing is written while the edit is still inside the pause');
    assert.equal(badge(first()), '未开启');
    assert.equal(badge(second()), '未开启');
    await timers.advance(PAUSE_SETTLED);
    const mutations = calls.filter((call) => call.endpoint !== 'connection.status');
    assert.deepEqual(mutations, [{ endpoint: 'bot.context-enhancement.set', payload: {
      botId: `${channel.name}_0`, config: {
        group: { enabled: false, fields: ['senderId'], guidance: '' },
        direct: { enabled: true, fields: [], guidance: '' },
      },
    } }]);
    assert.equal(badge(first()), '仅私聊');
    assert.equal(badge(second()), '未开启');
    assert.equal(renderer.root.findAllByProps({ className: 'dim-contextPanel' }).length, 1,
      'an auto-saving region stays open: there is no confirm step to dismiss it');
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
    const debounce = fakeTimers(t);
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
    await act(async () => { scopeSwitch(first(), 'direct').props.onChange({ target: { checked: true } }); });
    // The server response, not an optimistic copy of this draft, is authoritative.
    await debounce.advance(PAUSE_SETTLED);
    assert.equal(badge(first()), '仅私聊');
    oldRead.resolve({ ok: true, value: original });
    await act(async () => { await flush(); });
    assert.equal(badge(first()), '仅私聊');
    // A region built afresh reads the reconciled config, not the draft a stale poll would
    // have restored. Closing it here flushes nothing: the pause already elapsed.
    await act(async () => {
      first().findByProps({ className: 'dim-contextEntry' }).props.onClick();
      await flush();
    });
    assert.equal(renderer.root.findAllByProps({ className: 'dim-contextPanel' }).length, 0);
    await open(first());
    assert.deepEqual(fieldNames(fields(first(), 'direct').filter((node) => node.props.checked)), ['botId']);
    assert.equal(guidance(first(), 'direct').props.value, '');
  });
});

test('all nine settings ignore an older concurrent bot mutation after context settings are saved', async (t) => {
  mockWindow(t);
  for (const channel of channels) await t.test(channel.name, async (t) => {
    const reconnect = deferred();
    const timers = fakeTimers(t);
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
    await timers.advance(PAUSE_SETTLED);
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
    const timers = fakeTimers(t);
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
    await timers.advance(PAUSE_SETTLED);
    assert.equal(badge(first()), '未开启');
    assert.equal(scopeSwitch(first(), 'direct').props.checked, true);
    const dialog = first().findByProps({ className: 'dim-contextPanel' });
    assert.equal(guidance(first(), 'direct').props.value, '');
    assert.ok(textOf(dialog.findByProps({ role: 'alert' })));
    assert.equal(original.bots[0].contextEnhancement, undefined);
    assert.equal(calls.filter((call) => call.endpoint !== 'connection.status').length, 1);
    // There is no Cancel any more, so a close no longer throws the rejected draft away
    // either. What it does owe the reader is that it does not submit that config again.
    await act(async () => {
      first().findByProps({ className: 'dim-contextEntry' }).props.onClick();
      await flush();
    });
    assert.equal(renderer.root.findAllByProps({ className: 'dim-contextPanel' }).length, 0);
    assert.equal(calls.filter((call) => call.endpoint !== 'connection.status').length, 1,
      'closing after a rejected save does not submit it again');
    // A fresh card reads the persisted setting, which the rejected save never changed.
    const reloaded = await mount(t, channel.Settings, { rpcCall });
    await act(async () => {
      reloaded.root.findAllByProps({ className: 'dim-contextEntry' })[0].props.onClick();
      await flush();
    });
    assert.equal(scopeSwitch(reloaded.root, 'direct').props.checked, false);
    assert.equal(guidance(reloaded.root, 'direct').props.value, '');
  });
});

test('the approved neutral entry and its inline region keep responsive labels and touch targets', async () => {
  const styles = await readFile(new URL('../plugin-src/client/styles.js', import.meta.url), 'utf8');
  // The entry is a native row now: no border, no radius, no fill.
  assert.match(styles, /\.dim-contextEntry \{[^}]*min-height: 40px;[^}]*minmax\(0, 1fr\)[^}]*padding: 14px 0;[^}]*border: 0;[^}]*background: none;[^}]*font-size: var\(--dim-font-14\);/);
  // Native Pill active tone.
  assert.match(styles, /\.dim-contextStatus\[data-active="true"\] \{[^}]*--dsw-alias-button-ghost-active-fill/);
  // Inline region, not a modal surface: no fixed size, no elevation, and no rule of its
  // own either - the spacing and the tab strip's underline are what separate it.
  assert.match(styles, /\.dim-contextPanel \{[^}]*width: 100%;[^}]*min-width: 0;[^}]*margin-top: 12px;[^}]*padding: 0;/);
  assert.doesNotMatch(styles, /\.dim-contextPanel \{[^}]*border-top/,
    'the expansion no longer draws a hairline of its own');
  assert.doesNotMatch(styles, /dim-contextBackdrop|dim-contextDialog/, 'the overlay and its dialog are gone, not restyled');
  // Native tablist strip, not a bespoke segmented control - and now literally the
  // host's own tablist (settings-plugins bundle:377 .tabs/.tab), shared by all three of
  // the plugin's strips - Context enhancement, the General page, and the bot card's
  // More bot settings - so one edit moves every tab strip in the plugin.
  assert.match(styles, /\.dim-contextTabs, \.dim-generalSettingsTabs, \.dim-botSettingsTabs \{[^}]*display: flex;[^}]*align-items: flex-end;[^}]*border-bottom: 0\.5px solid var\(--dsw-alias-border-l2/);
  assert.match(styles, /\.dim-contextTab, \.dim-generalSettingsTab, \.dim-botSettingsTab \{[^}]*padding: 7px 1px 9px;[^}]*color: var\(--dsw-alias-label-tertiary,[^}]*font-size: var\(--dim-font-13\);/);
  assert.match(styles, /\.dim-contextTab\[aria-selected="true"\], \.dim-generalSettingsTab\[aria-selected="true"\], \.dim-botSettingsTab\[aria-selected="true"\] \{[^}]*--dsw-alias-label-primary/);
  assert.match(styles, /\.dim-contextTab\[aria-selected="true"\]::after, \.dim-generalSettingsTab\[aria-selected="true"\]::after, \.dim-botSettingsTab\[aria-selected="true"\]::after \{[^}]*background: var\(--dsw-alias-label-primary/);
  // The host has no scale animation on its bar, so neither strip carries one.
  assert.doesNotMatch(styles, /scaleX\(\.45\)/);
  // The footer is not a form action row any more: with nothing to confirm and nothing to
  // cancel it is a status line, so the button skin it used to carry left with the pair.
  assert.match(styles, /\.dim-contextFooter \{[^}]*min-height: 18px;[^}]*margin-top: 12px;[^}]*color: var\(--dsw-alias-label-tertiary/);
  assert.doesNotMatch(styles, /\.dim-contextFooter button|dim-contextSave/,
    'the confirm/cancel pair is deleted, not restyled');
  assert.match(styles, /\.dim-contextGuidance textarea \{[^}]*padding: 8px 10px;/);
  assert.match(styles, /\.dim-diagnosticTextarea \{[^}]*padding: 8px 10px;/);
  assert.match(styles, /\.dim-contextTabPanel\[hidden\] \{[^}]*display: none;/);
  assert.match(styles, /\.dim-contextFields \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(160px, 1fr\)\);[^}]*gap: var\(--dim-gap-8\);/);
  assert.match(styles, /\.dim-contextGuidance textarea \{[^}]*min-height: 88px;/);
  assert.match(styles, /\.dim-contextGuidance textarea::placeholder \{[^}]*--dsw-alias-label-caption[^}]*opacity: 1;/);
  // The code family now has one address; the literal stack it replaced is gone.
  assert.match(styles, /\.dim-contextFieldKey \{[^}]*var\(--dim-font-mono/);
  // The second track must not be sized by its content: the mono key is a full-width
  // row, and a max-content track made the grid overflow the dialog.
  // One track: the key spans 1 / -1, so a second track stayed empty.
  assert.match(styles, /\.dim-contextFieldText \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  // The key row is the one that spans the single track now: the caveat that used to
  // share that rule lives in the field's own "?" panel.
  assert.match(styles, /\.dim-contextFieldKey \{[^}]*grid-column: 1 \/ -1;/);
  assert.match(styles, /\.dim-contextField \{[^}]*position: relative;/);
  assert.match(styles, /@media \(pointer: coarse\) \{\s*\.dim-contextEntry[^}]*min-height: 44px;/);
  assert.match(styles, /\.dim-contextLabel \{[^}]*overflow-wrap: anywhere;/);
  // Same two semantics, one shared author: the panel is hidden until its own button
  // is hovered or focused, and the guidance editor's panel still opens upward.
  assert.match(styles, /\.dim-helpPanel \{[^}]*opacity: 0;[^}]*visibility: hidden;/);
  // Placement is measured in the component now (the panel is fixed and portaled), so the
  // upward variant keeps only its own shape: wider, and scrollable.
  assert.match(styles, /\.dim-helpPanelTop \{[^}]*width: min\(380px,[^}]*overflow-y: auto;/);
  assert.match(styles, /\.dim-helpPanel \{[^}]*position: fixed;/);
  // One title per disclosure: the trigger names it, the opened region does not repeat it.
  assert.doesNotMatch(styles, /dim-contextHeader|dim-contextClose/);
  assert.match(styles, /\.dim-contextLegend \{[^}]*position: relative;[^}]*display: grid/);
  assert.match(styles, /\.dim-helpPanel\[data-open="true"\] \{[^}]*opacity: 1;[^}]*visibility: visible;/);
  // The help row no longer needs to be a positioned anchor: the panel is fixed and is
  // measured against its own button, so a position: relative here would be a leftover.
  assert.doesNotMatch(styles, /\.dim-helpRow \{[^}]*position: relative;/);
  const office = await readFile(new URL('../plugin-src/client/channels/office/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(office, /ContextEnhancement|context-enhancement/);
});
