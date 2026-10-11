import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToWhatsapp } from '../../../src/channels/whatsapp/whatsapp-markdown.mjs';

test('WhatsApp projects common formats and keeps link destinations and list markers', () => {
  assert.equal(markdownToWhatsapp('# 标题\n**粗体** __粗体__ *斜体* _斜体_ ~~删除~~\n- 列表\n[链接](https://example.com/a_(b))'),
    '*标题*\n*粗体* *粗体* _斜体_ _斜体_ ~删除~\n- 列表\n链接 (https://example.com/a_(b))');
});

test('WhatsApp protects code, escaped literals, complex nesting and tables', () => {
  for (const value of [
    '`**code** _var_`', '``a`b``', '\\*literal\\*', '***nested***', '**bold _nested_**',
    '````js\na```b\n````', '~~~js\n```\n~~~',
    '| **a** | b |\n| --- | --- |\n| *c* | `d` |',
  ]) assert.equal(markdownToWhatsapp(value), value);
  assert.equal(markdownToWhatsapp('```js\n**code** _var_\n```'), '```\n**code** _var_\n```');
  assert.equal(markdownToWhatsapp('~~~js\n**code** _var_'), '```\n**code** _var_\n```');
  assert.equal(markdownToWhatsapp('`**code**` **bold**'), '`**code**` *bold*');
  assert.equal(markdownToWhatsapp('https://example.com/a_b?q=**x**'), 'https://example.com/a_b?q=**x**');
});
