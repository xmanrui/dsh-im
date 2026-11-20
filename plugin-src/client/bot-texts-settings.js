import * as React from 'react';
import { h, localizeTemplate } from './i18n.js';
import { normalizeTextOverrides } from '../../src/channels/shared/text-overrides.mjs';
import { DINGTALK_ENDPOINTS } from './channels/dingtalk/api.js';

// Each row keeps one optional override. An empty input means "use the default",
// which is also how the Host stores it: absent fields keep the i18n text.
const TEXT_FIELDS = Object.freeze([
  Object.freeze({
    field: 'cardInitial', label: '卡片初始文案', fallback: '正在思考 🤔',
    help: 'AI 卡片刚创建时显示的文字。',
  }),
  Object.freeze({
    field: 'working', label: '处理中文案', fallback: '正在处理',
    help: '还没有具体工具可显示时的占位文字。',
  }),
  Object.freeze({
    field: 'toolUsing', label: '工具进度文案', fallback: '正在使用 {name}',
    help: '支持 {name} 占位符；不写占位符时只显示你填的文字。',
  }),
  Object.freeze({
    field: 'webSearching', label: '联网搜索文案', fallback: '正在搜索网络并整理信息',
    help: '执行 web_search 时显示的文字。',
  }),
  Object.freeze({
    field: 'accessDenied', label: '无权限提示', fallback: '你好，当前账号暂无访问权限，如需使用请联系管理员。',
    help: '非白名单账号私聊机器人时回复的提示；群聊不回复。',
  }),
]);

function textsFromResult(result, botId) {
  if (result?.ok !== true) throw new Error(result?.error?.message || '无法读取提示文案设置，请稍后重试。');
  const bot = result.value?.bots?.find((entry) => entry.botId === botId);
  if (!bot) throw new Error('找不到要修改的机器人。');
  return normalizeTextOverrides(bot.textOverrides);
}

export function BotTextsSettingsPage({ account, rpcCall }) {
  const fieldId = React.useId();
  const [texts, setTexts] = React.useState(() => ({}));
  const [savedTexts, setSavedTexts] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  const mounted = React.useRef(false);
  const inFlight = React.useRef(false);

  const load = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const value = textsFromResult(await rpcCall('connection.status', {}), account.botId);
      if (!mounted.current) return;
      setTexts(value);
      setSavedTexts(value);
    } catch (error) {
      if (mounted.current) setFeedback(error.message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [account.botId, rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const save = async (field, raw) => {
    if (inFlight.current || savedTexts === null) return;
    const value = typeof raw === 'string' ? raw.trim() : '';
    const current = savedTexts[field] ?? '';
    if (value === current) return;
    const next = { ...texts };
    if (value) next[field] = value;
    else delete next[field];
    inFlight.current = true;
    setTexts(next);
    setBusy(true);
    setFeedback(null);
    try {
      const saved = textsFromResult(await rpcCall(DINGTALK_ENDPOINTS.setTextOverrides, {
        botId: account.botId, texts: next,
      }), account.botId);
      if (!mounted.current) return;
      setTexts(saved);
      setSavedTexts(saved);
    } catch (error) {
      if (mounted.current) {
        setTexts(savedTexts);
        setFeedback(error.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return h('section', {
    className: 'dim-botGeneralSettings', 'aria-label': '机器人提示文案', 'aria-busy': busy,
  },
  h('p', { className: 'dim-botGeneralHelp' },
    '留空即使用默认文案；只有填过的字段会被保存，切换界面语言时默认文案仍会自动翻译。'),
  h('div', { className: 'dim-botGeneralList' },
    TEXT_FIELDS.map(({ field, label, fallback, help }) => {
      const id = `${fieldId}-${field}`;
      return h('div', { key: field, className: 'dim-botGeneralRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: id }, label),
          h('p', { className: 'dim-botGeneralHelp', id: `${id}-help` },
            help, ' ', localizeTemplate('默认：{text}', { text: fallback }))),
        h('div', { className: 'dim-botGeneralControl' },
          h('input', {
            id,
            type: 'text',
            value: texts[field] ?? '',
            placeholder: fallback,
            maxLength: 500,
            disabled: busy || savedTexts === null,
            'aria-label': label,
            'aria-describedby': `${id}-help`,
            onChange: (event) => setTexts({ ...texts, [field]: event.target.value }),
            onBlur: (event) => void save(field, event.target.value),
          })));
    })),
  feedback ? h('p', {
    className: 'dim-accessFeedback', 'data-tone': 'error', role: 'alert',
  }, feedback) : null,
  savedTexts === null && !busy ? h('div', { className: 'dim-botGeneralActions' },
    h('button', {
      type: 'button', className: 'dim-deliveryButton', onClick: () => void load(),
    }, '重新读取')) : null);
}
