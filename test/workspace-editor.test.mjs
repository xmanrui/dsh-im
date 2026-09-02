import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  AgentPresetCatalogContext,
  AgentPresetEditor,
} from '../plugin-src/client/agent-preset.js';
import {
  WorkspaceDirectoryPickerContext,
  WorkspaceEditor,
} from '../plugin-src/client/workspace-editor.js';
import { DiscordSettingsTab } from '../plugin-src/client/channels/discord/index.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function directoryListing(path, childNames = [], { home = '/workspace', truncated = false } = {}) {
  let cursor = '';
  const crumbs = [{ name: '/', path: '/', hidden: false }];
  for (const name of path.split('/').filter(Boolean)) {
    cursor += `/${name}`;
    crumbs.push({ name, path: cursor, hidden: false });
  }
  return {
    path,
    home,
    crumbs,
    entries: childNames.map((name) => ({
      name,
      path: `${path === '/' ? '' : path}/${name}`,
      hidden: name.startsWith('.'),
    })),
    truncated,
  };
}

function nativeUnavailable({
  code = 'directory-picker/unavailable',
  capability = 'native',
} = {}) {
  const error = new Error('Directory browsing is unavailable');
  error.rpcError = {
    code,
    message: error.message,
    details: { capability },
  };
  return error;
}

function nativeDirectoryPicker(selected, unavailable = undefined) {
  const calls = { list: 0, pick: 0 };
  return {
    calls,
    async listDirectory() {
      calls.list += 1;
      throw nativeUnavailable(unavailable);
    },
    async pickDirectory() {
      calls.pick += 1;
      return selected;
    },
  };
}

function withDirectoryPicker(element, picker) {
  return React.createElement(
    WorkspaceDirectoryPickerContext.Provider,
    { value: picker },
    element,
  );
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

function buttonNamed(root, name) {
  return root.findAllByType('button').find((button) => textOf(button) === name);
}

function discordSnapshot(workspace) {
  return {
    revision: 1,
    bots: [{
      botId: 'discord_test',
      connected: true,
      state: 'connected',
      workspace,
      bot: { name: 'Harness Bot', username: 'HarnessBot', idMasked: '123•••' },
      health: { summary: 'Discord Gateway 长连接运行正常', lastCheckedAt: Date.now() },
      error: null,
    }],
  };
}

function twoBotDiscordSnapshot(firstWorkspace) {
  const first = discordSnapshot(firstWorkspace).bots[0];
  return {
    revision: 1,
    bots: [
      { ...first, botId: 'discord_first', bot: { ...first.bot, name: 'First Bot' } },
      {
        ...first,
        botId: 'discord_second',
        workspace: '/workspace/second',
        bot: { ...first.bot, name: 'Second Bot' },
      },
    ],
  };
}

test('WorkspaceEditor browses from the current path and saves the selected directory', async () => {
  const saved = [];
  const listed = [];
  const picker = {
    async listDirectory(path) {
      listed.push(path);
      if (path === '/workspace/current') {
        return directoryListing(path, ['next project', '.hidden']);
      }
      if (path === '/workspace/current/next project') return directoryListing(path);
      throw new Error(`Unexpected directory: ${path}`);
    },
    async pickDirectory() { throw new Error('native picker should not run'); },
  };
  function Fixture() {
    const [workspace, setWorkspace] = React.useState('/workspace/current');
    return React.createElement(WorkspaceEditor, {
      workspace,
      directoryPicker: picker,
      async onSave(value) {
        saved.push(value);
        setWorkspace(value);
      },
    });
  }

  const bodyNode = { scrollTop: 0 };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(Fixture), {
      createNodeMock(element) {
        if (element.props?.className === 'dim-directoryPickerBody') return bodyNode;
        return {};
      },
    });
  });
  assert.equal(renderer.root.findByType('code').props.title, '/workspace/current');

  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });
  const dialog = renderer.root.findByProps({ role: 'dialog' });
  assert.equal(dialog.props['aria-modal'], 'true');
  assert.equal(
    textOf(renderer.root.findByProps({ id: dialog.props['aria-describedby'] })),
    '切换后会清除这个机器人的旧会话映射。',
  );
  assert.equal(renderer.root.findAllByProps({ title: '/workspace/current/.hidden' }).length, 0);
  bodyNode.scrollTop = 240;
  await act(async () => {
    renderer.root.findByProps({ title: '/workspace/current/next project' }).props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.onClick();
    await flushMicrotasks();
  });

  assert.deepEqual(listed, ['/workspace/current', '/workspace/current/next project']);
  assert.equal(bodyNode.scrollTop, 0);
  assert.deepEqual(saved, ['/workspace/current/next project']);
  assert.equal(renderer.root.findByType('code').props.title, '/workspace/current/next project');
});

