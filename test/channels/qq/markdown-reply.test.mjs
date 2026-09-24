import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';

import {
  chunkMarkdownText,
  sendMarkdownReply,
} from '../../../src/channels/qq/markdown-reply.mjs';

const target = { scope: 'c2c', targetId: 'user-openid', msgId: 'msg-1' };

function apiRejection(
  message = 'markdown rejected',
  httpStatus = 400,
  bizCode = 40_034_090,
) {
  return new ApiError(message, httpStatus, '/v2/users/test/messages', bizCode, message);
}

test('chunkMarkdownText keeps short text as a single chunk', () => {
  assert.deepEqual(chunkMarkdownText('**你好**，世界'), ['**你好**，世界']);
});

test('chunkMarkdownText returns no chunks for empty text', () => {
  assert.deepEqual(chunkMarkdownText(''), []);
  assert.deepEqual(chunkMarkdownText(null), []);
});

test('chunkMarkdownText splits long text within the limit', () => {
  const text = Array.from({ length: 200 }, (_, index) => `第${index}行内容`).join('\n');
  const chunks = chunkMarkdownText(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `chunk exceeds the limit: ${chunk.length}`);
  }
  assert.equal(chunks.join('\n'), text);
});

test('chunkMarkdownText never emits an empty edge chunk at an exact limit', () => {
  const exact = 'x'.repeat(100);
  assert.deepEqual(chunkMarkdownText(`${exact}\n`, 100), [exact]);
  assert.deepEqual(chunkMarkdownText(`\n${exact}`, 100), [exact]);
});

test('chunkMarkdownText does not break inside a code block that fits the limit', () => {
  const code = '```js\nconsole.log(1);\n```';
  const text = `${'A'.repeat(80)}\n\n${code}\n\n${'B'.repeat(80)}`;
  const chunks = chunkMarkdownText(text, 100);
  const codeChunk = chunks.find((chunk) => chunk.includes('```js'));
  assert.ok(codeChunk);
  assert.ok(codeChunk.startsWith(code));
});

test('chunkMarkdownText makes every oversized code-block chunk independently renderable', () => {
  const payload = 'x'.repeat(250);
  const chunks = chunkMarkdownText(`\`\`\`js\n${payload}\n\`\`\``, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `chunk exceeds the limit: ${chunk.length}`);
    const lines = chunk.split('\n');
    const opening = /^(`{3,}|~{3,})js$/.exec(lines[0]);
    assert.ok(opening, `missing opening fence: ${lines[0]}`);
    assert.match(lines.at(-1), new RegExp(`^\\${opening[1][0]}{${opening[1].length},}$`));
  }
  assert.equal(chunks.map((chunk) => chunk.split('\n').slice(1, -1).join('\n')).join(''), payload);
});

test('chunkMarkdownText uses a safe synthetic fence around indented nested fences', () => {
  const cases = [
    { sourceFence: '````', nested: '   ```', expectedFence: '~' },
    { sourceFence: '~~~~', nested: '   ~~~', expectedFence: '`' },
  ];
  for (const { sourceFence, nested, expectedFence } of cases) {
    const source = `  ${sourceFence}js\n${nested}\n${'x'.repeat(250)}\n  ${sourceFence}`;
    const chunks = chunkMarkdownText(source, 100);
    assert.ok(chunks.length > 1);
    // A two-space opener removes up to two leading spaces from each code line.
    assert.equal(chunks.some((chunk) => chunk.includes(nested.slice(2))), true);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 100, `chunk exceeds the limit: ${chunk.length}`);
      const lines = chunk.split('\n');
      const opening = /^(`{3,}|~{3,})js$/.exec(lines[0]);
      assert.ok(opening, `missing opening fence: ${lines[0]}`);
      assert.equal(opening[1][0], expectedFence);
      assert.equal(lines.at(-1), opening[1]);
    }
  }
});

test('chunkMarkdownText preserves the CommonMark literal of oversized indented fences', async () => {
  const literal = `${'  console.log(1);\n'.repeat(400)} x`;
  const expectedLiteral = `${'console.log(1);\n'.repeat(400)}x`;
  const plain = [];
  await sendMarkdownReply({
    send: async (options) => {
      if (options.msgType === 2) throw apiRejection();
      plain.push(options.content);
      return { id: `plain-${plain.length}` };
    },
    sendText: async () => { throw new Error('explicit msg_type=0 must be used'); },
  }, target, `  \`\`\`js\n${literal}\n  \`\`\``, { logger: { warn() {} } });

  assert.equal(plain.join(''), expectedLiteral);
});

