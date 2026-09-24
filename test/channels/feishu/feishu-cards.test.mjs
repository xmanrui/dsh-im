import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answeredQuestionCard,
  countMarkdownTables,
  splitStepStreamCardBlocks,
  stepStreamCard,
  STEP_STREAM_CARD_MAX_TABLES,
  cardActionProbeCard,
  completionCard,
  customSteerCard,
  helpCard,
  menuCard,
  menuHelpText,
  modelCard,
  presetCard,
  questionCard,
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

test('issue #162: questionCard 渲染「✏️ 其他答案…」自定义入口按钮', () => {
  const card = questionCard({
    interactionId: 'i-1', header: 'H', question: 'Q?',
    options: [{ label: 'A', description: 'a' }, { label: 'B' }], index: 0, total: 1,
  });
  const actions = String(card);
  assert.ok(actions.includes('answerCustom:i-1:0'), '必须包含自定义入口 action');
  assert.ok(actions.includes('其他答案'));
});

test('issue #162: answeredQuestionCard 无任何按钮且标注已选项', () => {
  const card = answeredQuestionCard({
    interactionId: 'i-1', header: 'H', question: 'Q?',
    options: [{ label: 'A' }, { label: 'B' }], chosen: 'B', index: 0, total: 2,
  });
  const json = String(card);
  assert.ok(!json.includes('"tag":"button"'), '已答状态卡不得含可点按钮');
  assert.ok(json.includes('已回答') && json.includes('✅ 已选择：B'));
  assert.ok(json.includes('A') && json.includes('B'), '选项列表保留');
});

test('a card is split once it would carry more tables than Feishu accepts', () => {
  // Feishu rejects the whole card write with `230099 / ErrCode 11310 card table
  // number over limit` when one card holds too many tables, and the card then
  // stays on its previous content — so the reply never appears. Splitting was
  // budgeted by encoded bytes only, which a card full of short tables passes
  // easily.
  const table = (n) => ({ text: `| T${n} |\n| --- |\n| v |` });
  const chunks = splitStepStreamCardBlocks(Array.from({ length: 6 }, (_, i) => table(i)));
  assert.ok(chunks.length > 1, 'six tables must not stay on one card');
  for (const chunk of chunks) {
    const tables = chunk.reduce((sum, block) => sum + countMarkdownTables(block.text), 0);
    assert.ok(
      tables <= STEP_STREAM_CARD_MAX_TABLES,
      `a card carried ${tables} tables, above the limit`,
    );
  }
  // Nothing is dropped while splitting.
  const total = chunks.flat().length;
  assert.equal(total, 6, 'every block survives the split');
});

test('tables inside a folded process panel count toward the limit', () => {
  // The maintainer's boundary test: 3 folded + 2 in the body succeeded, while
  // 3 folded + 3 failed — the panel's tables are part of the same card.
  const table = (n) => `| T${n} |\n| --- |\n| v |\n`;
  const blocks = [
    { kind: 'notes', lines: [table(1), table(2), table(3)] },
    { text: table(4) },
    { text: table(5) },
    { text: table(6) },
  ];
  const chunks = splitStepStreamCardBlocks(blocks);
  assert.ok(chunks.length > 1, 'folded tables must count, so this cannot fit on one card');
  const countIn = (chunk) => chunk.reduce((sum, block) => (
    sum
    + (typeof block.text === 'string' ? countMarkdownTables(block.text) : 0)
    + (Array.isArray(block.lines)
      ? block.lines.reduce((n, line) => n + countMarkdownTables(line), 0) : 0)
  ), 0);
  for (const chunk of chunks) {
    assert.ok(countIn(chunk) <= STEP_STREAM_CARD_MAX_TABLES, 'no chunk exceeds the table limit');
  }
});

