import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCORD_APPROVAL_CARD_MAX_CHARS,
  DiscordApprovalCard,
  discordApprovalComponents,
  discordApprovalCustomId,
  parseDiscordApprovalCustomId,
} from '../../../src/channels/discord/approval-card.mjs';
import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';
import { APPROVAL_SUBMIT_RESULT } from '../../../src/channels/shared/harness-approval.mjs';

const APPROVAL_PAYLOAD = {
  type: 'approval/requested',
  sessionId: 'session-one',
  approvalId: 'approval-one',
  toolName: 'bash',
  callId: 'call-one',
  reason: '测试审批链路',
};
const ARGUMENTS = JSON.stringify({ command: "printf 'approval-test\\n'" });

function pendingFixture(overrides = {}) {
  return {
    approvalId: 'approval-one',
    interaction: { payload: APPROVAL_PAYLOAD },
    toolCall: { callId: 'call-one', name: 'bash', arguments: ARGUMENTS },
    text: 'plain approval prompt',
    requiresMention: false,
    interactiveCard: false,
    ...overrides,
  };
}

function botFixture({ cardResult = 'ok', editResult = 'ok', supportsCards = true } = {}) {
  const env = { cards: [], edits: [], sent: [], notices: [], acks: 0 };
  const bot = {
    async sendText(_target, text) { env.sent.push(text); },
    async answerInteractionCallback(queryId, text) {
      env.acks += 1;
      env.notices.push({ queryId, text });
    },
  };
  if (supportsCards) {
    bot.sendInteractionCard = async (_target, card) => {
      if (cardResult === 'fail') throw new Error('discord refused the components');
      env.cards.push(card);
      return { providerMessageIds: [`card-${env.cards.length}`] };
    };
    bot.editInteractionCard = async (_target, messageId, edit) => {
      if (editResult === 'fail') throw new Error('discord refused the message edit');
      env.edits.push({ messageId, ...edit });
      return { id: messageId };
    };
    bot.updateInteractionCard = async (_target, messageId, edit) => {
      env.edits.push({ messageId, ...edit });
      return { id: messageId };
    };
  }
  return { bot, env };
}

function deliveredButton(env, index) {
  const row = env.cards.at(-1)?.components?.[0];
  const button = row?.components?.[index];
  assert.ok(button?.custom_id, `no delivered button at index ${index}`);
  return button.custom_id;
}

test('approval custom ids are versioned, bounded and limited to approve/reject', () => {
  const approve = discordApprovalCustomId('abcd1234EFGH', 'approve');
  const reject = discordApprovalCustomId('abcd1234EFGH', 'reject');
  assert.equal(approve, 'ap1|abcd1234EFGH|a');
  assert.equal(reject, 'ap1|abcd1234EFGH|d');
  assert.deepEqual(parseDiscordApprovalCustomId(approve), {
    nonce: 'abcd1234EFGH',
    action: 'approve',
  });
  for (const invalid of ['', 'ap1', 'ap1|n', 'ap1|n|x', 'ap1|n|a|extra', 'ap2|n|a', null, 7]) {
    assert.equal(parseDiscordApprovalCustomId(invalid), null, `foreign payload: ${String(invalid)}`);
  }
  assert.throws(() => discordApprovalCustomId('', 'approve'), /nonce is invalid/u);
});

test('the approval row uses one action row with approve and reject buttons', () => {
  const [row] = discordApprovalComponents('nonce123');
  assert.equal(row.type, 1);
  assert.deepEqual(row.components.map((button) => ({
    type: button.type,
    style: button.style,
    label: button.label,
  })), [
    { type: 2, style: 3, label: '✅ 批准一次' },
    { type: 2, style: 4, label: '❌ 拒绝' },
  ]);
  assert.deepEqual(row.components.map((button) => parseDiscordApprovalCustomId(button.custom_id)), [
    { nonce: 'nonce123', action: 'approve' },
    { nonce: 'nonce123', action: 'reject' },
  ]);
});

