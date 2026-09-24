import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARED_COMMAND_CATALOG } from '../../../src/channels/shared/command-catalog.mjs';
import {
  listSlashCommands,
  registerSlashCommands,
  SLASH_COMMAND_TENANT_SCOPES,
  SLASH_COMMAND_MANIFEST,
} from '../../../src/channels/feishu/slash-command-registry.mjs';

function fakeHttpInstance(handlers) {
  const requests = [];
  return {
    requests,
    http: {
      async request(options) {
        requests.push(options);
        const { method, url } = options;
        const key = method + ' ' + url.split('/open-apis/')[1];
        const handler = handlers[key];
        if (typeof handler !== 'function') {
          throw new Error(`no fake handler for ${key}`);
        }
        return handler(options);
      },
    },
  };
}

const AUTH_KEY = 'POST auth/v3/tenant_access_token/internal';
const LIST_KEY = 'GET application/v7/app_slash_commands';

test('SLASH_COMMAND_MANIFEST has unique plain command names and bilingual descriptions', () => {
  assert.deepEqual(SLASH_COMMAND_TENANT_SCOPES, [
    'application:app_slash_command:read',
    'application:app_slash_command:write',
  ]);
  assert.ok(Array.isArray(SLASH_COMMAND_MANIFEST));
  assert.ok(SLASH_COMMAND_MANIFEST.length > 0);
  assert.equal(new Set(SLASH_COMMAND_MANIFEST.map((entry) => entry.command)).size, SLASH_COMMAND_MANIFEST.length);
  for (const entry of SLASH_COMMAND_MANIFEST) {
    assert.match(entry.command, /^[a-z][a-z0-9_]*$/);
    assert.ok(entry.default.trim(), `/${entry.command} needs a Chinese description`);
    assert.ok(entry.en_us.trim(), `/${entry.command} needs an English description`);
    assert.doesNotMatch(entry.en_us, /\p{Script=Han}/u);
  }
});

test('Feishu panel covers supported shared primary commands and its repair command', () => {
  const byName = new Map(SLASH_COMMAND_MANIFEST.map((entry) => [entry.command, entry]));
  // Feishu uses the shared history, workspace, model, preset, control and batch handlers.
  for (const entry of SHARED_COMMAND_CATALOG.filter((item) => item.enabled !== false && item.menuVisible !== false)) {
    assert.ok(byName.has(entry.name), `Supported /${entry.name} is missing from the Feishu panel`);
  }
  for (const name of ['history', 'batch', 'send', 'cancel', 'repair']) {
    assert.match(byName.get(name)?.default ?? '', /仅私聊/);
    assert.match(byName.get(name)?.en_us ?? '', /private chats only/);
  }
});

test('default registration adds missing commands to an old panel and preserves existing items on restart', async () => {
  const originalCommands = [
    'menu', 'new', 'help', 'status', 'compact', 'sessionlist', 'workspacelist',
    'workspaces', 'wsl', 'ws', 'watch', 'unwatch', 'watchlist', 'archived',
  ];
  const initialItems = [...originalCommands, 'external_command'].map((command) => ({
    command, command_id: `existing-${command}`, description: { default_value: `Original ${command}` },
  }));
  const remoteItems = new Map(initialItems.map((entry) => [entry.command, structuredClone(entry)]));
  const { http, requests } = fakeHttpInstance({
    [AUTH_KEY]: () => ({ code: 0, tenant_access_token: 'tenant-token' }),
    [LIST_KEY]: () => ({ code: 0, data: { items: [...remoteItems.values()] } }),
    'POST application/v7/app_slash_commands': ({ data }) => {
      assert.equal(remoteItems.has(data.command), false, `Duplicate creation of /${data.command}`);
      const entry = { ...structuredClone(data), command_id: `created-${data.command}` };
      remoteItems.set(data.command, entry);
      return { code: 0, data: { command_id: entry.command_id } };
    },
  });
  const options = { appId: 'a', appSecret: 's', httpInstance: http };
  const first = await registerSlashCommands(options);
  assert.deepEqual(first.failed, []);
  assert.equal(first.created.length, 17);
  assert.equal(SLASH_COMMAND_MANIFEST.length, 31);
  assert.equal(remoteItems.size, 32);
  assert.deepEqual(SLASH_COMMAND_MANIFEST.slice(0, originalCommands.length).map((entry) => entry.command), originalCommands);
  for (const { command } of SLASH_COMMAND_MANIFEST) assert.ok(remoteItems.has(command));
  for (const entry of initialItems) assert.deepEqual(remoteItems.get(entry.command), entry);

  const creationCount = () => requests.filter((request) => request.method === 'POST'
    && request.url.endsWith('/app_slash_commands')).length;
  assert.equal(creationCount(), 17);
  const second = await registerSlashCommands(options);
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.created, []);
  assert.equal(creationCount(), 17);
  assert.equal(second.existing.length, 32);
  for (const entry of initialItems) assert.deepEqual(remoteItems.get(entry.command), entry);
  assert.ok(requests.every((request) => ['GET', 'POST'].includes(request.method)));
});