test('chunkMarkdownText applies CommonMark tab stops to oversized indented fences', async () => {
  const patterns = [
    { source: '\talpha', literal: ' alpha' },
    { source: ' \tbeta', literal: ' beta' },
    { source: '  gamma', literal: 'gamma' },
    { source: 'delta', literal: 'delta' },
  ];
  const sourceLines = Array.from({ length: 800 }, (_, index) => patterns[index % patterns.length].source);
  const literalLines = Array.from({ length: 800 }, (_, index) => patterns[index % patterns.length].literal);
  const plain = [];
  await sendMarkdownReply({
    send: async (options) => {
      if (options.msgType === 2) throw apiRejection();
      plain.push(options.content);
      return { id: `plain-${plain.length}` };
    },
    sendText: async () => { throw new Error('explicit msg_type=0 must be used'); },
  }, target, `   \`\`\`text\n${sourceLines.join('\n')}\n   \`\`\``, { logger: { warn() {} } });

  assert.equal(plain.join(''), literalLines.join('\n'));
});

test('chunkMarkdownText does not reinterpret an invalid backtick info string as fenced code', () => {
  const source = `\`\`\` a\`b\n${'not-code '.repeat(40)}\n\`\`\``;
  const chunks = chunkMarkdownText(source, 80);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.some((chunk) => /^~~~ a`b/m.test(chunk)), false);
  assert.equal(chunks.includes('``` a`b'), true);
});

test('chunkMarkdownText accepts a backtick in a tilde-fence info string', () => {
  const chunks = chunkMarkdownText(`~~~ lang\`x\n${'payload '.repeat(100)}\n~~~`, 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => /^~{3,} lang`x\n/.test(chunk)), true);
});

test('chunkMarkdownText closes every chunk of an unfinished oversized code block', () => {
  const chunks = chunkMarkdownText(`\`\`\`js\n${'x'.repeat(250)}`, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const opening = /^(`{3,}|~{3,})js$/.exec(lines[0]);
    assert.ok(opening);
    assert.equal(lines.at(-1), opening[1]);
  }
});

test('chunkMarkdownText keeps a GFM table together', () => {
  const table = [
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| a | b |',
    '| c | d |',
  ].join('\n');
  const chunks = chunkMarkdownText(table, 200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], table);
});

test('chunkMarkdownText repeats the header for every oversized GFM table chunk', () => {
  const header = '| 列一 | 列二 |';
  const separator = '| --- | --- |';
  const rows = Array.from({ length: 30 }, (_, index) => `| row-${index} | value-${index} |`);
  const chunks = chunkMarkdownText([header, separator, ...rows].join('\n'), 100);
  assert.ok(chunks.length > 1);
  const deliveredRows = [];
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `chunk exceeds the limit: ${chunk.length}`);
    const lines = chunk.split('\n');
    assert.deepEqual(lines.slice(0, 2), [header, separator]);
    assert.ok(lines.slice(2).every((line) => /^\|.+\|$/.test(line)));
    deliveredRows.push(...lines.slice(2));
  }
  assert.deepEqual(deliveredRows, rows);
});

test('chunkMarkdownText chunks GFM tables without outer pipes and ignores escaped or code-span pipes', () => {
  const header = 'name | value';
  const separator = ':--- | ---:';
  const rows = Array.from(
    { length: 30 },
    (_, index) => `row-${index} | \`a|b\` and x\\|y-${index}`,
  );
  const chunks = chunkMarkdownText([header, separator, ...rows].join('\n'), 110);
  assert.ok(chunks.length > 1);
  const deliveredRows = [];
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 110, `chunk exceeds the limit: ${chunk.length}`);
    const lines = chunk.split('\n');
    assert.deepEqual(lines.slice(0, 2), [header, separator]);
    deliveredRows.push(...lines.slice(2));
  }
  assert.deepEqual(deliveredRows, rows);
});

test('chunkMarkdownText accepts one-hyphen GFM delimiter cells', () => {
  const header = 'left | right';
  const separator = '- | :-:';
  const rows = Array.from({ length: 30 }, (_, index) => `row-${index} | value-${index}`);
  const chunks = chunkMarkdownText([header, separator, ...rows].join('\n'), 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.startsWith(`${header}\n${separator}\n`)), true);
  assert.deepEqual(chunks.flatMap((chunk) => chunk.split('\n').slice(2)), rows);
});

