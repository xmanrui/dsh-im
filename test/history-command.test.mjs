import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isHistoryCommand,
  runHistoryCommand,
} from '../src/channels/shared/history-command.mjs';
import {
  getImHostLanguage,
  setImHostLanguage,
} from '../src/channels/shared/i18n.mjs';

const KEY = 'direct:history-test';
const PRIVATE_DETAIL = 'DO_NOT_DISPLAY_PRIVATE_HISTORY_DETAIL';
const SAFE_FAILURE = /失败|无法|暂不支持|重试|不存在|变化|取消|unavailable|retry|failed|not exist|changed|cancel/iu;

function entry(seq, type, data, extra = {}) {
  return { event: { seq, type, data, ...extra } };
}

function user(seq, text, extra = {}) {
  return entry(seq, 'user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
    ...extra,
  }, { surfaceOp: 'append' });
}

function assistant(seq, turn, text, extra = {}) {
  return entry(seq, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  }, { surfaceOp: 'append' });
}

function end(seq, turn, reason = { kind: 'completed' }) {
  return entry(seq, 'turn/end', { turn, reason });
}

function dialogue(turns = 4) {
  return Array.from({ length: turns }, (_, index) => {
    const turn = index + 1;
    return [
      user(turn * 10, `history_user_${turn}`),
      assistant(turn * 10 + 1, turn, `history_assistant_${turn}`),
      end(turn * 10 + 2, turn),
    ];
  }).flat();
}

function fixture({ sessionId = 'hist42', events = dialogue(), read } = {}) {
  let binding = sessionId;
  const calls = [];
  const state = { sessionFor: () => binding };
  const forbidden = (method) => () => assert.fail(`/history called mutating method ${method}`);
  const session = {
    async readHistory(options) {
      calls.push({ sessionId: binding, options });
      return read ? read(options, calls.length) : { events, hasMore: false };
    },
    ask: forbidden('ask'),
    stopActiveTurn: forbidden('stopActiveTurn'),
    steerActiveTurn: forbidden('steerActiveTurn'),
  };
  const harness = {
    workspaceSession(id, key) {
      assert.equal(id, sessionId, 'only the originally bound Session may be read');
      assert.equal(key, KEY, 'history must retain the originating conversation fence');
      return session;
    },
    createSession: forbidden('createSession'),
    ensureRunning: forbidden('ensureRunning'),
    executeCommand: forbidden('executeCommand'),
    rpc: forbidden('raw RPC outside the scoped history handle'),
  };
  return {
    calls,
    harness,
    session,
    state,
    bind(nextSessionId) { binding = nextSessionId; },
    run(text = '/history', options = {}) {
      return runHistoryCommand(text, harness, state, KEY, { isDirect: true, ...options });
    },
  };
}

function reply(result) {
  assert.equal(result?.handled, true);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  assert.ok(Array.isArray(result.messages));
  assert.ok(result.messages.length > 0 && result.messages.length <= 3);
  assert.equal(result.messages.join(''), result.message);
  assert.ok(result.messages.every((part) => typeof part === 'string' && part.length <= 1_800));
  assert.ok(result.message.length <= 3_000);
  return result.message;
}

function selectedMarkers(message) {
  return message.match(/history_(?:user|assistant)_\d+/gu) ?? [];
}

test('history reserves its command token, including malformed arguments, but not other text', async () => {
  for (const text of [
    '/history', ' /HiStOrY ', '/history 3', '/history 0', '/history 1 2',
    '/history -1', '/history\nnot-a-number',
  ]) {
    assert.equal(isHistoryCommand(text), true, text);
  }
  for (const text of [null, undefined, 42, '', 'history', '/history2', '/histories', 'hi /history']) {
    assert.equal(isHistoryCommand(text), false, String(text));
    assert.equal(await runHistoryCommand(text, {}, {}, KEY), null);
  }
});

