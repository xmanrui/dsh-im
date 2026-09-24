import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HarnessApprovalQueue,
  harnessApprovalDecision,
  harnessApprovalText,
  validHarnessApproval,
} from '../../../src/channels/shared/harness-approval.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function interaction({
  id,
  toolName,
  respond,
  ...rest
} = {}) {
  const callId = `call-${id}`;
  return {
    kind: 'approval',
    interactionId: id,
    rpcId: `rpc-${id}`,
    sessionId: 'session-one',
    payload: {
      type: 'approval/requested',
      sessionId: 'session-one',
      approvalId: id,
      toolName,
      callId,
    },
    toolCall: {
      callId,
      name: toolName,
      arguments: JSON.stringify({ command: `${toolName} --run` }),
    },
    respond,
    ...rest,
  };
}

const approval = {
  type: 'approval/requested',
  sessionId: 'session-one',
  approvalId: 'approval-secret-id',
  toolName: 'bash',
  callId: 'call-secret-id',
  reason: '测试 IM 审批链路',
};

const toolCall = {
  callId: 'call-secret-id',
  name: 'bash',
  arguments: JSON.stringify({ command: "printf 'approval-test\\n'" }),
};

test('maps only precise whole-message approval replies', () => {
  const allowed = ['批准', '同意', 'yes', 'YES', '  YeS\n'];
  const rejected = ['拒绝', '不同意', 'no', 'NO', '\tNo  '];
  const unmatched = [
    '',
    '1',
    '2',
    '好的',
    '可以',
    '行',
    '没问题',
    '批准吧',
    '请批准',
    'yes please',
    'nope',
    '同 意',
  ];

  for (const text of allowed) {
    assert.equal(harnessApprovalDecision(text), 'allowed-once', text);
  }
  for (const text of rejected) {
    assert.equal(harnessApprovalDecision(text), 'rejected', text);
  }
  for (const text of unmatched) {
    assert.equal(harnessApprovalDecision(text), null, text);
  }
  assert.equal(harnessApprovalDecision(undefined), null);
  assert.equal(harnessApprovalDecision(1), null);
});

test('validates the Harness approval/requested payload without inventing options', () => {
  assert.equal(validHarnessApproval(approval), true);
  assert.equal(validHarnessApproval({ ...approval, callId: undefined, reason: undefined }), true);

  for (const key of ['sessionId', 'approvalId', 'toolName']) {
    const invalid = { ...approval, [key]: '' };
    assert.equal(validHarnessApproval(invalid), false, key);
  }
  assert.equal(validHarnessApproval({ ...approval, type: 'question/requested' }), false);
  assert.equal(validHarnessApproval({ ...approval, callId: 42 }), false);
  assert.equal(validHarnessApproval({ ...approval, reason: 42 }), false);
  assert.equal(validHarnessApproval(null), false);
});

