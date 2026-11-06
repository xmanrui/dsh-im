import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { FeishuConversationDirectorySettingsPage } from '../plugin-src/client/channels/feishu/conversation-directory-settings.js';
import { FEISHU_ENDPOINTS } from '../plugin-src/client/channels/feishu/api.js';

const { act, create } = TestRenderer;

test('bot form inherits a changed channel default before saving an override', async (t) => {
  const disabled = { enabled: false, strategy: 'per-conversation', prefix: 'conv-' };
  const enabled = { ...disabled, enabled: true };
  let snapshot = {
    conversationDirectory: disabled,
    bots: [{ botId: 'bot-one', conversationDirectory: disabled, conversationDirectoryOverride: null }],
  };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.setConversationDirectoryDefault) {
      snapshot = {
        conversationDirectory: payload.config,
        bots: [{ ...snapshot.bots[0], conversationDirectory: payload.config }],
      };
    }
    return { ok: true, value: snapshot };
  };
  let view;
  await act(async () => {
    view = create(React.createElement(FeishuConversationDirectorySettingsPage, {
      account: { botId: 'bot-one' }, rpcCall,
    }));
  });
  t.after(async () => { await act(async () => view.unmount()); });
  const forms = () => view.root.findAllByType('form');
  assert.equal(forms()[0].findByProps({ role: 'switch' }).props.checked, false);
  await act(async () => forms()[1].findByProps({ role: 'switch' }).props.onChange({ target: { checked: true } }));
  await act(async () => forms()[1].props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(calls.at(-1), {
    endpoint: FEISHU_ENDPOINTS.setConversationDirectoryDefault,
    payload: { config: enabled },
  });
  assert.equal(forms()[0].findByProps({ role: 'switch' }).props.checked, true);
  await act(async () => forms()[0].props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(calls.at(-1), {
    endpoint: FEISHU_ENDPOINTS.setConversationDirectory,
    payload: { botId: 'bot-one', config: enabled },
  });
});
