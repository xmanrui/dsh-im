import assert from 'node:assert/strict';
import test from 'node:test';

import { flattenMarkdown } from '../src/channels/shared/humanize-outbound.mjs';

//
// 微信不渲染 Markdown：`**加粗**` 会原样带着星号到群里，`- 列表` 会带着短横。
// 这是最响的机器味之一（像把日志贴进聊天），所以出站前必须拍平。
// 同时「拍平」不能把该保留的东西拍坏：代码块和行内代码必须原样可复制。
//
test('粗体、斜体、删除线去掉标记，只留文字', () => {
  assert.equal(flattenMarkdown('**重点**：先看这个'), '重点：先看这个');
  assert.equal(flattenMarkdown('***特别强调***的部分'), '特别强调的部分');
  assert.equal(flattenMarkdown('~~删掉~~'), '删掉');
});

test('列表变成人真的会打的点，标题去掉井号但保留文字', () => {
  assert.equal(flattenMarkdown('- 第一点\n- 第二点'), '· 第一点\n· 第二点');
  assert.equal(flattenMarkdown('### 标题\n正文'), '标题\n正文');
  assert.equal(flattenMarkdown('> 引用一句'), '引用一句');
});

test('链接保留地址：只去掉方括号语法', () => {
  assert.equal(
    flattenMarkdown('看这里 [文档](https://example.com/a) 讲得很清楚'),
    '看这里 文档（https://example.com/a） 讲得很清楚',
  );
});

test('代码块与行内代码原样保留，命令必须还能复制', () => {
  const fence = '```bash\nrm -rf /tmp/x\n```';
  assert.equal(flattenMarkdown(fence), fence);
  assert.equal(flattenMarkdown('运行 `npm run build` 就行'), '运行 npm run build 就行');
});

test('不该动的下划线不动：snake_case 不是斜体', () => {
  assert.equal(flattenMarkdown('a_b_c 这种下划线不能动'), 'a_b_c 这种下划线不能动');
});

test('分隔线与空行被清掉，不留视觉噪音', () => {
  assert.equal(flattenMarkdown('---'), '');
  assert.equal(flattenMarkdown('第一段\n\n\n\n第二段'), '第一段\n\n第二段');
});

test('纯文本原样返回，不被改写', () => {
  assert.equal(flattenMarkdown('今天好热，不想出门。'), '今天好热，不想出门。');
  assert.equal(flattenMarkdown(''), '');
  assert.equal(flattenMarkdown(undefined), '');
});
