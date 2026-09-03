import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cardActionProbeCard,
  completionCard,
  customSteerCard,
  helpCard,
  menuCard,
  menuHelpText,
  modelCard,
  presetCard,
  sessionListCard,
  statusCard,
  steerCard,
  watchListCard,
  workspaceListCard,
} from '../../../src/channels/feishu/feishu-cards.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';

function buttons(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) buttons(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (value.tag === 'button') result.push(value);
  for (const child of Object.values(value)) buttons(child, result);
  return result;
}

function selects(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) selects(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (value.tag === 'select_static') result.push(value);
  for (const child of Object.values(value)) selects(child, result);
  return result;
}

function forms(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) forms(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (value.tag === 'form') result.push(value);
  for (const child of Object.values(value)) forms(child, result);
  return result;
}

test('menu exposes the increased command set and keeps permission completion number-only', () => {
  const card = JSON.parse(menuCard());
  assert.match(JSON.stringify(card), /\*\*5\*\*\S*补全权限/);
  const actions = buttons(card).flatMap((button) => (
    button.behaviors?.map((behavior) => behavior?.value?.action) ?? []
  ));
  assert.deepEqual(actions, [
    'presets', 'models', 'new', 'sessions', 'workspaces',
    'stop', 'compact', 'archive_toggle', 'status', 'help',
  ]);
  // 补全权限不占位按钮：仅通过数字兜底「5🔧」触发（见 bridge）
  assert.equal(actions.includes('repair'), false);
});

test('menu and card help advertise Agent Preset, reasoning, and batch commands', () => {
  const help = menuHelpText();
  assert.match(help, /\/presetlist/);
  assert.match(help, /\/presets/);
  assert.match(help, /\/sessions/);
  assert.match(help, /\/workspace 工作区序号或绝对路径/);
  assert.match(help, /\/ws、\/wsl、\/workspaces/);
  assert.match(help, /\/preset \[序号或完整ID\]/);
  assert.match(help, /\/preset id:<ID>/);
  assert.match(help, /\/preset --default/);
  assert.match(help, /\/reasoninglist 或 \/reasonings/);
  assert.match(help, /\/reasoning \[序号、等级ID或 --default\]/);
  assert.match(help, /\/model \[序号或完整模型ID\] \[推理等级ID\]/);
  assert.match(help, /\/batch/);
  assert.match(help, /\/send/);
  assert.match(help, /\/cancel/);
  assert.match(help, /\/version/);

  const card = helpCard();
  assert.match(card, /\/presets/);
  assert.match(card, /\/sessions/);
  assert.match(card, /\/workspace 工作区序号或绝对路径/);
  assert.match(card, /\/ws、\/wsl、\/workspaces/);
  assert.match(card, /\/reasoninglist/);
  assert.match(card, /\/reasonings/);
  assert.match(card, /\/reasoning \[序号、等级ID或 --default\]/);
  assert.match(card, /\/model \[序号或完整模型ID\] \[推理等级ID\]/);
  assert.match(card, /\/batch/);
  assert.match(card, /\/send/);
  assert.match(card, /\/cancel/);
});

test('card-action probe carries only its action and opaque nonce', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const card = JSON.parse(cardActionProbeCard(nonce));
  const probe = buttons(card)[0];
  assert.deepEqual(probe.behaviors, [{
    type: 'callback',
    value: { action: 'repair_verify', nonce },
  }]);
  assert.throws(() => cardActionProbeCard('{{client_id}}'), /safe card-action probe nonce/);
});

test('custom steer card wraps input and submit in a form container', () => {
  const card = JSON.parse(customSteerCard());
  const form = forms(card)[0];
  assert.ok(form, 'custom steer card must contain a form container');
  assert.equal(form.name, 'steer_form');
  const inputs = buttons(form).filter((element) => element.tag === 'input');
  // inputs are not buttons; scan form.elements directly
  const input = form.elements.find((element) => element.tag === 'input');
  assert.equal(input?.name, 'steer_text');
  const submit = form.elements.find((element) => element.tag === 'button');
  assert.equal(submit?.name, 'steer_submit');
  assert.equal(submit?.form_action_type, 'submit');
  assert.equal(submit?.action_type, undefined, 'Card 2.0 must not rely on the legacy action_type field');
  const controlNames = [form.name, ...form.elements.map((element) => element.name).filter(Boolean)];
  assert.equal(new Set(controlNames).size, controlNames.length, 'form control names must be card-global unique');
  assert.deepEqual(submit?.behaviors, [{
    type: 'callback',
    value: { action: 'steer', source: 'form' },
  }]);
  // 表单外的返回菜单按钮仍保留
  const back = buttons(card).find((b) => b.behaviors?.[0]?.value?.action === 'back_to_menu');
  assert.ok(back);
});