test('WorkspaceEditor navigates to arbitrary absolute paths across drives and UNC shares', async () => {
  const start = 'C:\\Users\\alice\\project';
  const targets = [
    'D:\\projects\\bot',
    '\\\\server\\share\\bot',
    '/mnt/bot',
  ];
  const listed = [];
  const saved = [];
  const picker = {
    async listDirectory(path) {
      listed.push(path);
      return {
        path,
        home: 'C:\\Users\\alice',
        crumbs: [{ name: path, path, hidden: false }],
        entries: [],
        truncated: false,
      };
    },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: start,
      directoryPicker: picker,
      async onSave(value) { saved.push(value); },
    }));
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });

  const pathForm = renderer.root.findByProps({ className: 'dim-directoryPathForm' });
  assert.equal(renderer.root.findByProps({ className: 'dim-directoryPathInput' }).props.value, start);
  for (const target of targets) {
    await act(async () => {
      renderer.root.findByProps({ className: 'dim-directoryPathInput' }).props.onChange({
        target: { value: target },
      });
    });
    assert.equal(
      renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.disabled,
      true,
    );
    await act(async () => {
      pathForm.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });
    assert.equal(renderer.root.findByProps({ className: 'dim-directoryPathInput' }).props.value, target);
    assert.equal(
      renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.disabled,
      false,
    );
  }

  assert.deepEqual(listed, [start, ...targets]);
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.onClick();
    await flushMicrotasks();
  });
  assert.deepEqual(saved, [targets.at(-1)]);
});

test('WorkspaceEditor keeps the prior folder unselectable when a typed path cannot be read', async () => {
  const start = 'C:\\Users\\alice';
  const missing = 'Z:\\missing';
  const picker = {
    async listDirectory(path) {
      if (path === missing) {
        const error = new Error('cannot read requested folder');
        error.rpcError = { code: 'directory-picker/unreadable', message: error.message, details: { path } };
        throw error;
      }
      return {
        path,
        home: start,
        crumbs: [{ name: 'Home', path, hidden: false }],
        entries: [],
        truncated: false,
      };
    },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: start,
      directoryPicker: picker,
      async onSave() { throw new Error('must not save'); },
    }));
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-directoryPathInput' }).props.onChange({
      target: { value: missing },
    });
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-directoryPathForm' }).props.onSubmit({ preventDefault() {} });
    await flushMicrotasks();
  });

  assert.equal(textOf(renderer.root.findByProps({ role: 'alert' })), 'cannot read requested folder');
  assert.equal(renderer.root.findByProps({ className: 'dim-directoryPathInput' }).props.value, missing);
  assert.equal(
    renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.disabled,
    true,
  );
});

test('WorkspaceEditor keeps the picker open and presents a rejected workspace error', async () => {
  const picker = {
    async listDirectory(path) {
      return path === '/workspace/current'
        ? directoryListing(path, ['missing'])
        : directoryListing(path);
    },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: '/workspace/current',
      directoryPicker: picker,
      async onSave() {
        const error = new Error('工作区路径不存在。');
        error.code = 'workspace-not-found';
        throw error;
      },
    }));
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ title: '/workspace/current/missing' }).props.onClick();
    await flushMicrotasks();
    renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.onClick();
    await flushMicrotasks();
  });

  assert.equal(textOf(renderer.root.findByProps({ role: 'alert' })), '工作区路径不存在。');
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-modal'], 'true');
  assert.equal(renderer.root.findByType('code').props.title, '/workspace/current');
});

test('WorkspaceEditor closes without saving when the current directory is selected', async () => {
  let saves = 0;
  const picker = { async listDirectory(path) { return directoryListing(path); } };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: '/workspace/current',
      directoryPicker: picker,
      async onSave() { saves += 1; },
    }));
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.onClick();
    await flushMicrotasks();
  });

  assert.equal(saves, 0);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
});

