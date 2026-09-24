import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WeixinConfigStore, deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { BotWorkspaceStore } from '../../../src/channels/shared/bot-workspace-store.mjs';
import { withConfigResource } from '../../../src/channels/shared/config-read-error.mjs';
import { createWeixinDiagnostics } from '../../../src/channels/weixin/connection-error.mjs';
import { normalizeWeixinDiagnosticDetails } from '../../../src/channels/weixin/diagnostic-details.mjs';
import { publicChannelStartupError } from '../../../plugin-src/host/channels/shared/startup-error.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';

const privateValue = 'private-data-must-not-appear';
const account = {
  ...deriveWeixinBotIdentity(privateValue), accountId: privateValue, ownerUserId: privateValue,
  baseUrl: 'https://ilinkai.weixin.qq.com/',
};
const config = accounts => ({ version: 1, accounts });
const workspace = extra => ({ version: 1, workspaces: {}, ...extra });

const cases = [
  ['config', '{"secret":"' + privateValue + '"', undefined, undefined],
  ['config', [], '$', 'expected-object'],
  ['config', {}, 'version', 'unsupported-version'],
  ['config', { version: 1, accounts: {} }, 'accounts', 'expected-array'],
  ['config', config([null]), 'accounts[0]', 'expected-object'],
  ['config', config([{ ...account, accountId: '' }]), 'accounts[0].accountId', 'invalid-string'],
  ['config', config([{ ...account, ownerUserId: null }]), 'accounts[0].ownerUserId', 'invalid-string'],
  ['config', config([{ ...account, botId: privateValue }]), 'accounts[0].botId', 'invalid-identifier'],
  ['config', config([{ ...account, tokenRef: privateValue }]), 'accounts[0].tokenRef', 'invalid-identifier'],
  ['config', config([{ ...account, botId: 'wx_000000000000000000000000' }]), 'accounts[0].botId', 'identity-mismatch'],
  ['config', config([{ ...account, tokenRef: 'DSH_WEIXIN_BOT_TOKEN_000000000000000000000000' }]), 'accounts[0].tokenRef', 'identity-mismatch'],
  ['config', config([account, account]), 'accounts[1].botId', 'duplicate-identity'],
  ['config', config([{ ...account, baseUrl: privateValue }]), 'accounts[0].baseUrl', 'invalid-api-url'],
  ['config', config([{ ...account, baseUrl: `https://${privateValue}.example/` }]), 'accounts[0].baseUrl', 'untrusted-api-url'],
  ['workspaces', '{"secret":"' + privateValue + '"', undefined, undefined],
  ['workspaces', null, '$', 'expected-object'],
  ['workspaces', workspace({ version: 999 }), 'version', 'unsupported-version'],
  ['workspaces', workspace({ workspaces: [] }), 'workspaces', 'expected-object'],
  ['workspaces', workspace({ workspaces: { [`${privateValue}/invalid`]: '/valid' } }), 'workspaces[0].key', 'invalid-identifier'],
  ['workspaces', workspace({ workspaces: { [account.botId]: privateValue } }), 'workspaces[0].value', 'invalid-workspace-path'],
  ['workspaces', workspace({ agentPresets: [] }), 'agentPresets', 'expected-object'],
  ['workspaces', workspace({ agentPresets: { [account.botId]: 'invalid preset' } }), 'agentPresets[0].value', 'invalid-agent-preset'],
  ['workspaces', workspace({ models: [] }), 'models', 'expected-object'],
  ['workspaces', workspace({ models: { [account.botId]: { provider: privateValue } } }), 'models[0].value', 'invalid-model-selection'],
  ['workspaces', workspace({ deliveryTargets: {} }), 'deliveryTargets', 'unexpected-field'],
  ['workspaces', workspace({ version: 2, deliveryTargets: [] }), 'deliveryTargets', 'expected-object'],
  ['workspaces', workspace({ version: 2, deliveryTargets: { [account.botId]: { [privateValue]: {} } } }), 'deliveryTargets[0].targets[0]', 'invalid-delivery-target'],
];