test('formats a simple approval prompt without exposing an id or requiring a code', () => {
  assert.equal(harnessApprovalText(approval), null);
  const text = harnessApprovalText(approval, { toolCall });

  assert.match(text, /bash/);
  assert.match(text, /测试 IM 审批链路/);
  assert.match(text, /批准/);
  assert.match(text, /拒绝/);
  assert.match(text, /同意/);
  assert.match(text, /不同意/);
  assert.match(text, /yes/i);
  assert.match(text, /no/i);
  assert.match(text, /printf 'approval-test/);
  assert.doesNotMatch(text, /approval-secret-id|call-secret-id/);
  assert.doesNotMatch(text, /\/approve|\/reject|审批码/);
  assert.doesNotMatch(text, /1\s*[.\u3001]仅本次|2\s*[.\u3001]拒绝/);
  assert.equal(harnessApprovalText(approval, {
    toolCall: { ...toolCall, callId: 'another-call' },
  }), null);
  assert.equal(harnessApprovalText(approval, {
    toolCall: { ...toolCall, name: 'another-tool' },
  }), null);
  assert.equal(harnessApprovalText(approval, {
    toolCall: { ...toolCall, arguments: 'x'.repeat(6_001) },
  }), null);
  assert.match(harnessApprovalText(approval, {
    toolCall: { ...toolCall, arguments: '' },
  }), /\{\}/);
  assert.equal(harnessApprovalText(approval, {
    toolCall: { ...toolCall, arguments: '   ' },
  }), null);
});

test('tells a group user to address the bot when replying to an approval', () => {
  const text = harnessApprovalText(approval, { toolCall, requiresMention: true });
  assert.match(text, /@.*机器人/);
  assert.match(text, /批准/);
  assert.match(text, /拒绝/);
});

test('never submits the next FIFO approval before its operation is presented', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  const firstConfirmation = deferred();
  const confirmationStarted = deferred();
  const responses = [];
  const context = (toolName) => ({
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push({ toolName, text }),
  });
  await queue.handleRequested(interaction({
    id: 'first',
    toolName: 'first-tool',
    respond: async (result) => responses.push(result),
  }), context('first-tool'));
  await queue.handleRequested(interaction({
    id: 'second',
    toolName: 'second-tool',
    respond: async (result) => responses.push(result),
  }), context('second-tool'));

  const first = queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => {
      sent.push({ toolName: 'reply-one', text });
      if (text.startsWith('已批准')) {
        confirmationStarted.resolve();
        await firstConfirmation.promise;
      }
    },
  }).process();
  await confirmationStarted.promise;

  let earlySecondSettled = false;
  const earlySecond = queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push({ toolName: 'early-reply-two', text }),
  }).process().finally(() => { earlySecondSettled = true; });
  await Promise.resolve();
  assert.equal(responses.length, 1);
  assert.equal(earlySecondSettled, false);

  firstConfirmation.resolve();
  await Promise.all([first, earlySecond]);
  const earlyTexts = sent
    .filter(({ toolName }) => toolName === 'early-reply-two')
    .map(({ text }) => text);
  assert.equal(sent.some(({ toolName, text }) => (
    toolName === 'second-tool' && text.includes('second-tool --run')
  )), true);
  assert.equal(earlyTexts[0].includes('请精准回复'), true);

  await queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push({ toolName: 'reply-two', text }),
  }).process();
  assert.deepEqual(responses.map(({ value }) => value.approvalId), ['first', 'second']);
});

test('a failed presentation cannot be followed by a blind approval', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  let presentationAttempts = 0;
  const responses = [];
  const sent = [];
  const requested = interaction({
    id: 'presentation-retry',
    toolName: 'bash',
    respond: async (result) => responses.push(result),
  });
  await assert.rejects(queue.handleRequested(requested, {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => {
      presentationAttempts += 1;
      if (presentationAttempts === 1) throw new Error('temporary send failure');
      sent.push(text);
    },
  }), /temporary send failure/);

  await queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push(text),
  }).process();
  assert.equal(responses.length, 0);
  assert.equal(sent.some((text) => text.includes('bash --run')), true);
  assert.equal(sent.some((text) => text.includes('请精准回复')), true);

  await queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push(text),
  }).process();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].value.outcome, 'allowed-once');
});

test('an unrenderable approval never claims it was rejected after not-pending', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  await queue.handleRequested(interaction({
    id: 'unrenderable-resolved',
    toolName: 'bash',
    toolCall: undefined,
    respond: async () => {
      const error = new Error('already handled elsewhere');
      error.code = 'interaction-not-pending';
      throw error;
    },
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  });

  assert.deepEqual(sent, ['该审批已处理，无需再次回复。']);
  assert.equal(sent.some((text) => text.includes('已安全拒绝')), false);
});

