/**
 * Feishu interactive-card builders for the dsh-im menu / session-list /
 * workspace-list UX. All builders return the JSON string the
 * `im.message.create` API expects as `content` for `msg_type: interactive`
 * (card schema 2.0; callback buttons live inside a column_set/column layout).
 *
 * The session list lays each row out as a `column_set` (fixed-width ⭐
 * watch-toggle column + weighted session-button column), which is how V2
 * expresses a row of buttons.
 *
 * Buttons carry a small `{ action }` value object that `card.action.trigger`
 * events echo back (when the app subscribes that event); every numbered
 * button also has a numeric label so the number-reply fallback stays usable
 * without button callbacks.
 */

import { t } from '../shared/i18n.mjs';

export const MENU_PAGE_SIZE = 10;

/** 预设下拉中「跟随默认」(null) 的哨兵值，供 initial_index 命中与回调识别。 */
export const PRESET_FOLLOW_DEFAULT_SENTINEL = '__preset_follow_default__';

function plainText(content) {
  return { tag: 'plain_text', content: String(content) };
}

function markdown(content) {
  return { tag: 'lark_md', content: String(content) };
}

/** Full-width button wrapped in a column_set. */
function button(content, actionValue) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        text: plainText(content),
        type: 'default',
        width: 'fill',
        behaviors: [{ type: 'callback', value: { action: actionValue } }],
      }],
    }],
  };
}

/** The raw button element (without the full-width column_set wrapper). */
function buttonElement(content, actionValue) {
  return {
    tag: 'button',
    text: plainText(content),
    type: 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { action: actionValue } }],
  };
}

/**
 * Two buttons side by side in a `column_set`.
 * `leftContent` / `leftAction` and `rightContent` / `rightAction` define
 * each button's label and callback action value.
 */
function buttonPair(leftContent, leftAction, rightContent, rightAction) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [buttonElement(leftContent, leftAction)] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [buttonElement(rightContent, rightAction)] },
    ],
  };
}

/**
 * Feishu schema 2.0 single-select (`select_static`) does NOT support a
 * `selected` field on options (that triggers 230099 parse json err). The
 * supported way to show a default value is `initial_index` (1-based option
 * order; 0 = show none). Build it from the option array + current value.
 */
function initialIndex(options, currentValue) {
  const idx = options.findIndex((o) => o.value === currentValue);
  return idx >= 0 ? idx + 1 : 0;
}

function safeTitle(value) {
  const title = String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return title || t('暂无标题');
}

function cardWith(headerText, elements) {
  return JSON.stringify({
    schema: '2.0',
    header: { title: plainText(headerText), template: 'blue' },
    body: { elements },
  });
}

// ── Shared helper: a "back to menu" button ────────────────────────────────

function backButton() {
  return button(t('🔙 返回菜单'), 'back_to_menu');
}

// ── Main menu card ────────────────────────────────────────────────────────

/**
 * The hub menu card — a single entry point covering every command, organized
 * by operating flow:
 *   1. 会话 · 工作区（高频率）→ 会话下拉 · 工作区下拉 · 新会话 · 全部会话
 *   2. 任务控制 → 停止 · 压缩 · 补充指令下拉
 *   3. 配置 → 预设下拉 · 模型下拉 · 归档切换
 *   4. 系统 → 状态 · 帮助
 * `ctx` bundle:
 *   - workspaces: string[]          (工作区下拉选项)
 *   - currentWorkspace: string|null (当前工作区,下拉高亮)
 *   - currentSession: {id,title}|null (当前绑定会话,续写目标)
 *   - sessions: {id,title}[]        (最近会话,供会话下拉切换)
 *   - archiveVisible: boolean       (归档显隐开关当前值)
 *   - presetCatalog: object|null    (预设目录, {items,defaultId,_currentId})
 *   - modelCatalog: object|null     (模型目录, {groups,current})
 * Number fallback: 1=续写 2=新会话 3=会话列表 4=状态
 * 5=补全权限 6=帮助.
 */