test('chunkMarkdownText normalizes CRLF without leaking carriage returns across table chunks', () => {
  const header = '| key | value |';
  const separator = '| --- | --- |';
  const rows = Array.from({ length: 20 }, (_, index) => `| row-${index} | value-${index} |`);
  const chunks = chunkMarkdownText([header, separator, ...rows].join('\r\n'), 100);
  assert.ok(chunks.length > 1);
  const deliveredRows = [];
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `chunk exceeds the limit: ${chunk.length}`);
    assert.equal(chunk.includes('\r'), false);
    const lines = chunk.split('\n');
    assert.deepEqual(lines.slice(0, 2), [header, separator]);
    deliveredRows.push(...lines.slice(2));
  }
  assert.deepEqual(deliveredRows, rows);
});

test('chunkMarkdownText does not promote a cell-count mismatch to a GFM table', () => {
  const header = 'a | b';
  const invalidSeparator = '--- | --- | ---';
  const rows = Array.from({ length: 20 }, (_, index) => `row-${index} | value-${index}`);
  const source = [header, invalidSeparator, ...rows].join('\n');
  const chunks = chunkMarkdownText(source, 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join('\n'), source);
  assert.equal(chunks.filter((chunk) => chunk.startsWith(`${header}\n${invalidSeparator}`)).length, 1);
});

test('chunkMarkdownText ends a GFM table before a competing block marker', () => {
  const header = 'a | b';
  const separator = '--- | ---';
  const rows = Array.from({ length: 30 }, (_, index) => `row-${index} | value-${index}`);
  const heading = '# next section | not a table row';
  const chunks = chunkMarkdownText([header, separator, ...rows, heading].join('\n'), 100);
  const tableChunks = chunks.filter((chunk) => chunk.startsWith(`${header}\n${separator}\n`));
  assert.ok(tableChunks.length > 1);
  assert.deepEqual(tableChunks.flatMap((chunk) => chunk.split('\n').slice(2)), rows);
  assert.equal(tableChunks.some((chunk) => chunk.includes(heading)), false);
  assert.equal(chunks.some((chunk) => chunk.includes(heading)), true);
});

test('chunkMarkdownText safely code-fences a table with an individually oversized row', () => {
  const table = ['| key | value |', '| --- | --- |', `| huge | ${'x'.repeat(250)} |`].join('\n');
  const chunks = chunkMarkdownText(table, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `chunk exceeds the limit: ${chunk.length}`);
    const lines = chunk.split('\n');
    assert.match(lines[0], /^(`{3,}|~{3,})text$/);
    assert.match(lines.at(-1), /^(`{3,}|~{3,})$/);
  }
});

test('chunkMarkdownText hard-splits an oversized single line', () => {
  const line = 'x'.repeat(250);
  const chunks = chunkMarkdownText(line, 100);
  assert.deepEqual(chunks, ['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
});

test('chunkMarkdownText does not split an emoji surrogate pair', () => {
  const chunks = chunkMarkdownText(`1234😀5678`, 5);
  assert.equal(chunks.join(''), '1234😀5678');
  assert.equal(chunks.some((chunk) => chunk.includes('\uFFFD')), false);
  for (const chunk of chunks) assert.ok(chunk.length <= 5);
});

test('sendMarkdownReply sends markdown with unique msg_seq per chunk', async () => {
  const calls = [];
  const results = await sendMarkdownReply({
    send: async (options) => {
      calls.push(options);
      return { id: `id-${calls.length}` };
    },
    sendText: async () => {
      throw new Error('sendText must not be called when markdown succeeds');
    },
  }, target, '# 标题\n\n**加粗**内容');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, target);
  assert.equal(calls[0].msgType, 2);
  assert.equal(calls[0].markdown.content, '# 标题\n\n**加粗**内容');
  assert.equal(Number.isInteger(calls[0].extra.msg_seq), true);
  assert.deepEqual(results, [{ id: 'id-1' }]);
});

test('sendMarkdownReply does not send an empty message after an exact-limit trailing newline', async () => {
  const calls = [];
  const exact = 'x'.repeat(4_500);
  await sendMarkdownReply({
    send: async (options) => {
      calls.push(options);
      return { id: `id-${calls.length}` };
    },
    sendText: async () => { throw new Error('unexpected plain-text send'); },
  }, target, `${exact}\n`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].markdown.content, exact);
});

