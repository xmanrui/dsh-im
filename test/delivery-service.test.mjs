import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

test('reachable posting exposes a bounded preflight refusal without dispatching on account lookup failure', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  adapter.describeAccount = async () => { throw new Error('private provider diagnostic'); };
  adapter.listReachableConversations = async () => assert.fail('No discovery after failed account lookup');
  adapter.postConversationChecked = async () => assert.fail('No dispatch after failed account lookup');
  service.registerAdapter(adapter);
  await assert.rejects(service.postConversationChecked('bot_one', 'oc_group', 'Result', {
    expectedFingerprint: 'a'.repeat(64), beforeSend: () => true,
  }), { code: 'send-preflight-unavailable', message: 'send-preflight-unavailable' });
  assert.equal(adapter.sends.length, 0);
});

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

function checkedFixture() {
  const service = createDeliveryService();
  const adapter = memoryAdapter({channel: 'feishu'});
  const fingerprint = 'a'.repeat(64);
  adapter.describeAccount = async () => ({version: 1, botId: 'bot_one', channel: 'feishu',
    connected: true, capabilities: ['proactive-text-checked'], account: {fingerprint}});
  return {service, adapter, fingerprint};
}

async function checkedTarget(fx) {
  const target = {targetId: 'self', kind: 'user', route: {openId: 'ou_self'}};
  await fx.service.createTarget('bot_one', target);
  const {createHash} = await import('node:crypto');
  return createHash('sha256').update(JSON.stringify({kind: target.kind, route: target.route})).digest('hex');
}

test('checked saved-target sending honors the caller final authorization before any native effect', async () => {
  const fx = checkedFixture();
  fx.service.registerAdapter(fx.adapter);
  const digest = await checkedTarget(fx);
  await assert.rejects(fx.service.sendChecked('bot_one', 'self', 'hello', {
    expectedFingerprint: fx.fingerprint, expectedTargetDigest: digest, beforeSend: () => false,
  }), { code: 'send-permission-denied' });
  assert.equal(fx.adapter.sends.length, 0);
});

test('checked sending rejects changed targets and account identities before a side effect', async () => {
  const fx = checkedFixture(); fx.service.registerAdapter(fx.adapter);
  const digest = await checkedTarget(fx);
  await assert.rejects(fx.service.sendChecked('bot_one', 'self', 'hello', {
    expectedFingerprint: 'b'.repeat(64), expectedTargetDigest: digest,
  }), {code: 'account-changed'});
  await fx.service.updateTarget('bot_one', 'self', {kind: 'user', route: {openId: 'ou_other'}});
  await assert.rejects(fx.service.sendChecked('bot_one', 'self', 'hello', {
    expectedFingerprint: fx.fingerprint, expectedTargetDigest: digest,
  }), {code: 'target-changed'});
  assert.equal(fx.adapter.sends.length, 0);
});

test('checked sending freezes the authorized route across an alias edit during account verification', async () => {
  const fx = checkedFixture(); fx.service.registerAdapter(fx.adapter);
  const digest = await checkedTarget(fx);
  const describe = fx.adapter.describeAccount;
  fx.adapter.describeAccount = async () => {
    await fx.adapter.updateTarget('bot_one', 'self', {kind: 'user', route: {openId: 'ou_other'}});
    return describe();
  };
  assert.deepEqual(await fx.service.sendChecked('bot_one', 'self', 'hello', {
    expectedFingerprint: fx.fingerprint, expectedTargetDigest: digest,
  }), {sent: true});
  assert.deepEqual(fx.adapter.sends[0][1].route, {openId: 'ou_self'});
  assert.equal(fx.adapter.sends[0][3].expectedFingerprint, fx.fingerprint);
});

test('checked sending fails closed when its Registration is disposed during preflight', async () => {
  const fx = checkedFixture(); const dispose = fx.service.registerAdapter(fx.adapter);
  const digest = await checkedTarget(fx);
  const describe = fx.adapter.describeAccount;
  fx.adapter.describeAccount = async () => {dispose(); return describe();};
  await assert.rejects(fx.service.sendChecked('bot_one', 'self', 'hello', {
    expectedFingerprint: fx.fingerprint, expectedTargetDigest: digest,
  }), {code: 'capability-unavailable'});
  assert.equal(fx.adapter.sends.length, 0);
});

