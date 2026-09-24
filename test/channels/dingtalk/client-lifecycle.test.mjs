import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  DINGTALK_ENDPOINTS,
} from '../../../plugin-src/client/channels/dingtalk/api.js';
import { DingtalkSettingsTab } from '../../../plugin-src/client/channels/dingtalk/index.js';

const { act, create } = TestRenderer;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function ok(value) {
  return { ok: true, value };
}

function provisioning(attemptId, overrides = {}) {
  return {
    attemptId,
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    pollIntervalMs: 1_000,
    qrCodeDataUrl: `data:image/png;base64,${attemptId === 'attempt-old' ? 'QUFBQQ==' : 'QkJCQg=='}`,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    state: 'disconnected',
    bots: [],
    provisioning: null,
    ...overrides,
  };
}

function createBrowserClock() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const frames = new Map();
  const cancelledFrames = [];
  const previousWindow = globalThis.window;

  globalThis.window = {
    setTimeout(callback, delay) {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    },
  };

  return {
    cancelledFrames,
    frames,
    intervals,
    timeouts,
    runInterval(delay) {
      const entry = [...intervals.values()].find((candidate) => candidate.delay === delay);
      assert.ok(entry, `missing ${delay}ms interval`);
      return entry.callback();
    },
    runTimeout(delay) {
      const match = [...timeouts.entries()].find(([, candidate]) => candidate.delay === delay);
      assert.ok(match, `missing ${delay}ms timeout`);
      const [id, entry] = match;
      timeouts.delete(id);
      return entry.callback();
    },
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function nodeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  const children = Array.isArray(node) ? node : node.children;
  return Array.isArray(children) ? children.map(nodeText).join('') : nodeText(children);
}

function findButton(renderer, label) {
  const button = renderer.root.findAllByType('button')
    .find((candidate) => nodeText(candidate) === label);
  assert.ok(button, `missing button: ${label}`);
  return button;
}

test('connection check requests a test message and announces its delivery', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  const bot = {
    botId: 'dt_test',
    connected: true,
    state: 'connected',
    bot: { name: '钉钉机器人', clientIdMasked: 'ding••••test' },
    health: { status: 'healthy', summary: '连接正常', lastCheckedAt: Date.now() },
  };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === DINGTALK_ENDPOINTS.status) {
      return ok(snapshot({ state: 'connected', bots: [bot] }));
    }
    if (endpoint === DINGTALK_ENDPOINTS.reconnectBot) {
      return ok(snapshot({
        state: 'connected',
        bots: [bot],
        testMessage: { sent: true },
      }));
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '检查连接').props.onClick();
    await flushMicrotasks();
  });

  assert.deepEqual(calls.find((call) => call.endpoint === DINGTALK_ENDPOINTS.reconnectBot)?.payload, {
    botId: 'dt_test', sendTest: true,
  });
  const announcement = [...clock.frames.entries()].at(-1);
  assert.ok(announcement, 'successful connection test schedules an announcement');
  await act(async () => {
    clock.frames.delete(announcement[0]);
    announcement[1]();
    await flushMicrotasks();
  });
  const liveRegion = renderer.root.find(
    (node) => node.props.role === 'status' && node.props['aria-live'] === 'polite',
  );
  assert.equal(nodeText(liveRegion), '钉钉连接检查完成，测试消息已发送。');
  const botCard = renderer.root.find((node) => node.props['data-bot-id'] === 'dt_test');
  const visibleFeedback = botCard.find(
    (node) => node.props.role === 'status' && node.props['aria-live'] === undefined,
  );
  assert.equal(nodeText(visibleFeedback), '钉钉连接检查完成，测试消息已发送。');
  act(() => renderer.unmount());
});