test('resolved waits for an in-flight presentation before showing the next approval', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const firstSendStarted = deferred();
  const releaseFirstSend = deferred();
  const sent = [];
  const secondResponses = [];
  const firstRequest = queue.handleRequested(interaction({
    id: 'first-resolved',
    toolName: 'first-tool',
    respond: async () => ({ accepted: true }),
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => {
      firstSendStarted.resolve();
      await releaseFirstSend.promise;
      sent.push(text);
    },
  });
  await firstSendStarted.promise;
  await queue.handleRequested(interaction({
    id: 'second-after-resolved',
    toolName: 'second-tool',
    respond: async (result) => secondResponses.push(result),
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  });

  const resolved = queue.handleResolved({
    kind: 'approval',
    interactionId: 'first-resolved',
    outcome: 'rejected',
  });
  const earlyNextDecision = queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push(text),
  }).process();
  await Promise.resolve();
  assert.deepEqual(sent, []);
  assert.equal(secondResponses.length, 0);
  releaseFirstSend.resolve();
  await Promise.all([firstRequest, resolved, earlyNextDecision]);

  assert.match(sent[0], /first-tool --run/);
  assert.equal(sent[1], '已拒绝此次操作。');
  assert.match(sent[2], /second-tool --run/);
  assert.match(sent[3], /请精准回复/);
  assert.equal(secondResponses.length, 0);

  await queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push(text),
  }).process();
  assert.equal(secondResponses.length, 1);
});

test('a next-presentation failure never rewrites an accepted decision as submit failure', async () => {
  const errors = [];
  const queue = new HarnessApprovalQueue({
    logger: { warn() {}, error(...args) { errors.push(args); } },
  });
  const responses = [];
  let reconnects = 0;
  const sent = [];
  await queue.handleRequested(interaction({
    id: 'accepted-first',
    toolName: 'first-tool',
    respond: async (result) => responses.push(result),
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  });
  await queue.handleRequested(interaction({
    id: 'failed-second-presentation',
    toolName: 'second-tool',
    reconnect: () => { reconnects += 1; },
    respond: async (result) => responses.push(result),
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async () => { throw new Error('second presentation unavailable'); },
  });

  await queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push(text),
  }).process();

  assert.equal(responses.length, 1);
  assert.equal(responses[0].value.approvalId, 'accepted-first');
  assert.equal(sent.includes('已批准，仅对本次操作有效。'), true);
  assert.equal(sent.some((text) => text.includes('审批提交失败')), false);
  assert.equal(reconnects, 1);
  assert.equal(errors.length, 1);
});

test('resolved during submit gives one final outcome even when the HTTP response fails', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const responseStarted = deferred();
  const releaseResponse = deferred();
  const sent = [];
  await queue.handleRequested(interaction({
    id: 'resolved-submit',
    toolName: 'bash',
    respond: async () => {
      responseStarted.resolve();
      await releaseResponse.promise;
      throw new Error('response receipt lost');
    },
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  });

  const deciding = queue.claimReply({
    key: 'direct:actor-a',
    actor: 'actor-a',
    text: '批准',
    send: async (text) => sent.push(text),
  }).process();
  await responseStarted.promise;
  await queue.handleResolved({
    kind: 'approval',
    interactionId: 'resolved-submit',
    outcome: 'allowed-once',
  });
  releaseResponse.resolve();
  await deciding;

  assert.equal(sent.filter((text) => text === '已批准，仅对本次操作有效。').length, 1);
  assert.equal(sent.some((text) => text.includes('审批提交失败')), false);
});