export function menuCard(ctx) {
  const {
    workspaces = [],
    currentWorkspace = null,
    currentSession = null,
    sessions = [],
    archiveVisible = false,
    presetCatalog = null,
    modelCatalog = null,
  } = ctx || {};

  // currentSession 提供 id/title；为兼容旧调用，也接受 currentSessionTitle
  const currentSessionId = currentSession?.id ?? null;
  const currentSessionTitle = currentSession?.title ?? ctx?.currentSessionTitle ?? null;

  const sessionOptions = (Array.isArray(sessions) ? sessions : []).slice(0, 20);
  const hasSessions = sessionOptions.length > 0;
  const hasWorkspaces = Array.isArray(workspaces) && workspaces.length > 0;
  const elements = [];

  // ── 设置区 ──────────────────────────────────────────────────
  elements.push({ tag: 'div', text: markdown(t('**设置**')) });

  // ── 四个下拉菜单 2×2 网格 ────────────────────────────────────

  // 第 1 行：会话 + 工作区
  let sessionDropdown = null;
  if (hasSessions) {
    const sessionPickOptions = sessionOptions.map((s) => ({
      text: { tag: 'plain_text', content: `${s.id === currentSessionId ? '✓ ' : ''}${safeTitle(s.title)}` },
      value: s.id,
    }));
    sessionDropdown = {
      tag: 'select_static',
      name: 'session_pick',
      placeholder: {
        tag: 'plain_text',
        content: currentSessionId ? t('切换会话') : t('选择会话（当前未绑定）'),
      },
      initial_index: initialIndex(sessionPickOptions, currentSessionId),
      options: sessionPickOptions,
      behaviors: [{ type: 'callback', value: { action: 'session_pick' } }],
    };
  }

  let workspaceDropdown = null;
  if (hasWorkspaces) {
    const wsOptions = workspaces.slice(0, 20).map((path) => ({
      text: { tag: 'plain_text', content: `${path === currentWorkspace ? '✓ ' : ''}${path}` },
      value: path,
    }));
    workspaceDropdown = {
      tag: 'select_static',
      name: 'workspace_pick',
      placeholder: { tag: 'plain_text', content: t('切换工作区') },
      initial_index: initialIndex(wsOptions, currentWorkspace),
      options: wsOptions,
      behaviors: [{ type: 'callback', value: { action: 'workspace_pick' } }],
    };
  }

  // 第 2 行：预设 + 模型
  const presetItems = Array.isArray(presetCatalog?.items) ? presetCatalog.items : [];
  const curPresetId = presetCatalog?._currentId ?? null;
  const presetFollowDefault = curPresetId === null;
  let presetDropdown = null;
  if (presetItems.length >= 1) {
    const setPresetOptions = presetItems.slice(0, 30).map((item) => ({
      text: { tag: 'plain_text', content: `${item.id === curPresetId ? '✓ ' : ''}${item.label}` },
      value: item.id,
    }));
    const presetSelected = presetFollowDefault ? PRESET_FOLLOW_DEFAULT_SENTINEL : curPresetId;
    setPresetOptions.unshift({
      text: { tag: 'plain_text', content: `${presetFollowDefault ? '✓ ' : ''}${t('跟随默认')}` },
      value: PRESET_FOLLOW_DEFAULT_SENTINEL,
    });
    presetDropdown = {
      tag: 'select_static',
      name: 'preset_pick',
      placeholder: { tag: 'plain_text', content: t('切换预设') },
      initial_index: initialIndex(setPresetOptions, presetSelected),
      options: setPresetOptions,
      behaviors: [{ type: 'callback', value: { action: 'preset_pick' } }],
    };
  }

  const groups = Array.isArray(modelCatalog?.groups) ? modelCatalog.groups : [];
  const curModel = modelCatalog?.current;
  const curModelId = curModel ? `${curModel.provider}/${curModel.model}` : null;
  const flat = [];
  for (const group of groups) {
    for (const model of (group.models || [])) flat.push({ id: `${group.id}/${model.id}`, name: `${group.name} - ${model.name}` });
  }
  let modelDropdown = null;
  if (flat.length > 1) {
    const setModelOptions = flat.slice(0, 30).map((opt) => ({
      text: { tag: 'plain_text', content: `${opt.id === curModelId ? '✓ ' : ''}${opt.name}` },
      value: opt.id,
    }));
    modelDropdown = {
      tag: 'select_static',
      name: 'model_pick',
      placeholder: { tag: 'plain_text', content: t('切换模型') },
      initial_index: initialIndex(setModelOptions, curModelId),
      options: setModelOptions,
      behaviors: [{ type: 'callback', value: { action: 'model_pick' } }],
    };
  }

  // 渲染 2×2 网格：图标 + 下拉并列
  // 每一行用 4 列 column_set：图标 | 下拉 | 图标 | 下拉
  function iconCol(icon) {
    return { tag: 'column', width: 'weighted', weight: 0.1, vertical_align: 'center', elements: [{ tag: 'div', text: { tag: 'plain_text', content: icon } }] };
  }
  function dropdownCol(el) {
    return { tag: 'column', width: 'weighted', weight: 1, elements: [el] };
  }

  const row1 = [];
  if (sessionDropdown) row1.push(sessionDropdown);
  if (workspaceDropdown) row1.push(workspaceDropdown);
  if (row1.length === 2) {
    elements.push({
      tag: 'column_set', flex_mode: 'none',
      columns: [iconCol('💬'), dropdownCol(row1[0]), iconCol('📂'), dropdownCol(row1[1])],
    });
  } else if (row1[0]) {
    elements.push(row1[0]);
  }
  if (!hasSessions) {
    elements.push({ tag: 'div', text: markdown(t('当前工作区暂无可用会话。')) });
  }

  const row2 = [];
  const presetBtn = button(t('🤖 切换预设'), 'presets');
  const modelBtn = button(t('🧠 切换模型'), 'models');
  if (presetDropdown) row2.push(presetDropdown); else row2.push(presetBtn);
  if (modelDropdown) row2.push(modelDropdown); else row2.push(modelBtn);
  elements.push({
    tag: 'column_set', flex_mode: 'none',
    columns: [iconCol('🤖'), dropdownCol(row2[0]), iconCol('🧠'), dropdownCol(row2[1])],
  });

  // 新会话 + 全部会话按钮
  elements.push(buttonPair(t('🆕 新会话'), 'new', t('📋 会话/关注'), 'sessions'));
  if (!hasSessions && !hasWorkspaces) {
    elements.push(button(t('🗂 工作区列表'), 'workspaces'));
  }
  elements.push({ tag: 'hr' });

  // ── 任务控制（对运行中任务的操作）────────────────────────
  elements.push({ tag: 'div', text: markdown(t('**任务控制**')) });
  elements.push(buttonPair(t('⏹ 停止'), 'stop', t('📐 压缩'), 'compact'));
  elements.push({ tag: 'hr' });

  // ── 补充指令 + 归档切换（并列）────────────────────────────
  elements.push({
    tag: 'column_set', flex_mode: 'none',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 1,
        elements: [
          { tag: 'div', text: markdown(t('**补充指令**')) },
          {
            tag: 'select_static',
            name: 'steer_pick',
            placeholder: { tag: 'plain_text', content: t('选择补充指令') },
            initial_index: 0,
            options: [
              ...QUICK_STEER_OPTIONS.map((source) => ({
                text: { tag: 'plain_text', content: t(source) },
                value: t(source),
              })),
              { text: { tag: 'plain_text', content: t('✏️ 更多 / 自定义…') }, value: 'custom' },
            ],
            behaviors: [{ type: 'callback', value: { action: 'steer_pick' } }],
          },
        ],
      },
      {
        tag: 'column', width: 'weighted', weight: 1,
        elements: [
          { tag: 'div', text: markdown(t('🗄 归档：{state}', {
            state: archiveVisible ? t('已显示') : t('已隐藏'),
          })) },
          button(t('切换归档显示'), 'archive_toggle'),
        ],
      },
    ],
  });
  elements.push({ tag: 'hr' });

  // ── 底部操作（系统功能）────────────────────────────────────
  elements.push(buttonPair(t('📊 状态'), 'status', t('📖 帮助'), 'help'));

  // 命令与数字兜底说明
  elements.push({ tag: 'div', text: markdown(t(
    '**数字兜底**\n**1**工作区列表 · **2**新会话 · **3**会话列表 · **4**状态\n**5**🔧补全权限 · **6**帮助',
  )) });
  return cardWith(t('🤖 助手中心'), elements);
}

