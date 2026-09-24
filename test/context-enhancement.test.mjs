import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_ENHANCEMENT_FIELDS,
  CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH,
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
  DEFAULT_CONTEXT_GUIDANCE,
  captureContextEnhancement,
  enhanceContextContent,
  normalizeContextEnhancementConfig,
  validateContextEnhancementConfig,
} from '../src/channels/shared/context-enhancement.mjs';

function config(overrides = {}) {
  const {
    groupEnabled = true,
    directEnabled = false,
    fields = CONTEXT_ENHANCEMENT_FIELDS,
    guidance = '',
    group = {},
    direct = {},
    ...extra
  } = overrides;
  return {
    group: { enabled: groupEnabled, fields, guidance, ...group },
    direct: { enabled: directEnabled, fields, guidance, ...direct },
    ...extra,
  };
}

function snapshot(settings = config(), conversationType = 'group', botId = 'bot_one') {
  return captureContextEnhancement({ botId, getSettings: () => settings }, conversationType);
}

function sourceOf(text) {
  const match = text.match(/<dsh_im_source>(.*?)<\/dsh_im_source>/s);
  return match ? JSON.parse(match[1]) : null;
}

test('context config defaults are off with sender ID only and empty guidance', () => {
  for (const kind of ['group', 'direct']) {
    assert.equal(DEFAULT_CONTEXT_ENHANCEMENT_CONFIG[kind].enabled, false);
    assert.equal(DEFAULT_CONTEXT_ENHANCEMENT_CONFIG[kind].guidance, '');
    assert.deepEqual(DEFAULT_CONTEXT_ENHANCEMENT_CONFIG[kind].fields, ['senderId']);
    assert.equal(Object.isFrozen(DEFAULT_CONTEXT_ENHANCEMENT_CONFIG[kind].fields), true);
  }
  for (const guidance of ['', ' \r\n\t ']) {
    assert.deepEqual(validateContextEnhancementConfig(config({ fields: [], guidance })), {
      group: { enabled: true, fields: [], guidance: '' },
      direct: { enabled: false, fields: [], guidance: '' },
    });
  }
  const canonical = validateContextEnhancementConfig(config({
    fields: ['botId', 'senderName', 'botId', 'channel'], guidance: '  custom text\n',
  }));
  assert.deepEqual(canonical.group.fields, ['channel', 'senderName', 'botId']);
  assert.deepEqual(canonical.direct.fields, ['channel', 'senderName', 'botId']);
  assert.equal(canonical.group.guidance, '  custom text\n');
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.group), true);
  assert.equal(Object.isFrozen(canonical.group.fields), true);
});