test('resolving a blocked next approval preserves the route barrier for later items', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const confirmationStarted = deferred();
  const releaseConfirmation = deferred();
  const sent = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
  };
  await queue.handleRequested(interaction({
    id: 'barrier-a',
    toolName: 'tool-a',
    respond: async () => ({ accepted: true }),
  }), { ...context, send: async (text) => sent.push(text) });
  await queue.handleRequested(interaction({
    id: 'barrier-b',
    toolName: 'tool-b',
    respond: async () => ({ accepted: true }),
  }), { ...context, send: async (text) => sent.push(text) });
  await queue.handleRequested(interaction({
    id: 'barrier-c',
    toolName: 'tool-c',
    respond: async () => ({ accepted: true }),
  }), { ...context, send: async (text) => sent.push(text) });

  const decidingA = queue.claimReply({
    ...context,
    text: '批准',
    send: async (text) => {
      sent.push(text);
      if (text.startsWith('已批准')) {
        confirmationStarted.resolve();
        await releaseConfirmation.promise;
      }
    },
  }).process();
  await confirmationStarted.promise;
  const resolvingB = queue.handleResolved({
    kind: 'approval',
    interactionId: 'barrier-b',
    outcome: 'cancelled',
  });
  await Promise.resolve();
  assert.equal(sent.some((text) => text.includes('tool-b --run')), false);
  assert.equal(sent.some((text) => text.includes('tool-c --run')), false);

  releaseConfirmation.resolve();
  await Promise.all([decidingA, resolvingB]);
  assert.equal(sent.some((text) => text.includes('tool-b --run')), false);
  assert.equal(sent.some((text) => text.includes('tool-c --run')), true);
});

test('approval decisions stay bound to the initiating actor, route, and group mention', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  const responses = [];
  await queue.handleRequested(interaction({
    id: 'guarded',
    toolName: 'bash',
    respond: async (result) => responses.push(result),
  }), {
    key: 'group:room-a',
    actor: 'actor-a',
    requiresMention: true,
    send: async (text) => sent.push(text),
  });

  assert.equal(queue.claimReply({
    key: 'group:room-a',
    actor: 'actor-a',
    text: 'yes',
    addressed: true,
    hasPendingQuestion: true,
    send: async (text) => sent.push(text),
  }), null);
  assert.equal(queue.claimReply({
    key: 'group:room-b',
    actor: 'actor-a',
    text: '批准',
    addressed: true,
    send: async (text) => sent.push(text),
  }), null);
  const skippedUnauthorized = queue.claimReply({
    key: 'group:room-a',
    actor: 'actor-b',
    text: '批准',
    addressed: true,
    send: async (text) => sent.push(text),
  });
  const beforeSkippedCount = sent.length;
  await skippedUnauthorized.process(async () => false);
  assert.equal(sent.length, beforeSkippedCount);
  await queue.claimReply({
    key: 'group:room-a',
    actor: 'actor-b',
    text: '批准',
    addressed: true,
    send: async (text) => sent.push(text),
  }).process();
  await queue.claimReply({
    key: 'group:room-a',
    actor: 'actor-a',
    text: '批准',
    addressed: false,
    send: async (text) => sent.push(text),
  }).process();
  await queue.claimReply({
    key: 'group:room-a',
    actor: 'actor-a',
    text: '可以',
    addressed: true,
    send: async (text) => sent.push(text),
  }).process();
  assert.equal(responses.length, 0);

  await queue.claimReply({
    key: 'group:room-a',
    actor: 'actor-a',
    text: '批准',
    addressed: true,
    send: async (text) => sent.push(text),
  }).process();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].value.outcome, 'allowed-once');
  assert.equal(sent.filter((text) => text.includes('只有发起当前任务')).length, 2);
  assert.equal(sent.some((text) => text.includes('请精准回复')), true);
});

test('a deferred approval reply stays silent when the approval resolves with its question unfinished', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const questionCompletion = deferred();
  const sent = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'resolved-during-question',
    toolName: 'bash',
    respond: async () => ({ accepted: true }),
  }), context);

  const reply = queue.claimReply({
    ...context,
    text: '批准',
    hasPendingQuestion: true,
    questionCompletion: questionCompletion.promise,
    isQuestionPending: () => true,
  }).process();
  await Promise.resolve();
  await queue.handleResolved({
    kind: 'approval',
    interactionId: 'resolved-during-question',
    outcome: 'rejected',
  });
  questionCompletion.resolve();
  await reply;

  assert.equal(sent.some((text) => text.includes('请先完成当前问题')), false);
  assert.equal(sent.at(-1), '已拒绝此次操作。');
});

