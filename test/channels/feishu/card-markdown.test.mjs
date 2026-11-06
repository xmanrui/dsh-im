import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLocalImageTarget,
  stripLocalImageMarkdown,
} from '../../../src/channels/feishu/message-utils.mjs';

test('local image targets cover the paths an agent writes', () => {
  for (const target of [
    '/tmp/host_13.png',
    './shots/a.png',
    '../a.png',
    '~/Desktop/a.png',
    'file:///tmp/a.png',
    'C:\\shots\\a.png',
    'C:/shots/a.png',
    '\\\\server\\share\\a.png',
    '06-log/challenge_click_r108.png',
    'shots/a.png',
    'data:image/png;base64,iVBORw0KGgo=',
  ]) {
    assert.equal(isLocalImageTarget(target), true, target);
  }
  for (const target of ['https://example.com/a.png', 'http://example.com/a.png', 'img_v3_abc']) {
    assert.equal(isLocalImageTarget(target), false, target);
  }
});

test('a local image degrades to its caption instead of breaking the card', () => {
  assert.equal(
    stripLocalImageMarkdown('截图如下：\n![标题画面](/tmp/host_13.png)\n后续说明'),
    '截图如下：\n标题画面\n后续说明',
  );
});

test('a bare relative image path degrades instead of breaking the card', () => {
  assert.equal(
    stripLocalImageMarkdown('面板截图如下：\n![挑战任务面板](06-log/challenge_click_r108.png)\n结束时间'),
    '面板截图如下：\n挑战任务面板\n结束时间',
  );
});

test('an image with no caption keeps the path as plain text', () => {
  assert.equal(stripLocalImageMarkdown('![](/tmp/host_13.png)'), '/tmp/host_13.png');
});

test('angle brackets, spaces and a Markdown title are handled', () => {
  assert.equal(
    stripLocalImageMarkdown('![主城](</tmp/a b.png> "shot")'),
    '主城',
  );
});

test('remote images and Feishu image keys are left untouched', () => {
  for (const text of ['![a](https://example.com/a.png)', '![a](img_v3_abc)', '没有图片']) {
    assert.equal(stripLocalImageMarkdown(text), text);
  }
});

test('non-string input passes through', () => {
  assert.equal(stripLocalImageMarkdown(undefined), undefined);
  assert.equal(stripLocalImageMarkdown(null), null);
});
