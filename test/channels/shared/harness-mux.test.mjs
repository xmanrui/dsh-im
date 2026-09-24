import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { watchHarnessMux } from '../../../src/channels/shared/harness-mux.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = (id = 'frame-one') => ({
  rpcId: id,
  payload: { type: 'session/event', sessionId: 'session-one', event: { type: 'turn/end' } },
});

// Mirrors apiProxy's eager registration and lazy FrameQueue generator cleanup.
function hostMux({ initial = [], duringMux } = {}) {
  const subscriptions = new Set();
  const requests = [];
  let started = 0;
  let cleaned = 0;
  const apiProxy = {
    events: {
      mux(request, signal) {
        requests.push(request);
        const subscription = { signal, buffer: [...initial], done: false, wake: undefined };
        subscriptions.add(subscription);
        duringMux?.();
        return (async function* () {
          started++;
          const onAbort = () => {
            subscription.done = true;
            subscription.wake?.();
          };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            while (true) {
              while (subscription.buffer.length) {
                const value = subscription.buffer.shift();
                if (value instanceof Error) throw value;
                yield value;
              }
              if (subscription.done || signal.aborted) return;
              await new Promise((resolve) => { subscription.wake = resolve; });
              subscription.wake = undefined;
            }
          } finally {
            signal.removeEventListener('abort', onAbort);
            subscriptions.delete(subscription);
            cleaned++;
          }
        })();
      },
    },
  };
  return {
    apiProxy,
    requests,
    subscriptions,
    get started() { return started; },
    get cleaned() { return cleaned; },
    send(value) {
      for (const subscription of subscriptions) {
        subscription.buffer.push(value);
        subscription.wake?.();
      }
    },
    end() {
      for (const subscription of subscriptions) {
        subscription.done = true;
        subscription.wake?.();
      }
    },
  };
}

class FakeSocket {
  readyState = 0;
  listeners = new Map();
  closeCount = 0;
  throwOnClose = false;

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  emit(type, data) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const callback of [...(this.listeners.get(type) ?? [])]) callback({ data });
  }

  close() {
    this.closeCount++;
    if (this.throwOnClose) throw new Error('cannot close yet');
    this.emit('close');
  }

  assertClean() {
    for (const listeners of this.listeners.values()) assert.equal(listeners.size, 0);
  }
}

