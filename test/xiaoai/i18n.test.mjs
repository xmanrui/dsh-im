import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { XiaoAIController } from '../../src/channels/xiaoai/controller.mjs';
import { createXiaoAIRpcHandler } from '../../plugin-src/host/channels/xiaoai/rpc.mjs';
import { getImHostLanguage, setImHostLanguage } from '../../src/channels/shared/i18n.mjs';

function controller() {
  return new XiaoAIController({
    stateRoot: tmpdir(),
    configStore: { list: () => [], get: () => null, save() {}, remove() {} },
    credentials: { resolve: async () => null, set: async () => {}, unset: async () => {} },
    createRuntime: async () => { throw new Error('Unexpected runtime start'); },
  });
}

test('localized controlled errors survive the XiaoAI RPC boundary in English and Russian', async t => {
  const previous = getImHostLanguage();
  const instance = controller();
  t.after(async () => { setImHostLanguage(previous); await instance.close(); });
  const rpc = createXiaoAIRpcHandler(instance);
  for (const [language, expected] of [
    ['en', 'Enter the Xiaomi account and password'],
    ['ru', 'Введите аккаунт Xiaomi и пароль'],
  ]) {
    setImHostLanguage(language);
    const login = await rpc('auth.begin', { account: '', password: '' });
    assert.equal(login.ok, false);
    assert.equal(login.error.message, expected);
    const expired = await rpc('devices.bind', {
      authId: '12345678-1234-1234-1234-123456789abc', deviceIds: ['mock-device'], keyword: 'prefix',
    });
    assert.equal(expired.ok, false);
    assert.match(expired.error.message, language === 'en' ? /session has expired/ : /истекла/);
    assert.doesNotMatch(expired.error.message, /[\u3400-\u9fff]/u);
  }
});

test('raw provider failures remain redacted when the XiaoAI Host language is not Chinese', async t => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  const rpc = createXiaoAIRpcHandler({
    status: () => ({ bots: [] }), bindCredentials() {}, reconnectBot() {}, deleteBot() {},
    beginAuth: async () => { throw new Error('serviceToken=private-provider-secret'); },
  });
  for (const language of ['en', 'ru']) {
    setImHostLanguage(language);
    const result = await rpc('auth.begin', { account: 'mock', password: 'mock' });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error.message, /private-provider-secret|serviceToken|[\u3400-\u9fff]/u);
    assert.ok(result.error.message.length > 20);
  }
});
