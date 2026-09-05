import assert from 'node:assert/strict';
import test from 'node:test';
import { createDingtalkApi } from '../../../src/channels/dingtalk/dingtalk-api.mjs';
import {
  dingtalkMenuCommand, dingtalkMenuSnapshot, DINGTALK_MENU_TEMPLATE_ID,
} from '../../../src/channels/dingtalk/dingtalk-menu.mjs';

test('menu maps numeric preset IDs and rejects stale or fabricated selections', async () => {
  const menu = await dingtalkMenuSnapshot({
    currentWorkspace: () => process.cwd(), listWorkspaces: async () => [process.cwd()],
    agentPresetSettings: async () => ({ agentPreset: '123', agentPresetCatalog: {
      items: [{ id: '123', label: 'My preset' }],
    } }),
  }, { sessionFor: () => null }, 'key');
  const callback = (action, params) => ({ content: JSON.stringify({ cardPrivateData: {
    actionIds: [action], params: { revision: menu.data.revision, ...params },
  } }) });
  assert.equal(dingtalkMenuCommand(menu, callback('preset', { preset: { index: 1 } })), '/preset id:123');
  assert.equal(menu.data.preset_index, 1);
  assert.equal(dingtalkMenuCommand(menu, callback('preset', { preset: { index: -1 } })), null);
  assert.equal(dingtalkMenuCommand(menu, callback('preset', { preset: { index: '1' } })), null);
  assert.equal(dingtalkMenuCommand(menu, callback('preset', { preset: { index: 9 } })), null);
  assert.equal(dingtalkMenuCommand(menu, callback('stop', { revision: 'old' })), null);
  assert.equal(dingtalkMenuCommand(menu, callback('/workspace /tmp', {})), null);
  assert.equal(dingtalkMenuCommand(menu, callback('constructor', {})), null);
  assert.equal(dingtalkMenuCommand(menu, { content: '{' }), null);
});

test('all bots use the same native menu template with STREAM callbacks and in-place updates', async () => {
  const calls = [];
  const api = createDingtalkApi({
    cardMinIntervalMs: 0, cardBackoffMs: 0,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ path: url.pathname, method: options.method, body });
      return { ok: true, status: 200, json: async () => url.pathname.includes('accessToken')
        ? { accessToken: 'token', expireIn: 7200 } : { success: true } };
    },
  });
  for (const clientId of ['first-bot', 'second-bot']) {
    const result = await api.createMenuCard({ clientId, clientSecret: 'secret',
      target: { type: 'user', userId: 'staff' }, data: { revision: 'rev', preset_index: 0 },
    });
    await api.updateMenuCard({ clientId, clientSecret: 'secret', cardInstanceId: result.cardInstanceId,
      data: { preset_index: 1, notice: 'Changed' } });
  }
  const creates = calls.filter(call => call.path.endsWith('/createAndDeliver'));
  assert.equal(creates.length, 2);
  for (const call of creates) {
    assert.equal(call.body.cardTemplateId, DINGTALK_MENU_TEMPLATE_ID);
    assert.equal(call.body.callbackType, 'STREAM');
    assert.equal(call.body.openSpaceId, 'dtv1.card//IM_ROBOT.staff');
    assert.equal(call.body.cardData.cardParamMap.preset_index, '0');
  }
  const updates = calls.filter(call => call.method === 'PUT');
  assert.equal(updates.length, 2);
  assert.equal(updates[0].body.outTrackId, creates[0].body.outTrackId);
  assert.equal(updates[0].body.cardData.cardParamMap.preset_index, '1');
});