// ── Preset management card ────────────────────────────────────────────────

/**
 * Preset selection card with a dropdown of available presets.
 * The catalog comes from `harness.agentPresetSettings()`.
 */
export function presetCard(catalog) {
  const { items, defaultId } = catalog;
  const current = catalog._currentId; // injected by the caller
  const currentItem = items.find((i) => i.id === current);
  const defaultItem = items.find((i) => i.id === defaultId);

  const currentText = current === null
    ? t('跟随 Host 默认{default}', { default: defaultItem ? `（${defaultItem.label}）` : '' })
    : currentItem
      ? `${currentItem.label}（${currentItem.id}）`
      : t('{id}（已不可用）', { id: current });

  const elements = [
    { tag: 'div', text: markdown(t('**当前**：{value}', { value: currentText })) },
    { tag: 'div', text: markdown(t('**Host 默认**：{value}', {
      value: defaultItem ? `${defaultItem.label}（${defaultItem.id}）` : t('未设置'),
    })) },
    { tag: 'hr' },
  ];

  if (items.length >= 1) {
    const presetCardOptions = items.map((item) => ({
      text: { tag: 'plain_text', content: `${item.label}（${item.id}）${item.id === current ? ' ✓' : ''}` },
      value: item.id,
    }));
    elements.push(
      {
        tag: 'select_static',
        name: 'preset_pick',
        placeholder: { tag: 'plain_text', content: t('选择预设') },
        initial_index: current === null ? 0 : initialIndex(presetCardOptions, current),
        options: presetCardOptions,
        behaviors: [{ type: 'callback', value: { action: 'preset_pick' } }],
      },
      { tag: 'hr' },
      buttonPair(t('🔄 跟随默认'), 'preset_default', t('🔙 返回菜单'), 'back_to_menu'),
    );
  } else {
    elements.push(
      { tag: 'div', text: markdown(t('当前没有可选择的预设。')) },
      backButton(),
    );
  }
  return cardWith(t('🤖 预设列表'), elements);
}

