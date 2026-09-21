import * as React from 'react';

import {
  CONVERSATION_DIRECTORY_STRATEGIES,
  DEFAULT_CONVERSATION_DIRECTORY_SETTINGS,
  normalizeConversationDirectorySettings,
  validateConversationDirectorySettings,
} from '../../src/channels/shared/conversation-directory.mjs';
import { h } from './i18n.js';

const STRATEGY_LABELS = Object.freeze({
  'per-conversation': '每对话一个目录',
  'per-session': '每会话一个目录',
});

const SCOPE_TITLES = Object.freeze({
  bot: '会话目录隔离',
  channel: '渠道默认 · 会话目录隔离',
});

/**
 * Compact isolation switch: enabled / strategy / prefix. Saves as one atomic
 * config object so a damaged field never leaves a half-written toggle.
 *
 * `scope: 'channel'` targets the channel-wide default (no botId). `scope: 'bot'`
 * writes a per-bot override; when `hasOverride` is false the card only displays
 * the inherited channel default and a follow control.
 */
export function ConversationDirectoryEditor({
  config,
  scope = 'bot',
  hasOverride = true,
  disabled = false,
  onSave,
  onClear,
}) {
  const settings = normalizeConversationDirectorySettings(config);
  const [enabled, setEnabled] = React.useState(settings.enabled);
  const [strategy, setStrategy] = React.useState(settings.strategy);
  const [prefix, setPrefix] = React.useState(settings.prefix);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    setEnabled(settings.enabled);
    setStrategy(settings.strategy);
    setPrefix(settings.prefix);
  }, [settings.enabled, settings.strategy, settings.prefix]);

  const save = React.useCallback(async (next) => {
    const payload = {
      enabled: next.enabled,
      strategy: next.strategy,
      prefix: next.prefix || DEFAULT_CONVERSATION_DIRECTORY_SETTINGS.prefix,
    };
    try {
      validateConversationDirectorySettings(payload);
    } catch (cause) {
      setError(cause?.message ?? '会话目录设置无效。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave?.(payload);
    } catch (cause) {
      setError(cause?.message ?? '会话目录设置保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const clear = React.useCallback(async () => {
    if (typeof onClear !== 'function') return;
    setSaving(true);
    setError(null);
    try {
      await onClear();
    } catch (cause) {
      setError(cause?.message ?? '清除渠道默认失败，请重试。');
    } finally {
      setSaving(false);
    }
  }, [onClear]);

  const busy = disabled || saving;
  const title = SCOPE_TITLES[scope] ?? SCOPE_TITLES.bot;
  const showClear = scope === 'channel' && typeof onClear === 'function';
  const showFields = enabled || (scope === 'bot' && hasOverride);
  const helpId = React.useId();
  const helpText = scope === 'channel'
    ? '影响本渠道全部无覆盖的机器人。开启后 /workspace、/conv 与手动改工作区不可用。前缀或策略改动在下一个新会话生效（发送 /new 即切换），旧目录保留不删除。'
    : '开启后工作目录按对话自动派生；/workspace、/conv 与手动改工作区不可用；/session 仅可绑定本目录内会话。前缀或策略改动在下一个新会话生效（发送 /new 即切换），旧目录保留不删除。';

  return h('div', {
    className: 'dim-conversationDirectory',
    'data-conversation-directory-scope': scope,
  },
    h('div', { className: 'dim-conversationDirectoryHeader' },
      h('span', { className: 'dim-conversationDirectoryTitle' },
        h('span', null, title),
        h('span', { className: 'dim-conversationDirectoryHelp' },
          h('button', {
            type: 'button',
            className: 'dim-conversationDirectoryHelpButton',
            'aria-label': '查看会话目录隔离说明',
            'aria-describedby': helpId,
          }, h('span', { 'aria-hidden': 'true' }, '?')),
          h('span', { id: helpId, className: 'dim-conversationDirectoryTooltip', role: 'tooltip' }, helpText))),
      h('label', { className: 'dim-contextSwitchRow' },
        h('span', { className: 'dim-contextSwitchLabel' }, enabled ? '已开启' : '已关闭'),
        h('input', {
          type: 'checkbox',
          role: 'switch',
          className: 'dim-contextSwitch',
          checked: enabled,
          disabled: busy,
          onChange: (event) => {
            const nextEnabled = event.target.checked;
            setEnabled(nextEnabled);
            void save({ enabled: nextEnabled, strategy, prefix });
          },
        }))),
    scope === 'bot' && !hasOverride
      ? h('div', { className: 'dim-summary' }, '未覆盖 · 当前继承渠道默认；打开开关可单独为本机器人覆盖。')
      : null,
    showFields ? h('div', { className: 'dim-conversationDirectoryFields' },
      h('label', { className: 'dim-conversationDirectoryField' },
        h('span', null, '策略'),
        h('select', {
          value: strategy,
          disabled: busy,
          onChange: (event) => {
            const nextStrategy = event.target.value;
            setStrategy(nextStrategy);
            void save({ enabled, strategy: nextStrategy, prefix });
          },
        }, CONVERSATION_DIRECTORY_STRATEGIES.map((value) => h('option', {
          key: value,
          value,
        }, STRATEGY_LABELS[value] ?? value)))),
      h('label', { className: 'dim-conversationDirectoryField' },
        h('span', null, '前缀'),
        h('input', {
          type: 'text',
          value: prefix,
          disabled: busy,
          maxLength: 32,
          onChange: (event) => setPrefix(event.target.value),
          onBlur: () => {
            if (prefix !== settings.prefix) void save({ enabled, strategy, prefix });
          },
        }))) : null,
    showClear
      ? h('div', { className: 'dim-conversationDirectoryActions' },
          h('button', {
            type: 'button',
            className: 'dim-workspaceEdit',
            disabled: busy,
            onClick: () => { void clear(); },
          }, '清除渠道默认'))
      : null,
    error ? h('div', { className: 'dim-summary dim-cardFeedback', role: 'alert' }, error) : null,
  );
}