test('connection-check failure stays on the matching card with locale-safe wording', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  const bots = ['dt_one', 'dt_two'].map((botId) => {
    const connected = botId === 'dt_one';
    return {
      botId,
      connected,
      state: connected ? 'connected' : 'error',
      bot: { name: botId, clientIdMasked: `ding••••${botId.slice(-3)}` },
      health: {
        status: connected ? 'healthy' : 'offline',
        summary: connected ? '连接正常' : '现有连接错误',
        lastCheckedAt: Date.now(),
      },
      error: connected ? null : { code: 'STREAM_DOWN', message: '现有连接错误' },
    };
  });
  const rpcCall = async (endpoint, payload) => {
    if (endpoint === DINGTALK_ENDPOINTS.status) {
      return ok(snapshot({ state: 'degraded', bots }));
    }
    if (endpoint === DINGTALK_ENDPOINTS.reconnectBot) {
      assert.equal(payload.botId, 'dt_two');
      return {
        ok: false,
        error: { code: 'UPSTREAM_FAILED', message: 'provider-specific failure' },
      };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const targetCard = renderer.root.find((node) => node.props['data-bot-id'] === 'dt_two');
  const targetButton = targetCard.findAllByType('button')
    .find((candidate) => nodeText(candidate) === '重试连接');
  assert.ok(targetButton);
  await act(async () => {
    targetButton.props.onClick();
    await flushMicrotasks();
  });

  const firstCard = renderer.root.find((node) => node.props['data-bot-id'] === 'dt_one');
  assert.equal(firstCard.findAll((node) => node.props.role === 'status').length, 0);
  const visibleFeedback = targetCard.find((node) => node.props.role === 'status');
  assert.equal(nodeText(visibleFeedback), '连接检查失败，请稍后重试。');
  assert.match(nodeText(targetCard), /现有连接错误/);
  assert.equal(
    targetCard.findAll((node) => node.props.className?.includes('dim-cardSummary')).length,
    1,
  );
  assert.equal(
    targetCard.findAll((node) => node.props.className?.includes('dim-cardFeedback')).length,
    1,
  );
  assert.doesNotMatch(nodeText(targetCard), /provider-specific failure/);
  const announcement = [...clock.frames.entries()].at(-1);
  assert.ok(announcement, 'failed connection check schedules an announcement');
  await act(async () => {
    clock.frames.delete(announcement[0]);
    announcement[1]();
    await flushMicrotasks();
  });
  const liveRegion = renderer.root.find(
    (node) => node.props.role === 'status' && node.props['aria-live'] === 'polite',
  );
  assert.equal(nodeText(liveRegion), '连接检查失败，请稍后重试。');
  act(() => renderer.unmount());
});

test('QR setup surfaces a saved bot connection diagnostic instead of polling forever', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  let statusCalls = 0;
  const failedBot = {
    botId: 'dt_failed',
    connected: false,
    state: 'error',
    bot: { name: '钉钉机器人', clientIdMasked: 'ding••••fail' },
    health: { status: 'offline', summary: '钉钉 Stream 连接失败', lastCheckedAt: Date.now() },
    error: {
      code: 'stream-proxy-dependency-incompatible',
      message: '钉钉 Stream 连接失败：检测到代理依赖 agent-base 6.0.0。',
      hint: '请将 agent-base@6 固定为 6.0.2 后重新安装依赖。',
      referenceId: 'DT-CONN-DEADBEEF',
    },
  };
  const rpcCall = async (endpoint) => {
    if (endpoint === DINGTALK_ENDPOINTS.status) {
      statusCalls += 1;
      return ok(statusCalls === 1
        ? snapshot()
        : snapshot({ state: 'offline', bots: [failedBot] }));
    }
    if (endpoint === DINGTALK_ENDPOINTS.beginProvisioning) {
      return ok(provisioning('attempt-failed'));
    }
    if (endpoint === DINGTALK_ENDPOINTS.pollProvisioning) {
      return ok(provisioning('attempt-failed', {
        status: 'connected',
        botId: 'dt_failed',
      }));
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '生成钉钉二维码').props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    clock.runTimeout(1_000);
    await flushMicrotasks();
  });

  const text = nodeText(renderer.root);
  assert.match(text, /机器人已保存，但连接未就绪/);
  assert.match(text, /agent-base 6\.0\.0/);
  assert.match(text, /DT-CONN-DEADBEEF/);
  findButton(renderer, '查看已保存的机器人');
  assert.equal(clock.timeouts.size, 0, 'a diagnosed connection failure stops QR polling');
  act(() => renderer.unmount());
});