// ── Model management card ─────────────────────────────────────────────────

/**
 * Model selection card with a dropdown of available models.
 * The catalog comes from `harness.listModels()` or `session.models()`.
 * Groups are shown as text, then a flat dropdown for selection.
 */
export function modelCard(catalog) {
  const { groups, current } = catalog;
  const currentId = current ? `${current.provider}/${current.model}` : null;

  const elements = [
    { tag: 'div', text: markdown(t('**当前模型**：{model}', { model: currentId || t('未设置') })) },
    { tag: 'hr' },
  ];

  // Count total models
  let total = 0;
  for (const group of groups) total += group.models.length;

  if (total === 0) {
    elements.push(
      { tag: 'div', text: markdown(t('当前没有可用模型。')) },
      backButton(),
    );
  } else {
    // Show groups as text
    for (const group of groups) {
      const modelLines = group.models.map((m) => {
        const id = `${group.id}/${m.id}`;
        return `${id}${id === currentId ? ' ✓' : ''}`;
      });
      elements.push(
        { tag: 'div', text: markdown(`**${group.name}**\n${modelLines.join('\n')}`) },
      );
    }

    // Flatten all models into a dropdown
    const allOptions = [];
    for (const group of groups) {
      for (const model of group.models) {
        allOptions.push({
          value: `${group.id}/${model.id}`,
          text: { tag: 'plain_text', content: `${group.name} - ${model.name}` },
        });
      }
    }

    elements.push(
      { tag: 'hr' },
      {
        tag: 'select_static',
        name: 'model_pick',
        placeholder: { tag: 'plain_text', content: t('选择模型') },
        initial_index: currentId === null ? 0 : initialIndex(allOptions, currentId),
        options: allOptions.map((opt) => ({
          text: { tag: 'plain_text', content: `${opt.text.content}${opt.value === currentId ? ' ✓' : ''}` },
          value: opt.value,
        })),
        behaviors: [{ type: 'callback', value: { action: 'model_pick' } }],
      },
      { tag: 'hr' },
      backButton(),
    );
  }
  return cardWith(t('🧠 模型列表'), elements);
}

// ── Status card ───────────────────────────────────────────────────────────

/**
 * System status card showing connection, workspace, preset, model and session
 * count. `info` is an object with keys:
 *   - connected: boolean
 *   - workspace: string | null
 *   - preset: string | null
 *   - model: string | null
 *   - sessionCount: number
 */
export function statusCard(info) {
  const elements = [
    { tag: 'div', text: markdown(t('{icon} 飞书机器人{state}', {
      icon: info.connected ? '✅' : '❌',
      state: info.connected ? t('已连接') : t('未连接'),
    })) },
    { tag: 'div', text: markdown(t('📂 工作区：`{workspace}`', { workspace: info.workspace || t('未设置') })) },
    { tag: 'div', text: markdown(t('🤖 预设：{preset}', { preset: info.preset || t('未设置') })) },
    { tag: 'div', text: markdown(t('🧠 模型：{model}', { model: info.model || t('未设置') })) },
    { tag: 'div', text: markdown(t('💬 会话：{count} 个', { count: info.sessionCount })) },
    { tag: 'hr' },
    backButton(),
  ];
  return cardWith(t('📊 系统状态'), elements);
}

// ── Help card ─────────────────────────────────────────────────────────────

/**
 * Plain-text command reference advertised when no interactive card is
 * available (e.g. non-interactive clients), so every command stays
 * discoverable without card callbacks.
 */
