import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SHARED_COMMAND_CATALOG } from '../../../src/channels/shared/command-catalog.mjs';
import { getImHostLanguage, setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TelegramConfigStore } from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramRuntime, telegramCommandMenu } from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';
const CONFIG = { botId: 'telegram_menu_sync', platformId: '123456789', username: 'HarnessBot' };

function memoryState() {
  let cursor = null;
  const seen = new Set();
  return {
    cursor: () => cursor,
    setCursor: async (value) => { cursor = value; },
    sessionFor: () => null,
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
  };
}

function server({ failMethod, updates = [], identity = '123456789', webhook = '', gates = {} } = {}) {
  const calls = [];
  // Mutable so a test can start a healthy bot and then fail one later call.
  const faults = { failMethod };
  // Hold one method's response open until the test releases it, so a language
  // switch can be interleaved inside a partially-completed startup.
  const gatePromises = new Map(Object.entries(gates).map(([method, promise]) => [method, promise]));
  let delivered = false;
  let resolveReply;
  const reply = new Promise((resolve) => { resolveReply = resolve; });
  return {
    calls,
    faults,
    reply,
    createHttpTransport: () => ({
      destroy: async () => {},
      fetchImpl: async (url, options) => {
        const method = url.pathname.split('/').at(-1);
        const body = JSON.parse(options.body);
        calls.push({ method, body });
        if (method === faults.failMethod) {
          return new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Test failure' }));
        }
        if (gatePromises.has(method)) {
          await gatePromises.get(method);
          gatePromises.delete(method);
        }
        let result = true;
        if (method === 'getMe') result = { id: identity, is_bot: true };
        if (method === 'getWebhookInfo') result = { url: webhook };
        if (method === 'getUpdates') {
          if (body.timeout === 0) result = [];
          else if (!delivered && updates.length) {
            delivered = true;
            result = updates;
          } else {
            return new Promise((_, reject) => {
              if (options.signal.aborted) reject(options.signal.reason);
              else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
          }
        }
        if (method === 'sendMessage') {
          resolveReply(body.text);
          result = { message_id: 99 };
        }
        return new Response(JSON.stringify({ ok: true, result }));
      },
    }),
  };
}

function runtimeFor(t, apiServer, options = {}) {
  const runtime = new TelegramRuntime({
    config: CONFIG, token: TOKEN, harness: { ensureRunning: async () => {} },
    state: memoryState(), createHttpTransport: apiServer.createHttpTransport, ...options,
  });
  t.after(() => runtime.stop());
  return runtime;
}

const menuCalls = (apiServer) => apiServer.calls.filter(({ method }) =>
  ['setMyCommands', 'deleteMyCommands'].includes(method));

test('runtime sends the complete localized production catalog before menu button and polling', async (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  setImHostLanguage('en');
  const apiServer = server();
  const runtime = runtimeFor(t, apiServer);
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.deepEqual(apiServer.calls.slice(0, 6).map(({ method }) => method), [
    'getMe', 'getWebhookInfo', 'setMyCommands', 'setChatMenuButton', 'getUpdates', 'getUpdates',
  ]);
  const commands = menuCalls(apiServer)[0].body.commands;
  assert.deepEqual(commands, telegramCommandMenu());
  assert.equal(commands.length, telegramCommandMenu().length);
  assert.equal(commands.find((item) => item.command === 'history').description,
    'Show recent history (private chats only)');
  for (const command of ['history', 'reasoninglist', 'reasonings', 'reasoning']) {
    assert.ok(commands.some((item) => item.command === command));
  }
  assert.deepEqual(apiServer.calls[3].body, { menu_button: { type: 'commands' } });
  await runtime.start();
  assert.equal(menuCalls(apiServer).length, 1, 'start is idempotent while connected');
  await runtime.stop();
  setImHostLanguage('zh');
  await runtime.start();
  assert.deepEqual(menuCalls(apiServer)[1].body, { commands: telegramCommandMenu() });
});

test('a live interface language switch re-sends the command menu without a reconnect', async (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  setImHostLanguage('zh');
  const apiServer = server();
  const runtime = runtimeFor(t, apiServer);
  await runtime.start();
  assert.equal(menuCalls(apiServer).length, 1);
  assert.equal(menuCalls(apiServer)[0].body.commands.find((item) => item.command === 'history').description,
    '查看最近历史消息（仅私聊）');

  setImHostLanguage('en');
  assert.equal(await runtime.refreshCommandMenu(), true);
  assert.equal(menuCalls(apiServer).length, 2);
  const refreshed = menuCalls(apiServer)[1].body.commands;
  assert.deepEqual(refreshed, telegramCommandMenu());
  assert.equal(refreshed.find((item) => item.command === 'history').description,
    'Show recent history (private chats only)');
  // The menu button belongs to connect; a language refresh only replaces text.
  assert.equal(apiServer.calls.filter(({ method }) => method === 'setChatMenuButton').length, 1);
  assert.equal(runtime.status.ready, true);

  // An empty catalog clears the list on refresh exactly as it does on connect.
  const emptyServer = server();
  const emptyRuntime = runtimeFor(t, emptyServer, { commandCatalog: [] });
  await emptyRuntime.start();
  setImHostLanguage('zh');
  assert.equal(await emptyRuntime.refreshCommandMenu(), true);
  assert.deepEqual(menuCalls(emptyServer).map(({ method }) => method),
    ['deleteMyCommands', 'deleteMyCommands']);
});

test('a language switch during connection is reconciled once the bot is ready', async (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  setImHostLanguage('zh');
  const gate = Promise.withResolvers();
  const apiServer = server({ gates: { setMyCommands: gate.promise } });
  const runtime = runtimeFor(t, apiServer);

  // Start in Chinese. The initial setMyCommands is held open.
  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.status.ready, false, 'startup must still be connecting');

  // Switch to English while connecting. refresh has nothing to push yet, so it
  // returns false -- but it must not be dropped.
  setImHostLanguage('en');
  assert.equal(await runtime.refreshCommandMenu(), false);

  // A second switch before the catch-up must win; only the latest counts.
  setImHostLanguage('zh');
  assert.equal(await runtime.refreshCommandMenu(), false);

  // Release the initial menu send and let startup finish.
  gate.resolve();
  await starting;
  assert.equal(runtime.status.ready, true);

  const menus = menuCalls(apiServer);
  assert.equal(menus.length, 2, 'the initial menu plus one catch-up re-send');
  const initial = menus[0].body.commands;
  const caughtUp = menus[1].body.commands;
  assert.equal(initial.find((item) => item.command === 'help').description, '显示帮助',
    'the initial menu was sent in the language in force when it started');
  assert.deepEqual(caughtUp, telegramCommandMenu());
  assert.equal(caughtUp.find((item) => item.command === 'help').description, '显示帮助',
    'the catch-up must end on the latest language, not the one current at the first send');
});

test('refreshing the menu of a bot that is not connected changes nothing', async (t) => {
  const apiServer = server();
  const runtime = runtimeFor(t, apiServer);
  assert.equal(await runtime.refreshCommandMenu(), false, 'never started');
  assert.equal(apiServer.calls.length, 0);
  await runtime.start();
  await runtime.stop();
  assert.equal(await runtime.refreshCommandMenu(), false, 'already stopped');
  assert.equal(menuCalls(apiServer).length, 1);
});

test('a failed menu refresh warns, reports failure and leaves the bot connected', async (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  setImHostLanguage('zh');
  const apiServer = server();
  const warnings = [];
  const runtime = runtimeFor(t, apiServer, {
    logger: { warn: (...args) => warnings.push(args), error() {} },
  });
  await runtime.start();
  apiServer.faults.failMethod = 'setMyCommands';
  setImHostLanguage('en');
  assert.equal(await runtime.refreshCommandMenu(), false);
  assert.equal(runtime.status.ready, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /command menu refresh failed/);

  // A later healthy refresh still succeeds; the failure is not sticky.
  apiServer.faults.failMethod = undefined;
  assert.equal(await runtime.refreshCommandMenu(), true);
  assert.deepEqual(menuCalls(apiServer).at(-1).body, { commands: telegramCommandMenu() });
});

test('the controller fans a language refresh out to every bot and contains one failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-command-fanout-'));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  const values = new Map();
  const credentials = {
    resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
    set: async (ref, value) => { values.set(ref, value); },
    unset: async (ref) => { values.delete(ref); },
  };
  const runtimes = [];
  const warnings = [];
  const controller = new TelegramController({
    credentials,
    configStore,
    logger: { warn: (...args) => warnings.push(args), error() {} },
    inspectToken: async (token) => ({
      platformId: token.split(':')[0], name: 'Menu test', username: CONFIG.username,
    }),
    createRuntime: async ({ config }) => {
      const runtime = {
        platformId: config.platformId,
        refreshes: 0,
        status: { ready: true, connectionState: 'connected', harnessReachable: true },
        async start() { return this.status; },
        async stop() { this.status = { ready: false }; },
        async refreshCommandMenu() {
          this.refreshes += 1;
          if (config.platformId === '222222222') throw new Error('private-menu-failure');
          return true;
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  });
  t.after(async () => {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  });
  await controller.bindCredentials({ token: TOKEN });
  await controller.bindCredentials({ token: `222222222:${TOKEN.split(':')[1]}` });
  assert.equal(runtimes.length, 2);

  assert.equal(await controller.refreshCommandMenus(), 1, 'only the healthy bot reports success');
  assert.deepEqual(runtimes.map((runtime) => runtime.refreshes), [1, 1]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /command menu refresh failed/);
  assert.doesNotMatch(JSON.stringify(warnings[0][0]), /private/);

  // A stopped bot is skipped rather than restarted by a language change.
  await controller.close();
  assert.equal(await controller.refreshCommandMenus(), 0);
  assert.deepEqual(runtimes.map((runtime) => runtime.refreshes), [1, 1]);
});

test('controller reconnect rebuilds runtime and replaces removed, hidden and empty menus', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-command-reconnect-'));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  const values = new Map();
  const credentials = {
    resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
    set: async (ref, value) => { values.set(ref, value); },
    unset: async (ref) => { values.delete(ref); },
  };
  const fixture = {
    name: 'fixture', description: 'Fixture command', channels: ['telegram'], menuVisible: true,
    aliases: [{ name: 'fixture_alias' }], help: ['/fixture or /fixture_alias  Fixture command'],
  };
  let catalog = [...SHARED_COMMAND_CATALOG, fixture];
  const apiServer = server();
  const runtimes = [];
  const controller = new TelegramController({
    credentials, configStore,
    inspectToken: async () => ({ platformId: CONFIG.platformId, name: 'Menu test', username: CONFIG.username }),
    createRuntime: async ({ config, token }) => {
      const runtime = new TelegramRuntime({
        config, token, harness: { ensureRunning: async () => {} }, state: memoryState(),
        createHttpTransport: apiServer.createHttpTransport, commandCatalog: catalog,
      });
      runtimes.push(runtime);
      return runtime;
    },
  });
  t.after(async () => {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  });
  await controller.bindCredentials({ token: TOKEN });
  const botId = configStore.list()[0].botId;
  assert.deepEqual(menuCalls(apiServer)[0].body.commands.slice(-2), [
    { command: 'fixture', description: 'Fixture command' },
    { command: 'fixture_alias', description: 'Fixture command' },
  ]);
  catalog = catalog.filter((item) => item.name !== 'history');
  await controller.reconnectBot(botId);
  assert.deepEqual(menuCalls(apiServer)[1].body, { commands: telegramCommandMenu(catalog) });
  assert.ok(!menuCalls(apiServer)[1].body.commands.some((item) => item.command === 'history'));
  catalog = catalog.map((item) => item.name === 'fixture' ? { ...item, menuVisible: false } : item);
  await controller.reconnectBot(botId);
  assert.deepEqual(menuCalls(apiServer)[2].body, { commands: telegramCommandMenu(catalog) });
  assert.ok(!menuCalls(apiServer)[2].body.commands.some((item) => item.command.startsWith('fixture')));
  catalog = [];
  await controller.reconnectBot(botId);
  assert.deepEqual(menuCalls(apiServer)[3], { method: 'deleteMyCommands', body: {} });
  assert.equal(runtimes.length, 4);
  assert.ok(runtimes.slice(0, -1).every((runtime) => runtime.status.ready === false));
  assert.equal(runtimes.at(-1).status.ready, true);
  assert.equal(apiServer.calls.filter(({ method }) => method === 'setChatMenuButton').length, 4);
});

