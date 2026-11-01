import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HOST_CHANNELS, deliveryKeyOf } from '../plugin-src/host/channel-registry.mjs';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostDirectory = resolve(repoRoot, 'plugin-src/host');

/** 目录名（kebab）-> 渠道名（注册表的 configKey）：wecom-app -> wecomApp。 */
function configKeyFromDirectory(name) {
  return name.replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase());
}

/** 渠道目录名：kebab 原样；camel 的 configKey 反推回 kebab。 */
function directoryFromEntry(entry) {
  const key = entry.deliveryKey ?? entry.configKey;
  return key.replace(/([A-Z])/gu, (letter) => '-' + letter.toLowerCase());
}

/**
 * feishu -> applyFeishu，wecomApp -> applyWecomApp。
 * 唯一例外是 imessage：历史上就叫 applyIMessage（IMessage 是两个词），
 * 写进特例而不是改公开名 —— internals 覆盖键已被宿主测试与调用方使用。
 */
function expectedApplyName(configKey) {
  if (configKey === 'imessage') return 'applyIMessage';
  return 'apply' + configKey
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// 判据核心：注册表 ↔ 磁盘目录必须一一对应。少一条 = 该渠道永远不会启动；
// 多一条 = import 一个不存在的目录，宿主直接崩。这一条就是「新增渠道只改一处」的牙。
test('every host channel directory has exactly one registry entry', async () => {
  const entries = await readdir(resolve(hostDirectory, 'channels'), { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'shared')
    .map((entry) => entry.name)
    .sort();
  // 注册表用 camel 的 configKey（wecomApp），目录用 kebab（wecom-app）：按目录名比对。
  const registryDirectories = HOST_CHANNELS.map(directoryFromEntry).sort();
  assert.deepEqual(registryDirectories, directories,
    'registry and plugin-src/host/channels/ must list the same channels');
  assert.equal(HOST_CHANNELS.length, directories.length);
});

test('registry keys and apply names are unique and conventional', () => {
  const configKeys = HOST_CHANNELS.map((entry) => entry.configKey);
  const applyNames = HOST_CHANNELS.map((entry) => entry.applyName);
  assert.equal(new Set(configKeys).size, configKeys.length, 'duplicate configKey');
  assert.equal(new Set(applyNames).size, applyNames.length, 'duplicate applyName');
  for (const entry of HOST_CHANNELS) {
    assert.equal(typeof entry.apply, 'function', entry.configKey + ' needs an apply function');
    assert.equal(entry.applyName, expectedApplyName(entry.configKey),
      'applyName must derive from the channel name: ' + entry.configKey);
  }
});

// 每条注册项必须真的指向同渠道目录的 apply，否则「注册了但装错渠道」无人发现。
test('each entry imports apply from its own channel module', async () => {
  for (const entry of HOST_CHANNELS) {
    const directory = directoryFromEntry(entry);
    // repoRoot 是 Windows 盘符路径，不能当 URL base 用，必须先转 file: URL。
    const module = await import(pathToFileURL(
      resolve(hostDirectory, 'channels', directory, 'index.mjs'),
    ).href);
    assert.equal(entry.apply, module.apply,
      entry.configKey + ' must register the apply exported by ' + directory + '/index.mjs');
  }
});

test('only the AI Office connector runs without the shared delivery service', () => {
  const withoutDelivery = HOST_CHANNELS
    .filter((entry) => entry.withoutDeliveryService)
    .map((entry) => entry.configKey);
  assert.deepEqual(withoutDelivery, ['office']);
});

// 投递服务用的是平台真实渠道名（wecom-app），配置用的是 camel（wecomApp）：
// 这层映射以前写在 index.mjs 里的一次字符串三元比较中，现在由注册表声明并被这里钉住。
test('deliveryKey mapping collapses the only camel/kebab divergence', () => {
  const mapped = HOST_CHANNELS
    .filter((entry) => entry.deliveryKey !== undefined && entry.deliveryKey !== entry.configKey)
    .map((entry) => [entry.configKey, entry.deliveryKey]);
  assert.deepEqual(mapped, [['wecomApp', 'wecom-app']]);
  assert.equal(deliveryKeyOf({ configKey: 'telegram' }), 'telegram');
});

// 行为面：宿主必须按注册表顺序启动全部渠道，并把 deliveryService 给非 office 渠道。
test('the host activates channels in registry order', async () => {
  const calls = [];
  const internals = Object.fromEntries(HOST_CHANNELS.map((entry) => [
    entry.applyName,
    async (_ctx, config) => {
      calls.push([entry.configKey, config.deliveryService !== undefined]);
    },
  ]));
  const plugin = createImHostPlugin({
    ...internals,
    createDeliveryService: () => ({ marker: 'delivery' }),
    installUpdateRpc: () => {}, installInboundTtlRpc: () => {},
    installDeliveryRpc: () => {}, installDeliveryHttp: () => {},
    installSessionSyncCoordinator: () => {}, installHostLanguage: () => undefined,
  });
  await plugin.apply({ connection: {} }, {});
  assert.deepEqual(calls.map(([channel]) => channel), HOST_CHANNELS.map((entry) => entry.configKey));
  assert.deepEqual(
    calls.filter(([channel]) => channel === 'office').map(([, withDelivery]) => withDelivery),
    [false],
  );
  assert.equal(calls.filter(([, withDelivery]) => withDelivery === true).length, 13);
});

// harnessBaseUrl 声明「该渠道自己连宿主」，投递服务必须收到 kebab 的投递名。
test('unavailable session-sync channels are reported by delivery key', async () => {
  let seen = null;
  const internals = Object.fromEntries(HOST_CHANNELS.map((entry) => [entry.applyName, async () => {}]));
  const plugin = createImHostPlugin({
    ...internals,
    createDeliveryService: ({ unavailableSessionSyncChannels }) => {
      seen = unavailableSessionSyncChannels;
      return {};
    },
    installUpdateRpc: () => {}, installInboundTtlRpc: () => {},
    installDeliveryRpc: () => {}, installDeliveryHttp: () => {},
    installSessionSyncCoordinator: () => {}, installHostLanguage: () => undefined,
  });
  await plugin.apply({ connection: {} }, {
    wecomApp: { harnessBaseUrl: 'http://127.0.0.1:1' },
    office: { harnessBaseUrl: 'http://127.0.0.1:1' },
    feishu: { harnessBaseUrl: 'http://127.0.0.1:1' },
  });
  assert.deepEqual(seen, ['feishu', 'wecom-app'], 'office is never a sync channel: ' + seen);
});

// 负向对照：index.mjs 里不许再出现渠道名硬编码清单（改造前的形态）。
// 有人把渠道写回 index.mjs 时，注册表与装配会分叉，这条必须红。
test('index.mjs keeps no channel list of its own', async () => {
  const source = await readFile(resolve(hostDirectory, 'index.mjs'), 'utf8');
  assert.equal(
    /from '\.\/channels\/[a-z-]+\/index\.mjs'/u.test(source),
    false,
    'channel activation must be imported only through the registry',
  );
  assert.match(source, /channel-registry\.mjs/u);
});
