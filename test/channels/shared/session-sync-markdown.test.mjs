import assert from 'node:assert/strict';
import test from 'node:test';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { SlackBotClient } from '../../../src/channels/slack/slack-runtime.mjs';
import { SlackApi } from '../../../src/channels/slack/slack-api.mjs';
import { DiscordBotClient } from '../../../src/channels/discord/discord-runtime.mjs';
import { WhatsappBotClient } from '../../../src/channels/whatsapp/whatsapp-runtime.mjs';

const quiet = { warn() {} };
const block = text => ({ kind: 'text', format: 'markdown', text });
const bridge = bot => new TextHarnessBridge({
  descriptor: { key: 'test', label: 'Test' }, bot, harness: {}, state: {}, logger: quiet,
});

test('proactive Telegram Markdown uses rich delivery; plain, malformed and unknown retain their semantics', async () => {
  const calls = [];
  const warnings = [];
  let failure;
  const bot = new TelegramBotClient({
    logger: { warn: message => warnings.push(message) },
    api: {
      sendRichMessage: async request => {
        calls.push({ method: 'rich', ...request });
        if (failure) throw failure;
        return { message_id: calls.length };
      },
      sendMessage: async request => {
        calls.push({ method: 'plain', ...request });
        return { message_id: calls.length };
      },
    },
  });
  const sender = bridge(bot);
  const target = { chatId: 42 };
  await sender.sendProactiveText(target, '**user input**');
  await sender.sendProactiveText(target, '[DSH 助手]\n\n# Heading\n**bold**', { format: 'markdown' });
  assert.deepEqual(calls.map(call => call.method), ['plain', 'rich']);
  assert.match(calls[1].richMessage.markdown, /\*\*bold\*\*/);
  assert.equal(calls[1].chatId, 42);
  const malformed = '```js\nprivate content';
  await sender.sendProactiveText(target, malformed, { format: 'markdown' });
  assert.equal(calls.at(-1).method, 'plain');
  assert.equal(calls.at(-1).text, malformed);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private content/);
  failure = Object.assign(new Error('timeout'), { code: 'telegram-timeout' });
  const before = calls.length;
  const result = await sender.sendProactiveText(target, '**answer**', { format: 'markdown' });
  assert.equal(result.deliveryOutcome, 'unknown');
  assert.equal(calls.length, before + 1);
  const aborted = AbortSignal.abort();
  assert.throws(() => sender.sendProactiveText(target, 'cancelled', { signal: aborted }), { name: 'AbortError' });
  assert.equal(calls.length, before + 1);
});