for (const failMethod of ['setMyCommands', 'deleteMyCommands', 'setChatMenuButton']) {
  test(`${failMethod} failure warns and still processes an incoming help command`, async (t) => {
    const apiServer = server({ failMethod, updates: [{
      update_id: 0,
      message: {
        message_id: 1, chat: { id: 88, type: 'private' },
        from: { id: 42, is_bot: false }, text: '/help',
      },
    }] });
    const warnings = [];
    const runtime = runtimeFor(t, apiServer, {
      ...(failMethod === 'deleteMyCommands' ? { commandCatalog: [] } : {}),
      logger: { warn: (...args) => warnings.push(args), error() {} },
    });
    await runtime.start();
    assert.equal(runtime.status.ready, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /command menu setup failed/);
    let timer;
    try {
      const text = await Promise.race([
        apiServer.reply,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No help reply')), 1000); }),
      ]);
      assert.match(text, /\/history/);
      assert.match(text, /\/reasoninglist/);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(apiServer.calls.filter(({ method }) => method === 'setChatMenuButton').length,
      failMethod === 'setChatMenuButton' ? 1 : 0);
  });
}

test('invalid catalog warns without sending a partial menu or blocking readiness', async (t) => {
  const apiServer = server();
  const warnings = [];
  const runtime = runtimeFor(t, apiServer, {
    commandCatalog: [SHARED_COMMAND_CATALOG[0], SHARED_COMMAND_CATALOG[0]],
    logger: { warn: (...args) => warnings.push(args), error() {} },
  });
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.equal(menuCalls(apiServer).length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].reason, 'unknown');
  assert.equal(warnings[0][1].message, undefined);
});

for (const options of [{ identity: '987654321' }, { webhook: 'https://example.invalid/webhook' }]) {
  test(`identity/webhook failure still blocks startup before menu synchronization: ${JSON.stringify(options)}`, async (t) => {
    const apiServer = server(options);
    const runtime = runtimeFor(t, apiServer);
    await assert.rejects(() => runtime.start());
    assert.equal(runtime.status.ready, false);
    assert.equal(menuCalls(apiServer).length, 0);
  });
}