test('listSlashCommands returns the registered command items', async () => {
  const { http, requests } = fakeHttpInstance({
    [AUTH_KEY]: () => ({ code: 0, tenant_access_token: 'tenant-token' }),
    [LIST_KEY]: () => ({ code: 0, data: { items: [{ command: 'menu', command_id: '1' }] } }),
  });
  const items = await listSlashCommands({ appId: 'a', appSecret: 's', httpInstance: http });
  assert.deepEqual(items, [{ command: 'menu', command_id: '1' }]);
  assert.equal(requests[1].headers.authorization, 'Bearer tenant-token');
});

test('registerSlashCommands creates missing and skips existing commands', async () => {
  const createdBodies = [];
  const { http, requests } = fakeHttpInstance({
    [AUTH_KEY]: () => ({ code: 0, tenant_access_token: 'tenant-token' }),
    [LIST_KEY]: () => ({ code: 0, data: { items: [{ command: 'menu' }, { command: 'help' }] } }),
    'POST application/v7/app_slash_commands': (options) => {
      createdBodies.push(options.data);
      return { code: 0, data: { command_id: `id-${options.data.command}` } };
    },
  });

  const manifest = [
    { command: 'menu', default: '打开菜单', en_us: 'Open menu' },
    { command: 'status', icon: 'ai-functions_outlined', default: '状态', en_us: 'Status' },
    { command: 'watch', icon: 'flag_outlined', default: '关注', en_us: 'Watch' },
  ];
  const result = await registerSlashCommands({
    appId: 'a', appSecret: 's', httpInstance: http, manifest,
  });

  // menu exists -> skipped; status & watch created
  assert.equal(result.created.length, 2);
  assert.ok(result.created.some((c) => c.command === 'status'));
  assert.ok(result.created.some((c) => c.command === 'watch'));
  assert.ok(result.existing.includes('menu'));
  assert.ok(result.existing.includes('help'));
  assert.equal(result.failed.length, 0);
  assert.equal(createdBodies.length, 2);
  assert.equal(requests.filter((request) => request.url.includes('/tenant_access_token/')).length, 1);
  assert.deepEqual(createdBodies.map((body) => body.description.icon.icon_key), [
    'ai-functions_outlined',
    'flag_outlined',
  ]);
  for (const body of createdBodies) {
    assert.equal(body.command.startsWith('/'), false);
    assert.ok(body.description.default_value);
    assert.ok(body.description.i18n.zh_cn);
    assert.ok(body.description.icon.icon_key);
  }
});

test('registerSlashCommands aborts batch on missing permission', async () => {
  const { http, requests } = fakeHttpInstance({
    [AUTH_KEY]: () => ({ code: 0, tenant_access_token: 'tenant-token' }),
    [LIST_KEY]: () => ({ code: 0, data: { items: [] } }),
    'POST application/v7/app_slash_commands': () => {
      const error = new Error('Request failed with status code 400');
      error.response = {
        data: {
          code: 99991672,
          msg: 'Access denied. One of the following scopes is required: [application:app_slash_command:write]',
        },
      };
      throw error;
    },
  });
  const manifest = [
    { command: 'menu', default: 'x', en_us: 'x' },
    { command: 'status', default: 'x', en_us: 'x' },
  ];
  const result = await registerSlashCommands({
    appId: 'a', appSecret: 's', httpInstance: http, manifest,
  });
  assert.equal(result.created.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error.code, '99991672');
  assert.equal(
    requests.filter((request) => request.url.endsWith('/app_slash_commands')
      && request.method === 'POST').length,
    1,
  );
});

test('registerSlashCommands treats duplicate-create as already-existing', async () => {
  const { http } = fakeHttpInstance({
    [AUTH_KEY]: () => ({ code: 0, tenant_access_token: 'tenant-token' }),
    [LIST_KEY]: () => ({ code: 0, data: { items: [] } }),
    'POST application/v7/app_slash_commands': () => ({ code: 40000000, msg: 'command already exists' }),
  });
  const result = await registerSlashCommands({
    appId: 'a', appSecret: 's', httpInstance: http,
    manifest: [{ command: 'menu', default: 'x', en_us: 'x' }],
  });
  assert.equal(result.created.length, 0);
  assert.equal(result.failed.length, 0);
});