export function menuHelpText() {
  return [
    '🤖 助手菜单（回复数字即可，无需记命令）',
    '',
    '📋 会话 / 工作区',
    '/sessionlist 或 /sessions  列出工作区会话',
    '/sessionlist --limit N  仅列出当前工作区前 N 个会话',
    '/session ID  绑定已有会话',
    '/workspacelist  列出工作区',
    '/workspace 工作区序号或绝对路径  切换工作区',
    '/ws、/wsl、/workspaces  工作区命令别名',
    '/new  开启全新会话',
    '',
    '📊 状态 / 压缩',
    '/status  连接状态',
    '/version  查看插件版本',
    '/compact  压缩当前会话上下文',
    '/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）',
    '/archived on/off  会话列表显示/隐藏归档',
    '',
    '👁 关注',
    '/watch ID  关注会话（完成后推送）',
    '/watchlist  关注列表',
    '/unwatch ID  取消关注',
    '',
    '🤖 预设 / 模型',
    '/presetlist 或 /presets  列出可用 Agent Preset',
    '/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset',
    '纯数字 ID：/preset id:<ID>',
    '/preset --default  跟随 Host 默认',
    '/models  列出模型',
    '/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级',
    '/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级',
    '/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型',
    '',
    '📦 批量输入（仅私聊）',
    '/batch  开始批量输入（仅私聊，最多 10 条文字）',
    '/send  提交当前批次',
    '/cancel  取消当前批次',
    '',
    '🎮 任务控制',
    '/stop  停止当前任务',
    '/steer 指令  给 Agent 补充指令',
    '/repair  补全飞书权限与卡片回调',
  ].map((line) => t(line)).join('\n');
}

/**
 * Help card with all available commands and their descriptions.
 */
const HELP_CARD_FEATURES = [
  '**📋 卡片功能**',
  '',
  '1. 会话下拉 — 切换当前绑定会话',
  '2. 工作区下拉 — 切换工作区',
  '3. 🤖 预设下拉 — 切换 Agent 预设',
  '4. 🧠 模型下拉 — 切换模型',
  '5. 🆕 新会话 — 开启全新会话',
  '6. 📋 会话/关注 — 查看/绑定会话，管理关注',
  '7. ⏹ 停止 — 停止当前任务',
  '8. 📐 压缩 — 压缩当前会话上下文',
  '9. 补充指令 — 给 Agent 发送指令',
  '10. 🗄 归档切换 — 显示/隐藏归档会话',
  '11. 📊 状态 — 查看系统连接状态',
  '12. 📖 帮助 — 查看本帮助',
].join('\n');

const HELP_TEXT_COMMANDS = [
  '**⌨️ 文本命令**',
  '',
  '`/m` — 打开菜单卡片',
  '`/new` — 开启全新会话',
  '`/session ID` — 绑定已有会话',
  '`/sessionlist [工作区]` 或 `/sessions [工作区]` — 列出会话',
  '`/sessionlist --limit N` 或 `/sessions --limit N` — 仅列出当前工作区前 N 个会话',
  '`/workspace 工作区序号或绝对路径` — 切换工作区',
  '`/workspacelist` — 列出工作区',
  '`/status` — 查看连接状态',
  '`/compact` — 压缩上下文',
  '`/stop` — 停止当前任务',
  '`/steer 指令` — 补充指令',
  '`/watch ID` — 关注会话',
  '`/watchlist` — 关注列表',
  '`/unwatch ID` — 取消关注',
  '`/archived on/off` — 归档显隐',
  '`/presetlist` 或 `/presets` — 列出预设',
  '`/preset [序号/ID]` — 切换预设',
  '`/preset --default` — 跟随默认',
  '`/models` — 列出模型',
  '`/reasoninglist` 或 `/reasonings` — 按序号列出当前模型可用推理等级',
  '`/reasoning [序号、等级ID或 --default]` — 查看或切换当前推理等级',
  '`/model [序号或完整模型ID] [推理等级ID]` — 查看或切换当前会话模型',
  '`/batch` — 开启批量输入（仅私聊，最多 10 条文字）',
  '`/send` — 提交当前批次',
  '`/cancel` — 取消当前批次',
  '`/repair` — 补全飞书权限与卡片回调',
].join('\n');

const HELP_NUMBER_FALLBACK = [
  '**💡 数字兜底**',
  '回复数字快速操作：',
  '**1**工作区列表 · **2**新会话 · **3**会话/关注',
    '**4**状态 · **5**补全权限 · **6**帮助',
].join('\n');

