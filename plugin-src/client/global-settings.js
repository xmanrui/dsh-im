import * as React from 'react';
import { QuestionGlyph } from './ui-glyphs.js';

import {
  DEFAULT_INBOUND_TTL_HOURS,
  INBOUND_TTL_MAX_HOURS,
  normalizeInboundTtlHours,
} from '../../src/channels/shared/inbound-ttl.mjs';
import { h } from './i18n.js';

export const GLOBAL_SETTINGS_RPC_CHANNEL = '/dsh-im-settings';

export const GLOBAL_SETTINGS_TAB_ID = 'global-settings';

const ATTACHMENTS_TAB_ID = 'dim-general-settings-tab-attachments';
const ATTACHMENTS_PANEL_ID = 'dim-general-settings-panel-attachments';

export const GLOBAL_SETTINGS_ENDPOINTS = Object.freeze({
  getTtl: 'settings.inbound-ttl.get',
  setTtl: 'settings.inbound-ttl.set',
  sweep: 'settings.inbound-ttl.sweep',
});

function presentError(error, fallback) {
  return error?.message || fallback;
}

function unwrapRpcResult(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '请求失败，请稍后重试。');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

export function GlobalSettingsLogoGlyph({ size } = {}) {
  // Vendored from the native @deepseek-ai/dsh-client-ui-primitives icon set
  // (ic_ds_settings_outline_16) so the page gear is the same artwork the shell
  // draws for its own settings navigation, instead of a second, heavier gear
  // that reads as foreign beside it.
  return h('svg', {
    ...(size === undefined ? {} : { width: size, height: size }),
    viewBox: '0 0 16 16',
    fill: 'none',
    focusable: 'false',
    'aria-hidden': 'true',
    'data-im-icon': 'global-settings',
  },
  h('path', { fill: 'currentColor', d: 'M14.0861 5.51366C13.8717 5.0575 13.588 4.58542 13.2889 4.18108C13.208 4.07172 13.1596 4.04373 13.0243 4.03054C12.4277 3.97255 11.8245 4.05527 11.2269 3.9972C10.7224 3.94816 10.3133 3.71661 10.0115 3.30919C9.66986 2.84777 9.43973 2.31343 9.09824 1.85234C9.01771 1.74365 8.96805 1.71589 8.83354 1.70282C8.29432 1.65044 7.70402 1.65061 7.16656 1.70282C7.03205 1.71589 6.98239 1.74365 6.90186 1.85234C6.56067 2.31303 6.33025 2.84774 5.98855 3.30919C5.68681 3.71661 5.27774 3.94816 4.77317 3.9972C4.17564 4.05527 3.57239 3.97255 2.97585 4.03054C2.84046 4.04373 2.79208 4.07172 2.71115 4.18108C2.41212 4.58542 2.12835 5.0575 1.91403 5.51366C1.85299 5.64359 1.85286 5.7018 1.91403 5.8319C2.14865 6.33077 2.49748 6.76892 2.73237 7.26854C2.9594 7.7515 2.96041 8.24717 2.73338 8.73044C2.49837 9.23061 2.14891 9.66837 1.91403 10.1681C1.85291 10.2982 1.85299 10.3564 1.91403 10.4863C2.12856 10.9429 2.41185 11.4142 2.71115 11.8189C2.79208 11.9283 2.84046 11.9563 2.97585 11.9694C3.57239 12.0274 4.17564 11.9447 4.77317 12.0028C5.27774 12.0518 5.68681 12.2834 5.98855 12.6908C6.33024 13.1522 6.56037 13.6866 6.90186 14.1476C6.98239 14.2563 7.03205 14.2841 7.16656 14.2972C7.70402 14.3494 8.29432 14.3495 8.83354 14.2972C8.96805 14.2841 9.01771 14.2563 9.09824 14.1476C9.43944 13.687 9.66985 13.1522 10.0115 12.6908C10.3133 12.2834 10.7224 12.0518 11.2269 12.0028C11.8244 11.9447 12.4271 12.0275 13.0243 11.9694C13.1596 11.9563 13.208 11.9283 13.2889 11.8189C13.5891 11.4131 13.872 10.942 14.0861 10.4863C14.1471 10.3564 14.1472 10.2982 14.0861 10.1681C13.8513 9.66861 13.5017 9.23061 13.2667 8.73044C13.0397 8.24717 13.0407 7.7515 13.2677 7.26854C13.5026 6.7689 13.8513 6.33106 14.0861 5.8319C14.1472 5.7018 14.1471 5.64359 14.0861 5.51366ZM15.3035 6.40373C15.0685 6.90359 14.7188 7.34119 14.4841 7.84037C14.4231 7.97025 14.423 8.02855 14.4841 8.15861C14.7189 8.65833 15.0685 9.09611 15.3035 9.59626C15.5308 10.0801 15.5308 10.5744 15.3035 11.0582C15.052 11.5933 14.7225 12.1426 14.37 12.6191C14.0685 13.0265 13.6581 13.259 13.1536 13.3081C12.5566 13.366 11.9541 13.2835 11.3573 13.3414C11.2228 13.3545 11.1731 13.3823 11.0926 13.491C10.7511 13.9521 10.521 14.4864 10.1793 14.9478C9.87828 15.3542 9.46719 15.5869 8.96387 15.6358C8.34008 15.6964 7.66194 15.6966 7.03623 15.6358C6.53291 15.5869 6.12182 15.3542 5.82084 14.9478C5.47911 14.4863 5.24878 13.9517 4.90753 13.491C4.82701 13.3823 4.77734 13.3545 4.64284 13.3414C4.04647 13.2835 3.44373 13.366 2.84653 13.3081C2.34201 13.259 1.93164 13.0265 1.63013 12.6191C1.27867 12.144 0.948453 11.5941 0.696621 11.0582C0.469315 10.5744 0.469279 10.0801 0.696621 9.59626C0.931628 9.09613 1.2813 8.65807 1.51597 8.15861C1.57708 8.02855 1.57702 7.97025 1.51597 7.84037C1.28117 7.34095 0.931635 6.9036 0.696621 6.40373C0.469213 5.91992 0.469367 5.42562 0.696621 4.94183C0.948441 4.40587 1.27868 3.85598 1.63013 3.38092C1.93164 2.97349 2.34201 2.74095 2.84653 2.6919C3.44353 2.63397 4.04599 2.71649 4.64284 2.65856C4.77734 2.64549 4.82701 2.61774 4.90753 2.50904C5.24905 2.04792 5.47913 1.51362 5.82084 1.05219C6.12182 0.645806 6.53291 0.413119 7.03623 0.364178C7.66002 0.303556 8.33816 0.303369 8.96387 0.364178C9.46719 0.413119 9.87828 0.645806 10.1793 1.05219C10.521 1.51365 10.7513 2.04828 11.0926 2.50904C11.1731 2.61774 11.2228 2.64549 11.3573 2.65856C11.9541 2.71649 12.5566 2.63397 13.1536 2.6919C13.6581 2.74095 14.0685 2.97349 14.37 3.38092C14.7214 3.85598 15.0517 4.40587 15.3035 4.94183C15.5307 5.42562 15.5309 5.91992 15.3035 6.40373Z' }),
  h('path', { fill: 'currentColor', d: 'M9.13764 7.99999C9.13764 7.3715 8.62855 6.8624 8.00005 6.8624C7.37155 6.8624 6.86246 7.3715 6.86246 7.99999C6.86246 8.62849 7.37155 9.13759 8.00005 9.13759C8.62855 9.13759 9.13764 8.62849 9.13764 7.99999ZM10.4834 7.99999C10.4834 9.37126 9.37132 10.4833 8.00005 10.4833C6.62878 10.4833 5.51674 9.37126 5.51674 7.99999C5.51674 6.62873 6.62878 5.51669 8.00005 5.51669C9.37132 5.51669 10.4834 6.62873 10.4834 7.99999Z' }));
}