test('an approval is delivered as a component card carrying the prompt body', async () => {
  const { bot, env } = botFixture();
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:222222222222222222',
    actor: '333333333333333333',
    target: { channelId: '222222222222222222', replyToMessageId: '111111111111111111' },
    send: (text) => bot.sendText(null, text),
    bot,
  });
  const pending = pendingFixture();
  await context.render(pending);

  assert.equal(env.cards.length, 1);
  assert.equal(env.sent.length, 0);
  assert.match(env.cards[0].text, /bash/u);
  assert.match(env.cards[0].text, /测试审批链路/u, 'the reason stays in the card body');
  assert.doesNotMatch(env.cards[0].text, /请精准回复/u,
    'a card does not tell the user to type the decision');
  assert.equal(pending.interactiveCard, true);
  assert.equal(parseDiscordApprovalCustomId(deliveredButton(env, 0)).action, 'approve');
});

test('resolving a card rewrites it to a terminal receipt without buttons', async () => {
  const { bot, env } = botFixture();
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:1', actor: 'actor-a', target: { channelId: '1' }, bot,
    send: (text) => bot.sendText(null, text),
  });
  await context.render(pendingFixture());
  const delivered = await context.onResolved('已批准，仅对本次操作有效。', 'allowed-once');

  assert.equal(delivered, true);
  assert.equal(env.edits.length, 1);
  assert.equal(env.edits[0].messageId, 'card-1');
  assert.deepEqual(env.edits[0].components, []);
  assert.match(env.edits[0].text, /✅ 已批准（仅本次）/u);
  // The queue would send the same receipt as text; the card already showed it.
  await context.send('已批准，仅对本次操作有效。');
  assert.deepEqual(env.sent, []);
});

test('a refused card send falls back to the exact plain-text approval', async () => {
  const { bot, env } = botFixture({ cardResult: 'fail' });
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:1', actor: 'actor-a', target: { channelId: '1' }, bot,
    send: (text) => bot.sendText(null, text),
  });
  const pending = pendingFixture();
  await context.render(pending);
  assert.deepEqual(env.sent, [pending.text]);
  assert.equal(pending.interactiveCard, false);
});

test('an over-limit approval body keeps the plain-text path', async () => {
  const { bot, env } = botFixture();
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:1', actor: 'actor-a', target: { channelId: '1' }, bot,
    send: (text) => bot.sendText(null, text),
  });
  const pending = pendingFixture({
    interaction: { payload: { ...APPROVAL_PAYLOAD, reason: 'x'.repeat(DISCORD_APPROVAL_CARD_MAX_CHARS + 10) } },
  });
  await context.render(pending);
  assert.equal(env.cards.length, 0);
  assert.deepEqual(env.sent, [pending.text]);
});

test('pressing approve acknowledges first and submits exactly once', async () => {
  const { bot, env } = botFixture();
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:1', actor: 'actor-a', target: { channelId: '1' }, bot,
    send: (text) => bot.sendText(null, text),
  });
  await context.render(pendingFixture());
  const submissions = [];
  const handled = await card.handlePress({
    data: deliveredButton(env, 0),
    senderId: 'actor-a',
    providerMessageId: 'card-1',
    replyTarget: { channelId: '1' },
  }, {
    bot,
    answer: (text) => bot.answerInteractionCallback('interaction-1', text),
    submit: async (approvalId, outcome, options) => {
      submissions.push({ approvalId, outcome, options });
      return APPROVAL_SUBMIT_RESULT.SUBMITTED;
    },
  });

  assert.equal(handled, true);
  assert.equal(env.acks, 1);
  assert.equal(env.notices[0].text, undefined, 'the ack is a deferred update, not a notice');
  assert.deepEqual(submissions, [{
    approvalId: 'approval-one',
    outcome: 'allowed-once',
    options: { actor: 'actor-a', detailed: true },
  }]);
});

