import * as React from 'react';

import { h, localizeText } from '../../i18n.js';
import {
  FEISHU_ENDPOINTS,
  normalizeBotsSnapshot,
  presentError,
  unwrapRpcResult,
} from './api.js';
import {
  SLASH_COMMAND_MANIFEST,
  SLASH_PANEL_MODES,
  normalizeSlashPanelConfig,
} from '../../../../src/channels/feishu/slash-command-panel.mjs';

const MANIFEST_BY_NAME = new Map(SLASH_COMMAND_MANIFEST.map((entry) => [entry.command, entry]));
const ALL_COMMANDS = Object.freeze(SLASH_COMMAND_MANIFEST.map((entry) => entry.command));

function PanelButton({ children, disabled = false, onClick, ...props }) {
  return h('button', {
    ...props,
    type: 'button',
    className: 'dim-deliveryButton',
    disabled,
    onClick,
  }, children);
}

function panelSignature(panel) {
  const normalized = normalizeSlashPanelConfig(panel);
  return `${normalized.mode}:${normalized.order.join(',')}`;
}

function commandText(name) {
  const entry = MANIFEST_BY_NAME.get(name);
  return `/${name} — ${entry?.default ?? name}`;
}

/**
 * "指令面板" settings page: which commands the Feishu "/" panel offers, and in
 * which order.
 *
 * The panel lives on Feishu's side per app, so saving only records the choice;
 * the Host re-syncs the app in the background (creating and removing commands,
 * one per second, because Feishu returns the panel in creation order).
 */