test('legacy providers cannot advertise checked sending implicitly', async () => {
  const fx = checkedFixture(); delete fx.adapter.describeAccount; fx.service.registerAdapter(fx.adapter);
  await assert.rejects(fx.service.describeBot('bot_one'), {code: 'capability-unavailable'});
});


test('checked account discovery fences replacement even when the same adapter object is registered again', async () => {
  const service = createDeliveryService();
  const adapter = memoryAdapter();
  let calls = 0;
  adapter.describeAccount = async () => {
    ++calls;
    service.registerAdapter(adapter);
    return {version: 1, botId: 'bot_one', channel: 'telegram', account: {fingerprint: 'a'.repeat(64)}, connected: true, capabilities: ['proactive-text-checked']};
  };
  service.registerAdapter(adapter);
  await assert.rejects(service.describeBot('bot_one'), {code: 'capability-unavailable'});
  assert.equal(calls, 1);
  assert.equal(adapter.sends.length, 0);
});

test('checked receipt requires capability and exact frozen group correspondence, never resends', async () => {
  const fx = checkedFixture(); fx.service.registerAdapter(fx.adapter);
  const target = { targetId: 'group', kind: 'group', route: { chatId: 'oc_group' } };
  await fx.service.createTarget('bot_one', target);
  const { createHash } = await import('node:crypto');
  const expectedTargetDigest = createHash('sha256').update(JSON.stringify({ kind: target.kind, route: target.route })).digest('hex');
  const options = { expectedFingerprint: fx.fingerprint, expectedTargetDigest, receipt: true };
  await assert.rejects(fx.service.sendChecked('bot_one', 'group', 'report', options), { code: 'capability-unavailable' });
  assert.equal(fx.adapter.sends.length, 0);
  fx.adapter.describeAccount = async () => ({ version: 1, capabilities: ['proactive-text-checked', 'proactive-receipt-checked'], account: { fingerprint: fx.fingerprint } });
  let calls = 0;
  fx.adapter.sendText = async (_id, saved, _text, opts) => {
    calls++; assert.equal(saved.route.chatId, 'oc_group'); assert.equal(opts.receipt, true);
    return { sent: true, receipt: { version: 1, messageId: 'om_report', conversationId: 'oc_group', secret: 'not exposed' } };
  };
  assert.deepEqual(await fx.service.sendChecked('bot_one', 'group', 'report', options), { sent: true, receipt: { version: 1, messageId: 'om_report', conversationId: 'oc_group' } });
  fx.adapter.sendText = async () => { calls++; return { sent: true, receipt: { version: 1, messageId: 'om_other', conversationId: 'oc_other' } }; };
  await assert.rejects(fx.service.sendChecked('bot_one', 'group', 'report', options), { code: 'send-result-unknown' });
  assert.equal(calls, 2);
});

test('consumer replacement aborts the old account lease and stale dispose cannot remove its successor', async () => {
  const fx = checkedFixture();
  let lease;
  fx.adapter.consumeInbound = async (_id, options) => {
    lease = options;
    return () => {};
  };
  const oldDispose = fx.service.registerAdapter(fx.adapter);
  await fx.service.consumeInbound('bot_one', { expectedFingerprint: fx.fingerprint, onEvent: async () => ({ accepted: true }) });
  fx.service.registerAdapter(fx.adapter);
  assert.equal(lease.signal.aborted, true);
  assert.equal(oldDispose(), false);
  await assert.rejects(lease.onEvent({}, {}), { code: 'capability-unavailable' });
  assert.equal((await fx.service.describeBot('bot_one')).account.fingerprint, fx.fingerprint);
});

test('a reply waiting for provider preflight cannot send after its Registration disappears', async () => {
  const fx = checkedFixture();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let resume;
  const ready = new Promise(resolve => { resume = resolve; });
  let sends = 0;
  fx.adapter.replyChecked = async (_id, _route, _text, options) => {
    entered(); await ready;
    options.signal.throwIfAborted();
    sends++;
    return { sent: true };
  };
  const dispose = fx.service.registerAdapter(fx.adapter);
  const result = fx.service.replyChecked('bot_one', { messageId: 'message' }, 'hello', { expectedFingerprint: fx.fingerprint });
  await started;
  dispose(); resume();
  await assert.rejects(result, { code: 'provider-unavailable' });
  assert.equal(sends, 0);
});