test('a stranger press is refused without consuming the owner decision', async () => {
  const { bot, env } = botFixture();
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:1', actor: 'actor-a', target: { channelId: '1' }, bot,
    send: (text) => bot.sendText(null, text),
  });
  await context.render(pendingFixture());
  let submitted = 0;
  await card.handlePress({
    data: deliveredButton(env, 0),
    senderId: 'stranger',
    providerMessageId: 'card-1',
    replyTarget: { channelId: '1' },
  }, {
    bot,
    answer: (text) => bot.answerInteractionCallback('interaction-1', text),
    submit: async () => { submitted += 1; return APPROVAL_SUBMIT_RESULT.SUBMITTED; },
  });

  assert.equal(submitted, 0);
  assert.match(env.notices[0].text, /只有发起当前任务的用户可以处理这条审批/u);
  // The owner can still decide after the stranger was turned away.
  const second = await card.handlePress({
    data: deliveredButton(env, 0),
    senderId: 'actor-a',
    providerMessageId: 'card-1',
    replyTarget: { channelId: '1' },
  }, {
    bot,
    answer: () => {},
    submit: async () => APPROVAL_SUBMIT_RESULT.SUBMITTED,
  });
  assert.equal(second, true);
});

test('a retryable failure restores the live buttons', async () => {
  const { bot, env } = botFixture();
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:1', actor: 'actor-a', target: { channelId: '1' }, bot,
    send: (text) => bot.sendText(null, text),
  });
  await context.render(pendingFixture());
  const data = deliveredButton(env, 1);
  await card.handlePress({ data, senderId: 'actor-a', providerMessageId: 'card-1', replyTarget: { channelId: '1' } }, {
    bot,
    answer: () => {},
    submit: async () => APPROVAL_SUBMIT_RESULT.RETRYABLE,
  });

  const restore = env.edits.at(-1);
  assert.equal(restore.messageId, 'card-1');
  assert.deepEqual(restore.components.map((row) => row.components.length), [2]);
  // The same press can be retried and is submitted this time.
  let submitted = 0;
  await card.handlePress({ data, senderId: 'actor-a', providerMessageId: 'card-1', replyTarget: { channelId: '1' } }, {
    bot,
    answer: () => {},
    submit: async () => { submitted += 1; return APPROVAL_SUBMIT_RESULT.SUBMITTED; },
  });
  assert.equal(submitted, 1);
});

test('a resolved card refuses a late press and retires its buttons', async () => {
  const { bot, env } = botFixture();
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  const context = card.createContext({
    key: 'group:1', actor: 'actor-a', target: { channelId: '1' }, bot,
    send: (text) => bot.sendText(null, text),
  });
  await context.render(pendingFixture());
  const data = deliveredButton(env, 0);
  await context.onResolved('已批准，仅对本次操作有效。', 'allowed-once');
  let submitted = 0;
  await card.handlePress({ data, senderId: 'actor-a', providerMessageId: 'card-1', replyTarget: { channelId: '1' } }, {
    bot,
    answer: (text) => bot.answerInteractionCallback('interaction-1', text),
    submit: async () => { submitted += 1; return APPROVAL_SUBMIT_RESULT.SUBMITTED; },
  });
  assert.equal(submitted, 0);
  assert.match(env.notices[0].text, /该审批已处理/u);
  assert.deepEqual(env.edits.at(-1).components, []);
});

test('the card context stays empty when the bot cannot carry components', () => {
  const card = new DiscordApprovalCard({ logger: { warn() {} } });
  assert.deepEqual(card.createContext({ key: 'group:1', actor: 'a', target: { channelId: '1' }, bot: {} }), {});
});