export function helpCard(extraTextLines = []) {
  const extraText = Array.isArray(extraTextLines) && extraTextLines.length > 0
    ? ('\n' + extraTextLines.join('\n'))
    : '';
  const elements = [
    { tag: 'div', text: markdown(t(HELP_CARD_FEATURES)) },
    { tag: 'hr' },
    { tag: 'div', text: markdown([
      t(HELP_TEXT_COMMANDS),
      t('/ws、/wsl、/workspaces  工作区命令别名'),
      t('`/version` — 查看插件版本'),
      t('/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）'),
    ].join('\n') + extraText) },
    { tag: 'hr' },
    { tag: 'div', text: markdown(t(HELP_NUMBER_FALLBACK)) },
    { tag: 'hr' },
    backButton(),
  ];
  return cardWith(t('📖 帮助'), elements);
}

// ── One-shot callback probe (repair verification) ─────────────────────────

/** One-shot callback probe used only after an existing app was re-authorized. */
export function cardActionProbeCard(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new TypeError('A safe card-action probe nonce is required');
  }
  return cardWith(t('🧪 验证卡片按钮'), [
    {
      tag: 'div',
      text: markdown(t('授权已提交。请点击下方按钮；机器人真实收到回调后才会判定修复成功。')),
    },
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [{
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'button',
          text: plainText(t('完成验证')),
          type: 'primary',
          width: 'fill',
          behaviors: [{
            type: 'callback',
            value: { action: 'repair_verify', nonce },
          }],
        }],
      }],
    },
  ]);
}

// ── Session list card (preserved, with back button) ───────────────────────

/**
 * One page of the workspace's sessions. Each row is a `column_set` pair:
 * the fixed-width ⭐ watch toggle (`⭐关注` / `⭐取关` for already-watched
 * sessions) followed by the session button that carries the page-local
 * number label (reply-number fallback = bind). Archived sessions are marked
 * in the label. `watchedSessionIds` is a Set-like of ids this conversation
 * already watches.
 */
export function sessionListCard(workspace, sessions, page, total, watchedSessionIds = new Set()) {
  const start = page * MENU_PAGE_SIZE;
  const slice = sessions.slice(start, start + MENU_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(total / MENU_PAGE_SIZE));
  const watched = (id) => typeof watchedSessionIds?.has === 'function' && watchedSessionIds.has(id);
  /** One row: fixed 90px watch toggle + the session button filling the rest. */
  const row = (watchButton, sessionButton) => ({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'default',
    columns: [
      { tag: 'column', width: '90px', vertical_align: 'center', elements: [watchButton] },
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [sessionButton] },
    ],
  });
  const elements = [
    { tag: 'div', text: markdown(t('**工作区**：{workspace}\n共 **{total}** 个会话{paging}', {
      workspace: `\`${workspace}\``,
      total,
      paging: total > MENU_PAGE_SIZE
        ? t('（第 {page}/{pageCount} 页）', { page: page + 1, pageCount })
        : '',
    })) },
    ...slice.map((session, offset) => {
      // Page-local numbering: number replies resolve against this page.
      const label = `${offset + 1}. ${safeTitle(session.title)}${session.archived === true ? t('（已归档）') : ''}`;
      const watching = watched(session.sessionId);
      return row(
        buttonElement(watching ? t('⭐ 取消关注') : t('☆ 关注'), watching ? `unwatch:${session.sessionId}` : `watch:${session.sessionId}`),
        buttonElement(label, `use:${session.sessionId}`),
      );
    }),
  ];
  if (page > 0) elements.push(button(t('◀ 上一页'), `sessions:${page - 1}`));
  if (page + 1 < pageCount) elements.push(button(t('下一页 ▶'), `sessions:${page + 1}`));
  elements.push(
    { tag: 'hr' },
    buttonPair(t('🔙 返回菜单'), 'back_to_menu', t('🔍 关注列表'), 'watchlist'),
    { tag: 'div', text: markdown(t('回复数字（1~N）绑定本页会话。')) },
  );
  return cardWith(t('📂 会话列表'), elements);
}

// ── Workspace list card (preserved, with back button) ─────────────────────

/** The workspace list card (switch-workspace buttons + reply fallback). */
export function workspaceListCard(paths, current) {
  const elements = paths.length === 0
    ? [
        { tag: 'div', text: markdown(t('当前 Host 上没有已登记的工作区。')) },
        backButton(),
      ]
    : [
        { tag: 'div', text: markdown(t('回复数字切换工作区，或点击按钮：')) },
        ...paths.map((path, index) => button(
          `${index + 1}. ${path}${path === current ? t('（当前）') : ''}`,
          `workspace:${path}`,
        )),
        { tag: 'hr' },
        backButton(),
      ];
  return cardWith(t('🗂 工作区'), elements);
}

// ── Watch list card (multi-select add/remove + back button) ──────────────

