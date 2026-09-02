import * as React from 'react';

import { h } from './i18n.js';

const RETENTION_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'turn',
    label: '临时附件（每轮对话后自动清理）',
  }),
  Object.freeze({
    value: 'forever',
    label: '永久附件（保留至手动删除）',
  }),
]);

/**
 * Per-bot inbound attachment retention editor: turn-based auto cleanup versus
 * workspace-persisted attachments with a manual "clear directory" action.
 */
export function InboundAttachmentEditor({
  retention,
  busy = false,
  onSave,
  onClear,
}) {
  const [draft, setDraft] = React.useState(retention === 'forever' ? 'forever' : 'turn');
  const [confirmingClear, setConfirmingClear] = React.useState(false);
  React.useEffect(() => {
    setDraft(retention === 'forever' ? 'forever' : 'turn');
  }, [retention]);
  React.useEffect(() => {
    if (!confirmingClear) return undefined;
    const timer = setTimeout(() => setConfirmingClear(false), 8_000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  const dirty = draft !== (retention === 'forever' ? 'forever' : 'turn');

  return h('div', { className: 'dim-inboundRetention' },
    h('div', { className: 'dim-inboundRetentionTitle', role: 'group', 'aria-label': '入站附件保留策略' },
      RETENTION_OPTIONS.map((option) => h('label', {
        key: option.value,
        className: 'dim-inboundRetentionOption',
      },
      h('input', {
        type: 'radio',
        name: 'dim-inbound-retention',
        value: option.value,
        checked: draft === option.value,
        disabled: Boolean(busy),
        onChange: () => setDraft(option.value),
      }),
      h('span', null, option.label)))),
    h('div', { className: 'dim-inboundRetentionActions' },
      h('button', {
        type: 'button',
        className: 'dim-inboundRetentionSave',
        onClick: () => onSave?.(draft),
        disabled: Boolean(busy) || (!dirty && draft === retention),
      }, '保存保留策略'),
      onClear ? h('button', {
        type: 'button',
        className: 'dim-inboundRetentionClear',
        onClick: () => {
          if (!confirmingClear) {
            setConfirmingClear(true);
            return;
          }
          setConfirmingClear(false);
          onClear();
        },
        disabled: Boolean(busy),
      }, confirmingClear ? '再次点击确认清空' : '清空附件目录') : null));
}