function approvalBridgeFixture() {
  const sessions = new Map();
  const seen = new Set();
  const controller = new AbortController();
  const env = { cards: [], edits: [], sent: [], notices: [], submissions: [] };
  const bot = {
    async sendText(_target, text) { env.sent.push(text); },
    async sendInteractionCard(_target, card) {
      env.cards.push(card);
      return { providerMessageIds: [`card-${env.cards.length}`] };
    },
    async editInteractionCard(_target, messageId, edit) {
      env.edits.push({ messageId, ...edit });
      return { id: messageId };
    },
    async updateInteractionCard(_target, messageId, edit) {
      env.edits.push({ messageId, ...edit });
      return { id: messageId };
    },
    async answerInteractionCallback(_queryId, text) { env.notices.push(text); },
  };
  let settleDecision;
  const decision = new Promise((resolve) => { settleDecision = resolve; });
  const harness = {
    sessionExists: async () => false,
    createSession: async () => 'session-one',
    ask: async (sessionId, _text, options) => {
      await options.onInteraction({
        kind: 'approval',
        interactionId: 'approval-one',
        rpcId: 'rpc-approval-one',
        sessionId,
        payload: { ...APPROVAL_PAYLOAD, sessionId },
        toolCall: { callId: 'call-one', name: 'bash', arguments: ARGUMENTS },
        respond: async (result) => {
          env.submissions.push(result);
          settleDecision();
          return { accepted: true };
        },
      });
      await Promise.race([
        decision,
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        }),
      ]);
      return '审批完成';
    },
  };
  const bridge = new DiscordHarnessBridge({
    state: {
      sessionFor: (key) => sessions.get(key) ?? null,
      async setSession(key, value) { sessions.set(key, value); return true; },
      async clearSession(key) { sessions.delete(key); },
      hasSeen: (id) => seen.has(id),
      async markSeen(id) { seen.add(id); },
      async unmarkSeen(id) { seen.delete(id); },
    },
    signal: controller.signal,
    bot,
    harness,
    logger: { warn() {}, error() {} },
  });
  return { bridge, controller, env };
}

function directMessage() {
  return {
    messageId: '111111111111111111',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: '222222222222222222',
    content: '启动审批',
    addressed: true,
    replyTarget: { channelId: '222222222222222222' },
  };
}

function pressOf(env, index, overrides = {}) {
  return {
    data: env.cards.at(-1).components[0].components[index].custom_id,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: '222222222222222222',
    messageId: '111111111111111111',
    providerMessageId: 'card-1',
    callbackQueryId: 'interaction-1|token-1',
    replyTarget: { channelId: '222222222222222222' },
    ...overrides,
  };
}

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

test('the bridge delivers an approval card and a press approves it', async () => {
  const { bridge, controller, env } = approvalBridgeFixture();
  const processing = bridge.accept(directMessage());
  await eventually(() => env.cards.length === 1);
  assert.equal(env.cards[0].components[0].components.length, 2);

  await bridge.acceptCallback(pressOf(env, 0));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'allowed-once');
  assert.equal(env.submissions[0].value.approvalId, 'approval-one');
  await processing;
  await eventually(() => env.edits.some((edit) => edit.components?.length === 0));
  const terminal = env.edits.find((edit) => edit.components?.length === 0);
  assert.match(terminal.text, /✅ 已批准（仅本次）/u);
  controller.abort(new DOMException('test finished', 'AbortError'));
});

test('a stranger press is refused and the owner can still decide', async () => {
  const { bridge, controller, env } = approvalBridgeFixture();
  const processing = bridge.accept(directMessage());
  await eventually(() => env.cards.length === 1);

  await bridge.acceptCallback(pressOf(env, 1, { senderId: 'stranger' }));
  assert.equal(env.submissions.length, 0);
  assert.match(env.notices[0], /只有发起/u);

  await bridge.acceptCallback(pressOf(env, 1));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'rejected');
  await processing;
  controller.abort(new DOMException('test finished', 'AbortError'));
});
