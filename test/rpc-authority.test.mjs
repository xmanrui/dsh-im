import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRpcAuthority } from '../plugin-src/host/rpc-authority.mjs';

test('IM management RPC authority defaults to trusted hosts and accepts explicit loopback restrictions', () => {
  assert.equal(resolveRpcAuthority(), 'trusted-host');
  assert.equal(resolveRpcAuthority('loopback'), 'loopback');
  assert.equal(resolveRpcAuthority('trusted-host'), 'trusted-host');
});

test('IM management RPC authority rejects unknown policy values', () => {
  assert.throws(
    () => resolveRpcAuthority('public'),
    /rpcAuthority must be "loopback" or "trusted-host"/,
  );
});