test('in-process mux is ready with no frames and abort cleans an idle read', { timeout: 1000 }, async () => {
  const host = hostMux();
  const controller = new AbortController();
  let opened = false;
  const task = watchHarnessMux({
    apiProxy: host.apiProxy,
    rpcId: 'mux-one',
    signal: controller.signal,
    onOpen() {
      assert.equal(host.started, 1);
      assert.equal(host.subscriptions.size, 1);
      opened = true;
    },
    onEnvelope() { assert.fail('empty mux emitted a frame'); },
  });
  assert.equal(opened, true);
  assert.deepEqual(host.requests, [{ rpcId: 'mux-one', payload: {} }]);
  controller.abort();
  await task;
  assert.equal(host.cleaned, 1);
  assert.equal(host.subscriptions.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('in-process mux normalizes frames without changing request IDs', async () => {
  const host = hostMux({ initial: [frame()] });
  const controller = new AbortController();
  const envelopes = [];
  const task = watchHarnessMux({
    apiProxy: host.apiProxy,
    signal: controller.signal,
    rpcId: 'subscription-id',
    onEnvelope(envelope) { envelopes.push(envelope); },
  });
  await tick();
  host.end();
  await task;
  assert.deepEqual(envelopes, [{
    type: 'server-request', rpcId: 'frame-one', method: 'session/event', payload: frame().payload,
  }]);
  assert.equal(host.cleaned, 1);
});

for (const initial of [[], [frame(), frame('frame-two')]]) {
  test(`closing in onOpen cleans ${initial.length ? 'queued' : 'empty'} in-process mux`, { timeout: 1000 }, async () => {
    const host = hostMux({ initial });
    const controller = new AbortController();
    await watchHarnessMux({
      apiProxy: host.apiProxy,
      signal: controller.signal,
      onOpen(close) { close(); },
      onEnvelope() { assert.fail('forwarded after close'); },
    });
    assert.equal(host.started, 1);
    assert.equal(host.cleaned, 1);
    assert.equal(host.subscriptions.size, 0);
    assert.equal(controller.signal.aborted, false);
  });
}

test('pre-aborted watchers never create either transport', async () => {
  const controller = new AbortController();
  controller.abort();
  const host = hostMux();
  for (const baseUrl of [undefined, 'http://127.0.0.1:3080']) {
    await watchHarnessMux({
      apiProxy: host.apiProxy,
      baseUrl,
      signal: controller.signal,
      createWebSocket() { assert.fail('opened an aborted transport'); },
      onOpen() { assert.fail('reported aborted transport ready'); },
    });
  }
  assert.equal(host.requests.length, 0);
});

test('abort during eager mux creation still starts the generator to release its listeners', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const host = hostMux({ initial: [frame()], duringMux: () => controller.abort() });
  await watchHarnessMux({
    apiProxy: host.apiProxy,
    signal: controller.signal,
    onOpen() { assert.fail('reported readiness after cancellation'); },
    onEnvelope() { assert.fail('forwarded after cancellation'); },
  });
  assert.equal(host.started, 1);
  assert.equal(host.cleaned, 1);
  assert.equal(host.subscriptions.size, 0);
});

test('closing one in-process mux does not cancel another subscription on the same host', async () => {
  const host = hostMux();
  const controller = new AbortController();
  let closeFirst;
  const first = [];
  const second = [];
  const firstTask = watchHarnessMux({
    apiProxy: host.apiProxy,
    signal: controller.signal,
    onOpen(close) { closeFirst = close; },
    onEnvelope(envelope) { first.push(envelope); },
  });
  const secondTask = watchHarnessMux({
    apiProxy: host.apiProxy,
    signal: controller.signal,
    onEnvelope(envelope) { second.push(envelope); },
  });
  closeFirst();
  await firstTask;
  assert.equal(host.subscriptions.size, 1);
  host.send(frame());
  await tick();
  controller.abort();
  await secondTask;
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.equal(host.cleaned, 2);
});

test('in-process read failures reject and clean up their subscriptions', async () => {
  const error = new Error('mux read failed');
  const host = hostMux({ initial: [error] });
  const controller = new AbortController();
  await assert.rejects(watchHarnessMux({ apiProxy: host.apiProxy, signal: controller.signal }), error);
  assert.equal(host.cleaned, 1);
  assert.equal(host.subscriptions.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const hook of ['onOpen', 'onEnvelope']) {
  for (const asynchronous of [false, true]) {
    test(`${hook} ${asynchronous ? 'async' : 'sync'} failure closes the in-process stream`, { timeout: 1000 }, async () => {
      const error = new Error('callback failed');
      const host = hostMux({ initial: [frame()] });
      await assert.rejects(watchHarnessMux({
        apiProxy: host.apiProxy,
        signal: new AbortController().signal,
        [hook]: asynchronous ? async () => { throw error; } : () => { throw error; },
      }), error);
      assert.equal(host.cleaned, 1);
      assert.equal(host.subscriptions.size, 0);
    });
  }
}

test('explicit URL uses WebSocket even when apiProxy is available, isolating malformed messages', async () => {
  const socket = new FakeSocket();
  const host = hostMux();
  const controller = new AbortController();
  const received = [];
  const malformed = [];
  let close;
  const task = watchHarnessMux({
    apiProxy: host.apiProxy,
    baseUrl: 'https://harness.example:8443/ignored',
    signal: controller.signal,
    createWebSocket(url) {
      assert.equal(url, 'wss://harness.example:8443/api/events.mux');
      return socket;
    },
    onOpen(value) { close = value; },
    onEnvelope(value) { received.push(value); },
    onMalformed(error) { malformed.push(error); },
  });
  assert.equal(close, undefined);
  socket.emit('open');
  socket.emit('message', '{');
  socket.emit('message', new Uint8Array([1, 2]));
  const envelope = { type: 'server-request', method: 'session/event', ...frame() };
  socket.emit('message', JSON.stringify(envelope));
  close();
  socket.emit('message', JSON.stringify(envelope));
  await task;
  assert.deepEqual(received, [envelope]);
  assert.equal(malformed.length, 2);
  assert.equal(host.requests.length, 0);
  assert.equal(socket.closeCount, 1);
  socket.assertClean();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('WebSocket abort settles even if close throws during connection', async () => {
  const socket = new FakeSocket();
  socket.throwOnClose = true;
  const controller = new AbortController();
  const task = watchHarnessMux({
    baseUrl: 'http://127.0.0.1:3080',
    signal: controller.signal,
    createWebSocket: () => socket,
    onOpen() { assert.fail('opened cancelled socket'); },
  });
  controller.abort();
  await task;
  socket.emit('open');
  socket.assertClean();
  assert.equal(socket.closeCount, 1);
});

for (const opened of [false, true]) {
  for (const event of ['close', 'error']) {
    test(`WebSocket ${event} ${opened ? 'after' : 'before'} opening has expected settlement and cleanup`, async () => {
      const socket = new FakeSocket();
      const controller = new AbortController();
      const task = watchHarnessMux({
        baseUrl: 'http://127.0.0.1:3080',
        signal: controller.signal,
        createWebSocket: () => socket,
      });
      if (opened) socket.emit('open');
      socket.emit(event);
      if (opened && event === 'close') await task;
      else await assert.rejects(task, opened ? /WebSocket failed/ : /before opening/);
      socket.assertClean();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
}

test('WebSocket callback failures reject and close the connection', async () => {
  const socket = new FakeSocket();
  const error = new Error('callback failed');
  const task = watchHarnessMux({
    baseUrl: 'http://127.0.0.1:3080',
    signal: new AbortController().signal,
    createWebSocket: () => socket,
    async onEnvelope() { throw error; },
  });
  socket.emit('open');
  socket.emit('message', JSON.stringify(frame()));
  await assert.rejects(task, error);
  socket.assertClean();
  assert.equal(socket.closeCount, 1);
});
