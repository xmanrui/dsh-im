import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

import { LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const silentLogger = Object.fromEntries(
  ['error', 'warn', 'info', 'debug', 'trace'].map((level) => [level, () => {}]),
);
const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function completeWebSocketHandshake(socket) {
  let request = '';
  const handleData = (chunk) => {
    request += chunk.toString('utf8');
    if (!request.includes('\r\n\r\n')) {
      return;
    }
    socket.removeListener('data', handleData);
    const key = request.match(/^Sec-WebSocket-Key:\s*(.+)$/imu)?.[1]?.trim();
    if (!key) {
      throw new Error('WebSocket handshake did not contain Sec-WebSocket-Key');
    }
    const accept = createHash('sha1').update(`${key}${websocketGuid}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
  };
  socket.on('data', handleData);
}

async function runScenario(mode) {
  let acceptedConnections = 0;
  const sockets = new Set();
  const server = createServer((socket) => {
    acceptedConnections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (mode === 'connected-repeat') {
      completeWebSocketHandshake(socket);
    }
    else {
      // Consume the HTTP upgrade bytes without responding. This keeps the
      // WebSocket handshake blackholed while allowing FIN/RST to surface as a
      // server-side close when the client aborts the pending socket.
      socket.resume();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  let endpointPulls = 0;
  let callbackCount = 0;
  const client = new WSClient({
    appId: 'cli_0123456789abcdef',
    appSecret: 'test-secret',
    autoReconnect: !['failed-restart', 'timeout'].includes(mode),
    handshakeTimeoutMs: ['connected-repeat', 'duplicate-start', 'restart'].includes(mode)
      ? 500
      : 50,
    httpInstance: {
      async request() {
        endpointPulls += 1;
        return {
          code: 0,
          data: {
            URL: `ws://127.0.0.1:${port}/blackhole`,
            ClientConfig: {
              PingInterval: 120,
              ReconnectCount: 5,
              ReconnectInterval: 0.01,
              ReconnectNonce: 0,
            },
          },
          msg: 'ok',
        };
      },
    },
    logger: silentLogger,
    loggerLevel: LoggerLevel.error,
    onError: () => {
      callbackCount += 1;
    },
    onReady: () => {
      callbackCount += 1;
    },
    onReconnected: () => {
      callbackCount += 1;
    },
    onReconnecting: () => {
      callbackCount += 1;
    },
  });

  try {
    client.start({ eventDispatcher: { invoke: async () => undefined } });
    if (mode === 'duplicate-start') {
      client.start({ eventDispatcher: { invoke: async () => undefined } });
    }
    await waitFor(() => acceptedConnections >= 1, 'first WebSocket handshake');

    if (mode === 'duplicate-start') {
      await delay(50);
      const stateBeforeClose = client.getConnectionStatus().state;
      const activeSocketsBeforeClose = sockets.size;
      if (stateBeforeClose !== 'connecting' || endpointPulls !== 1 ||
          acceptedConnections !== 1 || activeSocketsBeforeClose !== 1 || callbackCount !== 0) {
        throw new Error(JSON.stringify({
          stateBeforeClose,
          endpointPulls,
          acceptedConnections,
          activeSocketsBeforeClose,
          callbackCount,
        }));
      }

      client.close({ force: true });
      await waitFor(() => sockets.size === 0, 'duplicate-start socket shutdown');
      await delay(100);
      const activeSocketsAfterClose = sockets.size;
      if (endpointPulls !== 1 || acceptedConnections !== 1 || callbackCount !== 0) {
        throw new Error('duplicate start produced a callback or reconnect after close');
      }
      return {
        acceptedConnections,
        activeSocketsAfterClose,
        activeSocketsBeforeClose,
        callbackCount,
        endpointPulls,
        stateBeforeClose,
      };
    }

    if (mode === 'connected-repeat') {
      await waitFor(
        () => client.getConnectionStatus().state === 'connected',
        'connected WebSocket state',
      );
      client.start({ eventDispatcher: { invoke: async () => undefined } });
      await delay(100);

      const stateBeforeClose = client.getConnectionStatus().state;
      const activeSocketsBeforeClose = sockets.size;
      if (stateBeforeClose !== 'connected' || endpointPulls !== 1 ||
          acceptedConnections !== 1 || activeSocketsBeforeClose !== 1 || callbackCount !== 1) {
        throw new Error(JSON.stringify({
          stateBeforeClose,
          endpointPulls,
          acceptedConnections,
          activeSocketsBeforeClose,
          callbackCount,
        }));
      }

      client.close({ force: true });
      await waitFor(() => sockets.size === 0, 'connected socket shutdown');
      await delay(100);
      const activeSocketsAfterClose = sockets.size;
      if (endpointPulls !== 1 || acceptedConnections !== 1 || callbackCount !== 1) {
        throw new Error('connected repeat start produced a duplicate callback or reconnect');
      }
      return {
        acceptedConnections,
        activeSocketsAfterClose,
        activeSocketsBeforeClose,
        callbackCount,
        endpointPulls,
        stateBeforeClose,
      };
    }

    if (mode === 'failed-restart') {
      await waitFor(() => client.getConnectionStatus().state === 'failed', 'terminal failure state');
      const callbackCountBeforeRestart = callbackCount;
      if (endpointPulls !== 1 || callbackCountBeforeRestart !== 1) {
        throw new Error('initial terminal failure did not settle exactly once');
      }
      await waitFor(() => sockets.size === 0, 'failed socket shutdown');

      client.start({ eventDispatcher: { invoke: async () => undefined } });
      await waitFor(() => acceptedConnections >= 2, 'post-failure WebSocket handshake');
      const stateAfterRestart = client.getConnectionStatus().state;
      if (endpointPulls !== 2 || stateAfterRestart !== 'connecting') {
        throw new Error(`failed client did not restart: pulls=${endpointPulls}, state=${stateAfterRestart}`);
      }
      client.close({ force: true });
      await waitFor(() => sockets.size === 0, 'post-failure restarted socket shutdown');
      await delay(100);
      if (endpointPulls !== 2 || callbackCount !== callbackCountBeforeRestart) {
        throw new Error('post-failure restart produced a stale callback or reconnect');
      }
      return { callbackCountBeforeRestart, endpointPulls, stateAfterRestart };
    }

    if (mode === 'restart') {
      client.close({ force: true });
      client.start({ eventDispatcher: { invoke: async () => undefined } });
      await waitFor(() => acceptedConnections >= 2, 'restarted WebSocket handshake');
      await delay(50);

      const stateBeforeFinalClose = client.getConnectionStatus().state;
      if (stateBeforeFinalClose !== 'connecting') {
        throw new Error(
          `stale initial continuation replaced restarted state with ${stateBeforeFinalClose}`,
        );
      }
      if (endpointPulls !== 2) {
        throw new Error(`expected two endpoint pulls after immediate restart, received ${endpointPulls}`);
      }
      if (callbackCount !== 0) {
        throw new Error(`stale connection invoked ${callbackCount} lifecycle callbacks`);
      }

      client.close({ force: true });
      await delay(100);
      if (endpointPulls !== 2) {
        throw new Error(`old continuation triggered a third endpoint pull (${endpointPulls})`);
      }
      return { callbackCount, endpointPulls, stateBeforeFinalClose };
    }

    if (mode === 'close') {
      // close() happens while ws is still CONNECTING. The patched SDK must
      // abort that pending socket and cancel the old reConnect(true)
      // continuation before it can pull another endpoint.
      client.close({ force: true });
      await delay(150);
    }
    else {
      // Let the handshake watchdog terminate the blackholed CONNECTING socket.
      // The retained `error` listener must prevent an uncaught EventEmitter
      // error. autoReconnect=false keeps this scenario to one endpoint pull.
      await delay(150);
      client.close({ force: true });
    }

    if (endpointPulls !== 1) {
      throw new Error(`expected one endpoint pull after close, received ${endpointPulls}`);
    }
    return endpointPulls;
  }
  finally {
    client.close({ force: true });
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await delay(5);
  }
}

async function main() {
  const handshakeTimeoutPulls = await runScenario('timeout');
  const closeDuringHandshakePulls = await runScenario('close');
  const immediateRestart = await runScenario('restart');
  const duplicateStart = await runScenario('duplicate-start');
  const connectedRepeatStart = await runScenario('connected-repeat');
  const failedRestart = await runScenario('failed-restart');
  process.stdout.write(JSON.stringify({
    handshakeTimeoutPulls,
    closeDuringHandshakePulls,
    immediateRestart,
    duplicateStart,
    connectedRepeatStart,
    failedRestart,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
