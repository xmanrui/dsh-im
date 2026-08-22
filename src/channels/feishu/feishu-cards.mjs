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
  return title || '暂无标题';
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
  return button('🔙 返回菜单', 'back_to_menu');
}

// ── Main menu card ────────────────────────────────────────────────────────

/**
 * The hub menu card — a single entry point covering every command, organized
 * by operating flow:
 *   1. 情境 / 会话 (高频率) → 续写 · 新会话 · 会话列表
 *   2. 环境 / 能力(设置·即改即显) → 工作区下拉 · 模型 · 预设 · 归档
 *   3. 任务追踪 → 关注任务(watch 引擎入口) · 状态
 *   4. 系统 → 帮助 · 修复(数字 9)
 * `ctx` bundle:
 *   - workspaces: string[]          (工作区下拉选项)
 *   - currentWorkspace: string|null (当前工作区,下拉高亮)
 *   - currentSession: {id,title}|null (当前绑定会话,续写目标)
 *   - sessions: {id,title}[]        (最近会话,供会话下拉切换)
 *   - watchCount: number            (关注任务数)
 *   - archiveVisible: boolean       (归档显隐开关当前值)
 * Number fallback: 1=续写 2=新会话 3=会话列表 4=关注任务 5=模型 6=预设
 * 7=状态 8=帮助 9=修复.
 */
export function menuCard(ctx) {
  const {
    workspaces = [],
    currentWorkspace = null,
    currentSession = null,
    sessions = [],
    watchCount = 0,
    archiveVisible = false,
  } = ctx || {};

  // currentSession 提供 id/title；为兼容旧调用，也接受 currentSessionTitle
  const currentSessionId = currentSession?.id ?? null;
  const currentSessionTitle = currentSession?.title ?? ctx?.currentSessionTitle ?? null;

  // 状态摘要：一眼看"当前是什么"
  const wsLabel = currentWorkspace || '未设置工作区';
  const sessLabel = currentSessionTitle ? `「${safeTitle(currentSessionTitle)}」` : '无会话';
  const elements = [
    { tag: 'div', text: markdown(`**📂 ${wsLabel}** · **💬 ${sessLabel}**`) },
    { tag: 'hr' },
  ];

  // ── 情境 / 会话（高频率）────────────────────────────────────
  elements.push({ tag: 'div', text: markdown('**情境 · 会话**') });
  // 会话下拉：列出最近会话，选择即切换（当前绑定会话带 ✓）
  const sessionOptions = (Array.isArray(sessions) ? sessions : []).slice(0, 20);
  if (sessionOptions.length > 0) {
    elements.push({
      tag: 'select_static',
      name: 'session_pick',
      placeholder: { tag: 'plain_text', content: '切换/续写会话' },
      initial_index: initialIndex(sessionOptions, currentSessionId),
      options: sessionOptions.map((s) => ({
        text: { tag: 'plain_text', content: `${s.id === currentSessionId ? '✓ ' : ''}${safeTitle(s.title)}` },
        value: s.id,
      })),
      behaviors: [{ type: 'callback', value: { action: 'session_pick' } }],
    });
    elements.push(buttonPair('🆕 新会话', 'new', '📋 全部会话', 'sessions'));
  } else {
    elements.push(buttonPair('🆕 新会话', 'new', '📋 会话列表', 'sessions'));
  }
  elements.push({ tag: 'hr' });

  // ── 工作区（环境上下文）────────────────────────────────────
  elements.push({ tag: 'div', text: markdown('**工作区**') });
  if (Array.isArray(workspaces) && workspaces.length > 0) {
    // 飞书 schema 2.0 的 select_static option 不支持 selected 字段，
    // 默认展示用 initial_index；文本 ✓ 前缀仅作额外视觉高亮。
    const wsOptions = workspaces.slice(0, 20).map((path) => ({
      text: { tag: 'plain_text', content: `${path === currentWorkspace ? '✓ ' : ''}${path}` },
      value: path,
    }));
    elements.push({
      tag: 'select_static',
      name: 'workspace_pick',
      placeholder: { tag: 'plain_text', content: '切换工作区' },
      initial_index: initialIndex(wsOptions, currentWorkspace),
      options: wsOptions,
      behaviors: [{ type: 'callback', value: { action: 'workspace_pick' } }],
    });
  } else {
    elements.push(button('🗂 工作区列表', 'workspaces'));
  }
  elements.push({ tag: 'hr' });

  // ── 任务控制（对运行中任务的操作）────────────────────────
  elements.push({ tag: 'div', text: markdown('**任务控制**') });
  elements.push(buttonPair('⏹ 停止', 'stop', '📐 压缩', 'compact'));
  elements.push({ tag: 'div', text: markdown('**补充指令**（下拉选择，最后一项可自定义）') });
  elements.push({
    tag: 'select_static',
    name: 'steer_pick',
    placeholder: { tag: 'plain_text', content: '选择补充指令' },
    initial_index: 1,
    options: [
      ...QUICK_STEER_OPTIONS.map((text) => ({
        text: { tag: 'plain_text', content: text },
        value: text,
      })),
      { text: { tag: 'plain_text', content: '✏️ 更多 / 自定义…' }, value: 'custom' },
    ],
    behaviors: [{ type: 'callback', value: { action: 'steer_pick' } }],
  });
  elements.push({ tag: 'hr' });

  // ── 任务追踪 ───────────────────────────────────────────────
  elements.push({ tag: 'div', text: markdown(`**任务追踪** · 👁 关注任务 ${watchCount}`) });
  elements.push(buttonPair('👁 关注任务', 'watchlist', '📊 状态', 'status'));
  elements.push({ tag: 'hr' });

  // ── 底部操作（低频配置收敛到「更多设置」）──────────────────
  elements.push(buttonPair('⚙ 更多设置', 'settings', '📖 帮助', 'help'));
  elements.push(button('🔧 修复卡片', 'repair'));

  // 命令与数字兜底说明（飞书 schema 2.0 不支持 collapse，用平铺文本）
  elements.push({ tag: 'div', text: markdown(
    '**数字兜底**\n'
    + '**1**续写 · **2**新会话 · **3**会话列表 · **4**关注 · **5**状态\n'
    + '**6**更多设置 · **7**帮助 · **8**修复',
  ) });
  elements.push({ tag: 'div', text: markdown(
    '**任务控制**（需先绑定会话）\n'
    + '`/stop` 停止 · `/steer <指令>` 补充指令',
  ) });
  return cardWith('🤖 助手中心', elements);
}