function GlobalButton({ children, kind = 'secondary', className = '', ...props }) {
  return h('button', {
    ...props,
    type: props.type ?? 'button',
    className: `dim-deliveryButton ${className}`.trim(),
    'data-kind': kind,
  }, children);
}

export function GlobalSettingsPanel({ rpcCall }) {
  const [phase, setPhase] = React.useState('loading');
  const [loadError, setLoadError] = React.useState(null);
  const [ttlInput, setTtlInput] = React.useState('');
  const [savedTtl, setSavedTtl] = React.useState(null);
  const [ttlError, setTtlError] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);
  const [saveSucceeded, setSaveSucceeded] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [sweepConfirming, setSweepConfirming] = React.useState(false);
  const [sweeping, setSweeping] = React.useState(false);
  const ttlErrorId = React.useId();
  const ttlHintsId = React.useId();
  const sweepTriggerId = React.useId();
  const sweepConfirmId = React.useId();
  const sweepConfirmTextId = React.useId();
  const sweepConfirmButtonId = React.useId();
  const mounted = React.useRef(true);
  const saving = React.useRef(false);

  const invoke = React.useCallback(async (endpoint, payload = {}, signal) => {
    if (typeof rpcCall !== 'function') throw new Error('通用设置暂不可用。');
    return unwrapRpcResult(await rpcCall(endpoint, payload, signal));
  }, [rpcCall]);

  const loadSettings = React.useCallback(async ({ signal } = {}) => {
    setPhase('loading');
    setLoadError(null);
    try {
      const value = await invoke(GLOBAL_SETTINGS_ENDPOINTS.getTtl, {}, signal);
      if (signal?.aborted || !mounted.current) return;
      const ttlHours = normalizeInboundTtlHours(value?.ttlHours);
      if (ttlHours === null) {
        setLoadError('通用设置返回了无法识别的响应。');
        setPhase('error');
        return;
      }
      setSavedTtl(ttlHours);
      setTtlInput(String(ttlHours));
      setTtlError(false);
      setSaveError(null);
      setSaveSucceeded(false);
      setPhase('ready');
    } catch (caught) {
      if (signal?.aborted || caught?.name === 'AbortError' || !mounted.current) return;
      setLoadError(presentError(caught, '无法读取通用设置，请稍后重试。'));
      setPhase('error');
    }
  }, [invoke]);

  React.useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadSettings({ signal: controller.signal });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [loadSettings]);

  React.useEffect(() => {
    if (!sweepConfirming) return;
    globalThis.document?.getElementById(sweepConfirmButtonId)?.focus();
  }, [sweepConfirmButtonId, sweepConfirming]);

  const commitTtl = async () => {
    if (phase === 'loading' || saving.current) return;
    const proposed = normalizeInboundTtlHours(ttlInput.trim());
    if (proposed === null) {
      setSaveError(null);
      setSaveSucceeded(false);
      setTtlError(true);
      return;
    }
    setTtlError(false);
    if (proposed === savedTtl) return;
    saving.current = true;
    setIsSaving(true);
    setSaveError(null);
    setSaveSucceeded(false);
    try {
      const value = await invoke(GLOBAL_SETTINGS_ENDPOINTS.setTtl, { ttlHours: proposed });
      if (!mounted.current) return;
      const confirmed = normalizeInboundTtlHours(value?.ttlHours);
      const finalTtl = confirmed === null ? proposed : confirmed;
      setSavedTtl(finalTtl);
      // Never clobber the field if the user kept typing while the save was in flight.
      setTtlInput((current) => current.trim() === String(proposed) ? String(finalTtl) : current);
      setLoadError(null);
      setSaveSucceeded(true);
      setPhase('ready');
    } catch (caught) {
      if (mounted.current) {
        setSaveError(presentError(caught, '设置保存失败，请稍后重试。'));
      }
    } finally {
      saving.current = false;
      if (mounted.current) setIsSaving(false);
    }
  };

  const requestSweep = () => {
    if (sweeping) return;
    setSweepConfirming(true);
  };

  const cancelSweep = ({ restoreFocus = false } = {}) => {
    setSweepConfirming(false);
    if (restoreFocus) globalThis.document?.getElementById(sweepTriggerId)?.focus();
  };

  const runSweep = async () => {
    setSweepConfirming(false);
    setSweeping(true);
    try {
      // Manual sweeps are silent by design: the busy label on the button is
      // the only feedback, and RPC results or failures are not announced.
      await invoke(GLOBAL_SETTINGS_ENDPOINTS.sweep, {});
    } catch {
      // Intentionally swallowed — no result feedback for manual sweeps.
    } finally {
      if (mounted.current) setSweeping(false);
    }
  };

  const inlineStatus = phase === 'loading'
    ? { role: 'status', message: '正在读取通用设置…' }
    : ttlError
      ? { role: 'alert', message: `请输入 -1、0 或 1~${INBOUND_TTL_MAX_HOURS} 之间的整数。` }
      : saveError
        ? { role: 'alert', message: saveError }
        : phase === 'error' && loadError
          ? { role: 'alert', message: loadError }
          : saveSucceeded
            ? { role: 'status', message: '已保存' }
            : null;

  const proposedTtl = normalizeInboundTtlHours(ttlInput.trim());
  const canSave = phase !== 'loading'
    && !isSaving
    && proposedTtl !== null
    && proposedTtl !== savedTtl;

  return h('section', { className: 'dim-generalSettingsPage', 'aria-label': '通用设置' },
    h('header', { className: 'dim-generalSettingsHeader' },
      h('h2', null, '通用设置')),
    h('div', { className: 'dim-generalSettingsTabsBar' },
      h('div', {
        className: 'dim-generalSettingsTabs',
        role: 'tablist',
        'aria-label': '通用设置分类',
      },
      h('button', {
        type: 'button',
        id: ATTACHMENTS_TAB_ID,
        className: 'dim-generalSettingsTab',
        role: 'tab',
        'aria-selected': true,
        'aria-controls': ATTACHMENTS_PANEL_ID,
      }, '附件'))),
    h('div', {
      id: ATTACHMENTS_PANEL_ID,
      className: 'dim-generalSettingsTabPanel',
      role: 'tabpanel',
      'aria-labelledby': ATTACHMENTS_TAB_ID,
    },
    h('section', {
      className: 'dim-globalSection',
      'aria-label': '附件',
      'aria-busy': phase === 'loading',
    },
    h('div', { className: 'dim-globalHead' },
      h('div', { className: 'dim-globalHeadTitle' },
        h('h3', { id: 'dim-globalTtlTitle' }, '附件保留时长 (小时)'),
        h('div', { className: 'dim-globalTtlHelp' },
          h('button', {
            type: 'button',
            className: 'dim-channelHelpButton dim-globalTtlHelpButton',
            'aria-label': '查看附件保留时长说明',
            'aria-describedby': ttlHintsId,
          }, h(QuestionGlyph, { size: 14 })),
          h('div', {
            id: ttlHintsId,
            className: 'dim-globalTtlTooltip',
            role: 'tooltip',
          },
          h('ul', { className: 'dim-globalTtlHints' },
            h('li', null,
              h('code', null, '-1'),
              h('span', null, '永久保留，不会自动清理')),
            h('li', null,
              h('code', null, '0'),
              h('span', null, '每 Turn 结束后立即清理')),
            h('li', null,
              h('code', null, `1~${INBOUND_TTL_MAX_HOURS}`),
              h('span', null, '小时后自动清理'))))))),
    h('form', {
      className: 'dim-globalTtlRow',
      onSubmit: (event) => {
        event.preventDefault();
        void commitTtl();
      },
    },
      h('input', {
        id: 'dim-globalTtlInput',
        className: 'dim-globalTtlInput',
        type: 'text',
        value: ttlInput,
        placeholder: String(DEFAULT_INBOUND_TTL_HOURS),
        autoComplete: 'off',
        disabled: phase === 'loading' || isSaving,
        'aria-labelledby': 'dim-globalTtlTitle',
        'aria-invalid': ttlError ? 'true' : undefined,
        'aria-describedby': ttlError ? ttlErrorId : ttlHintsId,
        onBlur: () => {
          setTtlError(normalizeInboundTtlHours(ttlInput.trim()) === null);
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void commitTtl();
        },
        onChange: (event) => {
          setTtlInput(event.target.value);
          setTtlError(false);
          setSaveError(null);
          setSaveSucceeded(false);
        },
      }),
      h(GlobalButton, {
        type: 'submit',
        kind: 'primary',
        className: 'dim-globalSaveButton',
        disabled: !canSave,
      }, isSaving ? '保存中…' : '保存'),
      h('div', {
        className: 'dim-globalSweepAction',
        onBlur: (event) => {
          if (sweepConfirming && !event.currentTarget.contains(event.relatedTarget)) cancelSweep();
        },
      },
      h(GlobalButton, {
        id: sweepTriggerId,
        className: 'dim-globalSweepButton',
        onClick: () => (sweepConfirming ? cancelSweep() : requestSweep()),
        disabled: sweeping,
        'aria-haspopup': 'dialog',
        'aria-expanded': sweepConfirming,
        'aria-controls': sweepConfirmId,
      }, sweeping ? '正在清理…' : '清理过期附件'),
      sweepConfirming
        ? h('div', {
          id: sweepConfirmId,
          className: 'dim-globalSweepConfirm',
          role: 'alertdialog',
          'aria-label': '确认清理过期附件',
          'aria-describedby': sweepConfirmTextId,
          onKeyDown: (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            cancelSweep({ restoreFocus: true });
          },
        },
        h('p', { id: sweepConfirmTextId }, '确认清理当前已过期的附件？'),
        h('div', { className: 'dim-globalSweepConfirmActions' },
          h(GlobalButton, { onClick: () => cancelSweep({ restoreFocus: true }) }, '取消'),
          h(GlobalButton, {
            id: sweepConfirmButtonId,
            kind: 'danger',
            className: 'dim-globalSweepConfirmButton',
            onClick: () => void runSweep(),
          }, '确认清理')))
        : null),
      inlineStatus
        ? h('p', {
          id: ttlErrorId,
          className: 'dim-globalInline',
          'data-tone': inlineStatus.role === 'alert' ? 'error' : undefined,
          role: inlineStatus.role,
          'aria-live': inlineStatus.role === 'status' ? 'polite' : undefined,
        }, inlineStatus.message)
        : null))));
}
