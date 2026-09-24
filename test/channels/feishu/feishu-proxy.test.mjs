import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createFeishuWebSocketAgent } from '../../../plugin-src/host/channels/feishu/production.mjs';
import { verifyFeishuApp } from '../../../src/channels/feishu/feishu-app.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('Feishu verification uses the SDK HTTP client through HTTPS_PROXY', {
  timeout: 5000,
}, async () => {
  const proxyHits = [];
  const proxy = createServer((request, response) => {
    proxyHits.push(request.url);
    response.writeHead(502).end();
  });
  proxy.on('connect', (request, socket) => {
    proxyHits.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  const proxyPort = await listen(proxy);
  const environmentKeys = ['https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
  const environment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

  try {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    process.env.https_proxy = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;

    await assert.rejects(verifyFeishuApp({
      appId: 'cli_0000000000000000',
      appSecret: 'local-proxy-test-only',
      httpInstance: Lark.defaultHttpInstance,
      timeoutMs: 1000,
    }));
  } finally {
    restoreEnvironment(environment);
    await close(proxy);
  }

  assert.equal(proxyHits.length, 1);
  assert.match(proxyHits[0], /open\.feishu\.cn/);
});

test('Lark WSClient sends its WSS handshake through the Feishu proxy agent', {
  timeout: 5000,
}, async (t) => {
  const connectTargets = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    connectTargets.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  const proxyPort = await listen(proxy);
  const agent = createFeishuWebSocketAgent({
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
  });
  const quietLogger = {
    debug() {},
    error() {},
    info() {},
    trace() {},
    warn() {},
  };
  let failed;
  const failure = new Promise((resolve, reject) => {
    failed = { resolve, reject };
  });
  const wsClient = new Lark.WSClient({
    agent,
    appId: 'cli_0000000000000000',
    appSecret: 'local-proxy-test-only',
    autoReconnect: false,
    handshakeTimeoutMs: 1000,
    httpInstance: {
      async request() {
        return {
          code: 0,
          data: {
            ClientConfig: {
              PingInterval: 120,
              ReconnectCount: 0,
              ReconnectInterval: 1,
              ReconnectNonce: 0,
            },
            URL: 'wss://msg-frontier.feishu.cn/ws/v2?device_id=local&service_id=1',
          },
        };
      },
    },
    logger: quietLogger,
    loggerLevel: Lark.LoggerLevel.error,
    onError: () => failed.resolve(),
    onReady: () => failed.reject(new Error('The synthetic 502 proxy unexpectedly connected')),
  });
  t.after(() => {
    wsClient.close({ force: true });
    agent.destroy();
  });
  t.after(() => close(proxy));

  await wsClient.start({ eventDispatcher: {} });
  await failure;

  assert.deepEqual(connectTargets, ['msg-frontier.feishu.cn:443']);
});

test('Feishu WebSocket agent sends an upgrade through an HTTPS_PROXY CONNECT tunnel', {
  timeout: 5000,
}, async (t) => {
  let originSawUpgrade = false;
  const origin = createServer();
  origin.on('upgrade', (_request, socket) => {
    originSawUpgrade = true;
    socket.end([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      '',
      '',
    ].join('\r\n'));
  });
  const originPort = await listen(origin);

  const connectTargets = [];
  const proxy = createServer();
  proxy.on('connect', (proxyRequest, clientSocket, head) => {
    connectTargets.push(proxyRequest.url);
    const [hostname, port] = proxyRequest.url.split(':');
    const upstream = connect({ host: hostname, port: Number(port) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', (error) => clientSocket.destroy(error));
    clientSocket.on('error', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);

  const agent = createFeishuWebSocketAgent({
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
  });
  t.after(() => agent.destroy());
  t.after(async () => {
    await Promise.all([close(proxy), close(origin)]);
  });

  await new Promise((resolve, reject) => {
    const upgradeRequest = request({
      agent,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
      },
      hostname: '127.0.0.1',
      path: '/',
      port: originPort,
    });
    upgradeRequest.once('upgrade', (_response, socket) => {
      socket.destroy();
      resolve();
    });
    upgradeRequest.once('response', (response) => {
      reject(new Error(`Expected an upgrade, received HTTP ${response.statusCode}`));
    });
    upgradeRequest.once('error', reject);
    upgradeRequest.end();
  });

  assert.equal(originSawUpgrade, true);
  assert.deepEqual(connectTargets, [`127.0.0.1:${originPort}`]);
});

test('Feishu WebSocket agent is absent when no proxy is configured', () => {
  assert.equal(createFeishuWebSocketAgent({}), undefined);
});

test('Feishu WebSocket agent honors NO_PROXY for the long-connection endpoints', () => {
  const proxyUrl = 'http://127.0.0.1:8080';
  assert.equal(createFeishuWebSocketAgent({
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1,::1,*.local,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,.cn',
  }), undefined, 'a .cn NO_PROXY entry must exclude open.feishu.cn from proxying');
  assert.equal(createFeishuWebSocketAgent({
    https_proxy: proxyUrl,
    no_proxy: 'open.feishu.cn',
  }), undefined, 'an exact-host NO_PROXY entry must exclude the Feishu endpoint');
  assert.equal(createFeishuWebSocketAgent({
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: 'feishu.cn',
  }), undefined, 'a bare parent domain in NO_PROXY must exclude subdomains');
  assert.equal(createFeishuWebSocketAgent({
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: '*',
  }), undefined, 'a wildcard NO_PROXY must disable the WebSocket agent');
  assert.equal(createFeishuWebSocketAgent({
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: 'larksuite.com',
  }), undefined, 'NO_PROXY must also cover the Lark endpoint');
  assert.notEqual(createFeishuWebSocketAgent({
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: 'example.com,other.org',
  }), undefined, 'unrelated NO_PROXY entries must keep the WebSocket agent');
});