test('countMarkdownTables reads GFM tables and ignores pipe-shaped prose', () => {
  assert.equal(countMarkdownTables(''), 0);
  assert.equal(countMarkdownTables('普通文本，没有表格'), 0);
  assert.equal(countMarkdownTables('a | b 只是文字\n下一行'), 0);
  assert.equal(countMarkdownTables('| A | B |\n| --- | --- |\n| 1 | 2 |'), 1);
  assert.equal(countMarkdownTables('| A |\n| --- |\n| 1 |'), 1, 'a single-column table still counts');
  assert.equal(countMarkdownTables('| A | B |\n|:---|---:|\n| 1 | 2 |'), 1, 'alignment markers are fine');
  assert.equal(
    countMarkdownTables('| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |'),
    2,
    'two tables separated by a blank line',
  );
});

test('a single block holding too many tables is split from the inside', () => {
  // Splitting only between blocks left a short answer with six small tables on
  // one card: it is a single block, so there was no boundary to cut at.
  const table = (n) => `| T${n} |\n| --- |\n| v |\n`;
  const one = { text: Array.from({ length: 6 }, (_, i) => table(i)).join('\n\n') };
  assert.ok(countMarkdownTables(one.text) > STEP_STREAM_CARD_MAX_TABLES);

  const chunks = splitStepStreamCardBlocks([one]);
  assert.ok(chunks.length > 1, 'one over-full block must still become several cards');
  for (const chunk of chunks) {
    const tables = chunk.reduce((n, b) => n + countMarkdownTables(b.text), 0);
    assert.ok(tables <= STEP_STREAM_CARD_MAX_TABLES, `a card carried ${tables} tables`);
  }
  // No table is severed or dropped.
  const rebuilt = chunks.flat().map((b) => b.text).join('\n');
  for (let i = 0; i < 6; i += 1) assert.match(rebuilt, new RegExp(`T${i}`));
});

test('a folded panel with too many tables is split too', () => {
  // A panel's lines render into the same card, so its tables count as well.
  const table = (n) => `| T${n} |\n| --- |\n| v |\n`;
  const panel = { kind: 'notes', lines: Array.from({ length: 6 }, (_, i) => table(i)) };
  const chunks = splitStepStreamCardBlocks([panel]);
  assert.ok(chunks.length > 1, 'an over-full panel must be split');
  const countIn = (chunk) => chunk.reduce((n, b) => n
    + (typeof b.text === 'string' ? countMarkdownTables(b.text) : 0)
    + (Array.isArray(b.lines) ? b.lines.reduce((m, l) => m + countMarkdownTables(l), 0) : 0), 0);
  for (const chunk of chunks) {
    assert.ok(countIn(chunk) <= STEP_STREAM_CARD_MAX_TABLES, 'no chunk exceeds the table limit');
  }
  const total = chunks.flat().reduce((n, b) => n + (b.lines?.length ?? 0), 0);
  assert.equal(total, 6, 'every panel line survives the split');
});

test('table headers and delimiter rows stay in the same markdown element', t => {
  const tables = Array.from({length:6}, (_,i)=>`| H${i} |\n| --- |\n| V${i} |`);
  const chunks = splitStepStreamCardBlocks([{kind:'message',text:tables.join('\n\n')}]);
  const fragments = chunks.flat().map(b=>b.text);
  const broken = tables.filter(table=>!fragments.some(fragment=>fragment.includes(table)));
  t.diagnostic(JSON.stringify({cardCount:chunks.length, brokenTables:broken, fragments}));
  assert.deepEqual(broken, [], 'A complete table must stay in one markdown element');
});
test('tables with optional outer pipes omitted still respect the table budget', t => {
  const source = Array.from({length:6}, (_,i)=>`H${i} | B\n--- | ---\nV${i} | 1`).join('\n\n');
  const chunks = splitStepStreamCardBlocks([{kind:'message',text:source}]);
  const counts = chunks.map(chunk=>chunk.reduce((n,b)=>n+countMarkdownTables(b.text),0));
  t.diagnostic(JSON.stringify({counts}));
  assert.ok(counts.every(n=>n<=5));
});