test('/history defaults to three individual messages, newest selected then oldest displayed', async () => {
  const current = fixture();
  const text = reply(await current.run());
  assert.deepEqual(selectedMarkers(text), [
    'history_assistant_3', 'history_user_4', 'history_assistant_4',
  ]);
  assert.match(text, /hist42/);
  assert.equal(current.calls.length, 1);
  assert.equal(current.calls[0].options.maxMessages, 50);
  assert.equal(current.calls[0].options.beforeSeq, undefined);
});

test('/history accepts positive integer counts and clamps every count above five', async () => {
  const all = Array.from({ length: 4 }, (_, index) => [
    `history_user_${index + 1}`, `history_assistant_${index + 1}`,
  ]).flat();
  for (const [argument, count] of [
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 5], ['100', 5],
    ['9'.repeat(400), 5], ['0003', 3],
  ]) {
    const current = fixture();
    const text = reply(await current.run(`/history ${argument}`));
    assert.deepEqual(selectedMarkers(text), all.slice(-count), argument);
    assert.equal(current.calls.length, 1, argument);
  }
});

test('history omits stored history commands before applying the default and maximum counts', async () => {
  const oldCommand = user(1, '/history');
  oldCommand.event.time = Date.UTC(2020, 0, 1);
  const currentCommand = user(40, ' /HiStOrY 3 ');
  currentCommand.event.time = Date.now();
  const events = [
    oldCommand,
    ...dialogue(3),
    user(33, '/history'),
    user(34, '/history 10'),
    currentCommand,
  ];
  const normalMessages = Array.from({ length: 3 }, (_, index) => [
    `history_user_${index + 1}`, `history_assistant_${index + 1}`,
  ]).flat();
  for (const [command, count] of [['/history', 3], ['/history 10', 5]]) {
    const current = fixture({ events });
    const text = reply(await current.run(command));
    assert.deepEqual(selectedMarkers(text), normalMessages.slice(-count));
    assert.doesNotMatch(text, /\/history(?:\s|$)/iu);
  }
});

test('ordinary history text can mention /history or start with a different command token', async () => {
  const bodies = ['/history2', '请解释 /history 这个命令', '文档里也有 /history 10 的示例'];
  const current = fixture({ events: bodies.map((body, index) => user(index + 1, body)) });
  const text = reply(await current.run());
  for (const body of bodies) assert.ok(text.includes(body), body);
});

test('filtered history backfills older pages to reach three or five normal messages', async () => {
  const pages = [
    { events: [user(60, '/history'), user(61, '/history 10'), user(62, '/history 3')], hasMore: true },
    { events: [
      user(50, 'history_user_3'), user(51, 'history_user_4'),
      user(52, 'history_user_5'), user(53, 'history_user_6'), user(54, '/history 2'),
    ], hasMore: true },
    { events: [
      user(10, 'history_user_1'), user(11, 'history_user_2'), user(12, '/history 10'),
    ], hasMore: false },
  ];
  for (const [command, count, reads] of [['/history', 3, 2], ['/history 10', 5, 3]]) {
    const current = fixture({ read: (_options, call) => pages[call - 1] });
    const text = reply(await current.run(command));
    assert.deepEqual(selectedMarkers(text), Array.from({ length: count }, (_, index) => (
      `history_user_${7 - count + index}`
    )));
    assert.equal(current.calls.length, reads);
    assert.deepEqual(current.calls.map(({ options }) => options.beforeSeq), [undefined, 60, 50].slice(0, reads));
    assert.doesNotMatch(text, /\/history(?:\s|$)/iu);
  }
});

test('only stored history commands produce the empty-history response', async () => {
  const current = fixture({ events: [
    user(1, '/history'), user(2, '/history 10'), user(3, ' /HISTORY 5 '),
  ] });
  const text = reply(await current.run());
  assert.match(text, /暂无|没有|no .*history|no .*message/iu);
  assert.doesNotMatch(text, /\/history(?:\s|$)/iu);
});

test('invalid history counts are consumed as usage errors without querying the Session', async () => {
  for (const argument of ['0', '000', '-1', '+3', '1.5', '1e3', 'no', '1 2', '3\n4', '３']) {
    const current = fixture();
    const text = reply(await current.run(`/history ${argument}`));
    assert.match(text, /用法|usage/iu, argument);
    assert.match(text, /\/history/u, argument);
    assert.equal(current.calls.length, 0, argument);
  }
});

