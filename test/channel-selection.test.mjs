import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_KEYS,
  channelSelectionArgument,
  describeSelection,
  disabledChannelStubs,
  findChannel,
  parseChannelSelection,
} from '../plugin-src/host/channel-selection.mjs';

test('no selection keeps every channel', () => {
  for (const raw of [undefined, null, '', '   ', 'all']) {
    const selection = parseChannelSelection(raw);
    assert.deepEqual(selection.selected, [...CHANNEL_KEYS]);
    assert.deepEqual(selection.disabled, []);
  }
});

test('one channel disables the other thirteen', () => {
  const selection = parseChannelSelection('feishu');
  assert.deepEqual(selection.selected, ['feishu']);
  assert.equal(selection.disabled.length, CHANNEL_KEYS.length - 1);
  assert.ok(!selection.disabled.includes('feishu'));
  assert.ok(selection.disabled.includes('weixin'));
});

test('commas, spaces and both wecomApp spellings are accepted', () => {
  assert.deepEqual(parseChannelSelection('feishu,telegram').selected, ['feishu', 'telegram']);
  assert.deepEqual(parseChannelSelection('feishu telegram').selected, ['feishu', 'telegram']);
  assert.deepEqual(parseChannelSelection('wecom-app').selected, ['wecomApp']);
  assert.deepEqual(parseChannelSelection('wecomApp').selected, ['wecomApp']);
  // Selection keeps the canonical order, not the order typed.
  assert.deepEqual(parseChannelSelection('telegram,feishu').selected, ['feishu', 'telegram']);
});

test('an unknown channel fails the build instead of shipping a surprise', () => {
  assert.throws(() => parseChannelSelection('feishu,wechat'), /unknown channel\(s\) wechat/u);
});

test('the flag wins over the environment variable', () => {
  const env = { DSH_IM_CHANNELS: 'feishu' };
  assert.equal(channelSelectionArgument([], env), 'feishu');
  assert.equal(channelSelectionArgument(['--channels=telegram'], env), 'telegram');
  assert.equal(channelSelectionArgument(['--minify'], {}), undefined);
});

test('every channel has a distinct key and directory', () => {
  const keys = new Set();
  const dirs = new Set();
  for (const key of CHANNEL_KEYS) {
    const channel = findChannel(key);
    assert.ok(channel, `${key} resolves`);
    assert.ok(!keys.has(channel.key), `${channel.key} is unique`);
    assert.ok(!dirs.has(channel.dir), `${channel.dir} is unique`);
    keys.add(channel.key);
    dirs.add(channel.dir);
  }
  assert.equal(findChannel('wecom-app').key, 'wecomApp');
  assert.equal(findChannel('nope'), null);
});

test('the stub plugin only intercepts dropped channel entries', async () => {
  const plugin = disabledChannelStubs(['weixin']);
  const resolved = [];
  const loaded = [];
  plugin.setup({
    onResolve(_options, callback) {
      for (const path of [
        './channels/weixin/index.mjs',
        './channels/feishu/index.mjs',
        './channels/weixin/rpc.mjs',
      ]) {
        resolved.push([path, callback({ path }, {})]);
      }
    },
    onLoad(_options, callback) {
      loaded.push(callback({ path: './channels/weixin/index.mjs', namespace: 'dsh-im-disabled-channel' }));
    },
  });
  const byPath = new Map(resolved);
  assert.deepEqual(byPath.get('./channels/weixin/index.mjs'), {
    path: './channels/weixin/index.mjs',
    namespace: 'dsh-im-disabled-channel',
  });
  // A kept channel and a deeper module of the dropped one stay untouched.
  assert.equal(byPath.get('./channels/feishu/index.mjs'), null);
  assert.equal(byPath.get('./channels/weixin/rpc.mjs'), null);
  assert.match(loaded[0].contents, /export async function apply/u);
});

test('the build log names what went in', () => {
  assert.equal(describeSelection(parseChannelSelection(undefined)), `channels: all ${CHANNEL_KEYS.length}`);
  assert.match(describeSelection(parseChannelSelection('feishu')), /^channels: feishu \(stubbed: 13\)$/u);
});
