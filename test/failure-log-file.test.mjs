import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendFailureLog, failureLogPath } from '../src/channels/shared/failure-log-file.mjs';
import { classifyMessageFailure } from '../src/channels/shared/message-failure.mjs';

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-im-failure-log-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const streamFailure = classifyMessageFailure(
  Object.assign(new Error('Harness turn failed'), {
    code: 'harness-turn-failed',
    providerCode: 'STREAM_CLOSED',
  }),
  { referenceId: 'MF-12D8DE32' },
);

test('a failed turn is written with the reference id the user quotes back', async () => {
  await withHome(async (dshHome) => {
    assert.equal(appendFailureLog(streamFailure, {
      channel: 'feishu',
      dshHome,
      details: { providerCode: 'STREAM_CLOSED', stage: 'model.stream' },
    }), true);
    const file = failureLogPath({ dshHome });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.referenceId, 'MF-12D8DE32');
    assert.equal(record.code, 'MODEL_STREAM');
    assert.equal(record.channel, 'feishu');
    assert.equal(record.details.providerCode, 'STREAM_CLOSED');
  });
});

test('one failure per line keeps the log greppable by id', async () => {
  await withHome(async (dshHome) => {
    appendFailureLog(streamFailure, { channel: 'feishu', dshHome });
    appendFailureLog({ ...streamFailure, referenceId: 'MF-AAAAAAAA' }, { channel: 'telegram', dshHome });
    const lines = (await readFile(failureLogPath({ dshHome }), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /MF-12D8DE32/u);
    assert.match(lines[1], /MF-AAAAAAAA/u);
    assert.equal(JSON.parse(lines[1]).channel, 'telegram');
  });
});

test('a log past the cap keeps one previous generation', async () => {
  await withHome(async (dshHome) => {
    const file = failureLogPath({ dshHome });
    await mkdir(join(dshHome, '.dsh-im'), { recursive: true });
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024), { encoding: 'utf8' });
    assert.equal(appendFailureLog(streamFailure, { dshHome }), true);
    assert.equal((await stat(`${file}.1`)).size, 2 * 1024 * 1024);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MF-12D8DE32/u);
  });
});

test('bot tokens never reach the log line', async () => {
  await withHome(async (dshHome) => {
    appendFailureLog(streamFailure, {
      dshHome,
      details: { reason: 'bot123456:AAHfake-token-value-0123456789 did not answer' },
    });
    const line = await readFile(failureLogPath({ dshHome }), 'utf8');
    assert.equal(line.includes('AAHfake-token-value'), false);
    assert.match(line, /bot<redacted>/u);
  });
});

test('a failed write never throws into the caller', async () => {
  await withHome(async (dshHome) => {
    // A regular file where the directory must be makes mkdir fail.
    await writeFile(dshHome + '/.dsh-im', 'not a directory', { encoding: 'utf8' });
    assert.equal(appendFailureLog(streamFailure, { dshHome }), false);
  });
});
