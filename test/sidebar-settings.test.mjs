import { AirumoConfigStore, deriveAirumoBotIdentity } from '../src/channels/airumo/config-store.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSidebarSettingsRpcHandler, hasConfiguredChannel, installSidebarSettingsRpc, SidebarSettingsStore } from '../plugin-src/host/sidebar-settings.mjs';
import { QqConfigStore, deriveQqBotIdentity } from '../src/channels/qq/config-store.mjs';
import { WeixinConfigStore, deriveWeixinBotIdentity } from '../src/channels/weixin/config-store.mjs';
import { OfficeConfigStore } from '../src/channels/office/config-store.mjs';
import { installInboundTtlRpc } from '../plugin-src/host/inbound-ttl-rpc.mjs';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('auto follows saved channels across additions, removals and restart; forced modes persist', async (t) => {
  const dshHome = await home(t);
  const config = { dshHome };
  const call = createSidebarSettingsRpcHandler({ config });
  const get = () => call('settings.sidebar-entry.get', {});
  assert.deepEqual(await get(), { ok: true, value: { mode: 'auto', visible: true } });
  const wx = await new WeixinConfigStore(join(dshHome, 'integrations/dsh-weixin/config.json')).load();
  const wxId = deriveWeixinBotIdentity('account@im.bot');
  await wx.save({ ...wxId, accountId: 'account@im.bot', ownerUserId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' });
  assert.deepEqual((await get()).value, { mode: 'auto', visible: false });
  const qq = await new QqConfigStore(join(dshHome, 'integrations/dsh-qq/config.json')).load();
  const qqId = deriveQqBotIdentity('102345678');
  await qq.save({ ...qqId, appId: '102345678', ownerUserOpenid: 'owner' });
  await wx.remove(wxId.botId);
  assert.equal((await get()).value.visible, false);
  const set = (mode) => call('settings.sidebar-entry.set', { mode });
  assert.deepEqual((await set('show')).value, { mode: 'show', visible: true });
  assert.deepEqual((await createSidebarSettingsRpcHandler({ config })('settings.sidebar-entry.get', {})).value,
    { mode: 'show', visible: true });
  await qq.remove(qqId.botId);
  assert.deepEqual((await set('hide')).value, { mode: 'hide', visible: false });
  assert.deepEqual((await set('auto')).value, { mode: 'auto', visible: true });
});

test('Office-only setup and custom channel paths count without starting connections', async (t) => {
  const dshHome = await home(t);
  const officePath = join(dshHome, 'custom', 'office.json');
  const office = await new OfficeConfigStore(officePath).load();
  await office.save({ baseUrl: 'https://office.example.com', deviceId: 'test-device',
    deviceTokenRef: 'DSH_OFFICE_DEVICE_TOKEN_1234567890ABCDEF12345678' });
  assert.equal(await hasConfiguredChannel({ dshHome }), false);
  assert.equal(await hasConfiguredChannel({ dshHome, office: { configPath: officePath } }), true);
  await office.clear();
  const qq = await new QqConfigStore(join(dshHome, 'custom', 'config.json')).load();
  await qq.save({ ...deriveQqBotIdentity('102345678'), appId: '102345678', ownerUserOpenid: 'owner' });
  assert.equal(await hasConfiguredChannel({ dshHome, qq: { dataDir: join(dshHome, 'custom') } }), true);
});

test('bad configuration is not an empty channel list; forced modes remain usable', async (t) => {
  const dshHome = await home(t);
  await mkdir(join(dshHome, 'integrations/dsh-qq'), { recursive: true });
  await writeFile(join(dshHome, 'integrations/dsh-qq/config.json'), '{broken');
  const call = createSidebarSettingsRpcHandler({ config: { dshHome } });
  assert.equal((await call('settings.sidebar-entry.get', {})).ok, false);
  assert.deepEqual((await call('settings.sidebar-entry.set', { mode: 'show' })).value, { mode: 'show', visible: true });
  assert.deepEqual((await call('settings.sidebar-entry.set', { mode: 'hide' })).value, { mode: 'hide', visible: false });
  assert.equal((await call('settings.sidebar-entry.set', { mode: 'auto' })).ok, false);
  assert.equal((await call('settings.sidebar-entry.get', {})).value.mode, 'hide', 'failed save retains prior preference');
});

test('invalid and cancelled RPC requests never write; store serializes writes', async (t) => {
  const root = await home(t);
  const path = join(root, 'sidebar.json');
  const store = new SidebarSettingsStore(path);
  const call = createSidebarSettingsRpcHandler({ store, configured: async () => false });
  for (const payload of [null, [], {}, { mode: true }, { mode: 'invalid' }, { mode: 'show', extra: true }]) {
    assert.equal((await call('settings.sidebar-entry.set', payload)).error.code, 'bad-request');
  }
  assert.equal((await call('settings.sidebar-entry.get', { extra: true })).ok, false);
  const signal = AbortSignal.abort();
  assert.equal((await call('settings.sidebar-entry.set', { mode: 'hide' }, signal)).error.code, 'cancelled');
  assert.equal(await store.get(), 'auto');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await Promise.all(['show', 'hide', 'auto'].map((mode) => store.set(mode)));
  assert.equal(await new SidebarSettingsStore(path).get(), 'auto');
  await writeFile(path, '{broken');
  assert.equal((await call('settings.sidebar-entry.get', {})).ok, false);
  assert.equal((await call('settings.sidebar-entry.set', { mode: 'show' })).ok, true);
});

test('sidebar RPC follows channel authority while general settings remain loopback-only', async (t) => {
  for (const rpcAuthority of [undefined, 'trusted-host', 'loopback']) {
    await t.test(rpcAuthority ?? 'default', async (t) => {
      const dshHome = await home(t);
      const config = { dshHome, rpcAuthority };
      const routes = new Map();
      const ctx = { connection: { fetch: { register(options) {
        routes.set(options.path, options); return () => {};
      } } } };
      installSidebarSettingsRpc(ctx, { config });
      installInboundTtlRpc(ctx, { config, runtime: {
        store: { getTtlHours() { return 24; }, setTtlHours() {} }, service: { sweepNow() {} },
      }, groupHistory: {} });
      const request = (host, channel, method, payload = {}) => {
        const path = `/api/dsh-im/${channel}`;
        return routes.get(path).fetch(new Request(`http://${host}${path}`, {
          method: 'POST', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId: 'sidebar', method: `dsh-im/${channel}`, payload: { method, payload },
          }),
        }));
      };
      for (const host of ['localhost', '192.168.1.1:3080', 'dsh.example.com']) {
        const response = await request(host, 'dsh-im-sidebar', 'settings.sidebar-entry.get');
        if (rpcAuthority === 'loopback' && host !== 'localhost') {
          assert.equal(response.status, 403);
          assert.equal((await request(host, 'dsh-im-sidebar', 'settings.sidebar-entry.set', { mode: 'show' })).status, 403);
          continue;
        }
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).result, { ok: true, value: { mode: 'auto', visible: true } });
        for (const mode of ['hide', 'show', 'auto']) {
          const saved = await request(host, 'dsh-im-sidebar', 'settings.sidebar-entry.set', { mode });
          assert.deepEqual((await saved.json()).result, { ok: true, value: { mode, visible: mode !== 'hide' } });
        }
      }
      for (const host of ['192.168.1.1:3080', 'dsh.example.com']) {
        assert.equal((await request(host, 'dsh-im-settings', 'settings.inbound-ttl.get')).status, 403);
        assert.equal((await request(host, 'dsh-im-settings', 'settings.inbound-ttl.set', { ttlHours: 0 })).status, 403);
      }
      const ttl = await request('localhost', 'dsh-im-settings', 'settings.inbound-ttl.get');
      assert.equal((await ttl.json()).result.value.ttlHours, 24);
      const misplacedTtl = await request('localhost', 'dsh-im-sidebar', 'settings.inbound-ttl.set', { ttlHours: 0 });
      assert.equal((await misplacedTtl.json()).result.error.code, 'bad-request');
    });
  }
});

test('AIRumo-only binding participates in automatic sidebar visibility without opening a connection', async (t) => {
  const dshHome = await home(t);
  const store = await new AirumoConfigStore(join(dshHome, 'integrations/dsh-airumo/config.json')).load();
  const identity = deriveAirumoBotIdentity('fixture-bot');
  await store.save({ ...identity, platformId: 'fixture-bot', name: 'Fixture Bot' });
  assert.equal(await hasConfiguredChannel({ dshHome }), true);
  await store.remove(identity.botId);
  assert.equal(await hasConfiguredChannel({ dshHome }), false);
});
