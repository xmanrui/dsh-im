import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { installSessionChannelLogos } from '../../plugin-src/client/session-channel-logos.js';
import { SESSION_CHANNEL_LABELS } from '../../src/channels/shared/session-channel-labels.mjs';

const h = React.createElement;
const checks = [];
const errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise((done) => setTimeout(done, 20));
async function until(predicate, message) {
  const deadline = Date.now() + 3500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await tick();
  }
}
const titles = [
  '整理今天的项目进度', '分析本周的客户反馈', '跟进产品发布清单', '汇总团队讨论结果',
  '检查订单处理状态', 'Review the launch checklist', 'Plan the next release',
  'Summarize community feedback', '确认下周会议安排', '处理跨团队协作任务', '测试 iMessage 渠道',
];
const initial = Object.entries(SESSION_CHANNEL_LABELS).map(([channel, labels], index) => ({
  id: channel, title: `${labels[0]} · ${titles[index]}`, channel,
}));
initial.push({ id: 'web', title: '普通 Web 会话' });
let rows = initial;
let selected = 'weixin';
let expanded = true;
let editing = false;
let unsupported = false;
let productionNames = false;
let opens = 0;
let menus = 0;
const root = createRoot(document.getElementById('app'));
function render() {
  root.render(h('div', { className: 'preview' },
    h('aside', null,
      h('header', null, h('strong', null, 'DeepSeek Harness'), h('small', null, '会话列表 · Logo 展示验证')),
      h('div', { className: 'workspace' }, '⌄  dsh-im'),
      h('div', { role: 'tree' }, expanded ? rows.map((row) => h('div', {
        key: row.id, id: `row-${row.id}`,
        className: `${unsupported ? 'future-unknown-row' : productionNames ? '_dsh_sessionRow' : '_sessionRow_dsh_104'} ${selected === row.id ? 'selected' : ''}`,
        role: 'treeitem', 'aria-selected': selected === row.id, draggable: true,
        onClick: () => { opens += 1; selected = row.id; render(); },
      },
      h('span', { className: 'status', 'aria-label': '已完成' }, '·'),
      h('span', { className: productionNames ? '_dsh_title' : '_title_dsh_170', id: `title-${row.id}` },
        editing && row.id === 'weixin' ? h('input', { defaultValue: row.title, 'aria-label': '重命名' }) : row.title),
      h('span', { className: 'time' }, '刚刚'),
      h('button', { 'aria-label': `会话操作 ${row.title}`, onClick: (event) => { event.stopPropagation(); menus += 1; } }, '⋯')))
        : null)),
    h('main', null,
      h('div', { className: 'eyebrow' }, 'DSH-IM / BROWSER ADAPTER'),
      h('h1', null, '渠道，一眼可见'),
      h('p', null, '复用现有渠道 Logo，保留 DSH 自动生成的标题。'),
      h('div', { className: 'message' }, h('strong', null, '聊天正文保持原样'),
        h('p', { id: 'chat-prefix' }, '微信 · 这是一条普通聊天消息'), h('div', { id: 'stream' })),
      h('section', { className: 'search' }, h('h2', null, '搜索结果'),
        h('button', { id: 'search-row', className: '_searchResultRow_dsh_25', role: 'treeitem', 'aria-selected': false },
          h('span', { className: '_searchResultHeading_dsh_305' },
            h('span', { id: 'search-title', className: '_searchResultTitle_dsh_313' }, '飞书 · 分析客户反馈')),
          h('small', null, 'dsh-im · 找到一条相关会话'))),
      h('p', { className: 'note' }, '测试页面，非运行中的 DSH 会话。'))));
}
const title = (id) => document.getElementById(`title-${id}`);
const mark = 'data-dsh-im-session-channel';
const text = 'data-dsh-im-session-text';
const decorated = () => initial.slice(0, -1).every((row) => title(row.id)?.getAttribute(mark) === row.channel);