test('requested replay updates the responder without duplicating the approval prompt', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  let oldResponses = 0;
  let newResponse;
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'replayed',
    toolName: 'bash',
    respond: async () => { oldResponses += 1; },
  }), context);
  await queue.handleRequested(interaction({
    id: 'replayed',
    toolName: 'bash',
    respond: async (result) => { newResponse = result; },
  }), context);
  assert.equal(sent.filter((text) => text.includes('bash --run')).length, 1);

  await queue.claimReply({
    ...context,
    text: '同意',
  }).process();
  assert.equal(oldResponses, 0);
  assert.equal(newResponse.value.approvalId, 'replayed');
  assert.equal(newResponse.value.outcome, 'allowed-once');
});

test('replaying a queued approval never presents it ahead of the current item', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'replay-current',
    toolName: 'current-tool',
    respond: async () => ({ accepted: true }),
  }), context);
  const queued = interaction({
    id: 'replay-queued',
    toolName: 'queued-tool',
    respond: async () => ({ accepted: true }),
  });
  await queue.handleRequested(queued, context);
  await queue.handleRequested({ ...queued, reconnect: () => undefined }, context);

  assert.equal(sent.filter((text) => text.includes('current-tool --run')).length, 1);
  assert.equal(sent.some((text) => text.includes('queued-tool --run')), false);
});

test('two decisions claimed for the current item cannot approve the next FIFO item', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const releaseFirstResponse = deferred();
  const firstResponseStarted = deferred();
  const responses = [];
  const sent = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'double-first',
    toolName: 'first-tool',
    respond: async (result) => {
      responses.push(result);
      firstResponseStarted.resolve();
      await releaseFirstResponse.promise;
    },
  }), context);
  await queue.handleRequested(interaction({
    id: 'double-second',
    toolName: 'second-tool',
    respond: async (result) => responses.push(result),
  }), context);

  const firstDecision = queue.claimReply({ ...context, text: '批准' }).process();
  await firstResponseStarted.promise;
  const duplicateDecision = queue.claimReply({ ...context, text: '批准' }).process();
  releaseFirstResponse.resolve();
  await Promise.all([firstDecision, duplicateDecision]);

  assert.deepEqual(responses.map(({ value }) => value.approvalId), ['double-first']);
  assert.equal(sent.some((text) => text.includes('second-tool --run')), true);
  assert.equal(sent.at(-1), '该审批已处理，无需再次回复。');
  await queue.claimReply({ ...context, text: '批准' }).process();
  assert.deepEqual(responses.map(({ value }) => value.approvalId), [
    'double-first',
    'double-second',
  ]);
});

test('a failed approval response can retry and not-pending becomes a tombstone', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  let firstAttempts = 0;
  const accepted = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'retry-response',
    toolName: 'retry-tool',
    respond: async (result) => {
      firstAttempts += 1;
      if (firstAttempts === 1) throw new Error('temporary response failure');
      accepted.push(result);
    },
  }), context);
  await queue.handleRequested(interaction({
    id: 'not-pending-response',
    toolName: 'expired-tool',
    respond: async () => {
      const error = new Error('already resolved');
      error.code = 'interaction-not-pending';
      throw error;
    },
  }), context);

  await queue.claimReply({ ...context, text: '批准' }).process();
  assert.equal(firstAttempts, 1);
  assert.equal(sent.some((text) => text.includes('审批提交失败')), true);
  await queue.claimReply({ ...context, text: '批准' }).process();
  assert.equal(firstAttempts, 2);
  assert.equal(accepted.length, 1);
  assert.equal(sent.some((text) => text.includes('expired-tool --run')), true);

  await queue.claimReply({ ...context, text: '拒绝' }).process();
  assert.equal(sent.at(-1), '该审批已处理，无需再次回复。');
  await queue.claimReply({ ...context, text: 'no' }).process();
  assert.equal(sent.at(-1), '该审批已处理，无需再次回复。');
});