export function FeishuSlashPanelSettingsPage({ account, rpcCall }) {
  const incoming = React.useMemo(() => normalizeSlashPanelConfig(account.slashPanel), [account.botId, panelSignature(account.slashPanel)]);
  const [mode, setMode] = React.useState(incoming.mode);
  const [order, setOrder] = React.useState(() => [...incoming.order]);
  const [pending, setPending] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A status refresh must not discard what the reader is editing; once saved,
  // the next snapshot becomes the new baseline.
  React.useEffect(() => {
    if (dirty) return;
    setMode(incoming.mode);
    setOrder([...incoming.order]);
  }, [incoming.mode, incoming.order, dirty]);

  const edit = React.useCallback((update) => {
    setSaved(false);
    setDirty(true);
    update();
  }, []);

  const move = (index, offset) => edit(() => {
    const next = [...order];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  });

  const remove = (index) => edit(() => setOrder(order.filter((_, at) => at !== index)));

  const add = () => {
    if (!pending || order.includes(pending)) return;
    edit(() => setOrder([...order, pending]));
    setPending('');
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (typeof rpcCall !== 'function') throw new Error('飞书指令面板设置暂不可用。');
      const payload = mode === SLASH_PANEL_MODES.CUSTOM
        ? { mode: SLASH_PANEL_MODES.CUSTOM, order: [...order] }
        : { mode: SLASH_PANEL_MODES.DEFAULT, order: [] };
      const value = unwrapRpcResult(await rpcCall(
        FEISHU_ENDPOINTS.setSlashPanel,
        { botId: account.botId, slashPanel: payload },
      ));
      if (!mounted.current) return;
      const snapshot = normalizeBotsSnapshot(value);
      const bot = snapshot.bots.find((entry) => entry.botId === account.botId);
      const stored = normalizeSlashPanelConfig(bot?.slashPanel);
      setMode(stored.mode);
      setOrder([...stored.order]);
      setDirty(false);
      setSaved(true);
    } catch (cause) {
      if (!mounted.current) return;
      setError(presentError(cause));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const available = ALL_COMMANDS.filter((name) => !order.includes(name));

  return h('section', {
    className: 'dim-feishuGroupSettings',
    'aria-label': '指令面板设置',
  },
  h('section', {
    className: 'dim-feishuGroupControl',
    'aria-labelledby': 'dim-feishu-slash-panel-title',
  },
  h('div', { className: 'dim-feishuGroupControlHeader' },
    h('h3', { id: 'dim-feishu-slash-panel-title' }, '指令面板'),
    saving
      ? h('span', { className: 'dim-feishuGroupControlStatus', role: 'status' }, '保存中…')
      : saved
        ? h('span', { className: 'dim-feishuGroupControlStatus', role: 'status' }, '已保存，面板稍后同步')
        : null),
  h('p', { className: 'dim-feishuGroupHelp' },
    '面板只决定聊天输入框里打「/」时列出的指令和顺序；被移除的指令仍可手动输入，功能不受影响。同步由机器人后台完成，指令较多时需要一点时间。'),
  h('select', {
    className: 'dim-feishuGroupSelect',
    value: mode,
    'aria-label': '指令面板模式',
    disabled: saving,
    onChange: (event) => edit(() => {
      const next = event.target.value;
      setMode(next);
      // Switching to a custom panel starts from everything, in the shipped
      // order, so the reader only has to remove what they do not want.
      if (next === SLASH_PANEL_MODES.CUSTOM && order.length === 0) setOrder([...ALL_COMMANDS]);
    }),
  },
  h('option', { value: SLASH_PANEL_MODES.DEFAULT }, '跟随默认（随插件版本更新）'),
  h('option', { value: SLASH_PANEL_MODES.CUSTOM }, '自定义（自己挑指令和顺序）')),
  mode === SLASH_PANEL_MODES.CUSTOM
    ? h(React.Fragment, null,
      order.length === 0
        ? h('p', { className: 'dim-feishuGroupHelp' }, '当前没有选择任何指令，保存后「/」面板会变成空的。')
        : h('ul', { className: 'dim-feishuPanelList' },
          order.map((name, index) => h('li', {
            key: name,
            className: 'dim-feishuPanelRow',
          },
          h('span', { className: 'dim-feishuPanelIndex' }, String(index + 1)),
          h('span', { className: 'dim-feishuPanelCommand' }, commandText(name)),
          h('span', { className: 'dim-feishuPanelRowActions' },
            h(PanelButton, {
              'aria-label': [localizeText('上移'), `/${name}`].join(' '),
              disabled: saving || index === 0,
              onClick: () => move(index, -1),
            }, '↑'),
            h(PanelButton, {
              'aria-label': [localizeText('下移'), `/${name}`].join(' '),
              disabled: saving || index === order.length - 1,
              onClick: () => move(index, 1),
            }, '↓'),
            h(PanelButton, {
              'aria-label': [localizeText('移除'), `/${name}`].join(' '),
              disabled: saving,
              onClick: () => remove(index),
            }, '移除'))))),
      h('div', { className: 'dim-feishuPanelAdd' },
        h('select', {
          className: 'dim-feishuGroupSelect',
          value: pending,
          'aria-label': '添加指令',
          disabled: saving || available.length === 0,
          onChange: (event) => setPending(event.target.value),
        },
        h('option', { value: '' }, available.length === 0 ? '指令都已加入' : '选择要加入的指令'),
        available.map((name) => h('option', { key: name, value: name }, commandText(name)))),
        h(PanelButton, {
          disabled: saving || !pending,
          onClick: add,
        }, '加入'),
        h(PanelButton, {
          disabled: saving || available.length === 0,
          onClick: () => edit(() => setOrder([...ALL_COMMANDS])),
        }, '恢复全部'),
        h(PanelButton, {
          disabled: saving || order.length === 0,
          onClick: () => edit(() => setOrder([])),
        }, '全部移除')))
    : null,
  h('div', { className: 'dim-feishuPanelFooter' },
    h(PanelButton, {
      'data-kind': 'primary',
      disabled: saving || !dirty,
      onClick: () => { void save(); },
    }, '保存')),
  error
    ? h('p', { className: 'dim-feishuGroupError', role: 'alert' }, error)
    : null));
}
