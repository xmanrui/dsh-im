/**
 * Feishu interactive-card builders for the dsh-im menu / session-list /
 * completion-notification UX. All builders return the JSON string the
 * `im.message.create` API expects as `content` for `msg_type: interactive`
 * (card schema 2.0, lark_md where formatting is wanted).
 *
 * Card schema 2.0 has NO `action` container anymore — buttons are plain
 * body elements (stacked vertically). Buttons carry a small `{ action }`
 * value object that `card.action.trigger` events echo back (when the app
 * subscribes that event); every button also carries a numeric label so the
 * number-reply fallback stays usable without button callbacks.
 */

export const MENU_PAGE_SIZE = 10;

function plainText(content) {
  return { tag: 'plain_text', content: String(content) };
}

function markdown(content) {
  return { tag: 'lark_md', content: String(content) };
}

function button(content, actionValue) {
  return {
    tag: 'button',
    text: plainText(content),
    type: 'default',
    value: { action: actionValue },
  };
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

/** The main command menu (buttons + number-reply fallback). */
export function menuCard() {
  return cardWith('🤖 助手菜单', [
    { tag: 'div', text: markdown('**点击按钮或直接回复数字**') },
    button('1 · 会话列表', 'sessions'),
    button('2 · 工作区', 'workspaces'),
    button('3 · 新会话', 'new'),
    button('4 · 状态', 'status'),
    button('5 · 关注完成通知', 'watchlist'),
    button('6 · 帮助', 'help'),
  ]);
}

/**
 * One page of the workspace's sessions. Each row is a bind button; the
 * number label equals the reply-number for the same action (fallback).
 */
export function sessionListCard(workspace, sessions, start, total) {
  const page = sessions.slice(start, start + MENU_PAGE_SIZE);
  const elements = [
    { tag: 'div', text: markdown(`**工作区**：\`${workspace}\`\n共 **${total}** 个会话${total > MENU_PAGE_SIZE ? `（本页 ${start + 1}-${Math.min(start + page.length, total)}）` : ''}`) },
    ...page.map((session, offset) => button(
      `${start + offset + 1}. ${safeTitle(session.title)}`,
      `use:${session.sessionId}`,
    )),
  ];
  if (start > 0) elements.push(button('◀ 上一页', `sessions:${Math.max(0, start - MENU_PAGE_SIZE)}`));
  if (total > start + MENU_PAGE_SIZE) elements.push(button('下一页 ▶', `sessions:${start + MENU_PAGE_SIZE}`));
  elements.push({ tag: 'div', text: markdown('回复数字（1~N）同样可以绑定本页会话。') });
  return cardWith('📂 会话列表', elements);
}

/** The workspace list card (switch-workspace buttons + reply fallback). */
export function workspaceListCard(paths, current) {
  const elements = paths.length === 0
    ? [{ tag: 'div', text: markdown('当前 Host 上没有已登记的工作区。') }]
    : [
        { tag: 'div', text: markdown(`回复数字切换工作区，或点击按钮：`) },
        ...paths.map((path, index) => button(
          `${index + 1}. ${path}${path === current ? '（当前）' : ''}`,
          `workspace:${path}`,
        )),
      ];
  return cardWith('🗂 工作区', elements);
}

/** The watch-list card (one unwatch button per watched session). */
export function watchListCard(watches) {
  if (watches.length === 0) {
    return cardWith('🔔 完成通知', [{ tag: 'div', text: markdown('还没有关注的会话。\n用法：`/watch Session ID 或序号`，完成后在这里推送通知。') }]);
  }
  return cardWith('🔔 完成通知', [
    { tag: 'div', text: markdown('以下会话完成后会推送到本对话（点击取消关注）：') },
    ...watches.map((watch) => button(
      `取消 · ${safeTitle(watch.title)}`,
      `unwatch:${watch.sessionId}`,
    )),
  ]);
}

/** A session-turn completion notification card. */
export function completionCard(entry, { durationMs, reasonText }) {
  const lines = [
    `**✅ 会话完成**：${safeTitle(entry.title)}`,
    `工作区：\`${entry.workspace ?? ''}\``,
    ...(durationMs !== null ? [`用时：${formatDuration(durationMs)}`] : []),
    `结果：${reasonText}`,
    `回复 \`/session ${entry.sessionId}\` 可绑定继续，或回复任意消息继续当前会话。`,
  ].join('\n');
  return cardWith('🔔 完成通知', [{ tag: 'div', text: markdown(lines) }]);
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** The expanded help text listing every command (shared by /m and /help). */
export function menuHelpText() {
  return [
    '🤖 助手菜单（回复 /m 打开卡片，或直接回复数字）',
    '',
    '1 · /sessionlist  列出会话（回复数字绑定）',
    '2 · /workspacelist  列出工作区（回复数字切换）',
    '3 · /new  开启新会话',
    '4 · /status  连接状态',
    '5 · /watchlist  查看完成通知关注',
    '6 · /help  本帮助',
    '',
    '直接发送文字/图片即继续当前会话。',
    '/session ID 或序号  绑定已有会话',
    '/watch ID 或序号  关注会话，完成后推送',
    '/unwatch ID  取消关注',
    '/compact  压缩上下文',
    '/workspace 绝对路径  切换工作区',
  ].join('\n');
}