test('startup config diagnostics identify files and fields without revealing file contents or keys', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-config-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, [kind, value, field, issue]] of cases.entries()) {
    const file = kind === 'config' ? 'config.json' : 'workspaces.json';
    const resource = kind === 'config' ? 'account-config' : 'workspace-config';
    const Store = kind === 'config' ? WeixinConfigStore : BotWorkspaceStore;
    const path = join(root, `${index}.json`);
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(path, raw);
    const logs = [];
    const diagnostics = createWeixinDiagnostics({ logger: { error: entry => logs.push(entry) } });
    let result;
    await assert.rejects(new Store(path).load(), error => {
      result = diagnostics.report(error, {
        operation: 'startup', stage: 'startup.load', code: publicChannelStartupError('weixin', error).code,
      }).publicError;
      return true;
    }, `case ${index}`);
    assert.equal(result.code, 'weixin-startup-config-invalid');
    assert.equal(result.details.file, file);
    assert.equal(result.details.resource, resource);
    assert.equal(result.details.reason, issue ? 'invalid-config' : 'invalid-json');
    assert.equal(result.details.field, field);
    assert.equal(result.details.issue, issue);
    assert.ok(result.message.includes(file));
    assert.match(result.details.hint, /重启 DSH/);
    assert.equal(await readFile(path, 'utf8'), raw);
    const record = JSON.parse(logs[0].slice('[dsh-weixin] '.length));
    for (const key of ['file', 'resource', 'reason', 'field', 'issue', 'referenceId']) {
      assert.equal(record[key], result.details[key]);
    }
    const serialized = JSON.stringify([result, logs]);
    for (const secret of [privateValue, account.botId, account.tokenRef, root]) {
      assert.ok(!serialized.includes(secret), `case ${index} leaked private data`);
    }
  }
});

test('file access failures retain the resource and errno, and missing files remain allowed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-config-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [Store, resource, file] of [
    [WeixinConfigStore, 'account-config', 'config.json'], [BotWorkspaceStore, 'workspace-config', 'workspaces.json'],
  ]) {
    await new Store(join(root, 'missing.json')).load();
    await assert.rejects(new Store(root).load(), error => {
      const result = createWeixinDiagnostics({ logger: {} }).report(error, {
        operation: 'startup', stage: 'startup.load', code: publicChannelStartupError('weixin', error).code,
      }).publicError;
      assert.equal(result.details.file, file);
      assert.equal(result.details.resource, resource);
      assert.equal(result.details.reason, 'EISDIR');
      return true;
    });
    const permission = withConfigResource(Object.assign(new Error(privateValue), { code: 'EACCES' }), resource);
    const result = createWeixinDiagnostics({ logger: {} }).report(permission, {
      operation: 'startup', stage: 'startup.load', code: publicChannelStartupError('weixin', permission).code,
    }).publicError;
    assert.equal(result.code, 'weixin-startup-permission-denied');
    assert.equal(result.details.reason, 'EACCES');
    assert.equal(result.details.file, file);
    assert.ok(!JSON.stringify(result).includes(privateValue));
  }
});

test('new diagnostic fields reject arbitrary filenames, map keys and issue descriptions', () => {
  for (const field of [privateValue, `accounts[${privateValue}]`, `models.${privateValue}`, 'accounts[0].bot_token']) {
    const normalized = normalizeWeixinDiagnosticDetails({ file: `/private/${privateValue}/config.json`, field, issue: privateValue });
    assert.deepEqual(normalized, {});
  }
  for (const issue of [null, [], ['expected-object'], {}, { toString: privateValue }]) {
    assert.deepEqual(normalizeWeixinDiagnosticDetails({ issue }), {});
  }
  const error = Object.assign(new Error(privateValue), { field: 'version', issue: 'unsupported-version', resource: 'account-config' });
  const result = createWeixinDiagnostics({ logger: {} }).report(error).publicError;
  assert.equal(result.details.field, undefined);
  assert.equal(result.details.file, undefined);
});

test('startup file guidance is translated in English', async t => {
  setImHostLanguage('en');
  t.after(() => setImHostLanguage('zh'));
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-config-english-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workspaces.json');
  await writeFile(path, JSON.stringify(workspace({ workspaces: { [account.botId]: privateValue } })));
  await assert.rejects(new BotWorkspaceStore(path).load(), error => {
    const result = createWeixinDiagnostics({ logger: {} }).report(error, {
      operation: 'startup', stage: 'startup.load', code: publicChannelStartupError('weixin', error).code,
    }).publicError;
    assert.match(result.message, /workspaces\.json/);
    assert.match(result.details.hint, /absolute on the current operating system/);
    assert.match(result.details.hint, /restart DSH/);
    assert.doesNotMatch(JSON.stringify(result), /[\p{Script=Han}]/u);
    return true;
  });
});