function renderedMarkdown(card) {
  if (!card || typeof card !== 'object') return [];
  return [
    ...(card.tag === 'markdown' ? [card.content] : []),
    ...Object.values(card).flatMap(value => Array.isArray(value)
      ? value.flatMap(renderedMarkdown)
      : renderedMarkdown(value)),
  ];
}
const completeTable = n => `| Item${n} | Value |\n| --- | --- |\n| row${n} | ok |`;
for (const size of [5, 6, 11]) {
  test(`table budget preserves all ${size} complete tables in order`, () => {
    const tables = Array.from({ length: size }, (_, index) => completeTable(index));
    const source = tables.join('\n\n');
    const chunks = splitStepStreamCardBlocks([{ kind: 'message', text: source }]);
    assert.equal(chunks.length, Math.ceil(size / 5));
    const markdown = chunks.flatMap(chunk => renderedMarkdown(JSON.parse(stepStreamCard(chunk))));
    for (const table of tables) assert.equal(markdown.filter(text => text.includes(table)).length, 1);
    const ordered = markdown.join('\n').match(/row\d+/g);
    assert.deepEqual(ordered, tables.map((_, index) => `row${index}`));
    for (const chunk of chunks) {
      const rows = renderedMarkdown(JSON.parse(stepStreamCard(chunk))).join('\n').match(/row\d+/g) ?? [];
      assert.ok(rows.length <= 5);
    }
  });
}

test('Markdown table recognition skips code and keeps GFM variants', () => {
  const base = completeTable(0);
  for (const code of [
    `\x60\x60\x60markdown\n${base}\n\x60\x60\x60`,
    `~~~~\n${base}\n~~~~`,
    base.split('\n').map(line => `    ${line}`).join('\n'),
    base.split('\n').map(line => `\t${line}`).join('\n'),
    '| --- | --- |',
  ]) assert.equal(countMarkdownTables(code), 0, code);
  for (const source of [
    '| A |\n| --- |\n| 1 |',
    'A | B\r\n:--- | ---:\r\n1 | 2',
    '| A\\|B | C |\n| --- | --- |\n| 1 | 2 |',
    '| `A|B` | C |\n| --- | --- |\n| 1 | 2 |',
    '| A | B |\n| --- | --- |\n| --- | --- |\n| 1 | 2 |',
  ]) assert.equal(countMarkdownTables(source), 1, source);
});

for (const sizes of [[6], [3, 3], [1, 1, 1, 1, 1, 1]]) {
  test(`notes with table groups ${sizes.join('+')} split without mutating the source`, () => {
    let index = 0;
    const lines = sizes.map(size => Array.from({ length: size }, () => completeTable(index++)).join('\n\n') + '\n');
    const block = { kind: 'notes', lines: ['opening text', ...lines, 'closing text'], omitted: 4 };
    const snapshot = structuredClone(block);
    const chunks = splitStepStreamCardBlocks([block]);
    assert.ok(chunks.length > 1);
    const markdown = chunks.flatMap(chunk => renderedMarkdown(JSON.parse(stepStreamCard(chunk))));
    for (let n = 0; n < index; n++) assert.equal(markdown.filter(text => text.includes(completeTable(n))).length, 1);
    for (const chunk of chunks) {
      const rows = renderedMarkdown(JSON.parse(stepStreamCard(chunk))).join('\n').match(/row\d+/g) ?? [];
      assert.ok(rows.length <= 5);
    }
    assert.deepEqual(block, snapshot);
    assert.equal(chunks.flat().reduce((sum, b) => sum + (b.omitted ?? 0), 0), 4);
    assert.ok(markdown.join('\n').indexOf('opening text') < markdown.join('\n').indexOf('closing text'));
  });
}

test('table and encoded-byte budgets both constrain cards', () => {
  const blocks = Array.from({ length: 11 }, (_, index) => ({ text: completeTable(index) }));
  const chunks = splitStepStreamCardBlocks(blocks, 450);
  assert.ok(chunks.length > 3);
  assert.equal(chunks.flat().length, 11);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(stepStreamCard(chunk)) <= 450);
    assert.ok(chunk.length <= 5);
  }
});
