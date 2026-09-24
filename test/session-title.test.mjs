import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INITIAL_SESSION_TITLE_MAX_BYTES,
  initialSessionTitle,
} from '../src/channels/shared/session-title.mjs';

test('initial Session titles use original text instead of enhanced context', () => {
  const content = [
    {
      type: 'text',
      text: '<dsh_im_source>{"channel":"qq"}</dsh_im_source>\n\n'
        + '<dsh_im_source_guidance>reply formally</dsh_im_source_guidance>',
    },
    { type: 'text', text: 'enhanced copy' },
  ];

  assert.equal(initialSessionTitle({
    text: '  帮我查询\n今天的订单  ',
    content,
  }), '帮我查询 今天的订单');
});

test('initial Session titles strip only leading dsh-im context from structured prompts', () => {
  const content = [
    {
      type: 'text',
      text: '<dsh_im_source>{"channel":"feishu"}</dsh_im_source>\n\n'
        + '<dsh_im_source_guidance>private guidance</dsh_im_source_guidance>',
    },
    { type: 'text', text: '请分析这张图片。' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  ];

  const title = initialSessionTitle({ content });
  assert.equal(title, '请分析这张图片。');
  assert.doesNotMatch(title, /dsh_im_source|private guidance/u);

  assert.equal(initialSessionTitle({
    text: '<dsh_im_source>这是用户正文</dsh_im_source>',
  }), '<dsh_im_source>这是用户正文</dsh_im_source>');
});

test('initial Session titles ignore a leading reply reference block', () => {
  const content = [
    {
      type: 'text',
      text: '<dsh_im_source>{"channel":"feishu"}</dsh_im_source>',
    },
    {
      type: 'text',
      text: '<dsh_im_reply_to>{"content":"引用中的标题"}</dsh_im_reply_to>',
    },
    { type: 'text', text: '当前用户的问题' },
  ];

  assert.equal(initialSessionTitle({ content }), '当前用户的问题');
  assert.equal(initialSessionTitle({
    text: '当前原始问题',
    content,
  }), '当前原始问题');
});

test('initial Session titles truncate safely within the UTF-8 byte budget', () => {
  const title = initialSessionTitle({ text: '订单'.repeat(30) });
  assert.equal(title.endsWith('…'), true);
  assert.equal(Buffer.byteLength(title, 'utf8') <= INITIAL_SESSION_TITLE_MAX_BYTES, true);
});

test('initial Session titles fall back to a safe inbound filename', () => {
  assert.equal(initialSessionTitle({
    text: '',
    files: [{ name: '../reports/报价单.xlsx' }],
  }), '报价单.xlsx');
  assert.equal(initialSessionTitle({ text: '', content: [], files: [] }), null);
});
