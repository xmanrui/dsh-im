import test from 'node:test';
import { deepStrictEqual, match, ok } from 'node:assert';

import {
  applyMatrixRelations,
  buildMatrixEditContent,
  buildMatrixReactionContent,
  buildMatrixTextContent,
  escapeMatrixHtml,
  extractOutboundMentions,
  hasRoomMention,
  injectOutboundMentionPills,
  markdownToMatrixHtml,
  sanitizeMatrixHtml,
} from '../../../src/channels/matrix/matrix-rich-text.mjs';

test('the sanitizer keeps the whitelist and strips active content', () => {
  deepStrictEqual(escapeMatrixHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
  deepStrictEqual(sanitizeMatrixHtml('<script>alert(1)</script><b>ok</b>'), '<b>ok</b>');
  deepStrictEqual(sanitizeMatrixHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  deepStrictEqual(sanitizeMatrixHtml('<b onclick="steal()">y</b>'), '<b>y</b>');
  deepStrictEqual(sanitizeMatrixHtml('<div>plain</div>'), 'plain');
  deepStrictEqual(sanitizeMatrixHtml('<span data-mx-id="m1">pill</span>'), '<span data-mx-id="m1">pill</span>');
  deepStrictEqual(sanitizeMatrixHtml('<span class="evil" style="x">s</span>'), '<span>s</span>');
  match(sanitizeMatrixHtml('a<br/>b'), /a<br\s*\/?>b/);
  deepStrictEqual(
    sanitizeMatrixHtml('<a href="https://example.org/a?x=1&amp;y=2">doc</a>'),
    '<a href="https://example.org/a?x=1&amp;y=2">doc</a>',
  );
});

test('the markdown subset renders deterministic Matrix HTML', () => {
  match(markdownToMatrixHtml('```js\nconst a = 1 < 2;\n```'),
    /<pre><code class="language-js">const a = 1 &lt; 2;<\/code><\/pre>/);
  deepStrictEqual(markdownToMatrixHtml('Use `x` now'), '<p>Use <code>x</code> now</p>');
  deepStrictEqual(markdownToMatrixHtml('**强** 与 *斜* 与 ~~删~~'),
    '<p><strong>强</strong> 与 <em>斜</em> 与 <del>删</del></p>');
  match(markdownToMatrixHtml('[doc](https://example.org)'), /<a href="https:\/\/example\.org\/?">doc<\/a>/);
  deepStrictEqual(markdownToMatrixHtml('[x](javascript:alert(1))'), '<p>x (javascript:alert(1))</p>',
    'disallowed link schemes degrade to visible text instead of dead anchors');
  deepStrictEqual(markdownToMatrixHtml('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  deepStrictEqual(markdownToMatrixHtml('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  deepStrictEqual(markdownToMatrixHtml('> hi'), '<blockquote>hi</blockquote>');
  deepStrictEqual(markdownToMatrixHtml('---'), '<hr/>');
  deepStrictEqual(markdownToMatrixHtml('### 标题'), '<p><strong>标题</strong></p>');
  deepStrictEqual(markdownToMatrixHtml('l1\nl2'), '<p>l1<br/>l2</p>');
});

test('mention pills and the outbound mention set respect code regions', () => {
  deepStrictEqual(
    extractOutboundMentions('cc @bot:example.org hi @bot:example.org! (at @mate:x.org)'),
    ['@bot:example.org', '@mate:x.org'],
  );
  deepStrictEqual(extractOutboundMentions('code `@bot:example.org` stays inert'), []);
  const pill = injectOutboundMentionPills('cc @bot:example.org hi `@bot:example.org`');
  ok(pill.includes('[<@bot:example.org>](https://matrix.to/#/@bot:example.org)'));
  ok(pill.includes('`@bot:example.org`'), 'inline code keeps its raw mention text');
  ok(hasRoomMention('@room heads up'));
  ok(!hasRoomMention('`@room`'));
  ok(!hasRoomMention('nope'));
});

test('content builders emit the dual plain/rich body and every relation form', () => {
  const plain = buildMatrixTextContent({ text: '你好' });
  deepStrictEqual({ msgtype: plain.msgtype, body: plain.body }, { msgtype: 'm.text', body: '你好' });
  const rich = buildMatrixTextContent({
    text: '看 **加粗** 与 @u:a.org',
    mentionUserIds: ['@u:a.org', '@u:a.org'],
    roomMention: true,
  });
  deepStrictEqual(rich.format, 'org.matrix.custom.html');
  match(rich.formatted_body, /<strong>加粗<\/strong>/);
  deepStrictEqual(rich['m.mentions'], { user_ids: ['@u:a.org'], 'm.room': true });
  ok(rich.body.includes('@u:a.org'), 'the plain body keeps the mention for non-rendering clients');
  ok(!Object.hasOwn(plain, 'm.mentions'), 'empty mention sets are omitted');

  const edited = buildMatrixEditContent({
    originalContent: { msgtype: 'm.text', body: 'old' },
    newText: 'new **b**',
    eventId: '$e:x.org',
  });
  deepStrictEqual(edited.body, '* new **b**');
  deepStrictEqual(edited['m.new_content'].body, 'new **b**');
  deepStrictEqual(edited['m.relates_to'], { event_id: '$e:x.org', rel_type: 'm.replace' });
  match(edited.formatted_body, /^\* /);

  deepStrictEqual(buildMatrixReactionContent('$e:x.org', '👀'), {
    'm.relates_to': { event_id: '$e:x.org', rel_type: 'm.annotation' },
    'm.reaction': '👀',
  });

  const replied = applyMatrixRelations({ msgtype: 'm.text', body: 'r' }, { replyToEventId: '$o:x.org' });
  deepStrictEqual(replied['m.relates_to'], { 'm.in_reply_to': { event_id: '$o:x.org' }, is_falling_back: false });
  const threaded = applyMatrixRelations({ msgtype: 'm.text', body: 't' },
    { threadId: '$th:x.org', replyToEventId: '$o:x.org' });
  deepStrictEqual(threaded['m.relates_to'], {
    event_id: '$th:x.org',
    rel_type: 'm.thread',
    is_falling_back: true,
    'm.in_reply_to': { event_id: '$o:x.org' },
  });
});