/** Dropdown (multi-select) of sessions not yet watched, to add them in bulk. */
function watchAddSelect(entries, availableSessions) {
  const watched = new Set(entries.map((e) => e.sessionId));
  const options = (Array.isArray(availableSessions) ? availableSessions : [])
    .filter((s) => s?.sessionId && !watched.has(s.sessionId))
    .slice(0, 30)
    .map((s) => ({
      text: { tag: 'plain_text', content: safeTitle(s.title ?? s.sessionId) },
      value: s.sessionId,
    }));
  if (options.length === 0) return null;
  return {
    tag: 'multi_select_static',
    name: 'watch_add',
    placeholder: { tag: 'plain_text', content: t('勾选要关注的会话') },
    options,
    behaviors: [{ type: 'callback', value: { action: 'watch_add', kind: 'multi' } }],
  };
}

/** Dropdown (multi-select) of currently watched sessions, to remove in bulk. */
function watchRemoveSelect(entries) {
  const options = entries.slice(0, 30).map((entry) => ({
    text: { tag: 'plain_text', content: safeTitle(entry.title) },
    value: entry.sessionId,
  }));
  if (options.length === 0) return null;
  return {
    tag: 'multi_select_static',
    name: 'watch_remove',
    placeholder: { tag: 'plain_text', content: t('勾选要取消关注的会话') },
    options,
    behaviors: [{ type: 'callback', value: { action: 'watch_remove', kind: 'multi' } }],
  };
}

/** The watch list for one conversation (multi-select add/remove + buttons). */
export function watchListCard(entries, availableSessions) {
  const watching = Array.isArray(entries) ? entries : [];
  const addSelect = watchAddSelect(watching, availableSessions);
  const removeSelect = watchRemoveSelect(watching);

  const elements = [];
  if (watching.length === 0) {
    elements.push({ tag: 'div', text: markdown(t('当前没有关注的会话。任务完成会自动推送结果。')) });
  } else {
    elements.push({ tag: 'div', text: markdown(t('当前关注 **{count}** 个会话：', { count: watching.length })) });
  }

  if (addSelect) {
    elements.push({ tag: 'hr' }, { tag: 'div', text: markdown(t('**➕ 添加关注**（多选下拉勾选）')) }, addSelect);
  }
  if (removeSelect) {
    elements.push({ tag: 'hr' }, { tag: 'div', text: markdown(t('**➖ 取消关注**（多选下拉勾选）')) }, removeSelect);
  }
  elements.push({ tag: 'hr' }, buttonPair(t('📋 会话列表'), 'sessions', t('🔙 返回菜单'), 'back_to_menu'));
  return cardWith(t('👁 关注列表'), elements);
}

// ── Completion push card ──────────────────────────────────────────────────

/**
 * The completion push card. `title` is the session title, `reason` the
 * turn-end kind (completed / stopped / aborted).
 */
export function completionCard(sessionId, title, reason) {
  const reasonText = reason === 'completed'
    ? t('已完成')
    : reason === 'stopped'
      ? t('已停止')
      : reason === 'aborted'
        ? t('已中止')
        : reason === 'cancelled'
          ? t('已取消')
          : t('已结束');
  return cardWith(t('✅ 任务完成'), [
    { tag: 'div', text: markdown(`**${safeTitle(title)}**\n\`${sessionId}\``) },
    { tag: 'div', text: markdown(t('**状态**：{reason}', { reason: reasonText })) },
    { tag: 'hr' },
    buttonPair(t('📋 会话列表'), 'sessions', t('🔙 返回菜单'), 'back_to_menu'),
    { tag: 'div', text: markdown(t('绑定该会话后可继续追问，输入文字即可。')) },
  ]);
}

// ── Steer card (补充指令) ─────────────────────────────────────────────────

/** 常用补充指令的快捷选项，供下拉秒选。 */
const QUICK_STEER_OPTIONS = ['继续', '加速运行', '总结当前进展', '更简洁些', '更详细些'];

/** 快捷下拉的最后一项：切换到自定义输入卡片。 */
export const STEER_CUSTOM_SENTINEL = '__steer_custom__';

/** 补充指令卡片：单个下拉，快捷指令 + 「更多/自定义」。 */
export function steerCard({ hasSession }) {
  const hint = hasSession
    ? t('从下方下拉选择补充指令；最后一项可自定义输入。')
    : t('当前没有绑定会话，请先绑定会话再补充指令。');
  const options = QUICK_STEER_OPTIONS.map((source) => ({
    text: { tag: 'plain_text', content: t(source) },
    value: t(source),
  }));
  options.push({ text: { tag: 'plain_text', content: t('✏️ 更多 / 自定义…') }, value: STEER_CUSTOM_SENTINEL });
  const elements = [
    { tag: 'div', text: markdown(hint) },
    { tag: 'hr' },
    {
      tag: 'select_static',
      name: 'steer_quick',
      placeholder: { tag: 'plain_text', content: t('选择补充指令') },
      initial_index: 0,
      options,
      behaviors: [{ type: 'callback', value: { action: 'steer', source: 'quick' } }],
    },
    { tag: 'hr' },
    button(t('🔙 返回菜单'), 'back_to_menu'),
  ];
  return cardWith(t('➕ 补充指令'), elements);
}

