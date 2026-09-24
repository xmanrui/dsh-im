import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

function memoryAdapter({ channel = 'telegram', botId = 'bot_one' } = {}) {
  const targets = new Map();
  const sends = [];
  return {
    channel,
    sends,
    listBots: () => [botId],
    ownsBot: (candidate) => candidate === botId,
    listTargets: () => [...targets.values()].map((target) => structuredClone(target)),
    listSuggestions: () => [{ kind: 'chat', route: { chatId: '123' } }],
    async createTarget(_botId, target) {
      if (targets.has(target.targetId)) {
        const error = new Error('duplicate');
        error.code = 'target-conflict';
        throw error;
      }
      targets.set(target.targetId, structuredClone(target));
      return structuredClone(target);
    },
    async updateTarget(_botId, targetId, replacement) {
      if (!targets.has(targetId)) {
        const error = new Error('missing');
        error.code = 'unknown-target';
        throw error;
      }
      const target = { targetId, ...structuredClone(replacement) };
      targets.set(targetId, target);
      return structuredClone(target);
    },
    async deleteTarget(_botId, targetId) {
      if (!targets.delete(targetId)) {
        const error = new Error('missing');
        error.code = 'unknown-target';
        throw error;
      }
    },
    async sendText(...args) { sends.push(args); },
  };
}

test('DeliveryService shares target CRUD and sending through one adapter', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  service.registerAdapter(adapter);
  const target = {
    targetId: 'daily-report',
    name: 'Daily report',
    kind: 'chat',
    route: { chatId: 123 },
  };

  assert.deepEqual(await service.createTarget('bot_one', target), target);
  assert.deepEqual(await service.listTargets('bot_one'), {
    botId: 'bot_one',
    channel: 'telegram',
    targets: [{
      ...target,
      sessionSync: { enabled: false, state: 'unavailable' },
    }],
  });
  assert.deepEqual(await service.listBots(), [{ botId: 'bot_one', channel: 'telegram' }]);
  assert.deepEqual(await service.listSuggestions('bot_one'), {
    botId: 'bot_one',
    channel: 'telegram',
    suggestions: [{ kind: 'chat', route: { chatId: '123' } }],
  });
  assert.deepEqual(await service.updateTarget('bot_one', 'daily-report', {
    name: 'New target',
    kind: 'chat',
    route: { chatId: 456 },
  }), {
    targetId: 'daily-report',
    name: 'New target',
    kind: 'chat',
    route: { chatId: 456 },
  });

  const signal = new AbortController().signal;
  assert.deepEqual(
    await service.send('bot_one', 'daily-report', 'keep original whitespace\n', { signal }),
    { sent: true },
  );
  assert.deepEqual(adapter.sends, [[
    'bot_one',
    {
      targetId: 'daily-report',
      name: 'New target',
      kind: 'chat',
      route: { chatId: 456 },
    },
    'keep original whitespace\n',
    { signal },
  ]]);
  assert.deepEqual(await service.deleteTarget('bot_one', 'daily-report'), { deleted: true });
  await assert.rejects(service.send('bot_one', 'daily-report', 'missing'), { code: 'unknown-target' });
});

test('DeliveryService validates public ids, text, cancellation, and unknown bots', async () => {
  const service = createDeliveryService();
  service.registerAdapter(memoryAdapter());
  await assert.rejects(service.listTargets('../bot'), { code: 'bad-request' });
  await assert.rejects(service.listSuggestions('../bot'), { code: 'bad-request' });
  await assert.rejects(service.listTargets('bot_missing'), { code: 'unknown-bot' });
  await assert.rejects(service.listSuggestions('bot_missing'), { code: 'unknown-bot' });
  await assert.rejects(service.send('bot_one', 'bad target', 'hello'), { code: 'bad-request' });
  await assert.rejects(service.send('bot_one', 'target', '   '), { code: 'bad-request' });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(service.send('bot_one', 'target', 'hello', { signal: abort.signal }), {
    code: 'cancelled',
  });
  await assert.rejects(
    service.updateTarget('bot_one', 'target', {
      targetId: 'renamed', kind: 'chat', route: { chatId: 1 },
    }),
    { code: 'bad-request' },
  );
});

test('DeliveryService tests a validated draft route without reading or persisting targets', async () => {
  const service = createDeliveryService();
  const workspaceCalls = [];
  const sends = [];
  service.registerAdapter(createDeliveryAdapter({
    channel: 'telegram',
    workspaces: {
      has: (botId) => botId === 'bot_one',
      listDeliveryTargets: (...args) => workspaceCalls.push(['list', ...args]),
      createDeliveryTarget: (...args) => workspaceCalls.push(['create', ...args]),
      updateDeliveryTarget: (...args) => workspaceCalls.push(['update', ...args]),
      deleteDeliveryTarget: (...args) => workspaceCalls.push(['delete', ...args]),
    },
    coreController: {
      async sendProactiveText(...args) { sends.push(args); },
    },
    stateFor: async () => ({ snapshot: () => ({ sessions: {} }) }),
  }));
  const signal = new AbortController().signal;
  const draft = {
    kind: 'topic',
    route: { chatId: '-1001234567890', messageThreadId: 42 },
  };

  assert.deepEqual(
    await service.send('bot_one', draft, 'draft test', { signal }),
    { sent: true },
  );
  assert.deepEqual(workspaceCalls, []);
  assert.deepEqual(sends, [[
    'bot_one',
    { targetId: '__test__', ...draft },
    'draft test',
    { signal },
  ]]);
  assert.deepEqual(draft, {
    kind: 'topic',
    route: { chatId: '-1001234567890', messageThreadId: 42 },
  });

  await assert.rejects(
    service.send('bot_one', { ...draft, targetId: 'must-not-participate' }, 'draft test'),
    { code: 'bad-request' },
  );
  await assert.rejects(
    service.send('bot_one', { ...draft, name: 'must-not-participate' }, 'draft test'),
    { code: 'bad-request' },
  );
  await assert.rejects(
    service.send('bot_one', {
      kind: 'topic', route: { chatId: '-1001234567890', messageThreadId: '42' },
    }, 'draft test'),
    { code: 'invalid-target' },
  );
  assert.deepEqual(workspaceCalls, []);
  assert.equal(sends.length, 1);
});

