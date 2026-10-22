import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TELEGRAM_COMMAND_MENU_SCOPES } from '../src/channels/telegram/telegram-runtime.mjs';
import {
  DEFAULT_COMMAND_SCOPE,
  GROUP_COMMAND_SCOPE,
  PRIVATE_COMMAND_SCOPE,
  VERIFY_COMMAND_SCOPES,
  commandPayloadFor,
  restoreScopedMenus,
  saveScopedMenus,
} from '../scripts/telegram-menu-scopes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const verifyScript = join(here, '..', 'scripts', 'verify-interface-language.mjs');

function recordingTelegram(replies = {}) {
  const calls = [];
  return {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      return replies[method] ?? [];
    },
  };
}

test('the acceptance script plans all three command scopes in registration order', () => {
  assert.deepEqual(VERIFY_COMMAND_SCOPES.map(({ name }) => name), ['default', 'private', 'group']);
  assert.equal(VERIFY_COMMAND_SCOPES[0].scope, DEFAULT_COMMAND_SCOPE);
  assert.equal(VERIFY_COMMAND_SCOPES[1].scope, TELEGRAM_COMMAND_MENU_SCOPES.private);
  assert.equal(VERIFY_COMMAND_SCOPES[2].scope, TELEGRAM_COMMAND_MENU_SCOPES.group);
  assert.equal(PRIVATE_COMMAND_SCOPE, TELEGRAM_COMMAND_MENU_SCOPES.private);
  assert.equal(GROUP_COMMAND_SCOPE, TELEGRAM_COMMAND_MENU_SCOPES.group);
  assert.deepEqual(commandPayloadFor(PRIVATE_COMMAND_SCOPE), { scope: { type: 'all_private_chats' } });
  assert.deepEqual(commandPayloadFor(DEFAULT_COMMAND_SCOPE), {});
});

test('saving the original menu reads every scope, not just the default one', async () => {
  const telegram = recordingTelegram();
  const saved = await saveScopedMenus(telegram.call);
  assert.deepEqual(telegram.calls, [
    { method: 'getMyCommands', payload: {} },
    { method: 'getMyCommands', payload: { scope: { type: 'all_private_chats' } } },
    { method: 'getMyCommands', payload: { scope: { type: 'all_group_chats' } } },
  ]);
  assert.deepEqual([...saved.keys()], ['default', 'private', 'group']);
});

test('restoring the original menu covers every scope and clears the default scope last', async () => {
  const telegram = recordingTelegram();
  const saved = new Map([
    ['default', []],
    ['private', [{ command: 'help', description: '帮助' }]],
    ['group', []],
  ]);
  await restoreScopedMenus(telegram.call, saved);
  assert.deepEqual(telegram.calls, [
    { method: 'deleteMyCommands', payload: { scope: { type: 'all_group_chats' } } },
    {
      method: 'setMyCommands',
      payload: {
        commands: [{ command: 'help', description: '帮助' }],
        scope: { type: 'all_private_chats' },
      },
    },
    { method: 'deleteMyCommands', payload: {} },
  ], 'scoped scopes first, default scope last');
});

test('the live script no longer polls or restores only the default scope', async () => {
  const source = await readFile(verifyScript, 'utf8');
  assert.match(source, /saveScopedMenus\(telegram\)/, 'the original menu must be saved per scope');
  assert.match(source, /restoreScopedMenus\(telegram, savedMenus\)/, 'the restore must cover every scope');
  assert.match(source, /scope: PRIVATE_COMMAND_SCOPE/, 'the live wait must read the private-chat scope');
  assert.match(source, /scope: GROUP_COMMAND_SCOPE/, 'the live check must read the group scope');
  // The only allowed unscoped read is the explicit "legacy default scope is
  // empty" assertion; the live menu waits must poll the private chat scope.
  const unscopedReads = source.match(/telegram\('getMyCommands'\)/g) ?? [];
  assert.equal(unscopedReads.length, 1, 'exactly one unscoped read, for the cleared default scope');
  assert.match(source, /telegram\('getMyCommands', \{ scope: PRIVATE_COMMAND_SCOPE \}\)/);
  assert.doesNotMatch(source, /telegram\('setMyCommands', \{ commands: telegramMenu \}\)/, 'no default-only restore');
});

test('the offline scope self-check runs without a Harness checkout or token', () => {
  const env = { ...process.env };
  delete env.DSH_IM_TELEGRAM_TOKEN;
  const output = execFileSync(process.execPath, [verifyScript, '--check-scopes'], {
    encoding: 'utf8',
    env,
  });
  for (const scope of ['default', 'private', 'group', 'all_private_chats', 'all_group_chats']) {
    assert.match(output, new RegExp(scope), scope);
  }
  assert.match(output, /Offline self-check passed/);
});
