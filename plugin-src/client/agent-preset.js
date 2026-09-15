import * as React from 'react';

import { h } from './i18n.js';
import { RowSelect } from './row-selector.js';

export const SET_AGENT_PRESET_ENDPOINT = 'bot.preset.set';

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

export const EMPTY_AGENT_PRESET_CATALOG = Object.freeze({
  defaultId: '',
  items: Object.freeze([]),
});

export const AgentPresetCatalogContext = React.createContext(EMPTY_AGENT_PRESET_CATALOG);

export function normalizeAgentPresetId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return PRESET_ID.test(id) ? id : '';
}

export function normalizeAgentPresetCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { defaultId: '', items: [] };
  }
  const items = [];
  const seen = new Set();
  for (const entry of Array.isArray(value.items) ? value.items : []) {
    const id = typeof entry === 'string'
      ? normalizeAgentPresetId(entry)
      : normalizeAgentPresetId(entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry?.label === 'string' && entry.label.trim()
      ? entry.label.trim().slice(0, 128)
      : typeof entry?.name === 'string' && entry.name.trim()
        ? entry.name.trim().slice(0, 128)
        : id;
    items.push({ id, label });
  }
  return {
    defaultId: normalizeAgentPresetId(value.defaultId),
    items,
  };
}

export function AgentPresetEditor({ agentPreset = '', disabled = false, onSave }) {
  const catalog = React.useContext(AgentPresetCatalogContext) ?? EMPTY_AGENT_PRESET_CATALOG;
  const helpId = React.useId();
  const current = normalizeAgentPresetId(agentPreset);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const items = [];
  const seen = new Set();
  for (const item of Array.isArray(catalog.items) ? catalog.items : []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  const currentUnavailable = Boolean(current && !seen.has(current));
  if (currentUnavailable) items.push({ id: current, label: current, unavailable: true });

  const inheritLabel = '跟随 Host 默认';

  const change = async (next) => {
    if (next === current || saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await onSave?.(next || null);
    } catch (cause) {
      setError(cause?.message ?? 'Agent 预设修改失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return h('div', { className: 'dim-preset' },
    // Native row anatomy: the setting's name is the row's title on the left, the
    // control sits in the right slot at its own width. The heading keeps only the
    // save status, so the title is not stated twice.
    saving ? h('div', { className: 'dim-presetHeader' },
      h('span', { className: 'dim-presetStatus' }, '保存中…')) : null,
    /* A div, not a label. A label wrapping a row makes a click anywhere in the row - the
       setting's own name included - activate the control it labels, so the menu opened
       from the text. The host's rows are not labels either: only the control is
       clickable. The selector carries its own accessible name (label: 'Agent 预设'). */
    h('div', { className: 'dim-modelRow' },
      h('span', { className: 'dim-rowText' },
        h('span', { className: 'dim-modelRowLabel' }, 'Agent 预设')),
      h(RowSelect, {
        className: 'dim-presetSelect dim-rowControl',
        value: current,
        disabled: disabled || saving,
        label: 'Agent 预设',
        onChange: (next) => { void change(next); },
        options: [
          { value: '', label: inheritLabel },
          ...items.map((item) => ({
            value: item.id,
            label: item.unavailable
              ? item.id + '（已不可用）'
              : item.label && item.label !== item.id ? `${item.label}（${item.id}）` : item.id,
          })),
        ],
      })),
    error || currentUnavailable ? h(
      'p',
      { className: 'dim-presetError', role: error ? 'alert' : 'status' },
      error ?? '当前 Agent 预设已不可用，请选择其他预设或跟随 Host 默认。',
    ) : null,
  );
}
