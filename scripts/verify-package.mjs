import { access, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

async function readSourceTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readSourceTree(path));
    } else if (entry.isFile() && /\.m?js$/u.test(entry.name)) {
      chunks.push(await readFile(path, 'utf8'));
    }
  }
  return chunks.join('\n');
}

const required = [
  'lib/index.js',
  'lib/client.js',
  'bin/dsh-im.mjs',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'PROACTIVE_DELIVERY.md',
  'PROACTIVE_DELIVERY.en.md',
  'THIRD_PARTY_NOTICES.md',
  'plugin-src/client/channels/dingtalk/index.js',
  'plugin-src/client/channels/slack/index.js',
  'plugin-src/client/i18n.js',
  'plugin-src/client/update-panel.js',
  'plugin-src/client/context-enhancement.js',
  'plugin-src/host/update-service.mjs',
  'plugin-src/host/update-runtime.mjs',
  'plugin-src/host/update-rpc.mjs',
  'plugin-src/host/channels/feishu/index.mjs',
  'plugin-src/host/channels/weixin/index.mjs',
  'plugin-src/host/channels/dingtalk/index.mjs',
  'plugin-src/host/channels/qq/index.mjs',
  'plugin-src/host/channels/slack/index.mjs',
  'plugin-src/host/channels/wecom/index.mjs',
  'plugin-src/host/channels/telegram/index.mjs',
  'plugin-src/host/channels/discord/index.mjs',
  'plugin-src/host/channels/whatsapp/index.mjs',
  'src/channels/feishu/feishu-runtime.mjs',
  'src/channels/weixin/weixin-runtime.mjs',
  'src/channels/dingtalk/dingtalk-runtime.mjs',
  'src/channels/qq/qq-runtime.mjs',
  'src/channels/slack/slack-runtime.mjs',
  'src/channels/wecom/wecom-runtime.mjs',
  'src/channels/telegram/telegram-runtime.mjs',
  'src/channels/telegram/telegram-http.mjs',
  'src/channels/discord/discord-runtime.mjs',
  'src/channels/whatsapp/whatsapp-runtime.mjs',
  'src/channels/whatsapp/whatsapp-web-session.mjs',
  'src/channels/shared/context-enhancement.mjs',
];
await Promise.all(required.map((path) => access(resolve(root, path))));

const [
  client,
  host,
  patch,
  manifestText,
  lockText,
  hostSource,
  clientEntrySource,
  clientSources,
  executable,
] = await Promise.all([
  readFile(resolve(root, 'lib/client.js'), 'utf8'),
  readFile(resolve(root, 'lib/index.js'), 'utf8'),
  readFile(resolve(root, 'cordis.patch.yml'), 'utf8'),
  readFile(resolve(root, 'package.json'), 'utf8'),
  readFile(resolve(root, 'package-lock.json'), 'utf8'),
  readFile(resolve(root, 'plugin-src/host/index.mjs'), 'utf8'),
  readFile(resolve(root, 'plugin-src/client/index.js'), 'utf8'),
  readSourceTree(resolve(root, 'plugin-src/client')),
  stat(resolve(root, 'bin/dsh-im.mjs')),
]);
const manifest = JSON.parse(manifestText);
const lock = JSON.parse(lockText);