test('WorkspaceEditor falls back to one native picker without restarting after save', async () => {
  const saved = [];
  const picker = nativeDirectoryPicker('/workspace/native');
  function Fixture() {
    const [workspace, setWorkspace] = React.useState('/workspace/current');
    return React.createElement(WorkspaceEditor, {
      workspace,
      directoryPicker: picker,
      async onSave(value) {
        saved.push(value);
        setWorkspace(value);
      },
    });
  }

  let renderer;
  await act(async () => { renderer = create(React.createElement(Fixture)); });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });

  assert.deepEqual(saved, ['/workspace/native']);
  assert.deepEqual(picker.calls, { list: 1, pick: 1 });
  assert.equal(renderer.root.findByType('code').props.title, '/workspace/native');
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
});

test('WorkspaceEditor keeps the legacy native unavailable code compatible', async () => {
  const saved = [];
  const picker = nativeDirectoryPicker('/workspace/legacy-native', {
    code: 'directory-picker-unavailable',
  });
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: '/workspace/current',
      directoryPicker: picker,
      async onSave(value) { saved.push(value); },
    }));
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });

  assert.deepEqual(saved, ['/workspace/legacy-native']);
  assert.deepEqual(picker.calls, { list: 1, pick: 1 });
});

test('WorkspaceEditor does not treat a non-native unavailable capability as native', async () => {
  const picker = nativeDirectoryPicker('/workspace/must-not-pick', {
    capability: 'browse',
  });
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: '/workspace/current',
      directoryPicker: picker,
      async onSave() { throw new Error('must not save'); },
    }));
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });

  assert.deepEqual(picker.calls, { list: 1, pick: 0 });
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1);
});

test('WorkspaceEditor treats native picker cancellation as cancellation, not an error', async () => {
  let saves = 0;
  const picker = nativeDirectoryPicker(null);
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: '/workspace/current',
      directoryPicker: picker,
      async onSave() { saves += 1; },
    }));
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });

  assert.equal(saves, 0);
  assert.deepEqual(picker.calls, { list: 1, pick: 1 });
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
});

for (const unreadableCode of ['directory-picker/unreadable', 'directory-unreadable']) {
  test(`WorkspaceEditor falls back to the Host home for ${unreadableCode}`, async () => {
    const listed = [];
    const saved = [];
    const picker = {
      async listDirectory(path) {
        listed.push(path);
        if (path === '/workspace/gone') {
          const error = new Error('missing');
          error.rpcError = { code: unreadableCode, message: 'missing', details: { path } };
          throw error;
        }
        return directoryListing('/workspace', ['projects']);
      },
    };
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(WorkspaceEditor, {
        workspace: '/workspace/gone',
        directoryPicker: picker,
        async onSave(value) { saved.push(value); },
      }));
    });
    await act(async () => {
      renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
      await flushMicrotasks();
    });

    assert.deepEqual(listed, ['/workspace/gone', undefined]);
    await act(async () => {
      renderer.root.findByProps({ className: 'dim-directoryPickerPrimary' }).props.onClick();
      await flushMicrotasks();
    });
    assert.deepEqual(saved, ['/workspace']);
  });
}

test('WorkspaceEditor moves keyboard focus into and back out of the picker', async () => {
  let dialogFocus = 0;
  let editFocus = 0;
  const picker = { async listDirectory(path) { return directoryListing(path); } };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: '/workspace/current',
      directoryPicker: picker,
      async onSave() {},
    }), {
      createNodeMock(element) {
        if (element.props?.className === 'dim-directoryPicker') {
          return { focus() { dialogFocus += 1; } };
        }
        if (element.props?.className === 'dim-workspaceEdit') {
          return { focus() { editFocus += 1; } };
        }
        return {};
      },
    });
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });
  assert.equal(dialogFocus, 1);
  await act(async () => {
    buttonNamed(renderer.root, '取消').props.onClick();
    await flushMicrotasks();
  });
  assert.equal(editFocus, 1);
});

test('WorkspaceEditor never translates Host filesystem names in the English UI', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const picker = {
    async listDirectory(path) { return directoryListing(path, ['微信']); },
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceEditor, {
      workspace: '/workspace/current',
      directoryPicker: picker,
      async onSave() {},
    }));
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-workspaceEdit' }).props.onClick();
    await flushMicrotasks();
  });

  const directory = renderer.root.findByProps({ title: '/workspace/current/微信' });
  assert.equal(textOf(directory), '微信');
  assert.doesNotMatch(textOf(directory), /WeChat/);
  assert.equal(
    renderer.root.findByProps({ className: 'dim-directoryPathInput' }).props.placeholder,
    'Enter a full absolute path on the Host',
  );
  assert.ok(buttonNamed(renderer.root, 'Go'));
  await act(async () => { renderer.unmount(); });
});

