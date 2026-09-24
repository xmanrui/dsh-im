import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WECOM_APP_DEFAULT_API_BASE,
  WecomAppApi,
  WecomAppError,
  buildEncryptedReply,
  createUserCrypto,
  isXmlFormat,
  normalizeApiBaseUrl,
  parseWecomAppPlainMessage,
  parseWecomAppXmlBody,
  splitUtf8ByBytes,
} from '../../../src/channels/wecom-app/wecom-app-api.mjs';

const TOKEN = 'unit-test-token';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK'.slice(0, 43);
const CORP_ID = 'ww1234567890abcdef';

test('splitUtf8ByBytes respects the 2048-byte WeCom text limit', () => {
  assert.deepEqual(splitUtf8ByBytes(''), ['']);
  assert.deepEqual(splitUtf8ByBytes('hello'), ['hello']);
  const long = '深'.repeat(3000);
  const chunks = splitUtf8ByBytes(long, 2048);
  assert.equal(chunks.length, Math.ceil(3000 * 3 / 2048));
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk, 'utf8') <= 2048);
  assert.equal(chunks.join(''), long);
  const mixed = 'a深b深c'.repeat(700);
  for (const chunk of splitUtf8ByBytes(mixed, 16)) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 16);
  }
});

test('XML callback payloads parse into the canonical message shape', () => {
  const xml = [
    '<xml>',
    '<ToUserName><![CDATA[wwdcorp]]></ToUserName>',
    '<FromUserName><![CDATA[user-1]]></FromUserName>',
    '<CreateTime>1700000000</CreateTime>',
    '<MsgType><![CDATA[text]]></MsgType>',
    '<Content><![CDATA[你好]]></Content>',
    '<MsgId>123456</MsgId>',
    '<AgentID>1000002</AgentID>',
    '</xml>',
  ].join('');
  const message = parseWecomAppPlainMessage(xml);
  assert.equal(message.msgtype, 'text');
  assert.equal(message.msgid, '123456');
  assert.equal(message.from.userid, 'user-1');
  assert.equal(message.text.content, '你好');
  assert.equal(message.agentId, '1000002');

  const json = parseWecomAppPlainMessage(JSON.stringify({
    msgid: 'json-1',
    msgtype: 'image',
    from: { userid: 'user-2' },
    image: { url: 'https://example.com/a.png' },
  }));
  assert.equal(json.msgid, 'json-1');
  assert.equal(json.image.url, 'https://example.com/a.png');
  assert.equal(isXmlFormat(xml), true);
  assert.equal(isXmlFormat('{"a":1}'), false);
});

test('encrypted replies round-trip through the WeCom crypto scheme', () => {
  const crypto = createUserCrypto({ token: TOKEN, encodingAESKey: AES_KEY, corpId: CORP_ID });
  const timestamp = '1700000000';
  const nonce = 'nonce-1';
  const xmlBody = buildEncryptedReply({
    format: 'xml',
    crypto,
    plaintext: { msgtype: 'stream', stream: { id: 'abc', finish: false, content: 'hi' } },
    timestamp,
    nonce,
  });
  assert.equal(isXmlFormat(xmlBody), true);
  const xml = parseWecomAppXmlBody(xmlBody);
  assert.equal(crypto.verifySignature(xml.MsgSignature, timestamp, nonce, xml.Encrypt), true);
  const decrypted = JSON.parse(crypto.decrypt(xml.Encrypt));
  assert.equal(decrypted.msgtype, 'stream');
  assert.equal(decrypted.stream.id, 'abc');

  const jsonBody = buildEncryptedReply({
    format: 'json',
    crypto,
    plaintext: { ok: true },
    timestamp,
    nonce,
  });
  const json = JSON.parse(jsonBody);
  assert.equal(crypto.verifySignature(json.msgsignature, timestamp, nonce, json.encrypt), true);
  assert.equal(crypto.decrypt(json.encrypt), '{"ok":true}');
});

test('WecomAppApi caches tokens and posts message/send payloads', async () => {
  const calls = [];
  const api = new WecomAppApi({
    corpId: CORP_ID,
    corpSecret: 'unit-corp-secret-value',
    agentId: '1000002',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const target = String(url);
      if (target.includes('/cgi-bin/gettoken')) {
        return new Response(JSON.stringify({ errcode: 0, access_token: 'token-1', expires_in: 7200 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ errcode: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  await api.sendText({ userId: 'user-1', content: 'hello' });
  await api.sendText({ userId: 'user-1', content: 'hello again' });
  assert.equal(calls.filter((call) => call.url.includes('/cgi-bin/gettoken')).length, 1);
  const send = calls.find((call) => call.url.includes('/cgi-bin/message/send'));
  const body = JSON.parse(send.init.body);
  assert.equal(send.url.includes('access_token=token-1'), true);
  assert.equal(body.touser, 'user-1');
  assert.equal(body.agentid, 1000002);
  assert.equal(body.text.content, 'hello');
  assert.equal(api.apiBaseUrl, WECOM_APP_DEFAULT_API_BASE);
  assert.equal(normalizeApiBaseUrl('https://proxy.example.com/'), 'https://proxy.example.com');
});

test('WecomAppApi maps the trusted-IP error with an actionable hint', async () => {
  const api = new WecomAppApi({
    corpId: CORP_ID,
    corpSecret: 'unit-corp-secret-value',
    agentId: '1000002',
    fetchImpl: async (url) => {
      if (String(url).includes('/cgi-bin/gettoken')) {
        return new Response(JSON.stringify({ errcode: 0, access_token: 'token-1', expires_in: 7200 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ errcode: 60020, errmsg: 'not allow to access from your ip' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(
    () => api.sendText({ userId: 'user-1', content: 'hi' }),
    (error) => error instanceof WecomAppError
      && error.code === 'trusted-ip'
      && error.hint.includes('企业可信 IP'),
  );
});

test('downloadMedia returns raw bytes and ignores JSON error envelopes', async () => {
  const api = new WecomAppApi({
    corpId: CORP_ID,
    corpSecret: 'unit-corp-secret-value',
    agentId: '1000002',
    fetchImpl: async (url) => {
      if (String(url).includes('/cgi-bin/gettoken')) {
        return new Response(JSON.stringify({ errcode: 0, access_token: 'token-1', expires_in: 7200 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(Buffer.from([1, 2, 3]), {
        status: 200, headers: { 'content-type': 'application/octet-stream' },
      });
    },
  });
  const result = await api.downloadMedia({ mediaId: 'media-1' });
  assert.deepEqual([...result.data], [1, 2, 3]);
});
