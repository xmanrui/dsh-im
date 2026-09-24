import { managementFetch } from '../../fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, createDingtalkHostPlugin, inject, name } from '../../../plugin-src/host/channels/dingtalk/index.mjs';

function controller() {
  return {
    status() { return { bots: [] }; },
    startProvisioning() {},
    registrationStatus() {},
    cancelProvisioning() {},
    bindCredentials() {},
    reconnectBot() {},
    deleteBot() {},
    approveSender() {},
    revokeSender() {},
  };
}

test('Host exports the DingTalk plugin identity and required services', () => {
  const plugin = createDingtalkHostPlugin({ controller: controller() });
  assert.equal(name, 'dsh-dingtalk-host');
  assert.deepEqual(inject, ['connection', 'credentials', 'typertGateway']);
  assert.equal(plugin.name, name);
  assert.deepEqual(plugin.inject, inject);
});

test('Host installs RPC for an injected controller that accepts Harness-admitted LAN requests by default', async () => {
  const calls = [];
  const dispose = () => {};
  const ctx = {
    connection: {
      fetch: managementFetch((...args) => {
        calls.push(args);
        return dispose;
      }),
    },
  };

  assert.equal(await apply(ctx, { controller: controller() }), dispose);
  assert.equal(calls[0][0], '/dingtalk');
  assert.equal(calls[0][2].path, '/api/dsh-im/dingtalk');
  assert.equal((await calls[0][1]('connection.status', {})).ok, true);
  assert.equal((await calls[0][1]('connection.status', {}, undefined, {
    host: '192.168.1.100:3080', origin: 'http://192.168.1.100:3080',
  })).ok, true);
});