// DSH runtime packages use module-local Symbol keys, so a second physical copy breaks Host lookup.
const forbiddenDshDependency = /^@deepseek-ai\/dsh-/;
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
for (const section of dependencySections) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (forbiddenDshDependency.test(name)) {
      throw new Error(
        `${name} must not be declared in ${section}; DSH runtime packages must come from the host`,
      );
    }
  }
}
const bundledDependencies = manifest.bundleDependencies ?? manifest.bundledDependencies ?? [];
if (Array.isArray(bundledDependencies)) {
  for (const name of bundledDependencies) {
    if (forbiddenDshDependency.test(name)) {
      throw new Error(`${name} must not be bundled; DSH runtime packages must come from the host`);
    }
  }
}
const forbiddenDshLockPaths = Object.keys(lock.packages ?? {}).filter((path) => (
  /(?:^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+(?:\/|$)/.test(path)
));
if (forbiddenDshLockPaths.length > 0) {
  throw new Error(
    `package lock must not install DSH runtime packages: ${forbiddenDshLockPaths.join(', ')}`,
  );
}

if (!/\bid\s*:\s*["']@xmanrui\/dsh-im["']/u.test(client)) {
  throw new Error('client bundle does not register the dsh-im loader id');
}
const sourceSectionMarkers = [
  /ctx\.slots\.inject\(\s*["']settings\.section["']/u,
  /name\s*:\s*["']settings\.section["']/u,
  /id\s*:\s*["']xmanrui-dsh-im["']/u,
  /order\s*:\s*21\b/u,
  /label\s*:\s*\(\)\s*=>\s*t\(\s*["']IM机器人["']\s*\)/u,
  /locale\s*:\s*IM_LOCALE_NAMESPACE\b/u,
];
const bundleSectionPattern = /name\s*:\s*["']settings\.section["']\s*,\s*id\s*:\s*["']xmanrui-dsh-im["']\s*,\s*order\s*:\s*21\s*,\s*label\s*:\s*\(\)\s*=>\s*[$A-Z_a-z][$\w]*\(\s*["']IM(?:机器人|\\u673A\\u5668\\u4EBA)["']\s*\)\s*,\s*locale\s*:\s*(?:[$A-Z_a-z][$\w]*|["']dsh-im["'])/u;
if (sourceSectionMarkers.some((pattern) => !pattern.test(clientEntrySource))
  || !/IM_LOCALE_NAMESPACE\s*=\s*["']dsh-im["']/u.test(clientSources)
  || !bundleSectionPattern.test(client)) {
  throw new Error('client bundle does not register the localized top-level IM settings section');
}
if ((client.match(/\.slots\.inject\(\s*["']settings\.section["']/gu) ?? []).length !== 1) {
  throw new Error('client bundle must register exactly one top-level settings section');
}
if (client.includes('settings.plugins.tab') || clientSources.includes('settings.plugins.tab')) {
  throw new Error('client source or bundle still contains the legacy Plugins-tab settings entry');
}
// Connections still have no channel-enable toggle. Checkable inputs are owned
// only by the shared context editor, the saved-target Session sync row, and
// the Telegram thinking-traces block.
// The context editor contains one switch template and one mapped field-input
// template; the delivery target adds one ordinary checkbox template; the
// Telegram thinking-traces block adds one ordinary checkbox template.
const contextEditorSource = await readFile(resolve(root, 'plugin-src/client/context-enhancement.js'), 'utf8');
const deliverySettingsSource = await readFile(resolve(root, 'plugin-src/client/delivery-settings.js'), 'utf8');
const thinkingTracesSource = await readFile(resolve(root, 'plugin-src/client/channels/telegram/thinking-traces.js'), 'utf8');
const otherClientSources = clientSources
  .replace(contextEditorSource, '')
  .replace(deliverySettingsSource, '')
  .replace(thinkingTracesSource, '');
if (/role:\s*["']switch|type:\s*["']checkbox/.test(otherClientSources)
  || (deliverySettingsSource.match(/type:\s*["']checkbox["']/g) ?? []).length !== 1
  || /role:\s*["']switch["']/u.test(deliverySettingsSource)
  || (thinkingTracesSource.match(/type:\s*["']checkbox["']/g) ?? []).length !== 1
  || /role:\s*["']switch["']/u.test(thinkingTracesSource)
  || (client.match(/role:\s*["']switch["']/g) ?? []).length !== 1
  || (client.match(/type:\s*["']checkbox["']/g) ?? []).length !== 4) {
  throw new Error('checkable inputs must be limited to context enhancement, Session sync, and the Telegram thinking-traces toggle');
}
for (const marker of ['bot.context-enhancement.set', '<dsh_im_source>', '<dsh_im_source_guidance>']) {
  if (!host.includes(marker) || !client.includes(marker)) {
    throw new Error(`context-enhancement marker missing from Host or Client bundle: ${marker}`);
  }
}
if (!client.includes('container-type: inline-size')
  || !client.includes('@container (max-width: 680px)')) {
  throw new Error('client bundle does not contain the narrow-panel DingTalk QR layout');
}
for (const marker of ['/feishu', '/weixin', '/dingtalk', '/wecom', '/qq', '/slack', '/telegram', '/discord', '/whatsapp']) {
  if (!host.includes(marker)) {
    throw new Error(`host bundle does not contain the internal ${marker} RPC provider`);
  }
}
for (const marker of ['update.status', 'update.check', 'update.install']) {
  if (!host.includes(marker) || !client.includes(marker)) {
    throw new Error(`update RPC endpoint missing from Host or Client bundle: ${marker}`);
  }
}
if (!host.includes('https://registry.npmjs.org/') || !host.includes('desktopPnpm')) {
  throw new Error('host bundle is missing the npm updater or Desktop package-management adapter');
}
for (const marker of ['/session Session ID', 'bindWorkspaceSession', 'session-subagent-unsupported']) {
  if (!host.includes(marker)) {
    throw new Error(`host bundle does not contain the Session binding marker: ${marker}`);
  }
}
if (/@xmanrui\/dsh-(?:feishu|weixin|dingtalk)/.test(host)) {
  throw new Error('host bundle still imports an external channel plugin');
}
if (/@xmanrui\/dsh-(?:feishu|weixin|dingtalk)/.test(
  manifestText + lockText + hostSource + clientSources,
)) {
  throw new Error('source or package metadata still depends on an external channel plugin');
}
if (!patch.includes("name: '@xmanrui/dsh-im'") || /dsh-(?:feishu|weixin|dingtalk)/.test(patch)) {
  throw new Error('bundle patch must activate only dsh-im');
}
for (const name of ['@xmanrui/dsh-feishu', '@xmanrui/dsh-weixin', '@xmanrui/dsh-dingtalk']) {
  if (manifest.dependencies?.[name]) {
    throw new Error(`${name} must not remain an external dependency`);
  }
}
const directDependencies = {
  'dingtalk-stream': '2.1.4',
  '@tencent-connect/qqbot-connector': '1.2.0',
  '@tencent-connect/qqbot-nodejs': '1.0.4',
  '@wecom/aibot-node-sdk': '1.0.7',
  qrcode: '1.5.4',
  undici: '7.29.0',
};
for (const [name, version] of Object.entries(directDependencies)) {
  if (manifest.dependencies?.[name] !== version) {
    throw new Error(`${name} must be a pinned direct dependency at ${version}`);
  }
}
const bundledBuildDependencies = {
  '@larksuiteoapi/node-sdk': '1.73.0',
  '@whiskeysockets/baileys': '7.0.0-rc14',
  'https-proxy-agent': '5.0.1',
};
for (const [name, version] of Object.entries(bundledBuildDependencies)) {
  if (manifest.dependencies?.[name] !== undefined) {
    throw new Error(`${name} must not remain a runtime dependency`);
  }
  if (manifest.devDependencies?.[name] !== version) {
    throw new Error(`${name} must be a pinned build dependency at ${version}`);
  }
}
if (lock.packages?.['node_modules/protobufjs']?.dev !== true) {
  throw new Error('protobufjs must remain build-only in the package lock');
}
if (manifest.bin?.['dsh-im'] !== 'bin/dsh-im.mjs') {
  throw new Error('package manifest must publish the dsh-im executable');
}
if (/(?:from\s*|import\s*\(|require\s*\()\s*["'](?:@larksuiteoapi\/node-sdk|@whiskeysockets\/baileys|https-proxy-agent|protobufjs)(?:\/[^"']*)?["']/.test(host)) {
  throw new Error('host bundle must not import a bundled SDK, proxy agent, or protobufjs at runtime');
}
if (!/(?:from\s*|import\s*\()\s*["']undici["']/.test(host)) {
  throw new Error('host bundle must retain undici as an external runtime dependency');
}
if ((executable.mode & 0o111) === 0) throw new Error('dsh-im CLI is not executable');
if (/private-bot-token|must-be-rolled-back|DEEPSEEK_API_KEY=/.test(client + host)) {
  throw new Error('built artifacts contain a test or environment secret marker');
}
await import(pathToFileURL(resolve(root, 'lib/index.js')).href);

console.log('Verified dsh-im package artifacts.');
