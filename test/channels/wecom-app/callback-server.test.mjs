import assert from 'node:assert/strict';
import test from 'node:test';

import { WecomAppCallbackServer } from '../../../src/channels/wecom-app/callback-server.mjs';
import { createUserCrypto } from '../../../src/channels/wecom-app/wecom-app-api.mjs';

const TOKEN = 'unit-test-token';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK'.slice(0, 43);
const CORP_ID = 'ww1234567890abcdef';

function crypto() {
  return createUserCrypto({ token: TOKEN, encodingAESKey: AES_KEY, corpId: CORP_ID });
}

const cryptoFor = () => crypto();

function encryptedEnvelope(plaintext, { format = 'xml', timestamp, nonce } = {}) {
  const stamp = String(timestamp ?? Math.floor(Date.now() / 1000));
  const n = String(nonce ?? 'nonce-1');
  const { encrypt, signature } = cryptoFor().encrypt(
    typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext),
    stamp,
    n,
  );
  if (format === 'json') {
    return JSON.stringify({ encrypt, msgsignature: signature, timestamp: stamp, nonce: n });
  }
  return [
    '<xml>',
    '<Encrypt><![CDATA[' + encrypt + ']]></Encrypt>',
    '<MsgSignature><![CDATA[' + signature + ']]></MsgSignature>',
    '<TimeStamp>' + stamp + '</TimeStamp>',
    '<Nonce><![CDATA[' + n + ']]></Nonce>',
    '</xml>',
  ].join('');
}

function extractField(text, tag) {
  const open = '<' + tag + '><![CDATA[';
  const close = ']]></' + tag + '>';
  const start = text.indexOf(open);
  if (start < 0) return null;
  const valueStart = start + open.length;
  const end = text.indexOf(close, valueStart);
  return end < 0 ? null : text.slice(valueStart, end);
}

async function startServer() {
  const server = new WecomAppCallbackServer({ host: '127.0.0.1', port: 0 });
  await server.start();
  return server;
}

function baseUrl(server) {
  return 'http://127.0.0.1:' + server.actualPort;
}

test('callback server verifies the URL and answers with the decrypted echo', async () => {
  const server = await startServer();
  try {
    const inbound = [];
    server.registerRoute({
      botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32),
      cryptoFor, streamEnabled: () => true,
      onInbound: async (event) => inbound.push(event),
    });
    const path = server.routePath({ botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32) });
    const timestamp = '1700000000';
    const nonce = 'verify-nonce';
    const { encrypt, signature } = cryptoFor().encrypt('echo-plaintext', timestamp, nonce);
    const response = await fetch(baseUrl(server) + path
      + '?msg_signature=' + signature + '&timestamp=' + timestamp + '&nonce=' + nonce
      + '&echostr=' + encodeURIComponent(encrypt));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'echo-plaintext');

    const bad = await fetch(baseUrl(server) + path
      + '?msg_signature=deadbeef&timestamp=' + timestamp + '&nonce=' + nonce
      + '&echostr=' + encodeURIComponent(encrypt));
    assert.equal(bad.status, 401);
    assert.deepEqual(inbound, []);
  } finally {
    await server.stop();
  }
});

test('callback server ACKs text messages with a stream placeholder and dedupes retries', async () => {
  const server = await startServer();
  try {
    const inbound = [];
    server.registerRoute({
      botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32),
      cryptoFor, streamEnabled: () => true,
      onInbound: async (event) => {
        if (event.kind === 'message') {
          inbound.push(event);
          server.appendStream(event.stream.streamId, '回答第一段');
          server.finishStream(event.stream.streamId);
        }
      },
    });
    const path = server.routePath({ botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32) });
    const body = encryptedEnvelope({
      msgid: 'm-1', msgtype: 'text',
      from: { userid: 'user-1' },
      text: { content: '你好' },
    });
    const first = await post(server, path, body);
    assert.equal(first.status, 200);
    const firstText = await first.text();
    const crypto = cryptoFor();
    const encrypt = extractField(firstText, 'Encrypt');
    const signature = extractField(firstText, 'MsgSignature');
    const nonce = extractField(firstText, 'Nonce');
    const timestamp = firstText.match(/<TimeStamp>([^<]+)<\/TimeStamp>/u)[1];
    assert.equal(crypto.verifySignature(signature, timestamp, nonce, encrypt), true);
    const reply = JSON.parse(crypto.decrypt(encrypt));
    assert.equal(reply.msgtype, 'stream');
    assert.equal(reply.stream.finish, false);
    const streamId = reply.stream.id;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const retry = await post(server, path, body);
    const retryText = await retry.text();
    const retryReply = JSON.parse(crypto.decrypt(extractField(retryText, 'Encrypt')));
    assert.equal(retryReply.stream.finish, true);
    assert.equal(retryReply.stream.content.includes('回答第一段'), true);
    assert.equal(retryReply.stream.id, streamId);
    assert.equal(inbound.length, 1);
  } finally {
    await server.stop();
  }
});

async function post(server, path, body) {
  const response = await fetch(baseUrl(server) + path, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body,
  });
  return response;
}