test('a later disconnect removes stale success feedback and exposes the account error', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  const connectedBot = {
    botId: 'dt_stale',
    connected: true,
    state: 'connected',
    bot: { name: '状态测试机器人', clientIdMasked: 'ding••••ale' },
    health: { status: 'healthy', summary: '连接正常', lastCheckedAt: Date.now() },
  };
  const disconnectedBot = {
    ...connectedBot,
    connected: false,
    state: 'error',
    health: { status: 'offline', summary: 'Stream 已断开', lastCheckedAt: Date.now() },
    error: { code: 'STREAM_DOWN', message: 'Stream 已断开' },
  };
  let disconnected = false;
  const rpcCall = async (endpoint) => {
    if (endpoint === DINGTALK_ENDPOINTS.status) {
      const bot = disconnected ? disconnectedBot : connectedBot;
      return ok(snapshot({ state: bot.connected ? 'connected' : 'degraded', bots: [bot] }));
    }
    if (endpoint === DINGTALK_ENDPOINTS.reconnectBot) {
      return ok(snapshot({
        state: 'connected',
        bots: [connectedBot],
        testMessage: { sent: true },
      }));
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '检查连接').props.onClick();
    await flushMicrotasks();
  });
  let botCard = renderer.root.find((node) => node.props['data-bot-id'] === 'dt_stale');
  assert.match(nodeText(botCard), /测试消息已发送/);

  disconnected = true;
  await act(async () => {
    await clock.runInterval(15_000);
    await flushMicrotasks();
  });

  botCard = renderer.root.find((node) => node.props['data-bot-id'] === 'dt_stale');
  assert.match(nodeText(botCard), /Stream 已断开/);
  assert.doesNotMatch(nodeText(botCard), /测试消息已发送/);
  assert.equal(botCard.findAll((node) => node.props.role === 'status').length, 0);
  act(() => renderer.unmount());
});

test('a late poll response cannot issue status RPCs or schedule work after effect cleanup', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  const oldPoll = deferred();
  let beginCount = 0;
  let statusCalls = 0;
  const rpcCall = async (endpoint, payload) => {
    if (endpoint === DINGTALK_ENDPOINTS.status) {
      statusCalls += 1;
      return ok(snapshot());
    }
    if (endpoint === DINGTALK_ENDPOINTS.beginProvisioning) {
      beginCount += 1;
      return ok(provisioning(beginCount === 1 ? 'attempt-old' : 'attempt-new'));
    }
    if (endpoint === DINGTALK_ENDPOINTS.cancelProvisioning) return ok({ cancelled: true });
    if (endpoint === DINGTALK_ENDPOINTS.pollProvisioning) {
      assert.equal(payload.attemptId, 'attempt-old');
      return oldPoll.promise;
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '生成钉钉二维码').props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    clock.runTimeout(1_000);
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '换一个二维码').props.onClick();
    await flushMicrotasks();
  });

  assert.equal(clock.timeouts.size, 1, 'the replacement attempt owns one poll timer');
  assert.equal(statusCalls, 1, 'only the initial status request has run');

  await act(async () => {
    oldPoll.resolve(ok(provisioning('attempt-old', {
      status: 'connected',
      botId: 'bot-old',
    })));
    await flushMicrotasks();
  });

  assert.equal(statusCalls, 1, 'the disposed poll cannot start a connected-status refresh');
  assert.equal(clock.timeouts.size, 1, 'the disposed poll cannot add another timer');
  assert.equal(renderer.root.findByType('img').props.src, 'data:image/png;base64,QkJCQg==');

  act(() => renderer.unmount());
});

