import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercise the published entry, since source-only tests cannot catch a stale bundle.
import { createImHostPlugin } from '../lib/index.js';

async function startHost(t, language) {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-im-bundled-language-'));
  t.after(() => rm(dshHome, { recursive: true, force: true }));
  const channels = [
    'Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack',
    'Telegram', 'Airumo', 'Discord', 'Whatsapp', 'IMessage', 'Email', 'Matrix', 'Office',
  ];
  const internals = Object.fromEntries(channels.map((channel) => [
    `apply${channel}`, async () => {},
  ]));
  for (const installer of [
    'installUpdateRpc', 'installDeliveryRpc', 'installInboundTtlRpc',
    'installSidebarSettingsRpc', 'installInjectedContext',
  ]) internals[installer] = () => {};
  internals.createDeliveryService = () => ({});
  let controller;
  let languageAtChannelStart;
  internals.installHostLanguageRpc = (_ctx, value) => { controller = value; };
  internals.applyTelegram = async () => { languageAtChannelStart = controller.language(); };
  const errors = [];
  await createImHostPlugin(internals).apply({
    connection: { fetch: {} },
    logger: { error: (...args) => errors.push(args) },
  }, { dshHome, language });
  assert.deepEqual(errors, []);
  assert.ok(controller, 'the published Host installs its language controller');
  return { controller, languageAtChannelStart };
}

test('the published Host selects Russian before starting channels and preserves the operator pin', async (t) => {
  const { controller, languageAtChannelStart } = await startHost(t, 'ru-RU');
  assert.equal(languageAtChannelStart, 'ru');
  assert.deepEqual(controller.snapshot(), {
    language: 'ru', tag: 'ru-RU', source: 'config', pinned: true,
  });
  assert.equal((await controller.mirror('zh')).language, 'ru');
});

test('the published Host defaults to English and follows mirrored Russian and Chinese locales', async (t) => {
  const { controller, languageAtChannelStart } = await startHost(t);
  assert.equal(languageAtChannelStart, 'en');
  for (const [locale, expected] of [['ru', 'ru'], ['zh-CN', 'zh'], ['de', 'en'], [null, 'en']]) {
    assert.equal((await controller.mirror(locale)).language, expected);
    assert.equal(controller.language(), expected);
  }
});
