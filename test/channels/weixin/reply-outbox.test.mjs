import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReplyOutbox,
  createSendBudget,
  isContinueReply,
  planReply,
  splitText,
} from '../../../src/channels/weixin/reply-outbox.mjs';

function media(name = 'image') {
  return { kind: 'image', name };
}

function fixture({ quota = 10, maxTextChars = 1_800 } = {}) {
  const log = [];
  const budget = createSendBudget({ quota });
  const outbox = createReplyOutbox({
    quota,
    maxTextChars,
    budget,
    formatNotice: (count) => `还有 ${count} 条没发出，回复「继续」接着发。`,
  });
  const api = {
    async sendText(text) {
      log.push({ type: 'text', text, token: outbox.contextToken('user') });
    },
    async sendFile(file) {
      log.push({ type: 'file', file, token: outbox.contextToken('user') });
    },
  };
  return { api, budget, log, outbox };
}

test('planReply puts every image and file before the text', () => {
  const plan = planReply('result', [media('a'), { kind: 'file', name: 'b' }]);
  assert.deepEqual(plan.map((segment) => segment.kind), ['media', 'media', 'text']);
  assert.equal(plan[2].text, 'result');
  assert.equal(plan[2].chunkIndex, 0);
  assert.equal(plan[2].chunkCount, 1);
  assert.equal(plan[2].sourceText, 'result');
});

test('planReply returns only media for a file-only answer', () => {
  const plan = planReply('   ', [media('a')]);
  assert.deepEqual(plan, [{ kind: 'media', file: media('a') }]);
});

test('nine media plus one text use the whole budget without a notice', async () => {
  const { api, log, outbox } = fixture();
  await outbox.send('user', 'result', Array.from({ length: 9 }, (_, i) => media(`m${i}`)), api);
  assert.equal(log.length, 10);
  assert.equal(log.filter((entry) => entry.type === 'text').length, 1);
  assert.equal(log.at(-1).text, 'result');
});

test('ten media plus text reserves the last slot for a deferred notice', async () => {
  const { api, log, outbox } = fixture();
  await outbox.send('user', 'result', Array.from({ length: 10 }, (_, i) => media(`m${i}`)), api);
  assert.equal(log.length, 10);
  assert.equal(log.filter((entry) => entry.type === 'file').length, 9);
  assert.equal(log.at(-1).type, 'text');
  assert.match(log.at(-1).text, /还有 2 条/);
});

test('resume starts a new budget and flushes pending media before the new reply', async () => {
  const { api, log, outbox } = fixture();
  const files = Array.from({ length: 10 }, (_, i) => media(`m${i}`));
  await outbox.send('user', 'old result', files, api);

  const resumed = outbox.resume('user', 'new-token');
  assert.equal(resumed?.asked, true);
  await resumed.sending;

  assert.equal(log.length, 12);
  assert.equal(log.at(-1).text, 'old result');
  assert.equal(log.at(-1).token, 'new-token');
  assert.equal(log.at(-2).token, 'new-token');
});

test('resume does not report asked when the previous reply was not deferred', async () => {
  const { api, log, outbox } = fixture();
  await outbox.send('user', 'short', [], api);
  assert.equal(outbox.resume('user', 'next'), undefined);
  assert.equal(log.length, 1);
});

test('a long media list drains in successive budgets', async () => {
  const { api, log, outbox } = fixture();
  const files = Array.from({ length: 25 }, (_, i) => media(`m${i}`));
  await outbox.send('user', 'caption', files, api);
  assert.equal(log.length, 10);

  let resumed = outbox.resume('user', 't1');
  await resumed.sending;
  assert.equal(log.length, 20);

  resumed = outbox.resume('user', 't2');
  await resumed.sending;
  assert.equal(log.length, 28);
  assert.equal(log.at(-1).type, 'text');
  assert.equal(log.at(-1).text, 'caption');
});

test('resume during a deferred notice keeps draining with the new budget', async () => {
  const log = [];
  const budget = createSendBudget({ quota: 10 });
  const outbox = createReplyOutbox({
    quota: 10,
    budget,
    formatNotice: (count) => `notice ${count}`,
  });
  let releaseNotice;
  let noticeStarted;
  const noticeStartedPromise = new Promise((resolve) => {
    noticeStarted = resolve;
  });
  const api = {
    async sendText(text) {
      log.push({ type: 'text', text, token: outbox.contextToken('user') });
      if (text.startsWith('notice')) {
        noticeStarted();
        await new Promise((resolve) => {
          releaseNotice = resolve;
        });
      }
    },
    async sendFile(file) {
      log.push({ type: 'file', file, token: outbox.contextToken('user') });
    },
  };
  const files = Array.from({ length: 10 }, (_, i) => media(`m${i}`));
  const first = outbox.send('user', 'result', files, api);
  await noticeStartedPromise;

  const resumed = outbox.resume('user', 'new-token');
  assert.equal(resumed.asked, true);
  releaseNotice();
  await Promise.all([first, resumed.sending]);

  assert.equal(log.length, 12);
  assert.equal(log[9].type, 'text');
  assert.match(log[9].text, /^notice/);
  assert.equal(log[10].file.name, 'm9');
  assert.equal(log[11].text, 'result');
  assert.equal(log[10].token, 'new-token');
  assert.equal(log[11].token, 'new-token');
});

test('a one-message budget is rejected because it cannot send both a notice and a body', () => {
  assert.throws(
    () => createReplyOutbox({ quota: 1, formatNotice: () => 'notice' }),
    /at least 2/,
  );
  assert.throws(
    () => createReplyOutbox({ budget: createSendBudget({ quota: 1 }), formatNotice: () => 'notice' }),
    /at least 2/,
  );
});

test('a send failure clears pending and is rethrown', async () => {
  const { api, log, outbox } = fixture();
  const failing = {
    async sendText() {
      throw new Error('send failed');
    },
    async sendFile(file) {
      log.push(file);
    },
  };
  await assert.rejects(outbox.send('user', 'result', [], failing), /send failed/);
  assert.equal(outbox.resume('user', 'next'), undefined);
  assert.equal(log.length, 0);
});

test('send defers when outside sends have already consumed the budget', async () => {
  const { api, budget, log, outbox } = fixture();
  for (let i = 0; i < 10; i += 1) assert.equal(budget.consume('user'), true);
  await outbox.send('user', 'result', [], api);
  assert.equal(log.length, 0);

  const resumed = outbox.resume('user', 'next');
  await resumed.sending;
  assert.equal(log.length, 1);
});

test('splitText keeps every chunk within the configured limit', () => {
  const text = `${'a'.repeat(1_200)}\n${'b'.repeat(1_200)}`;
  const chunks = splitText(text, 1_800);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_800));
});

test('isContinueReply accepts short flush replies only', () => {
  for (const value of ['继续', '好的', 'OK', '👌']) {
    assert.equal(isContinueReply(value), true, value);
  }
  for (const value of ['继续做这个任务', '/status', '']) {
    assert.equal(isContinueReply(value), false, value);
  }
});
