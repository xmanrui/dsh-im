import * as React from 'react';
import { h, localizeText } from '../../i18n.js';
import { normalizeConnectionError } from './api.js';
import { CONFIG_ISSUE_LABELS } from '../../../../src/channels/weixin/diagnostic-details.mjs';
import { CollapsibleAccountSection } from '../shared/collapsible-account.js';

const STAGE_LABELS = {
  'startup.load': '加载微信配置', 'qr.begin': '申请二维码', 'qr.encode': '生成二维码图片', 'qr.poll': '查询扫码状态',
  'qr.verify': '提交配对码', 'qr.cancel': '取消绑定', 'credential.read': '读取登录凭据', 'credential.save': '保存登录凭据',
  'credential.remove': '移除登录凭据', 'account.save': '保存账号配置', 'account.remove': '移除账号配置',
  'state.load': '读取账号状态', 'state.write': '保存账号状态', 'state.cleanup': '清理账号状态',
  'workspace.write': '保存工作区设置', 'workspace.cleanup': '清理工作区设置', 'runtime.prepare': '准备消息连接',
  activation: '激活微信账号', 'harness.check': '检查 DSH 宿主', 'connection.start': '启动微信连接',
  'connection.poll': '同步微信消息', 'connection.stop': '停止微信连接', 'status.read': '读取连接状态',
  rollback: '恢复原账号状态', 'management.request': '访问 DSH 管理接口',
};

export function provisioningErrorTitle(error) {
  const stage = error?.details?.stage;
  if (stage === 'qr.begin' || stage === 'qr.encode') return '无法生成微信二维码';
  if (stage === 'qr.poll') return '查询微信扫码状态失败';
  if (stage === 'management.request') return '无法完成微信管理请求';
  return '微信没有绑定完成';
}

export function formatWeixinDiagnostic(value) {
  const error = normalizeConnectionError(value);
  const details = error.details ?? {};
  return [
    localizeText(error.message), details.hint ? localizeText(details.hint) : null,
    localizeText('错误码') + ': ' + error.code,
    ...['operation', 'stage', 'reason', 'httpStatus', 'providerCode', 'resource', 'file', 'field', 'issue', 'referenceId', 'occurredAt', 'rollback', 'pluginVersion']
      .filter(field => details[field] !== undefined)
      .map(field => `${field}: ${details[field]}`),
  ].filter(Boolean).join('\n');
}

export function WeixinConnectionError({ error: value, warning = false }) {
  const error = normalizeConnectionError(value);
  const details = error.details ?? {};
  const [copyState, setCopyState] = React.useState(null);
  React.useEffect(() => setCopyState(null), [details.referenceId, error.code, error.message]);
  const copy = async () => {
    try {
      if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
      await globalThis.navigator.clipboard.writeText(formatWeixinDiagnostic(error));
      setCopyState('copied');
    } catch { setCopyState('manual'); }
  };
  const fields = [
    ['错误码', error.code], ['失败阶段', localizeText(STAGE_LABELS[details.stage] ?? details.stage ?? '')],
    ['底层原因', details.reason], ['HTTP 状态', details.httpStatus], ['微信返回码', details.providerCode],
    ['配置文件', details.file], ['配置字段', details.field],
    ['校验原因', details.issue ? localizeText(CONFIG_ISSUE_LABELS[details.issue]) : undefined],
    ['参考号', details.referenceId], ['发生时间', details.occurredAt], ['插件版本', details.pluginVersion],
  ].filter(([, text]) => text !== undefined && text !== '');
  return h('div', { className: 'dxw-summary dim-cardSummary', 'data-weixin-diagnostic': true, role: warning ? 'status' : undefined },
    h('p', null, error.message),
    details.hint ? h('p', null, details.hint) : null,
    h(CollapsibleAccountSection, {
      className: 'dim-diagnosticDisclosure',
      toggleLabel: null,
      header: h('span', { className: 'dim-diagnosticSummary' }, '诊断详情'),
    },
      h('dl', { className: 'dim-diagnosticFields' },
        ...fields.flatMap(([label, text]) => [h('dt', { key: `${label}-label` }, label),
          React.createElement('dd', { key: label, className: 'dim-diagnosticValue' }, String(text))])),
      !details.referenceId ? h('p', { className: 'dim-diagnosticNotice' }, '未取得 Host 诊断参考号。') : null,
      h('div', { className: 'dim-viewActions' },
        h('button', { type: 'button', className: 'dxw-button', onClick: copy }, copyState === 'copied' ? '诊断信息已复制' : '复制诊断信息')),
      copyState === 'manual' ? h('div', null,
        h('p', { className: 'dim-diagnosticHint' }, '无法访问剪贴板，请选择并复制以下诊断信息。'),
        React.createElement('textarea', { readOnly: true, value: formatWeixinDiagnostic(error), rows: 7,
          'aria-label': localizeText('诊断信息'), className: 'dim-diagnosticTextarea' })) : null));
}
