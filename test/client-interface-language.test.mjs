import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOST_LANGUAGE_ENDPOINTS,
  HOST_LANGUAGE_RPC_CHANNEL,
  installInterfaceLanguageMirror,
} from '../plugin-src/client/interface-language.js';

const flush = () => new Promise(setImmediate);

function fakeCtx(active) {
  const listeners = new Map();
  return {
    locale: {
      active,
      getLocale() {
        return { active: this.active, locales: [], revision: 1 };
      },
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    listenerCount(event) {
      return (listeners.get(event) ?? new Set()).size;
    },
  };
}

function recorder({ fail = () => false, failResult = () => false } = {}) {
  const calls = [];
  return {
    calls,
    rpcCall: async (endpoint, payload, signal) => {
      calls.push({ endpoint, payload, signal });
      if (fail(calls.length)) throw new Error('mirror unavailable');
      if (failResult(calls.length)) {
        return { ok: false, error: { code: 'interface-language-unavailable', message: 'interface-language-unavailable' } };
      }
      return { ok: true, value: { language: payload.locale } };
    },
  };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutFn(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delayMs });
      return id;
    },
    clearTimeoutFn(id) {
      pending.delete(id);
    },
    get delays() {
      return [...pending.values()].map(({ delayMs }) => delayMs);
    },
    get size() {
      return pending.size;
    },
    async runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [id, { callback }] = entry;
      pending.delete(id);
      callback();
      await flush();
      return true;
    },
  };
}

test('the mirror channel and endpoint match the Host language RPC', () => {
  assert.equal(HOST_LANGUAGE_RPC_CHANNEL, '/dsh-im-language');
  assert.equal(HOST_LANGUAGE_ENDPOINTS.mirror, 'settings.language.mirror');
});

test('the mirror reports the effective interface locale and follows every switch', async () => {
  const ctx = fakeCtx('en');
  const { calls, rpcCall } = recorder();
  const dispose = installInterfaceLanguageMirror(ctx, { rpcCall });
  await flush();

  // The browser-derived locale is the one DSH never stores, so it has to be
  // reported explicitly for bot messages to follow the interface.
  assert.deepEqual(calls.map(({ endpoint, payload }) => [endpoint, payload]), [
    [HOST_LANGUAGE_ENDPOINTS.mirror, { locale: 'en' }],
  ]);

  ctx.emit('locale/change', ctx.locale.getLocale());
  await flush();
  assert.equal(calls.length, 1, 'an unchanged locale is not re-sent');

  ctx.locale.active = 'zh';
  ctx.emit('locale/change', ctx.locale.getLocale());
  await flush();
  assert.deepEqual(calls.at(-1).payload, { locale: 'zh' });
  assert.equal(calls.length, 2);

  dispose();
  dispose();
  assert.equal(ctx.listenerCount('locale/change'), 0);
  ctx.locale.active = 'en';
  ctx.emit('locale/change', ctx.locale.getLocale());
  await flush();
  assert.equal(calls.length, 2, 'a disposed mirror stops reporting');
});

test('a resolved { ok: false } mirror result retries exactly like a rejected promise', async () => {
  // Connection resolves failed business results normally: the Host returns
  // ok:false when it could not persist the mirror, and that must not be
  // mistaken for a successful report.
  const ctx = fakeCtx('en');
  const timers = fakeTimers();
  const { calls, rpcCall } = recorder({ failResult: (count) => count <= 2 });
  const dispose = installInterfaceLanguageMirror(ctx, {
    rpcCall,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    retryDelaysMs: [1_000, 4_000, 15_000],
  });
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(timers.delays, [1_000], 'an ok:false response schedules a retry');

  assert.equal(await timers.runNext(), true);
  assert.deepEqual(calls.map(({ payload }) => payload.locale), ['en', 'en']);
  assert.deepEqual(timers.delays, [4_000], 'the retry delay widens');

  assert.equal(await timers.runNext(), true);
  assert.deepEqual(calls.map(({ payload }) => payload.locale), ['en', 'en', 'en']);
  assert.equal(timers.size, 0, 'a landed report schedules nothing further');
  dispose();
});