test('a failed message-recording preflight cannot block later approval replies', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  const responses = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'preflight-retry',
    toolName: 'bash',
    respond: async (result) => responses.push(result),
  }), context);

  await assert.rejects(queue.claimReply({
    ...context,
    text: '批准',
  }).process(async () => {
    throw new Error('state persistence failed');
  }), /state persistence failed/);
  await queue.claimReply({ ...context, text: '拒绝' }).process(async () => true);

  assert.equal(responses.length, 1);
  assert.equal(responses[0].value.outcome, 'rejected');
});

test('closing a route rejects every queued approval without presenting hidden items', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  const responses = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'close-first',
    toolName: 'first-tool',
    respond: async (result) => responses.push(result),
  }), context);
  await queue.handleRequested(interaction({
    id: 'close-second',
    toolName: 'second-tool',
    respond: async (result) => responses.push(result),
  }), context);
  await queue.closeRoute(context.key);

  assert.deepEqual(responses.map(({ value }) => ({
    approvalId: value.approvalId,
    outcome: value.outcome,
  })), [
    { approvalId: 'close-first', outcome: 'rejected' },
    { approvalId: 'close-second', outcome: 'rejected' },
  ]);
  assert.equal(sent.some((text) => text.includes('first-tool --run')), true);
  assert.equal(sent.some((text) => text.includes('second-tool --run')), false);
  assert.equal(sent.includes('已拒绝此次操作。'), true);
});

test('closing while a decision is submitting races it with a fail-closed rejection', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const allowedStarted = deferred();
  const releaseAllowed = deferred();
  const outcomes = [];
  const sent = [];
  const context = {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  };
  await queue.handleRequested(interaction({
    id: 'closing-submit',
    toolName: 'bash',
    respond: async (result) => {
      outcomes.push(result.value.outcome);
      if (result.value.outcome === 'allowed-once') {
        allowedStarted.resolve();
        await releaseAllowed.promise;
        throw new DOMException('runtime stopped', 'AbortError');
      }
    },
  }), context);

  const deciding = queue.claimReply({ ...context, text: '批准' }).process();
  await allowedStarted.promise;
  await queue.closeRoute(context.key);
  releaseAllowed.resolve();
  await deciding;

  assert.deepEqual(outcomes, ['allowed-once', 'rejected']);
  assert.equal(sent.filter((text) => text === '已拒绝此次操作。').length, 1);
  assert.equal(sent.some((text) => text.includes('审批提交失败')), false);
});

test('closing during presentation follows a stale prompt with a rejected outcome', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const presentationStarted = deferred();
  const releasePresentation = deferred();
  const sent = [];
  const requested = queue.handleRequested(interaction({
    id: 'closing-presentation',
    toolName: 'bash',
    respond: async () => ({ accepted: true }),
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => {
      if (sent.length === 0) {
        presentationStarted.resolve();
        await releasePresentation.promise;
      }
      sent.push(text);
    },
  });
  await presentationStarted.promise;
  await queue.closeRoute('direct:actor-a');
  releasePresentation.resolve();
  await requested;

  assert.match(sent[0], /bash --run/);
  assert.equal(sent[1], '已拒绝此次操作。');
});

test('closing a displayed not-pending approval leaves a resolved notice', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const sent = [];
  await queue.handleRequested(interaction({
    id: 'closing-not-pending',
    toolName: 'bash',
    respond: async () => {
      const error = new Error('already handled');
      error.code = 'interaction-not-pending';
      throw error;
    },
  }), {
    key: 'direct:actor-a',
    actor: 'actor-a',
    send: async (text) => sent.push(text),
  });
  await queue.closeRoute('direct:actor-a');

  assert.match(sent[0], /bash --run/);
  assert.equal(sent[1], '该审批已处理，无需再次回复。');
  assert.equal(sent.some((text) => text.includes('已拒绝')), false);
});
