import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSessionChannelTitle, SESSION_CHANNEL_LABELS } from '../src/channels/shared/session-channel-labels.mjs';
import { installSessionChannelLogos } from '../plugin-src/client/session-channel-logos.js';

test('client recognizes every emitted Chinese and English channel prefix without altering the title', () => {
  const title = '标题 · 保留分隔符 👨‍👩‍👧‍👦 <img src=x> "quoted"';
  for (const [channel, labels] of Object.entries(SESSION_CHANNEL_LABELS)) {
    for (const label of labels) {
      assert.deepEqual(parseSessionChannelTitle(`${label} · ${title}`), { channel, title });
    }
  }
});

test('ordinary text, incomplete prefixes, and lookalike labels keep their normal rendering', () => {
  for (const value of [null, {}, undefined, '', '微信', '微信 · ', '微信 ·   ', '今天使用 微信 · 聊天', 'wechat · title', '未知 · 标题']) {
    assert.equal(parseSessionChannelTitle(value), null);
  }
});

test('logo installation is inert on server-side and unsupported browser surfaces', () => {
  assert.doesNotThrow(() => installSessionChannelLogos()());
  assert.doesNotThrow(() => installSessionChannelLogos({ body: {}, head: {}, defaultView: {} })());
});
