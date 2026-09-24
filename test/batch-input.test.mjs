import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_INPUT_LIMIT,
  BatchInputManager,
  batchInputBusyMessage,
  batchInputGroupUnsupportedMessage,
  isBatchInputCommand,
} from '../src/channels/shared/batch-input.mjs';

test('batch commands are reserved case-insensitively, including malformed argument forms', () => {
  for (const text of [
    '/batch', ' /BATCH ', '/batch now', '/send', '/SEND later', '/cancel', '/cancel all',
  ]) {
    assert.equal(isBatchInputCommand(text), true, text);
  }
  for (const text of [null, '', 'batch', '/batching', '/sender', '/cancellation', 'hello /batch']) {
    assert.equal(isBatchInputCommand(text), false, String(text));
  }
});

test('shared boundary messages cover unsupported groups and busy conversations', () => {
  assert.match(batchInputGroupUnsupportedMessage(), /仅支持私聊/);
  assert.match(batchInputBusyMessage(), /\/stop.*\/batch/s);
});

test('idle conversations pass through ordinary messages and handle the three commands', () => {
  const batches = new BatchInputManager();

  assert.deepEqual(batches.handle('direct:one', 'normal message'), { handled: false });
  assert.equal(batches.status('direct:one').phase, 'idle');

  const missingSend = batches.handle('direct:one', '/send');
  assert.equal(missingSend.handled, true);
  assert.equal(missingSend.kind, 'no-batch');
  assert.match(missingSend.message, /没有待提交/);

  const missingCancel = batches.handle('direct:one', '/cancel');
  assert.equal(missingCancel.kind, 'no-batch');
  assert.match(missingCancel.message, /没有正在进行/);

  const started = batches.handle('direct:one', ' /BATCH ');
  assert.equal(started.kind, 'started');
  assert.equal(started.count, 0);
  assert.equal(started.limit, BATCH_INPUT_LIMIT);
  assert.match(started.message, /最多可发送 10 条文字/);
  assert.deepEqual(batches.status('direct:one'), {
    phase: 'collecting', count: 0, limit: 10, full: false,
  });
});

test('malformed batch commands are handled without changing state', () => {
  const batches = new BatchInputManager();

  for (const command of ['/batch now', '/send now', '/cancel now']) {
    const response = batches.handle('direct:one', command);
    assert.equal(response.kind, 'invalid-command');
    assert.match(response.message, /不带参数/);
    assert.equal(batches.status('direct:one').phase, 'idle');
  }

  batches.handle('direct:one', '/batch');
  batches.handle('direct:one', 'first');
  const invalid = batches.handle('direct:one', '/send now');
  assert.equal(invalid.kind, 'invalid-command');
  assert.equal(batches.status('direct:one').count, 1);
});

test('collecting is isolated by conversation and repeated /batch only reports progress', () => {
  const batches = new BatchInputManager();
  batches.handle('direct:one', '/batch');

  assert.deepEqual(batches.handle('direct:two', 'ordinary elsewhere'), { handled: false });
  assert.equal(batches.handle('direct:one', 'first').kind, 'collected');
  assert.equal(batches.handle('direct:one', 'second').kind, 'collected');

  const progress = batches.handle('direct:one', '/batch');
  assert.equal(progress.kind, 'status');
  assert.equal(progress.count, 2);
  assert.match(progress.message, /已收集 2\/10 条/);
  assert.equal(batches.status('direct:two').phase, 'idle');
});

test('collecting rejects non-text content without counting it', () => {
  const batches = new BatchInputManager();
  batches.handle('direct:one', '/batch');

  const media = batches.handle('direct:one', 'photo caption', { plainText: false });
  assert.equal(media.kind, 'unsupported-content');
  assert.match(media.message, /未收录/);
  assert.match(media.message, /图片、文件或引用消息/);
  assert.equal(batches.status('direct:one').count, 0);

  const command = batches.handle('direct:one', '/stop');
  assert.equal(command.kind, 'blocked-command');
  assert.match(command.message, /\/send.*\/cancel/);
  assert.equal(batches.status('direct:one').count, 0);
});

test('quoted batch commands stay commands while collecting', () => {
  const batches = new BatchInputManager();
  batches.handle('direct:one', '/batch');
  batches.handle('direct:one', 'first');

  // A quoted /batch still reports progress instead of being refused as content.
  const progress = batches.handle('direct:one', '/batch', { plainText: false });
  assert.equal(progress.kind, 'status');
  assert.equal(progress.count, 1);
  assert.equal(batches.status('direct:one').phase, 'collecting');

  const submission = batches.handle('direct:one', '/send', { plainText: false });
  assert.equal(submission.kind, 'submit');
  assert.deepEqual(submission.messages, ['first']);
  assert.equal(batches.status('direct:one').phase, 'submitting');

  const other = new BatchInputManager();
  other.handle('direct:two', '/batch');
  other.handle('direct:two', 'first');
  const cancelled = other.handle('direct:two', '/cancel', { plainText: false });
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(cancelled.count, 1);
  assert.equal(other.status('direct:two').phase, 'idle');
});