test('a mirror that fails at plugin load retries until it lands, with no locale change', async () => {
  // The Connection is not necessarily established when the settings plugin
  // loads. A reader whose language never changes again must still be followed,
  // so the initial report cannot depend on a later locale/change event.
  const ctx = fakeCtx('en');
  const timers = fakeTimers();
  const { calls, rpcCall } = recorder({ fail: (count) => count <= 2 });
  const dispose = installInterfaceLanguageMirror(ctx, {
    rpcCall,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    retryDelaysMs: [1_000, 4_000, 15_000],
  });
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(timers.delays, [1_000], 'the first failure schedules a retry');

  assert.equal(await timers.runNext(), true);
  assert.deepEqual(calls.map(({ payload }) => payload.locale), ['en', 'en']);
  assert.deepEqual(timers.delays, [4_000], 'the retry delay widens');

  assert.equal(await timers.runNext(), true);
  assert.deepEqual(calls.map(({ payload }) => payload.locale), ['en', 'en', 'en']);
  assert.equal(timers.size, 0, 'a landed report schedules nothing further');
  dispose();
});

test('the retry delay is capped and a pending retry is cancelled on dispose', async () => {
  const ctx = fakeCtx('en');
  const timers = fakeTimers();
  const { calls, rpcCall } = recorder({ fail: () => true });
  const dispose = installInterfaceLanguageMirror(ctx, {
    rpcCall,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    retryDelaysMs: [1_000, 4_000],
  });
  await flush();
  assert.deepEqual(timers.delays, [1_000]);
  await timers.runNext();
  assert.deepEqual(timers.delays, [4_000]);
  await timers.runNext();
  assert.deepEqual(timers.delays, [4_000], 'the last delay is the cap, not an escalation');

  dispose();
  assert.equal(timers.size, 0, 'dispose cancels the pending retry');
  const settled = calls.length;
  ctx.locale.active = 'zh';
  ctx.emit('locale/change', ctx.locale.getLocale());
  await flush();
  assert.equal(calls.length, settled, 'a disposed mirror reports nothing');
});

test('a failed mirror is retried on the next switch instead of being latched', async () => {
  const ctx = fakeCtx('en');
  const { calls, rpcCall } = recorder({ fail: (count) => count === 1 });
  const dispose = installInterfaceLanguageMirror(ctx, { rpcCall });
  await flush();
  assert.equal(calls.length, 1);

  // The first report failed, so the same locale must be attempted again
  // rather than treated as already mirrored.
  ctx.emit('locale/change', ctx.locale.getLocale());
  await flush();
  assert.deepEqual(calls.map(({ payload }) => payload.locale), ['en', 'en']);

  ctx.emit('locale/change', ctx.locale.getLocale());
  await flush();
  assert.equal(calls.length, 2, 'a successful report is not repeated');
  dispose();
});

test('the mirror tolerates a Host without the locale service or the RPC transport', async () => {
  const withoutTransport = fakeCtx('en');
  const disposeWithoutTransport = installInterfaceLanguageMirror(withoutTransport, {});
  await flush();
  assert.equal(withoutTransport.listenerCount('locale/change'), 0);
  assert.doesNotThrow(disposeWithoutTransport);

  const { calls, rpcCall } = recorder();
  const withoutLocale = { on: fakeCtx('en').on };
  const disposeWithoutLocale = installInterfaceLanguageMirror(withoutLocale, { rpcCall });
  await flush();
  assert.deepEqual(calls, []);
  assert.doesNotThrow(disposeWithoutLocale);

  const bare = {};
  const disposeBare = installInterfaceLanguageMirror(bare, { rpcCall });
  await flush();
  assert.deepEqual(calls, []);
  assert.doesNotThrow(disposeBare);

  // A locale that is not a usable tag is skipped rather than reported.
  const malformed = fakeCtx(42);
  const disposeMalformed = installInterfaceLanguageMirror(malformed, { rpcCall });
  await flush();
  assert.deepEqual(calls, []);
  malformed.locale.active = 'en_US';
  malformed.emit('locale/change', malformed.locale.getLocale());
  await flush();
  assert.deepEqual(calls, []);
  malformed.locale.active = 'en';
  malformed.emit('locale/change', malformed.locale.getLocale());
  await flush();
  assert.deepEqual(calls.map(({ payload }) => payload.locale), ['en']);
  disposeMalformed();
});