test('history is private and text-only, including when private status is omitted', async () => {
  for (const options of [
    { isDirect: false }, { isDirect: true, hasImages: true }, { isDirect: true, hasFiles: true },
  ]) {
    const current = fixture();
    const text = reply(await current.run('/history', options));
    assert.match(text, /私聊|文字|图片|文件|direct|text|image|file/iu);
    assert.equal(current.calls.length, 0);
  }
  const current = fixture();
  reply(await runHistoryCommand('/history', current.harness, current.state, KEY));
  assert.equal(current.calls.length, 0);
});

test('history never creates a Session and returns only the available records', async () => {
  const unbound = fixture({ sessionId: null });
  assert.match(reply(await unbound.run()), /绑定|会话|bound|session/iu);
  assert.equal(unbound.calls.length, 0);

  const empty = fixture({ events: [] });
  assert.match(reply(await empty.run()), /暂无|没有|no .*history|no .*message/iu);
  const short = fixture({ events: [user(1, 'history_user_1')] });
  assert.deepEqual(selectedMarkers(reply(await short.run('/history 5'))), ['history_user_1']);
});

test('history accepts completed reasons from both current and older Host protocols', async () => {
  for (const reason of [{ kind: 'completed' }, 'completed']) {
    const current = fixture({ events: [
      user(1, 'history_user_1'),
      assistant(2, 1, 'history_assistant_1'),
      end(3, 1, reason),
    ] });
    assert.deepEqual(selectedMarkers(reply(await current.run())), [
      'history_user_1', 'history_assistant_1',
    ]);
  }
});