test('idle batch commands without content answer their own state instead of the text rule', () => {
  const batches = new BatchInputManager();

  const send = batches.handle('direct:one', '/send', { plainText: false });
  assert.equal(send.kind, 'no-batch');
  assert.match(send.message, /没有待提交/);

  const cancel = batches.handle('direct:one', '/cancel', { plainText: false });
  assert.equal(cancel.kind, 'no-batch');
  assert.match(cancel.message, /没有正在进行/);

  const start = batches.handle('direct:one', '/batch', { plainText: false });
  assert.equal(start.kind, 'unsupported-content');
  assert.match(start.message, /仅支持纯文字/);
  assert.equal(batches.status('direct:one').phase, 'idle');
});

test('the tenth message is accepted and later messages are rejected without auto-submit', () => {
  const batches = new BatchInputManager();
  batches.handle('direct:one', '/batch');

  for (let index = 1; index < BATCH_INPUT_LIMIT; index += 1) {
    const response = batches.handle('direct:one', `message ${index}`);
    assert.equal(response.kind, 'collected');
    assert.equal(response.count, index);
    assert.equal(response.message, undefined);
  }

  const tenth = batches.handle('direct:one', 'message 10');
  assert.equal(tenth.kind, 'collected');
  assert.equal(tenth.count, 10);
  assert.match(tenth.message, /10\/10.*已满/);
  assert.deepEqual(batches.status('direct:one'), {
    phase: 'collecting', count: 10, limit: 10, full: true,
  });

  const eleventh = batches.handle('direct:one', 'message 11');
  assert.equal(eleventh.kind, 'full');
  assert.equal(eleventh.count, 10);
  assert.match(eleventh.message, /这条消息未收录/);
  assert.equal(batches.status('direct:one').phase, 'collecting');
  assert.equal(batches.status('direct:one').count, 10);
});

test('/send keeps an empty batch collecting and creates one immutable submission snapshot', () => {
  const batches = new BatchInputManager();
  batches.handle('direct:one', '/batch');

  const empty = batches.handle('direct:one', '/send');
  assert.equal(empty.kind, 'empty');
  assert.equal(batches.status('direct:one').phase, 'collecting');

  batches.handle('direct:one', 'first line\ncontinued');
  batches.handle('direct:one', 'second');
  const submission = batches.handle('direct:one', '/send');
  assert.equal(submission.kind, 'submit');
  assert.equal(submission.count, 2);
  assert.deepEqual(submission.messages, ['first line\ncontinued', 'second']);
  assert.equal(Object.isFrozen(submission.messages), true);
  assert.throws(() => submission.messages.push('third'), TypeError);
  assert.equal(submission.prompt, [
    '以下是用户通过批量输入模式发送的多条内容，请按顺序作为同一次输入统一处理。',
    '[消息 1]\nfirst line\ncontinued',
    '[消息 2]\nsecond',
  ].join('\n\n'));
  // The composed prompt is dsh-im's own framing; only the collected text may
  // name the conversation.
  assert.equal(submission.title, 'first line\ncontinued');
  assert.equal(batches.status('direct:one').phase, 'submitting');

  const duplicate = batches.handle('direct:one', '/send');
  assert.equal(duplicate.kind, 'submitting');
  assert.equal(duplicate.token, undefined);
  assert.equal(duplicate.messages, undefined);
  assert.equal(batches.handle('direct:one', '/batch').kind, 'submitting');
  assert.match(batches.handle('direct:one', '/cancel').message, /无法取消/);
  assert.deepEqual(batches.handle('direct:one', 'next normal message'), { handled: false });
});

test('submission failure retains messages for retry while stale tokens cannot change state', () => {
  const batches = new BatchInputManager();
  batches.handle('direct:one', '/batch');
  batches.handle('direct:one', 'first');
  const first = batches.handle('direct:one', '/send');

  assert.deepEqual(batches.fail('direct:one', Object.freeze({})), { retained: false });
  assert.equal(batches.status('direct:one').phase, 'submitting');

  const failed = batches.fail('direct:one', first.token);
  assert.equal(failed.retained, true);
  assert.equal(failed.count, 1);
  assert.match(failed.message, /已保留 1 条消息/);
  assert.equal(batches.status('direct:one').phase, 'collecting');

  batches.handle('direct:one', 'second');
  const retry = batches.handle('direct:one', '/send');
  assert.notEqual(retry.token, first.token);
  assert.deepEqual(retry.messages, ['first', 'second']);
  assert.deepEqual(batches.complete('direct:one', first.token), { completed: false });
  assert.equal(batches.status('direct:one').phase, 'submitting');

  assert.deepEqual(batches.complete('direct:one', retry.token), { completed: true, count: 2 });
  assert.equal(batches.status('direct:one').phase, 'idle');
  assert.deepEqual(batches.fail('direct:one', retry.token), { retained: false });
});

test('/cancel discards collecting batches, including an empty batch', () => {
  const batches = new BatchInputManager();

  batches.handle('direct:one', '/batch');
  const empty = batches.handle('direct:one', '/cancel');
  assert.equal(empty.kind, 'cancelled');
  assert.equal(empty.count, 0);
  assert.match(empty.message, /已取消批量输入/);
  assert.equal(batches.status('direct:one').phase, 'idle');

  batches.handle('direct:one', '/batch');
  batches.handle('direct:one', 'one');
  batches.handle('direct:one', 'two');
  const populated = batches.handle('direct:one', '/cancel');
  assert.equal(populated.kind, 'cancelled');
  assert.equal(populated.count, 2);
  assert.match(populated.message, /丢弃 2 条消息/);
  assert.equal(batches.status('direct:one').phase, 'idle');
});
