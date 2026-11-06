import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROUP_TRIGGERS_ENDPOINTS,
  validGroupTriggersPayload,
} from '../../../plugin-src/host/channels/shared/group-triggers-rpc.mjs';
import { TOKEN_BOT_ENDPOINTS } from '../../../plugin-src/host/channels/shared/rpc.mjs';
import { createTelegramRpcHandler, TELEGRAM_ENDPOINTS } from '../../../plugin-src/host/channels/telegram/rpc.mjs';
import { normalizeGroupTriggers } from '../../../src/channels/telegram/group-triggers.mjs';

const BOT = 'telegram_abc';

/** A controller stub with only the endpoints under test. */
function controller({ seen = [], resolve } = {}) {
  let stored = normalizeGroupTriggers(undefined);
  const calls = [];
  return {
    calls,
    get stored() { return stored; },
    async status() { return { schemaVersion: 1, revision: 1, bots: [] }; },
    async bindCredentials() { throw new Error('not used'); },
    async reconnectBot() { throw new Error('not used'); },
    async deleteBot() { throw new Error('not used'); },
    async groupTriggersPanel() {
      return { defaults: { mode: stored.defaults.mode, senders: [...stored.defaults.senders] }, groups: {}, seen };
    },
    async updateGroupTriggers(botId, { config, removed = [] }) {
      calls.push({ botId, config, removed });
      const normalized = normalizeGroupTriggers(config);
      const groups = { ...normalized.groups };
      const hidden = new Set(normalized.hiddenGroupIds);
      for (const chatId of removed) {
        delete groups[chatId];
        hidden.add(chatId);
      }
      stored = normalizeGroupTriggers({
        version: 1,
        defaults: normalized.defaults,
        groups,
        hiddenGroupIds: [...hidden],
      });
      return {
        defaults: { mode: stored.defaults.mode, senders: [] },
        groups: Object.fromEntries(Object.entries(stored.groups)
          .map(([chatId, entry]) => [chatId, { mode: entry.mode, senders: [...entry.senders] }])),
        seen: [],
      };
    },
    async resolveGroupTrigger(botId, input) {
      calls.push({ botId, input });
      if (typeof resolve === 'function') return resolve(input);
      return { chatId: '-1001234567890', title: 'Team', type: 'supergroup', verified: false };
    },
  };
}

test('group trigger endpoints are telegram-only and leave the shared token endpoints untouched', () => {
  assert.equal(GROUP_TRIGGERS_ENDPOINTS.get, 'bot.group-triggers.get');
  assert.equal(GROUP_TRIGGERS_ENDPOINTS.set, 'bot.group-triggers.set');
  assert.equal(GROUP_TRIGGERS_ENDPOINTS.resolve, 'bot.group-triggers.resolve');
  assert.equal(TELEGRAM_ENDPOINTS.setThinkingTraces, 'bot.thinking-traces.set');
  assert.equal(TELEGRAM_ENDPOINTS.get, 'bot.group-triggers.get');
  // The shared token-bot map stays clean; only Telegram adds these endpoints.
  assert.ok(!Object.values(TOKEN_BOT_ENDPOINTS).includes(GROUP_TRIGGERS_ENDPOINTS.get));
});

test('payload validation rejects malformed requests', () => {
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.get, { botId: BOT }), true);
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.get, { botId: BOT, extra: 1 }), false);
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.get, { botId: '../bad' }), false);
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.set, {
    botId: BOT,
    config: { defaults: { mode: 'all', senders: ['1'] }, groups: {} },
  }), true);
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.set, {
    botId: BOT,
    config: { groups: { '-1': { senders: 'nope' } } },
  }), false);
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.set, {
    botId: BOT,
    config: { groups: {} },
    removed: [1],
  }), false);
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.resolve, { botId: BOT, input: '  ' }), false);
  assert.equal(validGroupTriggersPayload(GROUP_TRIGGERS_ENDPOINTS.resolve, {
    botId: BOT, input: 'https://t.me/c/1234567890/45',
  }), true);
});

test('get returns the panel snapshot', async () => {
  const stub = controller({ seen: [{ chatId: '-1', title: 'One', type: 'supergroup', lastSeenAt: null, lastSenderName: null }] });
  const handler = createTelegramRpcHandler(stub);
  const result = await handler(GROUP_TRIGGERS_ENDPOINTS.get, { botId: BOT });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.defaults, { mode: 'mention', senders: [] });
  assert.equal(result.value.seen[0].title, 'One');
});

test('set stores the rules and returns the saved snapshot', async () => {
  const stub = controller();
  const handler = createTelegramRpcHandler(stub);
  const result = await handler(GROUP_TRIGGERS_ENDPOINTS.set, {
    botId: BOT,
    config: {
      defaults: { mode: 'mention', senders: [] },
      groups: { '-1001': { mode: 'all-list', senders: [' 111 ', '222'] } },
    },
    removed: ['-1002'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(stub.calls[0].removed, ['-1002']);
  assert.deepEqual(result.value.groups['-1001'], { mode: 'all-list', senders: ['111', '222'] });
  assert.equal(result.value.defaults.mode, 'mention');
});

test('set rejects an invalid config without calling the controller', async () => {
  const stub = controller();
  const handler = createTelegramRpcHandler(stub);
  const result = await handler(GROUP_TRIGGERS_ENDPOINTS.set, {
    botId: BOT,
    config: { defaults: { senders: 'nope' } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'bad-request');
  assert.equal(stub.calls.length, 0);
});

test('resolve returns the resolved chat and reports lookup failures', async () => {
  const handler = createTelegramRpcHandler(controller({
    resolve: async (input) => {
      if (input === '@missing') {
        const error = new TypeError('Could not resolve this reference through Telegram (chat not found). Retry later or enter the numeric group ID.');
        error.code = 'group-triggers-invalid';
        throw error;
      }
      return { chatId: '-1001234567890', title: 'Team', type: 'supergroup', verified: true };
    },
  }));
  const ok = await handler(GROUP_TRIGGERS_ENDPOINTS.resolve, { botId: BOT, input: '@team_chat' });
  assert.deepEqual(ok.value, {
    chatId: '-1001234567890', title: 'Team', type: 'supergroup', verified: true,
  });
  const failed = await handler(GROUP_TRIGGERS_ENDPOINTS.resolve, { botId: BOT, input: '@missing' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'group-triggers-invalid');
  assert.match(failed.error.message, /numeric group ID/u);
});

test('unknown endpoints still fall through to the token-bot handler', async () => {
  const stub = controller();
  const handler = createTelegramRpcHandler(stub);
  const result = await handler('bot.thinking-traces.set', { botId: BOT, thinkingTraces: true });
  // The stub controller has no setThinkingTraces, and the shared handler reports
  // that as a normal operation failure rather than "unknown endpoint".
  assert.equal(result.ok, false);
  assert.notEqual(result.error.code, 'bad-request');
});
