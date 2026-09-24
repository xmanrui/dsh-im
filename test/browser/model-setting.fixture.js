import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { FeishuSettingsTab } from '../../plugin-src/client/channels/feishu/index.js';
import { installImStyles } from '../../plugin-src/client/styles.js';
import { en, setImTranslator } from '../../plugin-src/client/i18n.js';

const params = new URLSearchParams(location.search);
const english = params.has('en');
// Desktop Chrome can clamp its layout viewport to 500px despite a narrower
// screenshot. Constrain the page itself to exercise a real 390px layout.
const layoutWidth = params.has('mobile') ? 390 : innerWidth;
if (params.has('mobile')) {
  document.body.style.width = `${layoutWidth}px`;
  document.body.style.boxSizing = 'border-box';
}
const labels = english ? { model: 'Model', effort: 'Reasoning effort', default: 'Model default' }
  : { model: '模型', effort: '思考强度', default: '跟随模型默认' };
if (english) setImTranslator((key) => en[key] ?? key);
installImStyles();
const h = React.createElement;
let snapshot = {
  schemaVersion: 2, revision: 1,
  modelCatalog: { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Complex reasoning and coding',
      reasoning: { defaultEffort: 'high', efforts: [
        { id: 'off', name: 'Off', description: 'Fast responses without extended thinking' },
        { id: 'high', name: 'High', description: 'Balanced reasoning for everyday tasks' },
        { id: 'max', name: 'Max', description: 'More time for difficult problems' },
      ] } },
    { id: 'simple', name: 'Simple model', description: 'A model without configurable reasoning' },
  ] }], failures: [] },
  bots: [0, 1].map((index) => ({
    botId: `feishu_${index}`, configured: true, connected: true, state: 'connected',
    workspace: '/workspace/dsh-im', agentPreset: '',
    model: index === 0 ? { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' } : null,
    bot: { name: index === 0 ? '研发助手' : '日常助手', appIdMasked: 'cli_demo•••' },
    health: { status: 'healthy', summary: 'Connected', lastCheckedAt: Date.now() },
  })),
};
const calls = [];
const errors = [];
const originalError = console.error;
console.error = (...args) => { errors.push(args.join(' ')); originalError(...args); };
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
async function rpcCall(endpoint, payload) {
  if (endpoint === 'connection.status') return { ok: true, value: snapshot };
  if (endpoint !== 'bot.model.set') throw new Error(`Unexpected endpoint: ${endpoint}`);
  calls.push(payload);
  snapshot = { ...snapshot, revision: snapshot.revision + 1,
    bots: snapshot.bots.map((bot) => bot.botId === payload.botId ? { ...bot, model: payload.model } : bot) };
  return { ok: true, value: snapshot };
}
createRoot(document.getElementById('app')).render(h('div', { className: 'dim-page' },
  h('section', { className: 'dim-panel' }, h(FeishuSettingsTab, { rpcCall }))));

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise((done) => setTimeout(done, 20));
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await tick(); }
}
const card = () => document.querySelector('[data-bot-id="feishu_0"]');
const row = (label) => [...card().querySelectorAll('.dim-modelRow')]
  .find((button) => button.getAttribute('aria-label') === label);
const menu = () => card().querySelector('.dim-modelMenu');
const options = () => [...menu().querySelectorAll('[role="menuitemradio"]')];
const key = (name) => document.activeElement.dispatchEvent(
  new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

async function run() {
  await until(() => card(), 'Bot card did not mount');
  const collapse = card().querySelector('[aria-expanded="false"]');
  if (collapse && !collapse.classList.contains('dim-modelRow')) { collapse.click(); await tick(); }
  row(labels.effort).click();
  await until(() => menu() && document.activeElement?.getAttribute('aria-checked') === 'true',
    'Opening the effort list did not focus the selected option');
  assert(document.activeElement.textContent.startsWith('High'), 'High should be selected');
  key('End');
  assert(document.activeElement.textContent.startsWith('Max'), 'End should focus the last effort');
  key('Home');
  assert(document.activeElement.textContent.startsWith(labels.default), 'Home should focus default');
  key('ArrowUp');
  assert(document.activeElement.textContent.startsWith('Max'), 'ArrowUp should wrap');
  document.activeElement.click();
  await until(() => !menu() && !row(labels.effort).disabled, 'Effort save did not finish');
  assert(calls.at(-1).model.reasoningEffort === 'max', 'Selected effort was lost');
  assert(snapshot.bots[1].model === null, 'Changing one bot affected another');
  assert(document.activeElement === row(labels.effort), 'Save should return focus to the trigger');
  row(labels.effort).click(); await tick();
  options()[0].click();
  await until(() => !menu() && !row(labels.effort).disabled, 'Reset did not finish');
  assert(!Object.hasOwn(calls.at(-1).model, 'reasoningEffort'), 'Reset must omit the override');
  row(labels.model).click(); await tick();
  assert(menu().querySelector('[role="group"]'), 'Models should be grouped by provider');
  options().find((button) => button.textContent.startsWith('Simple model')).click();
  await until(() => !menu() && !row(labels.model).disabled, 'Model change did not finish');
  assert(row(labels.effort).disabled, 'A non-reasoning model should disable effort changes');
  row(labels.model).click(); await tick();
  options().find((button) => button.textContent.startsWith('DeepSeek V4 Pro')).click();
  await until(() => !menu() && !row(labels.effort).disabled, 'Reasoning model did not restore choices');
  row(labels.effort).click(); await tick();
  key('Escape'); await tick();
  assert(!menu() && document.activeElement === row(labels.effort), 'Escape should close and restore focus');
  row(labels.effort).click(); await tick();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await tick();
  assert(!menu(), 'Outside click should close the list');
  row(labels.effort).click(); await tick();
  options().find((button) => button.textContent.startsWith('High')).click();
  await until(() => !menu() && !row(labels.effort).disabled, 'Final selection did not finish');
  row(labels.effort).click(); await tick();
  assert(document.documentElement.scrollWidth <= innerWidth, 'Page overflows the viewport');
  for (const element of card().querySelectorAll('.dim-modelRow, .dim-modelMenu')) {
    const rect = element.getBoundingClientRect();
    assert(rect.width > 0 && rect.left >= 0 && rect.right <= layoutWidth, 'Model control overflows the viewport');
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  document.body.dataset.result = 'passed';
  document.getElementById('result').textContent = 'Passed: model/effort selection, defaults, per-bot isolation, keyboard navigation, focus, outside click, responsive layout.';
}
run().catch((error) => {
  document.body.dataset.result = 'failed';
  document.getElementById('result').textContent = error.stack;
});
