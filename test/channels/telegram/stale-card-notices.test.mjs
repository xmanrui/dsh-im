import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { ActionCardRegistry } from '../../../src/channels/shared/action-card.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';

/**
 * A card that outlived its process must tell the user what to do next.
 *
 * Card nonces live in memory, so after a host restart every keyboard still on
 * screen is dead. Pressing one used to answer "已失效或不存在" and nothing else —
 * true, but it leaves the user with a dead button and no way forward. Each card
 * now names the command that reopens it, and this file pins that for all of them
 * at once so a new card cannot ship without it.
 */

let WORKSPACE = '';

before(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'stale-'));
});

after(async () => {
  if (WORKSPACE) await rm(WORKSPACE, { recursive: true, force: true });
});

function bridgeWithBot(notices) {
  let seq = 0;
  return new TelegramHarnessBridge({
    bot: {
      async sendText() {},
      async sendInteractionCard() { seq += 1; return { providerMessageIds: [String(seq)] }; },
      async editInteractionCard() {},
      async updateInteractionCard() {},
      async answerInteractionCallback(_queryId, text) { notices.push(text); },
    },
    harness: {
      async ensureRunning() {},
      currentWorkspace: () => WORKSPACE,
      currentConversationWorkspace: () => WORKSPACE,
      hasConversationWorkspaceOverride: () => false,
      async listWorkspaces() { return [WORKSPACE]; },
      async listWorkspaceSessions(workspace) { return { workspace, sessions: [] }; },
      async agentPresetSettings() {
        return { agentPreset: null, agentPresetCatalog: { defaultId: '', items: [] } };
      },
      assertWorkspaceScope() {},
      workspaceSession: () => ({
        async sessionExists() { return true; },
        async models() { return { groups: [], failures: [], current: null }; },
        async isRunning() { return false; },
      }),
    },
    state: { hasSeen: () => false, async markSeen() {}, sessionFor: () => null },
    logger: { warn() {}, error() {} },
  });
}

/**
 * One stale press per card namespace, with the command that must be named.
 *
 * The nonce is deliberately unknown: that is exactly the state after a restart.
 */
const STALE_PRESSES = Object.freeze([
  { card: 'menu', data: 'm3|DEADNONCE123|s', reopen: '/menu' },
  { card: 'help', data: 'h1|DEADNONCE123|home', reopen: '/help' },
  { card: 'status', data: 't1|DEADNONCE123|r', reopen: '/status' },
  { card: 'preset', data: 'p1|DEADNONCE123|i1', reopen: '/presetlist' },
  { card: 'conv', data: 'v1|DEADNONCE123|i1', reopen: '/conv' },
  { card: 'clear', data: 'c2|DEADNONCE123|y', reopen: '/clear' },
  { card: 'model', data: 'm2|DEADNONCE123|1', reopen: '/models' },
  // The reasoning picker is its own namespace on the same adapter.
  { card: 'reasoning', data: 'r2|DEADNONCE123|1', reopen: '/reasoninglist' },
]);

for (const { card, data, reopen } of STALE_PRESSES) {
  test(`a stale ${card} card names the command that reopens it`, async () => {
    const notices = [];
    const bridge = bridgeWithBot(notices);
    await bridge.acceptCallback({
      callbackQueryId: `stale-${card}`,
      senderId: 'actor-a',
      senderIsBot: false,
      kind: 'direct',
      conversationId: 'chat-stale',
      messageId: `upd-${card}`,
      data,
      replyTarget: { chatId: 42 },
    });
    const text = notices.filter((entry) => typeof entry === 'string' && entry).join('\n');
    assert.ok(text, `${card}: a stale press must be acknowledged`);
    assert.match(text, /失效|已处理|过期|不存在/u, `${card}: says the card is dead`);
    assert.ok(text.includes(reopen),
      `${card}: a dead card must name how to reopen it (expected ${reopen}), got: ${text}`);
  });
}

test('every Telegram card namespace is covered above', async () => {
  // Guard against a new card being added without a reopen instruction: the set of
  // callback prefixes the bridge knows about must equal the ones exercised here.
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../../../src/channels/telegram/', import.meta.url);
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((name) => name.endsWith('-card.mjs'));
  const prefixes = new Set();
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    for (const match of source.matchAll(/createCallbackNamespace\(\s*'([a-z0-9]+)'/gu)) {
      prefixes.add(match[1]);
    }
  }
  const covered = new Set(STALE_PRESSES.map(({ data }) => data.split('|')[0]));
  const missing = [...prefixes].filter((prefix) => !covered.has(prefix));
  assert.deepEqual(missing, [],
    `these card namespaces have no stale-press test: ${missing.join(', ')}`);
});