// ── Settings card (低频配置收敛面板) ───────────────────────────────────────

/**
 * The collapsed low-frequency configuration panel opened from the main menu's
 * "更多设置" button. Setting-type commands are exposed directly as dropdowns
 * (预设 / 模型 / 工作区) so they apply in place; 归档 is a simple two-state
 * toggle. `presetCatalog` matches the shape presetCard accepts
 * ({ items, defaultId, _currentId }); `modelCatalog` matches modelCard
 * ({ groups, current }).
 */
export function settingsCard({ archiveVisible, presetCatalog, modelCatalog, workspaces, currentWorkspace }) {
  const elements = [
    { tag: 'div', text: markdown('低频配置：直接在下拉中选择，即改即用。') },
    { tag: 'hr' },
  ];

  // ── 工作区下拉 ──────────────────────────────────────────────
  const wsList = Array.isArray(workspaces) ? workspaces : [];
  elements.push({ tag: 'div', text: markdown(`**🗂 工作区**：${currentWorkspace || '未设置'}`) });
  if (wsList.length > 0) {
    const wsSetOptions = wsList.slice(0, 20).map((path) => ({
      text: { tag: 'plain_text', content: `${path === currentWorkspace ? '✓ ' : ''}${path}` },
      value: path,
    }));
    elements.push({
      tag: 'select_static',
      name: 'workspace_pick',
      placeholder: { tag: 'plain_text', content: '切换工作区' },
      initial_index: initialIndex(wsSetOptions, currentWorkspace),
      options: wsSetOptions,
      behaviors: [{ type: 'callback', value: { action: 'workspace_pick' } }],
    });
  } else {
    elements.push(button('查看工作区列表', 'workspaces'));
  }
  elements.push({ tag: 'hr' });

  // ── 预设下拉 ────────────────────────────────────────────────
  const presetItems = Array.isArray(presetCatalog?.items) ? presetCatalog.items : [];
  const curPresetId = presetCatalog?._currentId ?? null;
  const presetFollowDefault = curPresetId === null;
  const defaultPresetItem = presetItems.find((i) => i.id === presetCatalog?.defaultId);
  const curPresetLabel = presetItems.find((i) => i.id === curPresetId)?.label
    ?? (presetFollowDefault
      ? `跟随默认（${defaultPresetItem ? `${defaultPresetItem.label}·${presetCatalog?.defaultId}` : '未设置'}）`
      : String(curPresetId));
  elements.push({ tag: 'div', text: markdown(`**🤖 预设**：${curPresetLabel}`) });
  if (presetItems.length >= 1) {
    // 「跟随默认」当前仅在一项时仍是有效选择；null 用 __default 哨兵值承载，
    // 保证下拉始终有一项能命中 initial_index（否则会显示占位文本）。
    const setPresetOptions = presetItems.slice(0, 30).map((item) => ({
      text: { tag: 'plain_text', content: `${item.id === curPresetId ? '✓ ' : ''}${item.label}` },
      value: item.id,
    }));
    const presetSelected = presetFollowDefault ? PRESET_FOLLOW_DEFAULT_SENTINEL : curPresetId;
    setPresetOptions.unshift({
      text: { tag: 'plain_text', content: `${presetFollowDefault ? '✓ ' : ''}跟随默认` },
      value: PRESET_FOLLOW_DEFAULT_SENTINEL,
    });
    elements.push({
      tag: 'select_static',
      name: 'preset_pick',
      placeholder: { tag: 'plain_text', content: '切换预设' },
      initial_index: initialIndex(setPresetOptions, presetSelected),
      options: setPresetOptions,
      behaviors: [{ type: 'callback', value: { action: 'preset_pick' } }],
    });
  } else {
    elements.push(button('🤖 切换预设', 'presets'));
  }
  elements.push({ tag: 'hr' });

  // ── 模型下拉 ────────────────────────────────────────────────
  const groups = Array.isArray(modelCatalog?.groups) ? modelCatalog.groups : [];
  const curModel = modelCatalog?.current;
  const curModelId = curModel ? `${curModel.provider}/${curModel.model}` : null;
  const flat = [];
  for (const group of groups) {
    for (const model of (group.models || [])) flat.push({ id: `${group.id}/${model.id}`, name: `${group.name} - ${model.name}` });
  }
  elements.push({ tag: 'div', text: markdown(`**🧠 模型**：${curModelId || '未设置'}`) });
  if (flat.length > 1) {
    const setModelOptions = flat.slice(0, 30).map((opt) => ({
      text: { tag: 'plain_text', content: `${opt.id === curModelId ? '✓ ' : ''}${opt.name}` },
      value: opt.id,
    }));
    elements.push({
      tag: 'select_static',
      name: 'model_pick',
      placeholder: { tag: 'plain_text', content: '切换模型' },
      initial_index: initialIndex(setModelOptions, curModelId),
      options: setModelOptions,
      behaviors: [{ type: 'callback', value: { action: 'model_pick' } }],
    });
  } else {
    elements.push(button('🧠 切换模型', 'models'));
  }
  elements.push({ tag: 'hr' });

  // ── 归档切换（二选一 → 点击切换）──────────────────────────
  elements.push({ tag: 'div', text: markdown(`**🗄 归档**：${archiveVisible ? '已显示' : '已隐藏'}`) });
  elements.push(button('切换归档显示', 'archive_toggle'));
  elements.push({ tag: 'hr' });
  elements.push(buttonPair('🔙 返回菜单', 'back_to_menu', '📖 帮助', 'help'));
  return cardWith('⚙ 更多设置', elements);
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
    ? `跟随 Host 默认${defaultItem ? `（${defaultItem.label}）` : ''}`
    : currentItem ? `${currentItem.label}（${currentItem.id}）` : `${current}（已不可用）`;

  const elements = [
    { tag: 'div', text: markdown(`**当前**：${currentText}`) },
    { tag: 'div', text: markdown(`**Host 默认**：${defaultItem ? `${defaultItem.label}（${defaultItem.id}）` : '未设置'}`) },
    { tag: 'hr' },
  ];

  if (items.length > 1) {
    const presetCardOptions = items.map((item) => ({
      text: { tag: 'plain_text', content: `${item.label}（${item.id}）${item.id === current ? ' ✓' : ''}` },
      value: item.id,
    }));
    elements.push(
      {
        tag: 'select_static',
        name: 'preset_pick',
        placeholder: { tag: 'plain_text', content: '选择预设' },
        initial_index: current === null ? 0 : initialIndex(presetCardOptions, current),
        options: presetCardOptions,
        behaviors: [{ type: 'callback', value: { action: 'preset_pick' } }],
      },
      { tag: 'hr' },
      buttonPair('🔄 跟随默认', 'preset_default', '🔙 返回菜单', 'back_to_menu'),
    );
  } else {
    elements.push(
      { tag: 'div', text: markdown('当前没有可选择的预设。') },
      backButton(),
    );
  }
  return cardWith('🤖 预设列表', elements);
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
    { tag: 'div', text: markdown(`**当前模型**：${currentId || '未设置'}`) },
    { tag: 'hr' },
  ];

  // Count total models
  let total = 0;
  for (const group of groups) total += group.models.length;

  if (total === 0) {
    elements.push(
      { tag: 'div', text: markdown('当前没有可用模型。') },
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
          id: `${group.id}/${model.id}`,
          name: `${group.name} - ${model.name}`,
        });
      }
    }

    elements.push(
      { tag: 'hr' },
      {
        tag: 'select_static',
        name: 'model_pick',
        placeholder: { tag: 'plain_text', content: '选择模型' },
        initial_index: currentId === null ? 0 : initialIndex(allOptions, currentId),
        options: allOptions.map((opt) => ({
          text: { tag: 'plain_text', content: `${opt.name}${opt.id === currentId ? ' ✓' : ''}` },
          value: opt.id,
        })),
        behaviors: [{ type: 'callback', value: { action: 'model_pick' } }],
      },
      { tag: 'hr' },
      backButton(),
    );
  }
  return cardWith('🧠 模型列表', elements);
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
    { tag: 'div', text: markdown(`${info.connected ? '✅' : '❌'} 飞书机器人${info.connected ? '已连接' : '未连接'}`) },
    { tag: 'div', text: markdown(`📂 工作区：\`${info.workspace || '未设置'}\``) },
    { tag: 'div', text: markdown(`🤖 预设：${info.preset || '未设置'}`) },
    { tag: 'div', text: markdown(`🧠 模型：${info.model || '未设置'}`) },
    { tag: 'div', text: markdown(`💬 会话：${info.sessionCount} 个`) },
    { tag: 'hr' },
    backButton(),
  ];
  return cardWith('📊 系统状态', elements);
}