/** 自定义输入卡：输入框 + 提交（从下拉「更多/自定义」切过来）。 */
export function customSteerCard() {
  const elements = [
    { tag: 'div', text: markdown(t('输入补充指令后点「提交」，发送给当前运行的任务。')) },
    { tag: 'hr' },
    {
      tag: 'form',
      name: 'steer_form',
      elements: [
        {
          tag: 'input',
          name: 'steer_text',
          placeholder: { tag: 'plain_text', content: t('输入你的补充指令') },
        },
        {
          tag: 'button',
          // Card 2.0 form controls need stable names so the client can
          // construct a submit action (and expose action.name) reliably.
          name: 'steer_submit',
          text: { tag: 'plain_text', content: t('提交') },
          type: 'primary',
          width: 'fill',
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { action: 'steer', source: 'form' } }],
        },
      ],
    },
    { tag: 'hr' },
    button(t('🔙 返回菜单'), 'back_to_menu'),
  ];
  return cardWith(t('➕ 自定义指令'), elements);
}

/**
 * Interactive approval card with approve / reject buttons. Action values carry
 * the approvalId so the card callback can submit the decision:
 *   approve:<approvalId>  /  reject:<approvalId>
 * `requiresMention` is advisory; a button click is itself the operator's
 * explicit intent, so it does not need an @ mention in groups.
 */
export function approvalCard({ toolName, operation, reason, approvalId }) {
  const elements = [];
  if (toolName) {
    elements.push({ tag: 'div', text: markdown(t('工具：{tool}', { tool: String(toolName) })) });
  }
  if (operation) {
    // Cap the operation text so an oversized argument list cannot overflow the
    // card (the plain-text path rejects >6000 chars; here we truncate so the
    // approve/reject buttons still render).
    const MAX_OPERATION_CHARS = 6_000;
    const op = String(operation);
    const shown = op.length > MAX_OPERATION_CHARS
      ? `${op.slice(0, MAX_OPERATION_CHARS)}\n…（操作参数过长，已截断）`
      : op;
    elements.push({ tag: 'div', text: markdown(t('操作参数：\n{operation}', { operation: shown })) });
  }
  if (reason) {
    elements.push({ tag: 'div', text: markdown(t('原因：{reason}', { reason: String(reason) })) });
  }
  elements.push(
    { tag: 'hr' },
    buttonPair(t('✅ 批准'), `approve:${approvalId}`, t('❌ 拒绝'), `reject:${approvalId}`),
  );
  return cardWith(t('🔐 工具审批'), elements);
}

/**
 * Interactive question card. When the question carries options, each option is
 * rendered as its own button; the selected option label is submitted via a
 * card callback. Multi-select questions fall back to the plain-text flow (the
 * caller decides), because a multi-select needs a confirm step.
 * Action: answer:<interactionId>:<optionLabel>
 */
export function questionCard({ interactionId, header, question, detail, options, index, total }) {
  const elements = [];
  const progress = total > 1 ? `（${index + 1}/${total}）` : '';
  if (header) elements.push({ tag: 'div', text: markdown(String(header)) });
  const qText = typeof question === 'string' && question.trim() ? question : t('请输入你的回答。');
  elements.push({ tag: 'div', text: markdown(String(qText)) });
  if (detail) elements.push({ tag: 'div', text: markdown(String(detail)) });

  if (Array.isArray(options) && options.length > 0) {
    elements.push({ tag: 'hr' });
    for (const option of options) {
      const label = typeof option?.label === 'string' ? option.label : '';
      if (!label) continue;
      const description = typeof option?.description === 'string' && option.description.trim()
        ? option.description.trim()
        : '';
      // Include the option description in the button so the user sees the full
      // meaning (mirrors the text form "1. label — description").
      const buttonText = description ? `${label}\n${description}` : label;
      // Action carries the question index so a stale card from a previous
      // question cannot be applied to the current one: answer:<interactionId>:<index>:<label>
      elements.push(button(buttonText, `answer:${interactionId}:${index}:${label}`));
    }
  }
  return cardWith(t('❓ 请补充信息{progress}', { progress }), elements);
}
