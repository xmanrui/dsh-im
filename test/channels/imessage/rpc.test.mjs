import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMESSAGE_ENDPOINTS,
  createIMessageRpcHandler,
  installIMessageRpc,
} from '../../../plugin-src/host/channels/imessage/rpc.mjs';
import { managementFetch } from '../../fixtures/management-rpc.mjs';

function controller(overrides = {}) {
  return {
    status: async () => ({ bots: [] }),
    bindCredentials: async () => ({ bots: [] }),
    reconnectBot: async () => ({ bots: [] }),
    deleteBot: async () => ({ bots: [] }),
    bindNative: async () => ({ bots: [] }),
    permissions: async () => ({ database: 'granted', automation: 'granted' }),
    ...overrides,
  };
}

test('iMessage RPC failures include details for the DSH connection envelope', async () => {
  const handle = createIMessageRpcHandler(controller({
    bindNative: async () => {
      const error = new Error('请授予完全磁盘访问权限');
      error.code = 'messages-database-permission-required';
      throw error;
    },
  }));

  const result = await handle(IMESSAGE_ENDPOINTS.bindNative, {}, undefined);
  assert.equal(result.error.details.stage, 'permission.check');
  assert.match(result.error.details.referenceId, /^IM-CONN-[A-F0-9]{8}$/);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'messages-database-permission-required',
      message: '请在 macOS 系统设置中授予 DSH 完全磁盘访问权限，以读取 Messages 数据库。',
      details: result.error.details,
    },
  });
});

test('iMessage status RPC returns the awaited bot snapshot and permissions', async () => {
  const handle = createIMessageRpcHandler(controller({
    status: async () => ({
      schemaVersion: 1,
      revision: 2,
      bots: [],
      totals: { configured: 0, connected: 0 },
    }),
  }));

  assert.deepEqual(await handle(IMESSAGE_ENDPOINTS.status, {}), {
    ok: true,
    value: {
      schemaVersion: 1,
      revision: 2,
      bots: [],
      totals: { configured: 0, connected: 0 },
      permissions: { database: 'granted', automation: 'granted' },
    },
  });
});

test('iMessage RPC keeps details on delegated token handler failures', async () => {
  const handle = createIMessageRpcHandler(controller());
  const result = await handle(IMESSAGE_ENDPOINTS.deleteBot, { botId: 'bad', confirm: false }, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'bad-request');
  assert.deepEqual(result.error.details, {});
});

test('iMessage RPC registration installs the native handler', async () => {
  let registered;
  const dispose = () => {};
  const ctx = {
    connection: {
      fetch: managementFetch((channel, handler, route) => {
        registered = { channel, handler, route };
        return dispose;
      }),
    },
  };
  const handle = installIMessageRpc(ctx, controller());

  assert.equal(handle, dispose);
  assert.equal(registered.channel, '/imessage');
  assert.equal(registered.route.path, '/api/dsh-im/imessage');
  assert.deepEqual(await registered.handler(IMESSAGE_ENDPOINTS.status, {}), {
    ok: true,
    value: {
      bots: [],
      permissions: { database: 'granted', automation: 'granted' },
    },
  });
});
