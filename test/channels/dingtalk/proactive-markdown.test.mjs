import assert from 'node:assert/strict';
import test from 'node:test';
import { createDingtalkApi } from '../../../src/channels/dingtalk/dingtalk-api.mjs';

function fixture(reject) {
  const calls = [];
  const api = createDingtalkApi({ fetchImpl: async (url, options) => {
    if (url.pathname.endsWith('/oauth2/accessToken')) {
      return Response.json({ accessToken: 'test-token', expireIn: 7200 });
    }
    const body = JSON.parse(options.body);
    calls.push({ path: url.pathname, ...body, param: JSON.parse(body.msgParam) });
    return reject?.(calls.length, body) ?? Response.json({ processQueryKey: String(calls.length) });
  } });
  const send = (text, target = { type: 'user', robotCode: 'robot', userId: 'owner' }) => api.sendRobotText({
    clientId: 'robot', clientSecret: 'test-secret', target, text, format: 'markdown',
  });
  return { calls, send };
}

test('DingTalk proactive Markdown preserves private/group routes and uses sampleMarkdown', async () => {
  const { calls, send } = fixture();
  const text = '# Title\n**bold** [link](https://example.com)';
  await send(text);
  await send(text, { type: 'group', robotCode: 'robot', openConversationId: 'cid-test' });
  assert.equal(calls[0].path, '/v1.0/robot/oToMessages/batchSend');
  assert.deepEqual(calls[0].userIds, ['owner']);
  assert.equal(calls[1].path, '/v1.0/robot/groupMessages/send');
  assert.equal(calls[1].openConversationId, 'cid-test');
  for (const call of calls) {
    assert.equal(call.msgKey, 'sampleMarkdown');
    assert.deepEqual(call.param, { title: 'DSH', text });
    assert.equal(call.sessionWebhook, undefined);
  }
});

test('DingTalk definite model rejection falls back only for that chunk without losing code', async () => {
  const { calls, send } = fixture(index => index === 2
    ? Response.json({ code: 'sendMessage.model.notMatch' }, { status: 400 }) : null);
  const rows = Array.from({ length: 180 }, (_, i) => `row_${i} = "中文😀";`);
  await send('```js\n' + rows.join('\n') + '\n```');
  assert.ok(calls.length > 3);
  assert.equal(calls[2].msgKey, 'sampleText');
  assert.equal(calls.filter(call => call.msgKey === 'sampleText').length, 1);
  const accepted = calls.filter((_, index) => index !== 1).map(call => call.param.text ?? call.param.content).join('\n');
  for (const row of rows) assert.equal(accepted.split(row).length - 1, 1);
  for (const call of calls.filter(call => call.msgKey === 'sampleMarkdown')) {
    assert.ok(call.param.text.length <= 1000);
    assert.equal((call.param.text.match(/^```/gm) ?? []).length, 2);
  }
});

test('DingTalk does not retry permissions, server errors, network loss or failed text fallback', async () => {
  for (const failure of [
    () => Response.json({ code: 'Forbidden.AccessDenied' }, { status: 403 }),
    () => Response.json({ code: 'sendMessage.model.notMatch' }, { status: 500 }),
    () => { throw new Error('connection reset'); },
  ]) {
    const { calls, send } = fixture(failure);
    await assert.rejects(send('**answer**'));
    assert.equal(calls.length, 1);
  }
  const { calls, send } = fixture(index => index === 1
    ? Response.json({ code: 'sendMessage.model.notMatch' })
    : Response.json({ code: 'Forbidden.AccessDenied' }, { status: 403 }));
  await assert.rejects(send('**answer**'));
  assert.equal(calls.length, 2);
});
