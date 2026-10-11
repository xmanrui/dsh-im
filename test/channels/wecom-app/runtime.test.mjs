import assert from 'node:assert/strict';
import test from 'node:test';
import { WecomAppRuntime } from '../../../src/channels/wecom-app/wecom-app-runtime.mjs';
import { WecomAppApi } from '../../../src/channels/wecom-app/wecom-app-api.mjs';

test('WeCom app sync retains full plain content with UTF-8 chunks, cancellation and failure reporting', async (t) => {
  const calls = [];
  let failure;
  t.mock.method(WecomAppApi.prototype, 'sendText', async request => {
    calls.push(request);
    if (failure) throw failure;
  });
  const runtime = new WecomAppRuntime({
    config: { botId: 'app-test', corpId: 'ww-test', agentId: '100', callbackSecret: 'callback' },
    secrets: { corpSecret: 'test', token: 'test', encodingAESKey: 'test' },
    harness: { ensureRunning: async () => true }, state: {},
    callbackServer: { registerRoute: async () => {}, unregisterRoute() {} },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const target = { kind: 'user', route: { chatId: 'owner' } };
  const text = '# 同步\n' + '**中文😀** [link](https://example.com)\n'.repeat(150);
  await runtime.sendProactiveText(target, text, { format: 'markdown' });
  assert.ok(calls.length > 1);
  assert.equal(calls.map(call => call.content).join(''), text);
  assert.ok(calls.every(call => call.userId === 'owner' && Buffer.byteLength(call.content) <= 2048));
  const before = calls.length;
  await assert.rejects(runtime.sendProactiveText(target, text, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls.length, before);
  failure = new Error('provider failure');
  await assert.rejects(runtime.sendProactiveText(target, text, { format: 'markdown' }), error => error === failure);
  assert.equal(calls.length, before + 1);
});