test('stream refresh callbacks return the current snapshot', async () => {
  const server = await startServer();
  try {
    server.registerRoute({
      botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32),
      cryptoFor, streamEnabled: () => true,
      onInbound: async () => {},
    });
    const path = server.routePath({ botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32) });
    const stream = server.createStream({ botId: 'wecomapp_test', msgid: null });
    server.appendStream(stream.streamId, '部分内容');
    const body = encryptedEnvelope({
      msgid: 'refresh-1', msgtype: 'stream',
      stream: { id: stream.streamId },
    });
    const response = await post(server, path, body);
    const text = await response.text();
    const crypto = cryptoFor();
    const reply = JSON.parse(crypto.decrypt(extractField(text, 'Encrypt')));
    assert.equal(reply.stream.id, stream.streamId);
    assert.equal(reply.stream.finish, false);
    assert.equal(reply.stream.content, '部分内容');
  } finally {
    await server.stop();
  }
});

test('forged callbacks are rejected before reaching the bridge', async () => {
  const server = await startServer();
  try {
    const inbound = [];
    server.registerRoute({
      botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32),
      cryptoFor, streamEnabled: () => true,
      onInbound: async (event) => inbound.push(event),
    });
    const path = server.routePath({ botId: 'wecomapp_test', callbackSecret: 'a'.repeat(32) });
    const body = encryptedEnvelope(
      { msgid: 'forged', msgtype: 'text', from: { userid: 'u' }, text: { content: 'x' } },
      { timestamp: '1700000000', nonce: 'forged-nonce' },
    ).replace(/<MsgSignature><!\[CDATA\[[\s\S]*?\]\]><\/MsgSignature>/u,
      '<MsgSignature><![CDATA[' + '0'.repeat(40) + ']]></MsgSignature>');
    const response = await post(server, path, body);
    assert.equal(response.status, 401);
    const unknown = await post(server, '/wecom-app/unknown/route', body);
    assert.equal(unknown.status, 404);
    assert.deepEqual(inbound, []);
  } finally {
    await server.stop();
  }
});

function envelopeWithCrypto(crypto, plaintext) {
  const stamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n-' + Math.random().toString(36).slice(2, 8);
  const { encrypt, signature } = crypto.encrypt(
    typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext), stamp, nonce);
  return ['<xml>',
    '<Encrypt><![CDATA[' + encrypt + ']]></Encrypt>',
    '<MsgSignature><![CDATA[' + signature + ']]></MsgSignature>',
    '<TimeStamp>' + stamp + '</TimeStamp>',
    '<Nonce><![CDATA[' + nonce + ']]></Nonce>',
    '</xml>'].join('');
}

test('streams are isolated per app across shared MsgId and cross-app refresh', async () => {
  const server = await startServer();
  try {
    const inboundB = [];
    const cryptoB = createUserCrypto({
      token: 'unit-test-token-b',
      encodingAESKey: 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihg'.slice(0, 43),
      corpId: CORP_ID + '-b',
    });
    server.registerRoute({
      botId: 'wecomapp_a', callbackSecret: 'a'.repeat(32),
      cryptoFor, streamEnabled: () => true,
      onInbound: async () => {},
    });
    server.registerRoute({
      botId: 'wecomapp_b', callbackSecret: 'b'.repeat(32),
      cryptoFor: () => cryptoB, streamEnabled: () => true,
      onInbound: async (event) => inboundB.push(event),
    });
    const pathA = server.routePath({ botId: 'wecomapp_a', callbackSecret: 'a'.repeat(32) });
    const pathB = server.routePath({ botId: 'wecomapp_b', callbackSecret: 'b'.repeat(32) });
    const first = await post(server, pathA, encryptedEnvelope({
      msgid: 'shared-1', msgtype: 'text',
      from: { userid: 'user-a' },
      text: { content: 'A 的消息' },
    }));
    assert.equal(first.status, 200);
    const streamIdA = JSON.parse(cryptoFor().decrypt(
      extractField(await first.text(), 'Encrypt'))).stream.id;
    assert.equal(typeof streamIdA, 'string');
    const second = await post(server, pathB, envelopeWithCrypto(cryptoB, {
      msgid: 'shared-1', msgtype: 'text',
      from: { userid: 'user-b' },
      text: { content: 'B 的消息' },
    }));
    assert.equal(second.status, 200);
    const replyB = JSON.parse(cryptoB.decrypt(extractField(await second.text(), 'Encrypt')));
    assert.equal(replyB.stream.id !== streamIdA, true);
    for (let i = 0; i < 40 && inboundB.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(inboundB.length, 1);
    assert.equal(inboundB[0].message.text.content, 'B 的消息');
    const stamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'cross-refresh';
    const { encrypt, signature } = cryptoB.encrypt(JSON.stringify({
      msgid: 'refresh-x', msgtype: 'stream',
      stream: { id: streamIdA },
    }), stamp, nonce);
    const refresh = await post(server, pathB, [
      '<xml>',
      '<Encrypt><![CDATA[' + encrypt + ']]></Encrypt>',
      '<MsgSignature><![CDATA[' + signature + ']]></MsgSignature>',
      '<TimeStamp>' + stamp + '</TimeStamp>',
      '<Nonce><![CDATA[' + nonce + ']]></Nonce>',
      '</xml>',
    ].join(''));
    assert.equal(refresh.status, 200);
    assert.equal(await refresh.text(), '');
  } finally {
    await server.stop();
  }
});