async function run() {
  render();
  await until(() => title('weixin'), 'React fixture did not mount');
  const originalNode = title('weixin').firstChild;
  const originalText = title('weixin').textContent;
  let dispose = installSessionChannelLogos();
  await until(decorated, 'channel logos did not load');
  assert(title('weixin').firstChild === originalNode && title('weixin').textContent === originalText, 'React text was changed');
  assert(!title('web').hasAttribute(mark) && !document.getElementById('chat-prefix').hasAttribute(mark), 'unrelated text was decorated');
  assert(document.querySelectorAll('svg').length === 0, 'SVG nodes were inserted into the React tree');
  const before = getComputedStyle(title('weixin'), '::before');
  const after = getComputedStyle(title('weixin'), '::after');
  assert(before.backgroundImage.startsWith('url("data:image/svg+xml,'), 'logo is not a local SVG');
  assert(before.width === '16px' && before.pointerEvents === 'none', 'logo changes the hit target');
  assert(after.content.includes(titles[0]) && after.content.endsWith('/ ""'), 'visual title or accessible alternative is wrong');
  assert(getComputedStyle(title('weixin')).fontSize === '14px', 'Host typography changed');
  assert(title('weixin').getBoundingClientRect().height === 20, 'row title height changed');
  await until(() => document.getElementById('search-title').getAttribute(mark) === 'feishu', 'search result is missing its logo');
  assert(document.getElementById('search-title').getBoundingClientRect().width > 100, 'content-sized search title collapsed');
  checks.push('all channel SVGs, original text/node identity, typography, accessibility CSS, Web/chat exclusion, search');

  title('qq').click();
  await tick();
  assert(opens === 1 && selected === 'qq', 'opening the original row stopped working');
  document.querySelector('#row-qq button').click();
  await tick();
  assert(menus === 1 && opens === 1, 'row action click propagation changed');
  assert(document.getElementById('row-qq').draggable, 'drag support was changed');
  checks.push('original row clicks, menu propagation, and draggable state');

  rows = initial.map((row) => row.id === 'weixin' ? { ...row, title: '微信 · 更新后的标题 👨‍👩‍👧‍👦 <img src=x> "原样显示"' } : row);
  render();
  await until(() => title('weixin').getAttribute(text)?.includes('更新后的标题'), 'React title update was not reflected');
  assert(title('weixin').firstChild === originalNode, 'React had to replace its text node');
  assert(!title('weixin').querySelector('img'), 'title content became HTML');
  rows = initial.map((row) => row.id === 'weixin' ? { ...row, title: 'Slack · Reused row' } : row);
  render();
  await until(() => title('weixin').getAttribute(mark) === 'slack', 'reused row retained stale logo');
  rows = initial.map((row) => row.id === 'weixin' ? { ...row, title: '普通更新标题' } : row);
  render();
  await until(() => !title('weixin').hasAttribute(mark), 'unprefixed title stayed hidden');
  rows = initial;
  render();
  await until(decorated, 'prefix did not restore');
  editing = true;
  render();
  await until(() => !title('weixin').hasAttribute(mark), 'inline rename input was covered');
  editing = false;
  render();
  await until(decorated, 'logo did not return after rename input');
  checks.push('automatic title updates, reused rows, plain titles, literal markup, inline rename');

  const removed = title('weixin');
  expanded = false;
  render();
  await until(() => !title('weixin'), 'collapse did not unmount rows');
  await tick();
  assert(!removed.hasAttribute(mark), 'detached row retained adapter attributes');
  expanded = true;
  render();
  await until(decorated, 'expanded rows were not decorated');
  unsupported = true;
  render();
  await until(() => !title('weixin').hasAttribute(mark), 'unknown Host structure did not fall back');
  unsupported = false;
  productionNames = true;
  render();
  await until(decorated, 'production CSS-module names did not resume');
  checks.push('collapse/expand, detached-node cleanup, production/dev CSS modules, unsupported-structure fallback');

  let titleMutations = 0;
  const observer = new MutationObserver((records) => { titleMutations += records.length; });
  observer.observe(title('weixin'), { attributes: true, childList: true, characterData: true, subtree: true });
  for (let index = 0; index < 100; index += 1) document.getElementById('stream').appendChild(document.createTextNode('.'));
  await tick();
  observer.disconnect();
  assert(titleMutations === 0, 'chat streaming rewrote the sidebar');
  document.getElementById('stream').textContent = '';
  checks.push('chat streaming does not rewrite title rows');

  const secondDispose = installSessionChannelLogos();
  assert(document.querySelectorAll('[data-plugin-css="dsh-im-session-channel-logos"]').length === 1, 'duplicate styles installed');
  dispose();
  assert(decorated(), 'one consumer disposed another consumer');
  secondDispose();
  assert(!document.querySelector(`[${mark}]`), 'unload did not restore text');
  assert(!document.querySelector('[data-plugin-css="dsh-im-session-channel-logos"]'), 'unload left a stylesheet');
  render();
  await tick();
  assert(!title('weixin').hasAttribute(mark), 'unloaded observer is still running');
  checks.push('shared lifecycle, complete unload, no zombie observer');

  const RealImage = window.Image;
  window.Image = class BlockedImage { set src(value) { this.value = value; } };
  dispose = installSessionChannelLogos();
  await tick();
  assert(!title('weixin').hasAttribute(mark), 'a blocked logo hid its text fallback');
  dispose();
  window.Image = RealImage;
  checks.push('blocked image/CSP fallback');

  selected = 'weixin';
  render();
  dispose = installSessionChannelLogos();
  await until(decorated, 'reload did not restore all logos');
  assert(errors.length === 0, `browser/React errors: ${errors.join('; ')}`);
  document.body.dataset.result = 'passed';
  document.getElementById('result').textContent = `${checks.length} browser checks passed: ${checks.join('; ')}`;
  window.logoPreviewDispose = dispose;
}
run().catch((error) => {
  document.body.dataset.result = 'failed';
  document.getElementById('result').textContent = `${error.stack}\n${errors.join('\n')}`;
});