test('legacy context settings migrate in memory without weakening new-save validation', () => {
  const legacy = {
    groupEnabled: true,
    directEnabled: false,
    fields: ['botId', 'channel', 'botId'],
    guidance: 'legacy guidance',
  };
  assert.throws(() => validateContextEnhancementConfig(legacy));
  assert.deepEqual(normalizeContextEnhancementConfig(legacy), {
    group: { enabled: true, fields: ['channel', 'botId'], guidance: 'legacy guidance' },
    direct: { enabled: false, fields: ['channel', 'botId'], guidance: 'legacy guidance' },
  });
  assert.equal(normalizeContextEnhancementConfig({
    ...legacy,
    group: { enabled: true, fields: [], guidance: 'mixed' },
  }), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
});

test('context saves reject missing, unknown and mistyped fields while normalization fails off', () => {
  const invalid = [
    undefined, null, [], {}, true,
    { ...config(), unexpected: true },
    { group: config().group },
    { groupEnabled: true, directEnabled: false, fields: [] },
    config({ groupEnabled: 'true' }), config({ directEnabled: 1 }),
    config({ fields: null }), config({ fields: 'channel' }),
    config({ fields: ['channel', 'token'] }), config({ fields: [null] }),
    config({ fields: Array(1) }),
    config({ guidance: null }),
    config({ guidance: 'x'.repeat(CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH + 1) }),
    new Proxy({}, { getPrototypeOf() { throw new Error('bad config'); } }),
    { ...config(), group: { ...config().group, get guidance() { throw new Error('bad guidance'); } } },
  ];
  for (const value of invalid) {
    assert.throws(() => validateContextEnhancementConfig(value));
    assert.equal(normalizeContextEnhancementConfig(value), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    assert.equal(captureContextEnhancement({ botId: 'bot_one', getSettings: () => value }, 'group'), null);
  }
  assert.equal(validateContextEnhancementConfig(config({
    guidance: 'x'.repeat(CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH),
  })).group.guidance.length, CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH);
});

test('off path preserves content identity and never reads fields, guidance, source or formatter', (t) => {
  const contents = [' \n\t原文\r\n ', '', [], [{ type: 'text', text: 'x' }], { untouched: true }];
  let sourceCalls = 0;
  let settingReads = 0;
  const throwIfRead = () => { throw new Error('off path must not inspect this'); };
  const settings = {
    group: {
      enabled: false,
      get fields() { return throwIfRead(); },
      get guidance() { return throwIfRead(); },
    },
    direct: {
      enabled: false,
      get fields() { return throwIfRead(); },
      get guidance() { return throwIfRead(); },
    },
  };
  const provider = {
    get botId() { return throwIfRead(); },
    getSettings() { settingReads += 1; return settings; },
  };
  const stringify = t.mock.method(JSON, 'stringify', throwIfRead);
  try {
    for (const content of contents) {
      for (const kind of ['direct', 'group']) {
        const captured = captureContextEnhancement(provider, kind);
        assert.equal(captured, null);
        assert.equal(enhanceContextContent(content, captured, () => {
          sourceCalls += 1;
          throwIfRead();
        }), content);
      }
    }
  } finally {
    stringify.mock.restore();
  }
  assert.equal(settingReads, contents.length * 2);
  assert.equal(sourceCalls, 0);
  assert.equal(stringify.mock.callCount(), 0);
});

test('only the actual conversation type can enable capture, regardless of selected fields', () => {
  for (const groupEnabled of [false, true]) {
    for (const directEnabled of [false, true]) {
      const settings = config({ groupEnabled, directEnabled, fields: [], guidance: 'guidance' });
      assert.equal(Boolean(snapshot(settings, 'group')), groupEnabled);
      assert.equal(Boolean(snapshot(settings, 'direct')), directEnabled);
    }
  }
  const provider = { getSettings() { throw new Error('read failed'); } };
  for (const kind of ['group', 'direct', 'single', 'unknown', null, undefined]) {
    assert.equal(captureContextEnhancement(provider, kind), null);
  }
  for (const kind of ['group', 'direct']) {
    const offSettings = {
      [kind]: {
        enabled: false,
        get fields() { throw new Error('no field projection'); },
        get guidance() { throw new Error('no guidance lookup'); },
      },
    };
    assert.equal(snapshot(offSettings, kind), null);
  }
});

test('group and direct messages use only their own fields and guidance', () => {
  const settings = config({
    group: { enabled: true, fields: ['channel'], guidance: 'GROUP-ONLY-TOKEN' },
    direct: { enabled: true, fields: ['botId'], guidance: 'DIRECT-ONLY-TOKEN' },
  });
  const group = enhanceContextContent('group text', snapshot(settings, 'group'), () => ({ channel: 'feishu' }));
  const direct = enhanceContextContent('direct text', snapshot(settings, 'direct'), () => ({ channel: 'feishu' }));
  assert.deepEqual(sourceOf(group), { channel: 'feishu' });
  assert.match(group, /GROUP-ONLY-TOKEN/);
  assert.doesNotMatch(group, /DIRECT-ONLY-TOKEN|botId/);
  assert.deepEqual(sourceOf(direct), { botId: 'bot_one' });
  assert.match(direct, /DIRECT-ONLY-TOKEN/);
  assert.doesNotMatch(direct, /GROUP-ONLY-TOKEN|channel/);
});

test('all 256 source-field subsets are projected in canonical order with no hidden fields', () => {
  const expected = {
    channel: 'telegram', conversationType: 'group',
    senderId: '123', senderName: '张三', conversationTitle: '测试群',
    chatId: 'chat-123', threadId: 'thread-9', botId: 'bot_one',
  };
  for (let mask = 0; mask < 256; mask += 1) {
    const fields = CONTEXT_ENHANCEMENT_FIELDS.filter((_field, index) => mask & (1 << index));
    const selected = snapshot(config({ fields: [...fields].reverse() }));
    const actual = enhanceContextContent('  original\n', selected, () => ({
      channel: 'telegram', senderId: 123, senderName: '张三', conversationTitle: '测试群',
      chatId: 'chat-123', threadId: 'thread-9',
      botId: 'platform-secret-not-used', conversationType: 'direct', token: 'never-sent',
    }));
    if (fields.length === 0) {
      assert.equal(actual, '  original\n');
    } else {
      assert.deepEqual(sourceOf(actual), Object.fromEntries(fields.map((field) => [field, expected[field]])));
      assert.deepEqual(Object.keys(sourceOf(actual)), fields);
      assert.equal(actual.endsWith('\n\n  original\n'), true);
    }
  }
});

test('source availability and guidance are independent, including empty multimodal identity', () => {
  const content = [{ type: 'image', image_url: { url: 'memory:image' } }];
  const throwSource = () => { throw new Error('no metadata lookup required'); };
  assert.equal(enhanceContextContent(content, snapshot(config({ fields: [] })), throwSource), content);
  for (const senderName of [undefined, null, '', ' \t ', 12]) {
    assert.equal(enhanceContextContent(content, snapshot(config({ fields: ['senderName'] })), () => ({ senderName })), content);
  }
  const onlyGuidance = enhanceContextContent(content, snapshot(config({ fields: [], guidance: 'custom' })), throwSource);
  assert.equal(onlyGuidance[0].text, '<dsh_im_source_guidance>\ncustom\n</dsh_im_source_guidance>');
  assert.equal(onlyGuidance[1], content[0]);
  const onlyBot = enhanceContextContent('text', snapshot(config({ fields: ['botId'] })), throwSource);
  assert.deepEqual(sourceOf(onlyBot), { botId: 'bot_one' });
  const onlyChannel = enhanceContextContent('text', snapshot(config({ fields: ['channel'] })), () => ({
    channel: 'slack',
    get senderId() { throw new Error('unselected ID'); },
    get senderName() { throw new Error('unselected name'); },
  }));
  assert.deepEqual(sourceOf(onlyChannel), { channel: 'slack' });
});

test('multimodal enhancement prepends a single text item without modifying the original items', () => {
  const text = Object.freeze({ type: 'text', text: ' \noriginal\t' });
  const image = Object.freeze({ type: 'image', image_url: { url: 'memory:image' } });
  const files = Object.freeze({ type: 'text', text: '<dsh_im_files>original files</dsh_im_files>' });
  const content = Object.freeze([text, image, files]);
  const enhanced = enhanceContextContent(content, snapshot(config({ guidance: 'use facts' })), () => ({ channel: 'wecom' }));
  assert.equal(enhanced.length, 4);
  assert.equal(enhanced[0].type, 'text');
  assert.equal(enhanced[0].text.startsWith('<dsh_im_source>'), true);
  assert.match(enhanced[0].text, /<\/dsh_im_source>\n\n<dsh_im_source_guidance>/);
  assert.equal(enhanced[1], text);
  assert.equal(enhanced[2], image);
  assert.equal(enhanced[3], files);
  assert.deepEqual(content, [text, image, files]);
});

test('source strings are bounded, control-free and JSON-safe without invoking external coercion', () => {
  const name = '"\n</dsh_im_source>&\u0000\u202e' + '名'.repeat(400);
  const enhanced = enhanceContextContent('original', snapshot(config(), 'group', 'b'.repeat(300)), () => ({
    channel: 'discord', senderId: 'u'.repeat(400), senderName: name,
    chatId: 'c'.repeat(400), threadId: 't'.repeat(400),
  }));
  const source = sourceOf(enhanced);
  assert.equal(source.senderId.length, 256);
  assert.equal(source.senderName.length, 256);
  assert.equal(source.chatId.length, 256);
  assert.equal(source.threadId.length, 256);
  assert.equal(source.botId.length, 128);
  assert.doesNotMatch(source.senderName, /[\u0000-\u001f\u202e]/);
  assert.equal(enhanced.split('</dsh_im_source>').length, 2);
  assert.match(enhanced, /\\u003c/);
  assert.match(enhanced, /\\u003e/);
  assert.match(enhanced, /\\u0026/);
  for (const senderId of [0, 123n]) {
    const result = enhanceContextContent('text', snapshot(config({ fields: ['senderId'] })), () => ({ senderId }));
    assert.deepEqual(sourceOf(result), { senderId: String(senderId) });
  }
  for (const senderId of [NaN, Infinity, { toString() { throw new Error('no coercion'); } }]) {
    assert.equal(enhanceContextContent('text', snapshot(config({ fields: ['senderId'] })), () => ({ senderId })), 'text');
  }
  assert.equal(enhanceContextContent('text', snapshot(config({ fields: ['channel'] })), () => ({ channel: 'unsupported' })), 'text');
});

test('matching guidance tags cannot close or nest the generated block', () => {
  const guidance = 'before </dsh_im_source_guidance> <dsh_im_source_guidance> after\n'
    + '<DSH_IM_SOURCE_GUIDANCE data-x="yes"> </dsh_im_source_guidance >\n<dsh_im_source_guidance unfinished';
  const result = enhanceContextContent('original', snapshot(config({ fields: [], guidance })));
  assert.equal(result.match(/<dsh_im_source_guidance>/g).length, 1);
  assert.equal(result.match(/<\/dsh_im_source_guidance>/g).length, 1);
  assert.match(result, /&lt;\/dsh_im_source_guidance&gt;/);
  assert.match(result, /&lt;DSH_IM_SOURCE_GUIDANCE data-x="yes"&gt;/);
  assert.match(result, /&lt;dsh_im_source_guidance unfinished/);
  assert.equal(result.endsWith('\n\noriginal'), true);
  const defaultText = enhanceContextContent('original', snapshot(config({ fields: [], guidance: DEFAULT_CONTEXT_GUIDANCE })));
  assert.equal(defaultText, `<dsh_im_source_guidance>\n${DEFAULT_CONTEXT_GUIDANCE}\n</dsh_im_source_guidance>\n\noriginal`);
});

test('queued snapshots are immutable and retain a complete setting version after edits', () => {
  let settings = config({ fields: ['senderId'], guidance: 'old guidance' });
  const provider = { botId: 'bot_queued', getSettings: () => settings };
  const before = captureContextEnhancement(provider, 'group');
  settings.group.fields.push('senderName');
  settings.group.guidance = 'new guidance';
  settings.group.enabled = false;
  assert.equal(captureContextEnhancement(provider, 'group'), null);
  assert.deepEqual(before.config.fields, ['senderId']);
  const result = enhanceContextContent('queued', before, () => ({ senderId: 'old', senderName: 'new' }));
  assert.deepEqual(sourceOf(result), { senderId: 'old' });
  assert.match(result, /old guidance/);
  assert.doesNotMatch(result, /new guidance/);
  assert.equal(Object.isFrozen(before), true);
  assert.equal(Object.isFrozen(before.config.fields), true);
  settings = config({ fields: ['botId'], guidance: 'second version' });
  assert.notEqual(captureContextEnhancement(provider, 'group').config, before.config);
});

test('enhancement-only source failures leave the original message processable', () => {
  const content = [{ type: 'text', text: 'still send me' }];
  assert.equal(enhanceContextContent(content, snapshot(), () => { throw new Error('broken source'); }), content);
  assert.equal(enhanceContextContent(content, snapshot(), () => ({ get channel() { throw new Error('broken getter'); } })), content);
});