// ── Help card ─────────────────────────────────────────────────────────────

/**
 * Help card with all available commands and their descriptions.
 */
export function helpCard() {
  const elements = [
    { tag: 'div', text: markdown('**回复数字或点击按钮使用功能**\n\n' +
      '📋 会话列表 — 查看/绑定已有会话\n' +
      '🆕 新会话 — 开启全新会话\n' +
      '📊 状态 — 查看系统连接状态\n' +
      '📐 压缩 — 压缩当前会话上下文\n' +
      '🤖 预设 — 选择 Agent 预设\n' +
      '🧠 模型 — 选择 AI 模型\n' +
      '🔍 关注列表 — 管理关注会话\n' +
      '🔄 修复 — 修复卡片按钮回调') },
    { tag: 'hr' },
    { tag: 'div', text: markdown('**文本命令**\n\n' +
      '`/session ID` — 绑定已有会话\n' +
      '`/workspace 路径` — 切换工作区\n' +
      '`/watch ID` — 关注会话（完成后推送）\n' +
      '`/stop` — 停止当前任务\n' +
      '`/steer 指令` — 给 Agent 补充指令\n' +
      '`/archived on/off` — 会话列表显示/隐藏归档\n' +
      '`/compact` — 压缩上下文\n' +
      '`/presetlist` — 列出预设\n' +
      '`/models` — 列出模型') },
    { tag: 'hr' },
    backButton(),
  ];
  return cardWith('📖 帮助', elements);
}