test('optional checked history refuses legacy adapters and preserves public read refusals', async () => {
 const fx=checkedFixture();fx.service.registerAdapter(fx.adapter);
 await assert.rejects(fx.service.historyChecked('bot_one',{}, {}, {expectedFingerprint:fx.fingerprint}),{code:'capability-unavailable'});
 for(const code of ['history-permission-denied','stale-route','thread-unavailable','untrusted-source']) {
  fx.adapter.historyChecked=async()=>{throw Object.assign(new Error('refused'),{code});};
  await assert.rejects(fx.service.historyChecked('bot_one',{}, {}, {expectedFingerprint:fx.fingerprint}),{code});
 }
});

test('checked history discards an in-flight result after provider replacement or caller cancellation', async () => {
 for(const cancel of [false,true]) {
  const fx=checkedFixture();fx.service.registerAdapter(fx.adapter);let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  fx.adapter.historyChecked=async()=>{entered();await gate;return {events:['must not escape']};};
  const abort=new AbortController();
  const pending=fx.service.historyChecked('bot_one',{}, {}, {expectedFingerprint:fx.fingerprint,signal:abort.signal});
  await started;
  if(cancel)abort.abort();else fx.service.registerAdapter(fx.adapter);
  release();await assert.rejects(pending,{code:cancel?'cancelled':'capability-unavailable'});
 }
});

function approvalAdapter(channel, keys, { present = async () => true } = {}) {
  const botId = `bot_${channel.replaceAll('-', '_')}`;
  const adapter = memoryAdapter({ channel, botId });
  const offers = [];
  const notices = [];
  Object.assign(adapter, {
    setSessionSync() {},
    listSessionSyncTargets: () => keys.map((_, index) => ({ botId, targetId: `target${index}` })),
    describeSessionSyncApprovalTarget: (_bot, targetId) => ({ conversationKey: keys[Number(targetId.slice(6))] }),
    sendSessionSyncText: async (...args) => notices.push(args),
    presentSessionSyncApproval: async (...args) => { offers.push(args); return present(...args); },
  });
  return { adapter, offers, notices };
}

for (const channel of ['feishu', 'weixin', 'dingtalk', 'wecom', 'wecom-app', 'qq', 'telegram', 'slack', 'discord', 'whatsapp', 'matrix']) {
  test(`${channel}: one real bound private chat gets one approval despite target aliases`, async () => {
    const service = createDeliveryService();
    const { adapter, offers, notices } = approvalAdapter(channel, ['private:actor', 'private:actor']);
    service.registerAdapter(adapter);
    const interaction = { payload: { toolName: 'bash' } };
    assert.equal(await service.presentSessionSyncApproval('session', interaction, {
      completion: new Promise(() => {}),
    }), true);
    assert.equal(offers.length, 1);
    assert.equal(offers[0][3], interaction);
    assert.equal(notices.length, 0);
  });
}

test('multiple bound chats receive a Web notice and cannot compete for approval', async () => {
  const service = createDeliveryService();
  const first = approvalAdapter('feishu', ['p2p:a']);
  const second = approvalAdapter('telegram', ['direct:2']);
  service.registerAdapter(first.adapter);
  service.registerAdapter(second.adapter);
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  assert.equal(await service.presentSessionSyncApproval('session', { payload: { toolName: 'bash' } }, { completion }), false);
  assert.equal(first.offers.length + second.offers.length, 0);
  assert.match(first.notices[0][3], /Web/);
  finish('unavailable');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(first.notices.at(-1)[3], /未获批准/);
});

for (const channel of ['imessage', 'email', 'office']) {
  test(`${channel}: excluded channels never receive competitive approvals`, async () => {
    const service = createDeliveryService();
    const { adapter, offers, notices } = approvalAdapter(channel, ['private:actor']);
    service.registerAdapter(adapter);
    assert.equal(await service.presentSessionSyncApproval('session', { payload: { toolName: 'bash' } }), false);
    assert.equal(offers.length + notices.length, 0);
  });
}


test('an unresolved second binding cannot make the first chat look unique', async () => {
  const service = createDeliveryService();
  const first = approvalAdapter('feishu', ['p2p:a']);
  const second = approvalAdapter('telegram', ['direct:2']);
  second.adapter.describeSessionSyncApprovalTarget = () => { throw new Error('state unavailable'); };
  service.registerAdapter(first.adapter);
  service.registerAdapter(second.adapter);
  assert.equal(await service.presentSessionSyncApproval('session', { payload: { toolName: 'bash' } }, {
    completion: new Promise(() => {}),
  }), false);
  assert.equal(first.offers.length + second.offers.length, 0);
});
