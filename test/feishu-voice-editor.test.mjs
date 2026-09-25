import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer from 'react-test-renderer';

import { VoiceEditor } from '../plugin-src/client/channels/feishu/voice-editor.js';

const { act } = TestRenderer;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function renderVoiceEditor({ value = null, onSave = async () => {} } = {}) {
  const saves = [];
  const renderer = TestRenderer.create(React.createElement(VoiceEditor, {
    value,
    onSave: async (payload) => {
      saves.push(payload);
      await onSave(payload);
    },
  }));
  const select = renderer.root.findByProps({ 'aria-label': '语音交互开关' });
  return { renderer, select, saves };
}

// 回归:开关切到“关闭”后没有保存按钮,若不在切换时落盘,后台会一直保持
// 原配置,用户以为语音已停止而实际仍在处理语音。
test('toggling voice off immediately persists a disabled configuration', async () => {
  const { renderer, select, saves } = renderVoiceEditor({
    value: { enabled: true, secretRef: 'MY_KEY' },
  });
  await flush();

  act(() => {
    select.props.onChange({ target: { value: 'off' } });
  });
  await flush();

  assert.deepEqual(saves, [null]);
  renderer.unmount();
});

test('toggling voice on saves nothing until the save button is pressed', async () => {
  const { renderer, select, saves } = renderVoiceEditor({ value: null });
  await flush();

  act(() => {
    select.props.onChange({ target: { value: 'on' } });
  });
  await flush();

  assert.deepEqual(saves, []);
  renderer.unmount();
});