test('Slack sync posts safe standard Markdown blocks and falls back only for the rejected chunk', async () => {
  const calls = [];
  let rejectSecond = true;
  const api = new SlackApi({
    botToken: `xoxb-${'0'.repeat(24)}-not-a-real-token`,
    appToken: `xapp-${'0'.repeat(24)}-not-a-real-token`,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const reject = rejectSecond && calls.length === 2;
      return new Response(JSON.stringify(reject
        ? { ok: false, error: 'invalid_blocks' }
        : { ok: true, ts: String(calls.length) }), { status: 200 });
    },
  });
  const sender = bridge(new SlackBotClient({ api, logger: quiet }));
  const rows = Array.from({ length: 400 }, (_, i) => `row_${i} = "中文😀 <@U123> <!here>";`);
  const answer = '```js\n' + rows.join('\n') + '\n```';
  const result = await sender.sendProactiveText({ channelId: 'D12345678', threadTs: '123.456' }, answer, { format: 'markdown' });
  assert.ok(calls.length >= 3);
  assert.ok(calls[0].blocks);
  assert.ok(calls[1].blocks);
  assert.equal(calls[2].blocks, undefined);
  for (const call of calls) {
    assert.equal(call.channel, 'D12345678');
    assert.equal(call.thread_ts, '123.456');
    assert.doesNotMatch(call.text, /<@|<!here>/);
    if (call.blocks) {
      assert.ok(call.blocks[0].text.length <= 12_000);
      assert.equal(call.blocks[0].text, call.text);
      assert.equal((call.text.match(/^```/gm) ?? []).length, 2);
    }
  }
  const accepted = calls.filter((_, i) => i !== 1).map(call => call.text).join('\n');
  for (let i = 0; i < rows.length; i++) assert.equal(accepted.split(`row_${i} =`).length - 1, 1);
  assert.equal(result.providerMessageIds.length, calls.length - 1);
  rejectSecond = false;
  await sender.sendProactiveText({ channelId: 'D12345678' }, '**raw user**');
  assert.equal(calls.at(-1).blocks, undefined);
});

test('Slack permissions, rate limits and transport errors do not trigger a text resend', async () => {
  for (const error of [
    Object.assign(new Error('permission'), { providerCode: 'missing_scope' }),
    Object.assign(new Error('rate'), { status: 429, providerCode: 'ratelimited' }),
    Object.assign(new Error('server'), { status: 500, providerCode: 'invalid_blocks' }),
    new Error('connection reset'),
  ]) {
    let sends = 0;
    const client = new SlackBotClient({ api: { postMessage: async () => { sends++; throw error; } }, logger: quiet });
    await assert.rejects(client.sendDelivery({ channelId: 'D12345678' }, block('**answer**')), value => value === error);
    assert.equal(sends, 1);
  }
});

test('Discord sync protects long code fences and does not repeat a partial delivery', async () => {
  const calls = [];
  let failureAt = Infinity;
  const client = new DiscordBotClient({ api: { createMessage: async request => {
    calls.push(request);
    if (calls.length === failureAt) throw new Error('network lost');
    return { id: String(calls.length) };
  } } });
  const rows = Array.from({ length: 180 }, (_, i) => `line_${i} = "中文😀";`);
  const text = '```js\n' + rows.join('\n') + '\n```';
  const sender = bridge(client);
  await sender.sendProactiveText({ channelId: '123', replyToMessageId: '456' }, text, { format: 'markdown' });
  assert.ok(calls.length > 1);
  for (const [index, call] of calls.entries()) {
    assert.ok(call.content.length <= 1900);
    assert.equal((call.content.match(/^```/gm) ?? []).length, 2);
    assert.equal(call.replyToMessageId, index === 0 ? '456' : undefined);
  }
  const joined = calls.map(call => call.content).join('\n');
  for (const row of rows) assert.equal(joined.split(row).length - 1, 1);
  calls.length = 0;
  failureAt = 2;
  await assert.rejects(sender.sendProactiveText({ channelId: '123' }, text, { format: 'markdown' }), /network lost/);
  assert.equal(calls.length, 2);
});

test('WhatsApp converts before splitting, preserves code and quotes only the first chunk', async () => {
  const calls = [];
  let failureAt = Infinity;
  const client = new WhatsappBotClient({
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content, options) => {
      calls.push({ jid, content, options });
      if (calls.length === failureAt) throw new Error('network lost');
      return { key: { id: String(calls.length) } };
    },
  }, { remember() {} }, { logger: quiet });
  const rows = Array.from({ length: 300 }, (_, i) => `line_${i} = "**literal** 中文😀";`);
  const answer = '# Title\n**bold** [link](https://example.com)\n```js\n' + rows.join('\n') + '\n```';
  const target = { jid: '12345@s.whatsapp.net', quoted: { key: { id: 'quoted' } } };
  await client.sendDelivery(target, block(answer));
  assert.ok(calls.length > 1);
  assert.match(calls[0].content.text, /^\*Title\*\n\*bold\* link \(https:\/\/example.com\)/);
  for (const [index, call] of calls.entries()) {
    assert.ok(call.content.text.length <= 4000);
    assert.equal(call.options.quoted, index === 0 ? target.quoted : undefined);
  }
  const joined = calls.map(call => call.content.text).join('\n');
  for (const row of rows) assert.equal(joined.split(row).length - 1, 1);
  calls.length = 0;
  failureAt = 2;
  await assert.rejects(client.sendDelivery(target, block(answer)), /network lost/);
  assert.equal(calls.length, 2);
});
