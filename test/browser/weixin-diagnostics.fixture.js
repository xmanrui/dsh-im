import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { WeixinSettingsTab } from '../../plugin-src/client/channels/weixin/index.js';
import { installImStyles } from '../../plugin-src/client/styles.js';
import { installWeixinStyles } from '../../plugin-src/client/channels/weixin/styles.js';
import { en, localizeText, setImTranslator } from '../../plugin-src/client/i18n.js';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'qr';
const english = params.has('en');
const layoutWidth = params.has('mobile') ? 390 : innerWidth;
if (params.has('mobile')) document.body.style.width = `${layoutWidth}px`;
if (english) setImTranslator(key => en[key] ?? key);
installWeixinStyles();
installImStyles();
const botId = 'wx_0123456789abcdef01234567';
const error = scenario === 'startup' ? {
  code: 'weixin-startup-config-invalid', message: '微信配置格式错误：workspaces.json。请查看诊断详情，修复后重启 DSH。',
  details: { operation: 'startup', stage: 'startup.load', reason: 'invalid-config', resource: 'workspace-config',
    file: 'workspaces.json', field: 'workspaces[0].value', issue: 'invalid-workspace-path',
    hint: '工作区路径必须是当前操作系统的绝对路径。 请检查微信渠道数据目录中的 workspaces.json，修复后重启 DSH；“重新读取”不会重新加载配置。 字段位置中的序号从 0 开始，按文件中的条目顺序计数，不包含真实账号标识。' },
} : scenario === 'qr' ? {
  code: 'network-error', message: '暂时无法访问微信服务。',
  details: { operation: 'provision.begin', stage: 'qr.begin', reason: 'ENOTFOUND',
    hint: '微信服务域名解析失败，请检查运行 DSH 的机器的网络和 DNS 设置后重试。' },
} : scenario === 'delete' ? {
  code: 'credential-remove-failed', message: '无法从 DSH 凭据存储移除微信登录凭据。',
  details: { operation: 'bot.delete', stage: 'credential.remove', reason: 'EACCES', rollback: 'succeeded',
    hint: '操作未完成，已恢复之前的本机状态。请处理上述问题后重试。' },
} : {
  code: 'stale-token', message: '微信登录凭据已失效，请移除账号后重新扫码。',
  details: { operation: 'connection.monitor', stage: 'connection.poll', providerCode: '-14',
    hint: '请移除失效接入并重新扫码绑定。' },
};
Object.assign(error.details, { referenceId: 'WX-CONN-1234ABCD', occurredAt: '2026-09-12T04:10:00.000Z', pluginVersion: '4.19.2', token: 'private-fixture-secret' });
const snapshot = { schemaVersion: 1, revision: 1, bots: scenario === 'qr' ? [] : [{
  botId, state: 'error', connected: false, configured: true, workspace: '/workspace/demo',
  bot: { name: english ? 'Demo assistant' : '演示助手', accountIdMasked: 'demo•••' },
  error: scenario === 'offline' ? error : null,
}] };
const calls = [];
const errors = [];
const originalError = console.error;
console.error = (...args) => { errors.push(args.join(' ')); originalError(...args); };
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
let copied;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
  if (params.has('fallback')) throw new Error('Clipboard unavailable in fixture');
  copied = text;
} } });
async function rpcCall(endpoint) {
  calls.push(endpoint);
  return endpoint === 'connection.status' && scenario !== 'startup' ? { ok: true, value: snapshot } : { ok: false, error };
}
createRoot(document.getElementById('app')).render(React.createElement('div', { className: 'dim-page' },
  React.createElement('section', { className: 'dim-panel' }, React.createElement(WeixinSettingsTab, { rpcCall }))));

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await tick(); }
}
const button = label => [...document.querySelectorAll('button')].find(el => el.textContent === localizeText(label));
async function run() {
  await until(() => button('扫码接入机器人'), 'Page did not mount');
  const collapse = document.querySelector('[aria-expanded="false"]');
  if (collapse) collapse.click();
  if (scenario === 'qr') button('扫码接入机器人').click();
  if (scenario === 'delete') {
    await until(() => button('移除接入'), 'Remove action did not mount');
    button('移除接入').click();
    await until(() => button('确认移除'), 'Confirmation did not mount');
    button('确认移除').click();
  }
  await until(() => document.querySelector('[data-weixin-diagnostic]'), 'Diagnostic did not mount');
  const diagnostic = document.querySelector('[data-weixin-diagnostic]');
  diagnostic.querySelector('summary').click();
  await tick();
  button('复制诊断信息').click();
  await until(() => copied || document.querySelector('textarea[readonly]'), 'Copy did not complete');
  const text = copied ?? document.querySelector('textarea[readonly]').value;
  assert(text.includes(error.code) && text.includes(error.details.referenceId), 'Copy lost the diagnostic identity');
  assert(!text.includes('private-fixture-secret'), 'Copy leaked an unknown detail');
  assert(text.includes('pluginVersion: 4.19.2'), 'Copy lost the plugin version');
  if (scenario === 'startup') {
    for (const field of ['file', 'field', 'issue']) assert(text.includes(`${field}: ${error.details[field]}`), `Copy lost ${field}`);
    assert(diagnostic.textContent.includes('workspaces[0].value'), 'Field position is not visible');
    assert(button('重新读取'), 'Startup error lost its status refresh control');
  }
  if (english) assert(!/[\p{Script=Han}]/u.test(diagnostic.textContent), 'Diagnostic was not fully translated');
  if (scenario === 'delete') assert(button('保留账号') && button('确认移除'), 'Failed removal lost its recovery controls');
  const rect = diagnostic.getBoundingClientRect();
  assert(rect.width > 0 && rect.left >= 0 && rect.right <= layoutWidth + 1, 'Diagnostic overflows the page');
  for (const element of diagnostic.querySelectorAll('button, textarea, dd')) {
    const bounds = element.getBoundingClientRect();
    assert(bounds.left >= rect.left && bounds.right <= rect.right + 1, 'Diagnostic control overflows its container');
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  document.body.dataset.result = 'passed';
  document.getElementById('result').textContent = `Passed: ${scenario}, ${english ? 'English' : 'Chinese'}, ${layoutWidth}px, ${copied ? 'clipboard' : 'manual copy'}`;
  window.__weixinDiagnosticsResult = { passed: true, scenario, copied: text, calls, errors };
}
run().catch(error => {
  document.body.dataset.result = 'failed';
  document.getElementById('result').textContent = error.stack;
  window.__weixinDiagnosticsResult = { passed: false, error: error.message, errors, calls };
});
