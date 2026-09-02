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
 * Per-bot inbound attachment retention editor: a dropdown that applies the
 * selection immediately, plus a double-confirm "clear directory" action.
 */
export function InboundAttachmentEditor({
  retention,
  busy = false,
  onSave,
  onClear,
}) {
  const [confirmingClear, setConfirmingClear] = React.useState(false);
  const current = retention === 'forever' ? 'forever' : 'turn';
  React.useEffect(() => {
    if (!confirmingClear) return undefined;
    const timer = setTimeout(() => setConfirmingClear(false), 8_000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  return h('div', { className: 'dim-preset dim-inboundRetention' },
    h('div', { className: 'dim-presetHeader dim-inboundRetentionHeader' },
      h('span', { className: 'dim-presetTitle' }, '入站附件保留策略'),
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
      }, confirmingClear ? '再次点击确认清空' : '清空附件目录') : null),
    h('select', {
      className: 'dim-presetSelect dim-inboundRetentionSelect',
      'aria-label': '入站附件保留策略',
      value: current,
      disabled: Boolean(busy),
      onChange: (event) => {
        const next = event?.target?.value === 'forever' ? 'forever' : 'turn';
        if (next !== current) onSave?.(next);
      },
    }, RETENTION_OPTIONS.map((option) => h('option', {
      key: option.value,
      value: option.value,
    }, option.label))));
}