test('sendMarkdownReply assigns deterministic distinct 16-bit msg_seq values across chunks', async (t) => {
  t.mock.method(Date, 'now', () => 0);
  t.mock.method(Math, 'random', () => 1 - Number.EPSILON);
  const seqs = [];
  const bot = {
    send: async ({ extra }) => {
      seqs.push(extra.msg_seq);
      return { id: 'x' };
    },
    sendText: async () => { throw new Error('unexpected'); },
  };
  const text = Array.from({ length: 1_500 }, (_, index) => `第${index}行`).join('\n');
  await sendMarkdownReply(bot, target, text);
  assert.ok(seqs.length > 1);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(seqs.slice(0, 3), [65_535, 0, 1]);
  assert.ok(seqs.every((seq) => Number.isInteger(seq) && seq >= 0 && seq <= 65_535));
});

test('sendMarkdownReply falls back to plain text per chunk on markdown rejection', async () => {
  const calls = [];
  const warnings = [];
  const results = await sendMarkdownReply({
    send: async (options) => {
      calls.push(options);
      if (options.msgType === 2) throw apiRejection('markdown rejected: no permission');
      return { id: 'text-1' };
    },
    sendText: async () => { throw new Error('fallback must explicitly use msg_type=0'); },
  }, target, '回答内容', { logger: { warn: (...args) => warnings.push(args) } });
  assert.deepEqual(calls.map(({ msgType }) => msgType), [2, 0]);
  assert.equal(calls[1].content, '回答内容');
  assert.equal(calls[1].extra.msg_seq, calls[0].extra.msg_seq);
  assert.deepEqual(results, [{ id: 'text-1' }]);
  assert.equal(warnings.length, 1);
});

test('sendMarkdownReply falls back only for the known definite Markdown rejection', async () => {
  const errors = [
    apiRejection('network outcome unknown', 0),
    apiRejection('server outcome unknown', 500),
    apiRejection('success response unreadable', 200),
    apiRejection('duplicate msg_seq', 400, 40_054_005),
    new Error('unstructured failure'),
  ];
  for (const deliveryError of errors) {
    const calls = [];
    await assert.rejects(
      sendMarkdownReply({
        send: async (options) => {
          calls.push(options);
          throw deliveryError;
        },
        sendText: async () => { throw new Error('non-Markdown errors must not be retried'); },
      }, target, 'possibly delivered', { logger: { warn() {} } }),
      (error) => error === deliveryError,
    );
    assert.deepEqual(calls.map(({ msgType }) => msgType), [2]);
  }
});

test('sendMarkdownReply removes synthetic code fences from oversized-code plain fallback', async () => {
  const payload = 'x'.repeat(9_000);
  const markdown = [];
  const plain = [];
  await sendMarkdownReply({
    send: async (options) => {
      if (options.msgType === 2) {
        markdown.push(options.markdown.content);
        throw apiRejection();
      }
      plain.push(options.content);
      return { id: `plain-${plain.length}` };
    },
    sendText: async () => { throw new Error('explicit msg_type=0 must be used'); },
  }, target, `\`\`\`js\n${payload}\n\`\`\``, { logger: { warn() {} } });

  assert.ok(markdown.length > 1);
  assert.ok(markdown.every((chunk) => /^(`{3,}|~{3,})js\n/.test(chunk)));
  assert.equal(plain.join(''), payload);
  assert.equal(plain.some((chunk) => /^(`{3,}|~{3,})/.test(chunk)), false);
});

test('sendMarkdownReply never sends an empty fallback for an empty oversized fenced body', async () => {
  const source = `\`\`\`${'a'.repeat(4_495)}\n\`\`\``;
  const calls = [];
  const results = await sendMarkdownReply({
    send: async (options) => {
      calls.push(options);
      if (options.msgType === 2) throw apiRejection();
      throw new Error('empty plain fallback must not be sent');
    },
    sendText: async () => { throw new Error('empty plain fallback must not be sent'); },
  }, target, source, { logger: { warn() {} } });

  assert.deepEqual(calls.map(({ msgType }) => msgType), [2]);
  assert.deepEqual(results, []);

  let legacyTextCalls = 0;
  const legacyResults = await sendMarkdownReply({
    sendText: async () => {
      legacyTextCalls += 1;
      throw new Error('empty legacy text must not be sent');
    },
  }, target, source);
  assert.equal(legacyTextCalls, 0);
  assert.deepEqual(legacyResults, []);
});