test('a status response started before saving cannot restore the old workspace', async (t) => {
  const previousWindow = globalThis.window;
  let intervalCallback;
  globalThis.window = {
    setInterval(callback) { intervalCallback = callback; return 1; },
    clearInterval() {},
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const staleStatus = deferred();
  let statusCalls = 0;
  const rpcCall = async (endpoint) => {
    if (endpoint === 'connection.status') {
      statusCalls += 1;
      if (statusCalls === 1) return { ok: true, value: discordSnapshot('/workspace/current') };
      if (statusCalls === 2) return staleStatus.promise;
      return { ok: true, value: discordSnapshot('/workspace/new') };
    }
    if (endpoint === 'bot.workspace.set') {
      return { ok: true, value: discordSnapshot('/workspace/new') };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  const picker = nativeDirectoryPicker('/workspace/new');
  await act(async () => {
    renderer = create(withDirectoryPicker(
      React.createElement(DiscordSettingsTab, { rpcCall }),
      picker,
    ));
    await flushMicrotasks();
  });
  await act(async () => {
    intervalCallback();
    await flushMicrotasks();
  });
  await act(async () => {
    buttonNamed(renderer.root, '选择目录').props.onClick();
    await flushMicrotasks();
  });
  assert.equal(renderer.root.findByType('code').props.title, '/workspace/new');

  await act(async () => {
    staleStatus.resolve({ ok: true, value: discordSnapshot('/workspace/old') });
    await flushMicrotasks();
  });
  assert.equal(renderer.root.findByType('code').props.title, '/workspace/new');
  await act(async () => { renderer.unmount(); });
});

test('an older reconnect snapshot from another bot cannot restore a saved workspace', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval() { return 1; }, clearInterval() {} };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const staleReconnect = deferred();
  let statusCalls = 0;
  const rpcCall = async (endpoint) => {
    if (endpoint === 'connection.status') {
      statusCalls += 1;
      return {
        ok: true,
        value: twoBotDiscordSnapshot(statusCalls === 1 ? '/workspace/current' : '/workspace/new'),
      };
    }
    if (endpoint === 'bot.reconnect') return staleReconnect.promise;
    if (endpoint === 'bot.workspace.set') {
      return { ok: true, value: twoBotDiscordSnapshot('/workspace/new') };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  const picker = nativeDirectoryPicker('/workspace/new');
  await act(async () => {
    renderer = create(withDirectoryPicker(
      React.createElement(DiscordSettingsTab, { rpcCall }),
      picker,
    ));
    await flushMicrotasks();
  });
  const firstCard = renderer.root.findByProps({ 'data-bot-id': 'discord_first' });
  const secondCard = renderer.root.findByProps({ 'data-bot-id': 'discord_second' });
  await act(async () => {
    secondCard.findAllByType('button')
      .find((button) => button.children.join('') === '检查连接').props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    buttonNamed(firstCard, '选择目录').props.onClick();
    await flushMicrotasks();
  });

  staleReconnect.resolve({ ok: true, value: twoBotDiscordSnapshot('/workspace/old') });
  await act(async () => { await flushMicrotasks(); });
  assert.equal(
    renderer.root.findByProps({ 'data-bot-id': 'discord_first' }).findByType('code').props.title,
    '/workspace/new',
  );
  await act(async () => { renderer.unmount(); });
});

test('connection check requests a test message and shows its delivery result', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval() { return 1; }, clearInterval() {} };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const calls = [];
  const snapshot = discordSnapshot('/workspace/current');
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'connection.status') return { ok: true, value: snapshot };
    if (endpoint === 'bot.reconnect') {
      return { ok: true, value: { ...snapshot, testMessage: { sent: true } } };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DiscordSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const card = renderer.root.findByProps({ 'data-bot-id': 'discord_test' });
  await act(async () => {
    buttonNamed(card, '检查连接').props.onClick();
    await flushMicrotasks();
  });

  assert.deepEqual(calls.find((call) => call.endpoint === 'bot.reconnect')?.payload, {
    botId: 'discord_test',
    sendTest: true,
  });
  assert.equal(
    textOf(renderer.root.findByProps({ role: 'status' })),
    '测试消息已发送，请到对应机器人会话中确认。',
  );
  await act(async () => { renderer.unmount(); });
});

test('shared token target-unavailable feedback asks for any direct message', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval() { return 1; }, clearInterval() {} };
  setImTranslator((key) => en[key] ?? key);
  t.after(() => {
    setImTranslator(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const snapshot = discordSnapshot('/workspace/current');
  const rpcCall = async (endpoint) => {
    if (endpoint === 'connection.status') return { ok: true, value: snapshot };
    if (endpoint === 'bot.reconnect') {
      return {
        ok: true,
        value: {
          ...snapshot,
          testMessage: { sent: false, code: 'test-target-unavailable' },
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DiscordSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const card = renderer.root.findByProps({ 'data-bot-id': 'discord_test' });
  await act(async () => {
    buttonNamed(card, 'Check connection').props.onClick();
    await flushMicrotasks();
  });

  const notice = textOf(renderer.root.findByProps({ role: 'status' }));
  assert.equal(
    notice,
    'Connection check completed. The bot has not received a direct message it can use for testing.',
  );
  assert.doesNotMatch(notice, /\/status|[\p{Script=Han}]/u);
  await act(async () => { renderer.unmount(); });
});

test('shared token connection failures render a fixed English-safe notice', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval() { return 1; }, clearInterval() {} };
  setImTranslator((key) => en[key] ?? key);
  t.after(() => {
    setImTranslator(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const snapshot = discordSnapshot('/workspace/current');
  const rpcCall = async (endpoint) => {
    if (endpoint === 'connection.status') return { ok: true, value: snapshot };
    if (endpoint === 'bot.reconnect') {
      return {
        ok: false,
        error: { code: 'discord-operation-failed', message: 'Discord 操作失败，请稍后重试。' },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DiscordSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const card = renderer.root.findByProps({ 'data-bot-id': 'discord_test' });
  await act(async () => {
    buttonNamed(card, 'Check connection').props.onClick();
    await flushMicrotasks();
  });

  const notice = textOf(renderer.root.findByProps({ role: 'status' }));
  assert.equal(notice, 'Connection check failed. Try again later.');
  assert.doesNotMatch(notice, /[\p{Script=Han}]/u);
  await act(async () => { renderer.unmount(); });
});

test('an older reconnect snapshot cannot resurrect a bot deleted by a newer mutation', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval() { return 1; }, clearInterval() {} };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const staleReconnect = deferred();
  const initialSnapshot = twoBotDiscordSnapshot('/workspace/first');
  const deletedSnapshot = { ...initialSnapshot, bots: initialSnapshot.bots.slice(1) };
  let statusCalls = 0;
  const rpcCall = async (endpoint) => {
    if (endpoint === 'connection.status') {
      statusCalls += 1;
      return { ok: true, value: statusCalls === 1 ? initialSnapshot : deletedSnapshot };
    }
    if (endpoint === 'bot.reconnect') return staleReconnect.promise;
    if (endpoint === 'bot.delete') return { ok: true, value: deletedSnapshot };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DiscordSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const firstCard = renderer.root.findByProps({ 'data-bot-id': 'discord_first' });
  const secondCard = renderer.root.findByProps({ 'data-bot-id': 'discord_second' });
  await act(async () => {
    secondCard.findAllByType('button')
      .find((button) => button.children.join('') === '检查连接').props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    firstCard.findAllByType('button')
      .find((button) => button.children.join('') === '移除接入').props.onClick();
  });
  await act(async () => {
    await firstCard.findAllByType('button')
      .find((button) => button.children.join('') === '确认移除接入').props.onClick();
    await flushMicrotasks();
  });
  assert.equal(renderer.root.findAllByProps({ 'data-bot-id': 'discord_first' }).length, 0);

  staleReconnect.resolve({ ok: true, value: initialSnapshot });
  await act(async () => { await flushMicrotasks(); });
  assert.equal(renderer.root.findAllByProps({ 'data-bot-id': 'discord_first' }).length, 0);
  await act(async () => { renderer.unmount(); });
});

const PRESET_CATALOG = {
  defaultId: 'default',
  items: [
    { id: 'coding', label: 'Coding' },
    { id: 'default', label: 'Default' },
  ],
};

function optionValues(select) {
  return select.children.map((option) => option.props.value);
}

test('AgentPresetEditor lists Host presets and moves its session guidance into accessible help', () => {
  const renderer = create(React.createElement(
    AgentPresetCatalogContext.Provider,
    { value: PRESET_CATALOG },
    React.createElement(AgentPresetEditor, {
      agentPreset: 'coding',
      onSave() {},
    }),
  ));
  const select = renderer.root.findByProps({ className: 'dim-presetSelect' });
  assert.equal(select.props.value, 'coding');
  assert.deepEqual(optionValues(select), ['', 'coding', 'default']);
  assert.equal(textOf(select.children[0]), '跟随 Host 默认');
  assert.equal(textOf(select.children[1]), 'Coding（coding）');
  const helpButton = renderer.root.findByProps({
    'aria-label': '查看 Agent Preset 说明',
  });
  const tooltip = renderer.root.findByProps({ role: 'tooltip' });
  assert.equal(helpButton.props.type, 'button');
  assert.ok(tooltip.props.id);
  assert.equal(helpButton.props['aria-describedby'], tooltip.props.id);
  assert.equal(
    textOf(tooltip),
    '只影响新建会话；若当前聊天已有会话，先发送 /new，再发送普通消息生效。',
  );
  assert.equal(renderer.root.findAllByType('small').length, 0);
  renderer.unmount();
});

test('AgentPresetEditor marks a removed current preset and still allows clearing it', async () => {
  const saved = [];
  const renderer = create(React.createElement(
    AgentPresetCatalogContext.Provider,
    { value: PRESET_CATALOG },
    React.createElement(AgentPresetEditor, {
      agentPreset: 'removed-preset',
      onSave(value) { saved.push(value); },
    }),
  ));
  const select = renderer.root.findByProps({ className: 'dim-presetSelect' });
  assert.equal(select.props.value, 'removed-preset');
  assert.deepEqual(optionValues(select), ['', 'coding', 'default', 'removed-preset']);
  assert.equal(textOf(select.children[3]), 'removed-preset（已不可用）');
  assert.equal(
    textOf(renderer.root.findByProps({ role: 'status' })),
    '当前 Agent Preset 已不可用，请选择其他 Preset 或跟随 Host 默认。',
  );

  await act(async () => {
    select.props.onChange({ target: { value: '' } });
    await flushMicrotasks();
  });
  assert.deepEqual(saved, [null]);
  renderer.unmount();
});

test('AgentPresetEditor saves a selected preset and can follow the Host default', async () => {
  const saved = [];
  function Harness() {
    const [agentPreset, setAgentPreset] = React.useState('');
    return React.createElement(AgentPresetEditor, {
      agentPreset,
      onSave(value) {
        saved.push(value);
        setAgentPreset(value ?? '');
      },
    });
  }
  const renderer = create(React.createElement(
    AgentPresetCatalogContext.Provider,
    { value: PRESET_CATALOG },
    React.createElement(Harness),
  ));
  const select = renderer.root.findByProps({ className: 'dim-presetSelect' });
  await act(async () => {
    select.props.onChange({ target: { value: 'coding' } });
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-presetSelect' })
      .props.onChange({ target: { value: '' } });
    await flushMicrotasks();
  });
  assert.deepEqual(saved, ['coding', null]);
  renderer.unmount();
});

test('Discord settings save an Agent Preset through bot.preset.set', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval() { return 1; }, clearInterval() {} };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const snapshot = {
    ...discordSnapshot('/workspace/current'),
    agentPresetCatalog: PRESET_CATALOG,
  };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'connection.status') return { ok: true, value: snapshot };
    if (endpoint === 'bot.preset.set') {
      return {
        ok: true,
        value: {
          ...snapshot,
          bots: [{ ...snapshot.bots[0], agentPreset: payload.agentPreset }],
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DiscordSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const card = renderer.root.findByProps({ 'data-bot-id': 'discord_test' });
  await act(async () => {
    card.findByProps({ className: 'dim-presetSelect' })
      .props.onChange({ target: { value: 'coding' } });
    await flushMicrotasks();
  });

  assert.deepEqual(calls.find((call) => call.endpoint === 'bot.preset.set')?.payload, {
    botId: 'discord_test',
    agentPreset: 'coding',
  });
  await act(async () => { renderer.unmount(); });
});