test('menu session dropdown highlights the currently bound session via initial_index', () => {
  const sessions = [
    { id: 'session-1', title: 'First' },
    { id: 'session-2', title: 'Second' },
    { id: 'session-3', title: 'Third' },
  ];
  const card = JSON.parse(menuCard({
    currentSession: { id: 'session-2', title: 'Second' },
    sessions,
  }));
  const pick = selects(card).find((s) => s.name === 'session_pick');
  assert.ok(pick, 'menu must render a session dropdown');
  // initial_index is 1-based; the currently bound session sits at index 2.
  assert.equal(pick.initial_index, 2);
});

test('model card dropdown highlights the current model via initial_index', () => {
  const catalog = {
    groups: [
      { id: 'openrouter', name: 'OpenRouter', models: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
      ] },
    ],
    current: { provider: 'openrouter', model: 'deepseek/deepseek-chat' },
  };
  const card = JSON.parse(modelCard(catalog));
  const pick = selects(card).find((s) => s.name === 'model_pick');
  assert.ok(pick, 'model card must render a dropdown');
  // deepseek/deepseek-chat is the second option (1-based index 2), even
  // though the id itself contains a `/`.
  assert.equal(pick.initial_index, 2);
});

test('a single preset remains selectable alongside follow-default', () => {
  const card = JSON.parse(presetCard({
    defaultId: 'preset-one',
    _currentId: null,
    items: [{ id: 'preset-one', label: 'Preset One' }],
  }));
  const pick = selects(card).find((select) => select.name === 'preset_pick');
  assert.deepEqual(pick?.options.map((option) => option.value), ['preset-one']);
  const reset = buttons(card).find((button) => (
    button.behaviors?.[0]?.value?.action === 'preset_default'
  ));
  assert.ok(reset, 'follow-default must remain available beside the sole preset');
});

test('menu without sessions does not emit an empty session dropdown', () => {
  const card = JSON.parse(menuCard({ sessions: [] }));
  const pick = selects(card).find((select) => select.name === 'session_pick');
  assert.equal(pick, undefined, 'Feishu must not receive select_static with options: []');
});

test('quick steer dropdowns start without a preselected command', () => {
  const menuPick = selects(JSON.parse(menuCard()))
    .find((select) => select.name === 'steer_pick');
  const cardPick = selects(JSON.parse(steerCard({ hasSession: true })))
    .find((select) => select.name === 'steer_quick');
  assert.equal(menuPick?.initial_index ?? 0, 0);
  assert.equal(cardPick?.initial_index ?? 0, 0);
});

test('reachable Feishu cards contain no Chinese literals in English mode', () => {
  const presetCatalog = {
    defaultId: 'preset-one',
    _currentId: 'preset-two',
    items: [
      { id: 'preset-one', label: 'Preset One' },
      { id: 'preset-two', label: 'Preset Two' },
    ],
  };
  const modelCatalog = {
    groups: [{
      id: 'provider',
      name: 'Provider',
      models: [
        { id: 'model-one', name: 'Model One' },
        { id: 'model-two', name: 'Model Two' },
      ],
    }],
    current: { provider: 'provider', model: 'model-two' },
  };
  const sessions = [{ sessionId: 'session-one', title: 'Session One' }];
  const rendered = [];

  setImHostLanguage('en');
  try {
    const englishMenuHelp = menuHelpText();
    const englishCardHelp = helpCard(['Additional help']);
    assert.match(englishMenuHelp, /\/workspace <workspace index or absolute path>/);
    assert.match(englishMenuHelp, /\/ws, \/wsl, \/workspaces/);
    assert.match(englishCardHelp, /\/workspace <workspace index or absolute path>/);
    assert.match(englishCardHelp, /\/ws, \/wsl, \/workspaces/);
    rendered.push(
      menuCard({
        workspaces: ['/work'],
        currentWorkspace: '/work',
        currentSession: { id: 'session-one', title: 'Session One' },
        sessions: [{ id: 'session-one', title: 'Session One' }],
        archiveVisible: false,
        presetCatalog,
        modelCatalog,
      }),
      presetCard(presetCatalog),
      modelCard(modelCatalog),
      statusCard({
        connected: true,
        workspace: '/work',
        preset: 'Preset Two',
        model: 'provider/model-two',
        sessionCount: 1,
      }),
      englishCardHelp,
      sessionListCard('/work', sessions, 0, 1),
      workspaceListCard(['/work'], '/work'),
      watchListCard(
        [{ sessionId: 'session-one', title: 'Session One' }],
        [{ sessionId: 'session-two', title: 'Session Two' }],
      ),
      completionCard('session-one', 'Session One', 'completed'),
      steerCard({ hasSession: true }),
      customSteerCard(),
      cardActionProbeCard('0123456789abcdef0123456789abcdef'),
      englishMenuHelp,
    );
  } finally {
    setImHostLanguage('zh');
  }

  for (const output of rendered) {
    assert.doesNotMatch(output, /[\u3400-\u9fff]/u);
  }
});