test('sendMarkdownReply does not repeat synthetic table headers in plain fallback', async () => {
  const header = '| key | value |';
  const separator = '| --- | --- |';
  const rows = Array.from(
    { length: 500 },
    (_, index) => `| row-${String(index).padStart(3, '0')} | ${'x'.repeat(20)} |`,
  );
  const source = [header, separator, ...rows].join('\n');
  const markdown = [];
  const plain = [];
  await sendMarkdownReply({
    send: async (options) => {
      if (options.msgType === 2) {
        markdown.push(options.markdown.content);
        throw apiRejection();
      }
      plain.push(options.content);
      return { id: `plain-${plain.length}` };
    },
    sendText: async () => { throw new Error('explicit msg_type=0 must be used'); },
  }, target, source, { logger: { warn() {} } });

  assert.ok(markdown.length > 1);
  assert.ok(markdown.every((chunk) => chunk.startsWith(`${header}\n${separator}\n`)));
  assert.equal(plain.join('\n'), source);
  assert.equal((plain.join('\n').match(/\| key \| value \|/g) ?? []).length, 1);
});

test('sendMarkdownReply uses sendText directly when the bot lacks send()', async () => {
  const sentText = [];
  const results = await sendMarkdownReply({
    sendText: async (_target, text) => {
      sentText.push(text);
      return { id: 'plain-1' };
    },
  }, target, '没有 send 方法的机器人');
  assert.deepEqual(sentText, ['没有 send 方法的机器人']);
  assert.deepEqual(results, [{ id: 'plain-1' }]);
});

test('sendMarkdownReply delivers long answers as multiple markdown chunks', async () => {
  const markdownChunks = [];
  const bot = {
    send: async ({ markdown }) => {
      markdownChunks.push(markdown.content);
      return { id: `id-${markdownChunks.length}` };
    },
    sendText: async () => { throw new Error('unexpected'); },
  };
  const text = Array.from({ length: 600 }, (_, index) => `- 列表项 ${index}`).join('\n');
  const results = await sendMarkdownReply(bot, target, text);
  assert.ok(markdownChunks.length > 1);
  for (const chunk of markdownChunks) {
    assert.ok(chunk.length <= 4_500);
  }
  assert.equal(results.length, markdownChunks.length);
  assert.equal(markdownChunks.join('\n'), text);
});

test('sendMarkdownReply moves overflow chunks off the passive group reply target', async () => {
  const targets = [];
  const groupTarget = { scope: 'group', targetId: 'group-1', msgId: 'group-msg' };
  await sendMarkdownReply({
    send: async ({ target: sentTarget }) => {
      targets.push(sentTarget);
      return { id: `id-${targets.length}` };
    },
    sendText: async () => { throw new Error('unexpected'); },
  }, groupTarget, 'x'.repeat(4_500 * 6));

  assert.equal(targets.length, 6);
  assert.equal(targets.slice(0, 4).every((sentTarget) => sentTarget.msgId === 'group-msg'), true);
  assert.deepEqual(targets.slice(4), [
    { scope: 'group', targetId: 'group-1' },
    { scope: 'group', targetId: 'group-1' },
  ]);
});

test('sendMarkdownReply reserves the fourth passive C2C reply and moves overflow proactive', async () => {
  const targets = [];
  await sendMarkdownReply({
    send: async ({ target: sentTarget }) => {
      targets.push(sentTarget);
      return { id: `id-${targets.length}` };
    },
    sendText: async () => { throw new Error('unexpected'); },
  }, target, 'x'.repeat(4_500 * 5));

  assert.equal(targets.length, 5);
  assert.deepEqual(targets.map((sentTarget) => Boolean(sentTarget.msgId)), [
    true, true, true, false, false,
  ]);
});

test('sendMarkdownReply uses the reserved passive reply for a visible partial notice', async () => {
  const groupTarget = { scope: 'group', targetId: 'group-1', msgId: 'group-msg' };
  const notices = [];
  const seqs = [];
  const results = await sendMarkdownReply({
    send: async ({ target: sentTarget, msgType, content, extra }) => {
      seqs.push(extra.msg_seq);
      if (msgType === 0) {
        notices.push(content);
        return { id: 'partial-notice' };
      }
      if (!sentTarget.msgId) throw new Error('proactive delivery outcome unknown');
      return { id: 'passive' };
    },
    sendText: async () => { throw new Error('partial notice must explicitly use msg_type=0'); },
  }, groupTarget, 'x'.repeat(4_500 * 6), { logger: { warn() {} } });

  assert.equal(results.length, 5);
  assert.deepEqual(notices, ['回答较长，后续内容未能通过 QQ 完整发送，请回复“继续”。']);
  assert.equal(new Set(seqs).size, seqs.length);
});

test('sendMarkdownReply returns no deliveries for empty text', async () => {
  const results = await sendMarkdownReply({
    send: async () => { throw new Error('unexpected'); },
    sendText: async () => { throw new Error('unexpected'); },
  }, target, '');
  assert.deepEqual(results, []);
});