// ── One-shot callback probe (repair verification) ─────────────────────────

/** One-shot callback probe used only after an existing app was re-authorized. */
export function cardActionProbeCard(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new TypeError('A safe card-action probe nonce is required');
  }
  return cardWith('🧪 验证卡片按钮', [
    {
      tag: 'div',
      text: markdown('授权已提交。请点击下方按钮；机器人真实收到回调后才会判定修复成功。'),
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
          text: plainText('完成验证'),
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
    { tag: 'div', text: markdown(`**工作区**：\`${workspace}\`\n共 **${total}** 个会话${total > MENU_PAGE_SIZE ? `（第 ${page + 1}/${pageCount} 页）` : ''}`) },
    ...slice.map((session, offset) => {
      // Page-local numbering: number replies resolve against this page.
      const label = `${offset + 1}. ${safeTitle(session.title)}${session.archived === true ? '（已归档）' : ''}`;
      const watching = watched(session.sessionId);
      return row(
        buttonElement(watching ? '⭐取关' : '⭐关注', watching ? `unwatch:${session.sessionId}` : `watch:${session.sessionId}`),
        buttonElement(label, `use:${session.sessionId}`),
      );
    }),
  ];
  if (page > 0) elements.push(button('◀ 上一页', `sessions:${page - 1}`));
  if (page + 1 < pageCount) elements.push(button('下一页 ▶', `sessions:${page + 1}`));
  elements.push(
    { tag: 'hr' },
    buttonPair('🔙 返回菜单', 'back_to_menu', '🔍 关注列表', 'watchlist'),
    { tag: 'div', text: markdown('回复数字（1~N）绑定本页会话。') },
  );
  return cardWith('📂 会话列表', elements);
}

// ── Workspace list card (preserved, with back button) ─────────────────────

/** The workspace list card (switch-workspace buttons + reply fallback). */
export function workspaceListCard(paths, current) {
  const elements = paths.length === 0
    ? [
        { tag: 'div', text: markdown('当前 Host 上没有已登记的工作区。') },
        backButton(),
      ]
    : [
        { tag: 'div', text: markdown('回复数字切换工作区，或点击按钮：') },
        ...paths.map((path, index) => button(
          `${index + 1}. ${path}${path === current ? '（当前）' : ''}`,
          `workspace:${path}`,
        )),
        { tag: 'hr' },
        backButton(),
      ];
  return cardWith('🗂 工作区', elements);
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
    placeholder: { tag: 'plain_text', content: '勾选要关注的会话' },
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
    placeholder: { tag: 'plain_text', content: '勾选要取消关注的会话' },
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
    elements.push({ tag: 'div', text: markdown('当前没有关注的会话。任务完成会自动推送结果。') });
  } else {
    elements.push({ tag: 'div', text: markdown(`当前关注 **${watching.length}** 个会话：`) });
  }

  if (addSelect) {
    elements.push({ tag: 'hr' }, { tag: 'div', text: markdown('**➕ 添加关注**（多选下拉勾选）') }, addSelect);
  }
  if (removeSelect) {
    elements.push({ tag: 'hr' }, { tag: 'div', text: markdown('**➖ 取消关注**（多选下拉勾选）') }, removeSelect);
  }
  elements.push({ tag: 'hr' }, buttonPair('📋 会话列表', 'sessions', '🔙 返回菜单', 'back_to_menu'));
  return cardWith('👁 关注列表', elements);
}

