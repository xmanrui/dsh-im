import * as React from 'react';

import { h } from './i18n.js';

export const SET_ISOLATE_WORKSPACE_ENDPOINT = 'bot.workspace.isolate.set';

export function IsolateWorkspaceEditor({ enabled = false, disabled = false, onSave }) {
  const helpId = React.useId();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const change = async (event) => {
    const next = event.target.checked === true;
    if (next === enabled || saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await onSave?.(next);
    } catch (cause) {
      setError(cause?.message ?? '工作区隔离设置保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return h('div', { className: 'dim-preset dim-isolateWorkspace' },
    h('label', { className: 'dim-contextSwitchRow' },
      h('span', { className: 'dim-presetTitle' },
        h('span', null, '按聊天隔离工作区'),
        h('span', { className: 'dim-presetHelp' },
          h('button', {
            type: 'button',
            className: 'dim-presetHelpButton',
            'aria-label': '查看按聊天隔离工作区说明',
            'aria-describedby': helpId,
          }, h('span', { 'aria-hidden': 'true' }, '?')),
          h('span', {
            id: helpId,
            className: 'dim-presetTooltip',
            role: 'tooltip',
          }, '开启后，群聊或私聊里的 /workspace、菜单切换和跨工作区 /session 只影响当前聊天，不会改掉同一机器人的其他群。关闭后仍整台机器人共用一个工作区。')),
      ),
      saving ? h('span', { className: 'dim-presetStatus' }, '保存中…') : h('input', {
        type: 'checkbox',
        role: 'switch',
        className: 'dim-contextSwitch',
        checked: enabled === true,
        disabled: disabled || saving,
        'aria-label': '按聊天隔离工作区',
        onChange: change,
      })),
    error ? h('p', { className: 'dim-presetError' }, error) : null);
}
