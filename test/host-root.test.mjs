import assert from 'node:assert/strict';
import test from 'node:test';

import { hostRoot } from '../plugin-src/host/host-root.mjs';

const ROOT = Symbol.for('cordis.root');

test('hostRoot reads the root context from the Cordis root symbol', () => {
  const root = { name: 'root' };
  const ctx = { [ROOT]: root };
  Object.defineProperty(ctx, 'root', {
    get() { throw new Error('cannot get property "root" without inject'); },
  });
  assert.equal(hostRoot(ctx), root);
});

test('hostRoot falls back to the legacy ctx.root accessor', () => {
  const root = { name: 'legacy-root' };
  assert.equal(hostRoot({ root }), root);
});

test('hostRoot survives a rejecting legacy accessor and returns the context', () => {
  const ctx = {};
  Object.defineProperty(ctx, 'root', {
    get() { throw new Error('cannot get property "root" without inject'); },
  });
  assert.equal(hostRoot(ctx), ctx);
});

test('hostRoot passes nullish contexts through', () => {
  assert.equal(hostRoot(undefined), undefined);
  assert.equal(hostRoot(null), null);
});
