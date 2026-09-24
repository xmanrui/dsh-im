import { managementFetch } from './fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_RPC_CHANNEL,
  DELIVERY_TEST_MESSAGE,
  createDeliveryRpcHandler,
  installDeliveryRpc,
} from '../plugin-src/host/delivery-rpc.mjs';

function serviceFixture() {
  const calls = [];
  const service = {};
  for (const method of [
    'send',
    'listTargets',
    'listSuggestions',
    'createTarget',
    'updateTarget',
    'deleteTarget',
    'setSessionSync',
  ]) {
    service[method] = async (...args) => {
      calls.push([method, ...args]);
      return { method };
    };
  }
  return { service, calls };
}

test('delivery RPC forwards all endpoints and both target.test payloads to the shared service', async () => {
  const { service, calls } = serviceFixture();
  const handle = createDeliveryRpcHandler(service);
  const signal = new AbortController().signal;
  const target = {
    targetId: 'daily-report',
    name: 'Daily report',
    kind: 'group',
    route: { chatId: 'chat-one' },
  };
  const replacement = { kind: 'group', route: { chatId: 'chat-two' } };
  const draft = { kind: 'group', route: { chatId: 'chat-draft' } };

  for (const [endpoint, payload] of [
    ['message.send', { botId: 'bot_one', targetId: 'daily-report', text: 'hello' }],
    ['target.list', { botId: 'bot_one' }],
    ['target.suggestion.list', { botId: 'bot_one' }],
    ['target.create', { botId: 'bot_one', target }],
    ['target.update', { botId: 'bot_one', targetId: 'daily-report', target: replacement }],
    ['target.delete', { botId: 'bot_one', targetId: 'daily-report' }],
    ['target.session-sync.set', {
      botId: 'bot_one', targetId: 'daily-report', enabled: true,
    }],
    ['target.test', { botId: 'bot_one', targetId: 'daily-report' }],
    ['target.test', { botId: 'bot_one', target: draft }],
  ]) {
    assert.equal((await handle(endpoint, payload, signal)).ok, true);
  }
  assert.deepEqual(calls, [
    ['send', 'bot_one', 'daily-report', 'hello', { signal }],
    ['listTargets', 'bot_one'],
    ['listSuggestions', 'bot_one'],
    ['createTarget', 'bot_one', target],
    ['updateTarget', 'bot_one', 'daily-report', replacement],
    ['deleteTarget', 'bot_one', 'daily-report'],
    ['setSessionSync', 'bot_one', 'daily-report', true],
    ['send', 'bot_one', 'daily-report', DELIVERY_TEST_MESSAGE, { signal }],
    ['send', 'bot_one', draft, DELIVERY_TEST_MESSAGE, { signal }],
  ]);
});

test('delivery RPC rejects unknown, missing, and extra fields before calling the service', async () => {
  const { service, calls } = serviceFixture();
  const handle = createDeliveryRpcHandler(service);
  for (const [endpoint, payload] of [
    ['unknown', {}],
    ['message.send', { botId: 'bot_one', targetId: 'target', text: 'hello', sessionId: 'no' }],
    ['message.send', { botId: 'bot_one', targetId: 'target', text: '   ' }],
    ['target.list', { botId: '../bot' }],
    ['target.suggestion.list', { botId: 'bot_one', sessionId: 'no' }],
    ['target.create', {
      botId: 'bot_one',
      target: { targetId: 'bad target', kind: 'group', route: { chatId: 'one' } },
    }],
    ['target.update', {
      botId: 'bot_one',
      targetId: 'old',
      target: { targetId: 'new', kind: 'group', route: { chatId: 'one' } },
    }],
    ['target.delete', { botId: 'bot_one', targetId: 'target', confirm: true }],
    ['target.session-sync.set', { botId: 'bot_one', targetId: 'target', enabled: 'yes' }],
    ['target.session-sync.set', {
      botId: 'bot_one', targetId: 'target', enabled: true, sessionId: 'no',
    }],
    ['target.test', ['bot_one', 'target']],
    ['target.test', { botId: 'bot_one', targetId: 'target', target: {
      kind: 'group', route: { chatId: 'one' },
    } }],
    ['target.test', { botId: 'bot_one', target: {
      targetId: 'target', kind: 'group', route: { chatId: 'one' },
    } }],
    ['target.test', { botId: 'bot_one', target: {
      name: 'Draft', kind: 'group', route: { chatId: 'one' },
    } }],
    ['target.test', { botId: 'bot_one', target: { kind: 'group' } }],
  ]) {
    assert.equal((await handle(endpoint, payload)).error.code, 'bad-request');
  }
  assert.deepEqual(calls, []);
});

test('delivery RPC returns only stable public errors and handles pre-cancelled calls', async () => {
  const { service } = serviceFixture();
  service.listTargets = async () => {
    throw new Error('token=secret /Users/private/workspaces.json');
  };
  const handle = createDeliveryRpcHandler(service);
  assert.deepEqual(await handle('target.list', { botId: 'bot_one' }), {
    ok: false,
    error: { code: 'delivery-failed', message: 'delivery-failed', details: {} },
  });

  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await handle('target.list', { botId: 'bot_one' }, abort.signal), {
    ok: false,
    error: { code: 'cancelled', message: 'cancelled', details: {} },
  });
});

test('delivery RPC uses its own channel and accepts Harness-admitted LAN requests by default', async () => {
  const { service } = serviceFixture();
  const calls = [];
  installDeliveryRpc({
    connection: { fetch: managementFetch((...args) => calls.push(args)) },
  }, service);
  assert.equal(calls[0][0], DELIVERY_RPC_CHANNEL);
  assert.equal(typeof calls[0][1], 'function');
  assert.deepEqual(await calls[0][1]('target.list', { botId: 'bot_one' }, undefined, {
    host: '192.168.1.100:3080', origin: 'http://192.168.1.100:3080',
  }), { ok: true, value: { method: 'listTargets' } });
});
