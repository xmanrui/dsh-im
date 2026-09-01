import * as React from 'react';

import { h } from './i18n.js';
import {
  MODEL_COMPONENT_ID,
  normalizeDefaultModelSelection,
} from '../../src/channels/shared/default-model.mjs';

export { normalizeDefaultModelSelection };

export const SET_DEFAULT_MODEL_ENDPOINT = 'bot.model.set';
export const MODEL_CATALOG_ENDPOINT = 'bot.model.catalog';

export const EMPTY_MODEL_CATALOG = Object.freeze({
  groups: Object.freeze([]),
  failures: Object.freeze([]),
  current: null,
});

export const ModelCatalogContext = React.createContext(EMPTY_MODEL_CATALOG);

function componentId(value) {
  return typeof value === 'string' && MODEL_COMPONENT_ID.test(value.trim())
    ? value.trim()
    : '';
}

function normalizeCatalogModel(value) {
  if (typeof value === 'string') {
    const id = componentId(value);
    return id ? { id, name: id } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const id = componentId(value.id);
  if (!id) return null;
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, 128)
    : id;
  return { id, name };
}

function normalizeCatalogGroup(value) {
  if (!value || typeof value !== 'object') return null;
  const id = componentId(value.id);
  if (!id) return null;
  const models = [];
  const seen = new Set();
  for (const model of Array.isArray(value.models) ? value.models : []) {
    const normalized = normalizeCatalogModel(model);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    models.push(normalized);
  }
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, 128)
    : id;
  return { id, name, models };
}

export function normalizeModelCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { groups: [], failures: [], current: null };
  }
  const groups = [];
  const seenGroups = new Set();
  for (const group of Array.isArray(value.groups) ? value.groups : []) {
    const normalized = normalizeCatalogGroup(group);
    if (!normalized || seenGroups.has(normalized.id)) continue;
    seenGroups.add(normalized.id);
    groups.push(normalized);
  }
  const failures = [];
  for (const failure of Array.isArray(value.failures) ? value.failures : []) {
    const id = componentId(failure?.id);
    if (!id) continue;
    failures.push({
      id,
      name: typeof failure?.name === 'string' && failure.name.trim()
        ? failure.name.trim().slice(0, 128)
        : id,
    });
  }
  const currentSelection = normalizeDefaultModelSelection(value.current);
  return { groups, failures, current: currentSelection };
}

function selectionId(selection) {
  return selection ? `${selection.provider}/${selection.model}` : '';
}

export function DefaultModelEditor({
  defaultModel = null,
  disabled = false,
  onSave,
  catalogError = null,
  onRefreshCatalog = null,
}) {
  const catalog = React.useContext(ModelCatalogContext) ?? EMPTY_MODEL_CATALOG;
  const helpId = React.useId();
  const current = normalizeDefaultModelSelection(defaultModel);
  const currentId = selectionId(current);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  const knownIds = new Set();
  for (const group of groups) {
    for (const model of group.models ?? []) knownIds.add(`${group.id}/${model.id}`);
  }
  const hostCurrentId = selectionId(catalog.current);
  const currentUnavailable = Boolean(currentId && !knownIds.has(currentId));

  const inheritLabel = hostCurrentId
    ? `跟随 Host 默认（当前：${hostCurrentId}）`
    : '跟随 Host 默认';

  const change = async (event) => {
    const next = event.target.value;
    if (next === currentId || saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      if (!next) {
        await onSave?.(null);
      } else {
        const [provider, ...rest] = next.split('/');
        const model = rest.join('/');
        // Re-selecting the configured model keeps its reasoning effort.
        const selection = current && currentId === next
          ? current
          : { provider, model };
        await onSave?.(selection);
      }
    } catch (cause) {
      setError(cause?.message ?? '默认模型修改失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return h('div', { className: 'dim-preset' },
    h('div', { className: 'dim-presetHeader' },
      h('span', { className: 'dim-presetTitle' },
        h('span', null, '默认模型'),
        h('span', { className: 'dim-presetHelp' },
          h('button', {
            type: 'button',
            className: 'dim-presetHelpButton',
            'aria-label': '查看默认模型说明',
            'aria-describedby': helpId,
          }, h('span', { 'aria-hidden': 'true' }, '?')),
          h('span', {
            id: helpId,
            className: 'dim-presetTooltip',
            role: 'tooltip',
          }, '只影响新建会话；若当前聊天已有会话，先发送 /new，再发送普通消息生效。'))),
      saving ? h('span', { className: 'dim-presetStatus' }, '保存中…') : null),
    React.createElement('select', {
      className: 'dim-presetSelect',
      value: currentId,
      disabled: disabled || saving,
      'aria-label': '默认模型',
      onChange: (event) => { void change(event); },
    },
      h('option', { value: '' }, inheritLabel),
      ...groups.map((group) => React.createElement(
        'optgroup',
        { key: group.id, label: group.name && group.name !== group.id ? group.name : group.id },
        ...group.models.map((model) => {
          const id = `${group.id}/${model.id}`;
          const label = model.name && model.name !== model.id
            ? `${model.name}（${model.id}）`
            : model.id;
          return h('option', {
            key: id,
            value: id,
          }, id === hostCurrentId ? [label, '（Host 当前）'] : label);
        }),
      )),
      currentUnavailable
        ? h('option', { value: currentId }, [currentId, '（已不可用）'])
        : null,
    ),
    error || currentUnavailable ? h(
      'p',
      { className: 'dim-presetError', role: error ? 'alert' : 'status' },
      error ?? '当前配置的默认模型已不可用，请重新选择或跟随 Host 默认。',
    ) : null,
    catalogError && groups.length === 0 ? h('p', {
      className: 'dim-presetError',
      role: 'alert',
    },
      catalogError,
      onRefreshCatalog ? h('button', {
        type: 'button',
        className: 'dim-presetHelpButton',
        onClick: () => { void onRefreshCatalog(); },
        style: { marginLeft: '8px' },
      }, '重新获取') : null,
    ) : null,
  );
}