test('DeliveryService revalidates suggestions before exposing adapter output', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  service.registerAdapter(adapter);

  adapter.listSuggestions = () => [{
    kind: 'chat',
    route: { chatId: '123' },
    sessionId: 'secret-session',
  }];
  await assert.rejects(service.listSuggestions('bot_one'), { code: 'invalid-target' });

  adapter.listSuggestions = () => [{
    kind: 'chat',
    route: { chatId: '123', replyTarget: 'secret-reply' },
  }];
  await assert.rejects(service.listSuggestions('bot_one'), { code: 'invalid-target' });
});

test('DeliveryService maps an adapter abort to cancelled', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  adapter.sendText = async () => {
    const error = new Error('aborted downstream');
    error.name = 'AbortError';
    throw error;
  };
  service.registerAdapter(adapter);
  await service.createTarget('bot_one', {
    targetId: 'target', kind: 'chat', route: { chatId: 1 },
  });
  await assert.rejects(service.send('bot_one', 'target', 'hello'), { code: 'cancelled' });
});

test('DeliveryService adapter replacement has stale-safe unregister semantics', async () => {
  const service = createDeliveryService();
  const first = memoryAdapter();
  const second = memoryAdapter();
  const unregisterFirst = service.registerAdapter(first);
  const unregisterSecond = service.registerAdapter(second);
  assert.equal(unregisterFirst(), false);
  await service.createTarget('bot_one', {
    targetId: 'current', kind: 'chat', route: { chatId: 1 },
  });
  assert.equal((await service.listTargets('bot_one')).targets.length, 1);
  assert.equal(unregisterSecond(), true);
  await assert.rejects(service.listTargets('bot_one'), { code: 'unknown-bot' });
});

test('DeliveryService exposes and revalidates local Session sync without changing public send', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  const syncCalls = [];
  adapter.listTargets = () => [{
    targetId: 'direct', kind: 'chat', route: { chatId: '123' },
    sessionSync: { enabled: false, state: 'off' },
  }];
  adapter.setSessionSync = async (...args) => {
    syncCalls.push(['set', ...args]);
    return { enabled: args[2], state: args[2] ? 'active' : 'off' };
  };
  adapter.listSessionSyncTargets = async (sessionId) => (
    sessionId === 'session-one' ? [{ botId: 'bot_one', targetId: 'direct' }] : []
  );
  adapter.sendSessionSyncText = async (...args) => syncCalls.push(['send', ...args]);
  service.registerAdapter(adapter);

  assert.deepEqual((await service.listTargets('bot_one')).targets[0].sessionSync, {
    enabled: false, state: 'off',
  });
  assert.deepEqual(await service.setSessionSync('bot_one', 'direct', true), {
    enabled: true, state: 'active',
  });
  assert.deepEqual(await service.listSessionSyncTargets('session-one'), [{
    channel: 'telegram', botId: 'bot_one', targetId: 'direct',
  }]);
  assert.deepEqual(
    await service.sendSessionSyncText('bot_one', 'direct', 'session-one', 'hello'),
    { sent: true },
  );
  assert.deepEqual(syncCalls, [
    ['set', 'bot_one', 'direct', true],
    ['send', 'bot_one', 'direct', 'session-one', 'hello', { signal: undefined }],
  ]);
});

test('DeliveryService marks explicit remote Harness channels unavailable for Session sync', async () => {
  const service = createDeliveryService({ unavailableSessionSyncChannels: ['telegram'] });
  const adapter = memoryAdapter();
  const calls = [];
  adapter.listTargets = () => [{
    targetId: 'direct', kind: 'chat', route: { chatId: '123' },
    sessionSync: { enabled: true, state: 'active' },
  }];
  adapter.setSessionSync = async (...args) => {
    calls.push(args);
    return { enabled: false, state: 'off' };
  };
  adapter.listSessionSyncTargets = async () => [{ botId: 'bot_one', targetId: 'direct' }];
  adapter.sendSessionSyncText = async () => {};
  service.registerAdapter(adapter);

  assert.deepEqual((await service.listTargets('bot_one')).targets[0].sessionSync, {
    enabled: true, state: 'unavailable',
  });
  await assert.rejects(service.setSessionSync('bot_one', 'direct', true), {
    code: 'session-sync-unavailable',
  });
  assert.deepEqual(await service.listSessionSyncTargets('session-one'), []);
  assert.deepEqual(await service.setSessionSync('bot_one', 'direct', false), {
    enabled: false, state: 'off',
  });
  assert.deepEqual(calls, [['bot_one', 'direct', false]]);
});