test('a stale periodic status response cannot restore cancelled provisioning', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  const staleStatus = deferred();
  let statusCalls = 0;
  const rpcCall = async (endpoint) => {
    if (endpoint === DINGTALK_ENDPOINTS.status) {
      statusCalls += 1;
      return statusCalls === 1 ? ok(snapshot()) : staleStatus.promise;
    }
    if (endpoint === DINGTALK_ENDPOINTS.beginProvisioning) {
      return ok(provisioning('attempt-old'));
    }
    if (endpoint === DINGTALK_ENDPOINTS.cancelProvisioning) return ok({ cancelled: true });
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '生成钉钉二维码').props.onClick();
    await flushMicrotasks();
  });
  const firstAnnouncement = [...clock.frames.keys()][0];
  assert.ok(firstAnnouncement, 'starting provisioning schedules an announcement');

  await act(async () => {
    void clock.runInterval(15_000);
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '取消').props.onClick();
    await flushMicrotasks();
  });
  assert.ok(clock.cancelledFrames.includes(firstAnnouncement), 'a new announcement cancels the old frame');

  await act(async () => {
    staleStatus.resolve(ok(snapshot({ provisioning: provisioning('attempt-old') })));
    await flushMicrotasks();
  });

  assert.equal(renderer.root.findAllByType('img').length, 0);
  findButton(renderer, '生成钉钉二维码');
  assert.ok(clock.frames.size > 0, 'cancel leaves its announcement or focus frame pending');

  act(() => renderer.unmount());
  assert.equal(clock.frames.size, 0, 'unmount cancels every pending animation frame');
});

test('unmount does not cancel a Host provisioning task that already started', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  const begin = deferred();
  const calls = [];
  const rpcCall = async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal });
    if (endpoint === DINGTALK_ENDPOINTS.status) return ok(snapshot());
    if (endpoint === DINGTALK_ENDPOINTS.beginProvisioning) return begin.promise;
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  await act(async () => {
    findButton(renderer, '生成钉钉二维码').props.onClick();
    await flushMicrotasks();
  });

  const beginCall = calls.find((call) => call.endpoint === DINGTALK_ENDPOINTS.beginProvisioning);
  assert.ok(beginCall);
  assert.equal(beginCall.signal, undefined, 'component teardown must not abort Host provisioning');
  act(() => renderer.unmount());

  begin.resolve(ok(provisioning('attempt-old')));
  await flushMicrotasks();
  assert.equal(
    calls.filter((call) => call.endpoint === DINGTALK_ENDPOINTS.cancelProvisioning).length,
    0,
  );
  assert.equal(clock.frames.size, 0);
});

test('DingTalk settings save an Agent Preset through bot.preset.set', async (t) => {
  const clock = createBrowserClock();
  t.after(() => clock.restore());
  const bot = {
    botId: 'dt_test',
    connected: true,
    state: 'connected',
    workspace: '/workspace/current',
    bot: { name: '钉钉机器人', clientIdMasked: 'ding••••test' },
    health: { status: 'healthy', summary: '连接正常', lastCheckedAt: Date.now() },
  };
  const catalog = {
    defaultId: 'default',
    items: [
      { id: 'coding', label: 'Coding' },
      { id: 'default', label: 'Default' },
    ],
  };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === DINGTALK_ENDPOINTS.status) {
      return ok(snapshot({
        state: 'connected',
        bots: [bot],
        agentPresetCatalog: catalog,
      }));
    }
    if (endpoint === DINGTALK_ENDPOINTS.setAgentPreset) {
      return ok(snapshot({
        state: 'connected',
        bots: [{ ...bot, agentPreset: payload.agentPreset }],
        agentPresetCatalog: catalog,
      }));
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DingtalkSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-presetSelect' })
      .props.onChange({ target: { value: 'coding' } });
    await flushMicrotasks();
  });

  assert.deepEqual(
    calls.find((call) => call.endpoint === DINGTALK_ENDPOINTS.setAgentPreset)?.payload,
    { botId: 'dt_test', agentPreset: 'coding' },
  );
  act(() => renderer.unmount());
});
