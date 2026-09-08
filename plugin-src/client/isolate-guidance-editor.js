import * as React from 'react';

import { h } from './i18n.js';

export const SET_ISOLATE_GUIDANCE_ENDPOINT = 'bot.guidance.isolate.set';

export function IsolateGuidanceEditor({ enabled = false, disabled = false, onSave }) {
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
      setError(cause?.message ?? '提示词隔离设置保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return h('div', { className: 'dim-preset dim-isolateWorkspace dim-isolateGuidance' },
    h('label', { className: 'dim-contextSwitchRow' },
      h('span', { className: 'dim-presetTitle' },
        h('span', null, '按聊天隔离提示词'),
        h('span', { className: 'dim-presetHelp' },
          h('button', {
            type: 'button',
            className: 'dim-presetHelpButton',
            'aria-label': '查看按聊天隔离提示词说明',
            'aria-describedby': helpId,
          }, h('span', { 'aria-hidden': 'true' }, '?')),
          h('span', {
            id: helpId,
            className: 'dim-presetTooltip',
            role: 'tooltip',
          }, '开启后，群聊或私聊里的 /guidance 只改当前聊天的增强提示词，不会改掉同一机器人的其他群。设置页仍编辑整台机器人的默认提示词。关闭后仍整台机器人共用群聊/私聊各一份提示词。')),
      ),
      saving ? h('span', { className: 'dim-presetStatus' }, '保存中…') : h('input', {
        type: 'checkbox',
        role: 'switch',
        className: 'dim-contextSwitch',
        checked: enabled === true,
        disabled: disabled || saving,
        'aria-label': '按聊天隔离提示词',
        onChange: change,
      })),
    error ? h('p', { className: 'dim-presetError' }, error) : null);
}