test('history filters injections, replacements, tools, reasoning, and intermediate replies', async () => {
  const replacedUser = user(8, PRIVATE_DETAIL);
  replacedUser.event.surfaceOp = 'replace';
  const replacedAssistant = assistant(9, 1, PRIVATE_DETAIL);
  replacedAssistant.event.surfaceOp = 'replace';
  const unknownSource = user(10, PRIVATE_DETAIL, { source: undefined });
  const missingOperation = user(11, PRIVATE_DETAIL);
  delete missingOperation.event.surfaceOp;
  const current = fixture({ events: [
    user(1, 'history_user_1'),
    user(2, PRIVATE_DETAIL, { source: { kind: 'plugin', pluginId: 'time-context' } }),
    user(3, PRIVATE_DETAIL, { source: { kind: 'goal' } }),
    assistant(4, 1, PRIVATE_DETAIL),
    entry(5, 'tool/call', { name: 'bash', arguments: PRIVATE_DETAIL, turn: 1 }),
    entry(6, 'tool/result', { text: PRIVATE_DETAIL, turn: 1 }, { surfaceOp: 'append' }),
    entry(7, 'assistant/chunk', { turn: 1, chunk: { type: 'text-delta', text: PRIVATE_DETAIL } }),
    replacedUser,
    replacedAssistant,
    unknownSource,
    missingOperation,
    entry(12, 'approval/requested', { text: PRIVATE_DETAIL }),
    assistant(13, 1, '', {
      step: 2,
      message: { role: 'assistant', content: [
        { type: 'reasoning', text: PRIVATE_DETAIL },
        { type: 'text', text: 'history_assistant_1' },
        { type: 'tool-call', name: PRIVATE_DETAIL, arguments: PRIVATE_DETAIL },
      ] },
    }),
    end(14, 1),
  ] });
  const text = reply(await current.run('/history 5'));
  assert.deepEqual(selectedMarkers(text), ['history_user_1', 'history_assistant_1']);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('history keeps a running user input but never shows its unfinished assistant output', async () => {
  const current = fixture({ events: [
    ...dialogue(1),
    user(20, 'history_user_2'),
    assistant(21, 2, PRIVATE_DETAIL),
    entry(22, 'assistant/chunk', { turn: 2, chunk: { type: 'text-delta', text: PRIVATE_DETAIL } }),
  ] });
  const text = reply(await current.run());
  assert.deepEqual(selectedMarkers(text), [
    'history_user_1', 'history_assistant_1', 'history_user_2',
  ]);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('history excludes assistant replies from every unsuccessful terminal state', async () => {
  for (const reason of ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted']) {
    for (const terminal of [reason, { kind: reason }]) {
      const current = fixture({ events: [
        user(1, 'history_user_1'),
        assistant(2, 1, PRIVATE_DETAIL),
        end(3, 1, terminal),
      ] });
      const text = reply(await current.run());
      assert.deepEqual(selectedMarkers(text), ['history_user_1'], reason);
      assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'), reason);
    }
  }
});

test('history does not substitute an intermediate answer for an interrupted final message', async () => {
  const current = fixture({ events: [
    user(1, 'history_user_1'),
    assistant(2, 1, PRIVATE_DETAIL),
    assistant(3, 1, PRIVATE_DETAIL, { step: 2, interrupted: true }),
    end(4, 1),
  ] });
  const text = reply(await current.run());
  assert.deepEqual(selectedMarkers(text), ['history_user_1']);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('a final reply with no text gets a placeholder, not an earlier step or hidden blocks', async () => {
  const current = fixture({ events: [
    user(1, 'history_user_1'),
    assistant(2, 1, PRIVATE_DETAIL),
    assistant(3, 1, '', {
      step: 2,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: PRIVATE_DETAIL }] },
    }),
    end(4, 1),
  ] });
  const text = reply(await current.run('/history 1'));
  assert.deepEqual(selectedMarkers(text), []);
  assert.match(text, /文字|text/iu);
  assert.match(text, /助手|assistant/iu);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('structured attachments are represented without exposing their payload or fetching files', async () => {
  const current = fixture({ events: [user(1, '', {
    content: [
      { type: 'text', text: 'history_user_1' },
      { type: 'image', data: PRIVATE_DETAIL, mediaType: 'image/png' },
    ],
  })] });
  const text = reply(await current.run());
  assert.deepEqual(selectedMarkers(text), ['history_user_1']);
  assert.match(text, /图片|image/iu);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('history sorts and deduplicates sequence numbers before selecting messages', async () => {
  const events = dialogue(2);
  const current = fixture({ events: [
    events[5], events[3], events[0], events[2], events[4], events[1],
    structuredClone(events[4]),
  ] });
  assert.deepEqual(selectedMarkers(reply(await current.run('/history 5'))), [
    'history_user_1', 'history_assistant_1', 'history_user_2', 'history_assistant_2',
  ]);
});

test('history combines older pages with later terminal events and stops once enough is known', async () => {
  const pages = [
    { events: [end(32, 3)], hasMore: true },
    { events: [
      user(20, 'history_user_2'),
      assistant(21, 2, 'history_assistant_2'),
      end(22, 2),
      user(30, 'history_user_3'),
      assistant(31, 3, 'history_assistant_3'),
    ], hasMore: true },
  ];
  const current = fixture({ read: (_options, call) => {
    assert.ok(call <= pages.length, 'must not fetch beyond the requested messages');
    return pages[call - 1];
  } });
  const text = reply(await current.run());
  assert.deepEqual(selectedMarkers(text), [
    'history_assistant_2', 'history_user_3', 'history_assistant_3',
  ]);
  assert.equal(current.calls.length, 2);
  assert.deepEqual(current.calls.map(({ options }) => options.beforeSeq), [undefined, 32]);
  assert.ok(current.calls.every(({ options }) => options.maxMessages === 50));
});

test('a multi-page tool turn contributes only its final reply beside the next running input', async () => {
  const pages = [
    { events: [
      assistant(90, 1, 'history_assistant_1', { step: 50 }),
      end(91, 1),
      user(100, 'history_user_2'),
      assistant(101, 2, PRIVATE_DETAIL),
    ], hasMore: true },
    { events: [
      assistant(60, 1, PRIVATE_DETAIL, { step: 30 }),
      assistant(70, 1, PRIVATE_DETAIL, { step: 40 }),
    ], hasMore: true },
    { events: [
      user(1, 'history_user_1'),
      assistant(2, 1, PRIVATE_DETAIL),
    ], hasMore: false },
  ];
  for (const count of [1, 3, 5]) {
    const current = fixture({ read: (_options, call) => pages[call - 1] });
    const text = reply(await current.run(`/history ${count}`));
    assert.deepEqual(selectedMarkers(text), [
      'history_user_1', 'history_assistant_1', 'history_user_2',
    ].slice(-count));
    assert.equal(current.calls.length, count === 1 ? 1 : 3);
    assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
  }
});

test('history makes at most three backward reads and returns the confirmed records it has', async () => {
  const current = fixture({ read: (_options, call) => ({
    events: [user(100 - call, `history_user_${4 - call}`)], hasMore: true,
  }) });
  const text = reply(await current.run('/history 5'));
  assert.deepEqual(selectedMarkers(text), ['history_user_1', 'history_user_2', 'history_user_3']);
  assert.equal(current.calls.length, 3);
  assert.deepEqual(current.calls.map(({ options }) => options.beforeSeq), [undefined, 99, 98]);
});

test('history rejects conflicting or invalid event sequences without echoing any response data', async () => {
  for (const events of [
    [user(1, PRIVATE_DETAIL), user(1, `${PRIVATE_DETAIL}_conflict`)],
    [user(-1, PRIVATE_DETAIL)],
    [user(1.5, PRIVATE_DETAIL)],
    [user('1', PRIVATE_DETAIL)],
    [{ event: { type: 'user/message', data: { text: PRIVATE_DETAIL } } }],
  ]) {
    const current = fixture({ events });
    const text = reply(await current.run());
    assert.match(text, SAFE_FAILURE);
    assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
  }
});

test('history refuses a non-advancing cursor or a later event in a backward page', async () => {
  for (const nextSeq of [50, 51]) {
    const current = fixture({ read: (_options, call) => ({
      events: [user(call === 1 ? 50 : nextSeq, PRIVATE_DETAIL)], hasMore: true,
    }) });
    const text = reply(await current.run('/history 5'));
    assert.match(text, SAFE_FAILURE);
    assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
    assert.ok(current.calls.length <= 2);
  }
});

test('backfill keeps the first tail snapshot even if the Host includes newly appended events', async () => {
  const current = fixture({ read: (_options, call) => call === 1
    ? { events: [user(50, 'history_user_2')], hasMore: true }
    : { events: [user(40, 'history_user_1'), user(60, PRIVATE_DETAIL)], hasMore: false }
  });
  const text = reply(await current.run());
  assert.deepEqual(selectedMarkers(text), ['history_user_1', 'history_user_2']);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
  assert.equal(current.calls.length, 2);
});

test('history returns a safe error for malformed pages and unsupported history handles', async () => {
  for (const page of [null, {}, { events: PRIVATE_DETAIL }, { events: [null], hasMore: false }]) {
    const current = fixture({ read: () => page });
    const text = reply(await current.run());
    assert.match(text, SAFE_FAILURE);
    assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
  }
  const current = fixture();
  delete current.session.readHistory;
  assert.match(reply(await current.run()), SAFE_FAILURE);
});

test('history discards a fetched snapshot if the chat is rebound during the read', async () => {
  const current = fixture({ read: () => {
    current.bind('another-session');
    return { events: [user(1, PRIVATE_DETAIL)], hasMore: false };
  } });
  const text = reply(await current.run());
  assert.match(text, SAFE_FAILURE);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('workspace invalidation, missing Sessions and Host errors never reveal internal details', async () => {
  for (const code of [
    'workspace-session-stale', 'workspace-bot-not-found', 'session-not-found',
    'harness-api-not-found', 'harness-timeout', 'unrecognized-host-error',
  ]) {
    const current = fixture({ read: () => { throw Object.assign(new Error(PRIVATE_DETAIL), { code }); } });
    const text = reply(await current.run());
    assert.match(text, SAFE_FAILURE, code);
    assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'), code);
  }
});

test('a stale backfill discards every earlier page instead of returning partial private data', async () => {
  const current = fixture({ read: (_options, call) => {
    if (call === 1) return { events: [user(30, PRIVATE_DETAIL)], hasMore: true };
    throw Object.assign(new Error(PRIVATE_DETAIL), { code: 'workspace-session-stale' });
  } });
  const text = reply(await current.run('/history 5'));
  assert.equal(current.calls.length, 2);
  assert.match(text, SAFE_FAILURE);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('history uses bounded read options and honors cancellation without exposing old data', async () => {
  const controller = new AbortController();
  const current = fixture({ read: (options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (options.timeoutMs !== undefined) {
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 10_000);
    }
    controller.abort(new Error(PRIVATE_DETAIL));
    return { events: [user(1, PRIVATE_DETAIL)], hasMore: false };
  } });
  const text = reply(await current.run('/history', { signal: controller.signal }));
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
  assert.match(text, SAFE_FAILURE);
});

test('an already cancelled history request does not query the Host', async () => {
  const controller = new AbortController();
  controller.abort(new Error(PRIVATE_DETAIL));
  const current = fixture();
  const text = reply(await current.run('/history', { signal: controller.signal }));
  assert.equal(current.calls.length, 0);
  assert.match(text, SAFE_FAILURE);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('history applies one ten-second deadline across backfill requests', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const current = fixture({ read: () => {
    now += 10_001;
    return { events: [user(1, PRIVATE_DETAIL)], hasMore: true };
  } });
  const text = reply(await current.run('/history 5'));
  assert.equal(current.calls.length, 1);
  assert.match(text, SAFE_FAILURE);
  assert.doesNotMatch(text, new RegExp(PRIVATE_DETAIL, 'u'));
});

test('history truncates long Unicode and code text within shared message and chunk budgets', async () => {
  const events = Array.from({ length: 6 }, (_, index) => user(index + 1,
    `history_user_${index + 1}\n\`\`\`js\n${'中文🙂\n'.repeat(600)}\n\`\`\``,
  ));
  const current = fixture({ events });
  const result = await current.run('/history 100');
  const text = reply(result);
  assert.deepEqual(selectedMarkers(text), [
    'history_user_2', 'history_user_3', 'history_user_4', 'history_user_5', 'history_user_6',
  ]);
  assert.match(text, /截断|truncat/iu);
  assert.equal(text.isWellFormed(), true);
  assert.ok(result.messages.every((part) => part.isWellFormed()));
  assert.ok(text.length <= 3_000);
  assert.ok(result.messages.length <= 3);
  assert.ok([...text.matchAll(/中文/gu)].length <= 500,
    'body text should be cut to the shared per-record budget, not merely split into more messages');
});

test('each history body has its own five-hundred-character bound', async () => {
  const current = fixture({ events: [user(1, `${'Z'.repeat(499)}🙂${'Z'.repeat(2_000)}`)] });
  const text = reply(await current.run('/history 1'));
  assert.ok((text.match(/Z/gu) ?? []).length <= 500);
  assert.match(text, /截断|truncat/iu);
  assert.equal(text.isWellFormed(), true);
});

test('history English messages translate the command envelope without translating saved content', async () => {
  const previousLanguage = getImHostLanguage();
  setImHostLanguage('en');
  try {
    const current = fixture({ events: [user(1, 'Saved user text.')] });
    const text = reply(await current.run());
    assert.match(text, /history/iu);
    assert.match(text, /user/iu);
    assert.match(text, /Saved user text\./u);
    assert.doesNotMatch(text, /[一-鿿]/u);
    const invalid = reply(await current.run('/history 0'));
    assert.match(invalid, /usage/iu);
    assert.match(invalid, /\/history/u);
    assert.doesNotMatch(invalid, /[一-鿿]/u);
  } finally {
    setImHostLanguage(previousLanguage);
  }
});