// ── Completion push card ──────────────────────────────────────────────────

/**
 * The completion push card. `title` is the session title, `reason` the
 * turn-end kind (completed / stopped / aborted).
 */
export function completionCard(sessionId, title, reason) {
  const reasonText = reason === 'completed'
    ? '已完成'
    : reason === 'stopped'
      ? '已停止'
      : reason === 'aborted'
        ? '已中止'
        : reason === 'cancelled'
          ? '已取消'
          : '已结束';
  return cardWith('✅ 任务完成', [
    { tag: 'div', text: markdown(`**${safeTitle(title)}**\n\`${sessionId}\``) },
    { tag: 'div', text: markdown(`**状态**：${reasonText}`) },
    { tag: 'hr' },
    buttonPair('📋 会话列表', 'sessions', '🔙 返回菜单', 'back_to_menu'),
    { tag: 'div', text: markdown('绑定该会话后可继续追问，输入文字即可。') },
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
    ? '从下方下拉选择补充指令；最后一项可自定义输入。'
    : '当前没有绑定会话，请先绑定会话再补充指令。';
  const options = QUICK_STEER_OPTIONS.map((text) => ({
    text: { tag: 'plain_text', content: text },
    value: text,
  }));
  options.push({ text: { tag: 'plain_text', content: '✏️ 更多 / 自定义…' }, value: STEER_CUSTOM_SENTINEL });
  const elements = [
    { tag: 'div', text: markdown(hint) },
    { tag: 'hr' },
    {
      tag: 'select_static',
      name: 'steer_quick',
      placeholder: { tag: 'plain_text', content: '选择补充指令' },
      initial_index: 1,
      options,
      behaviors: [{ type: 'callback', value: { action: 'steer', source: 'quick' } }],
    },
    { tag: 'hr' },
    button('🔙 返回菜单', 'back_to_menu'),
  ];
  return cardWith('➕ 补充指令', elements);
}

/** 自定义输入卡：输入框 + 提交（从下拉「更多/自定义」切过来）。 */
export function customSteerCard() {
  const elements = [
    { tag: 'div', text: markdown('输入补充指令后点「提交」，发送给当前运行的任务。') },
    { tag: 'hr' },
    {
      tag: 'input',
      name: 'steer_text',
      placeholder: { tag: 'plain_text', content: '输入你的补充指令' },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '提交' },
      type: 'primary',
      width: 'fill',
      behaviors: [{ type: 'callback', value: { action: 'steer', source: 'form' } }],
    },
    { tag: 'hr' },
    button('🔙 返回菜单', 'back_to_menu'),
  ];
  return cardWith('➕ 自定义指令', elements);
}