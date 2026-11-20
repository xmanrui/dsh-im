import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer from 'react-test-renderer';

import { ProxySettings, PROXY_SETTINGS_ENDPOINTS } from '../plugin-src/client/proxy-settings.js';
import { ReconnectAllButton, OPS_ENDPOINTS } from '../plugin-src/client/reconnect-all.js';

const { act, create } = TestRenderer;

function textOf(node) {
  const collect = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(collect).join('');
    if (value.children) return collect(value.children);
    return '';
  };
  return collect(node);
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

test('the proxy page shows the saved settings and saves edits', async (t) => {
  const calls = [];
  const saved = {
    enabled: true, type: 'socks5h', host: 'proxy.example', port: '1080',
    anonymous: true, username: '', password: '',
  };
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === PROXY_SETTINGS_ENDPOINTS.get) return { ok: true, value: saved };
    return { ok: true, value: { ...saved, ...payload } };
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(ProxySettings, { rpcCall }));
  });
  await flush();
  t.after(() => act(() => renderer.unmount()));

  const root = renderer.root;
  assert.equal(root.findByProps({ id: expectId(root, 'host') }).props.value, 'proxy.example');

  const host = root.findByProps({ placeholder: 'proxy.example' });
  await act(async () => { host.props.onChange({ target: { value: 'other.example' } }); });

  const form = root.findByType('form');
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });

  const setCall = calls.find((call) => call.endpoint === PROXY_SETTINGS_ENDPOINTS.set);
  assert.ok(setCall, 'save must reach the RPC');
  assert.equal(setCall.payload.host, 'other.example');
});

test('the check button asks the host and renders what came back', async (t) => {
  const calls = [];
  const rpcCall = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === PROXY_SETTINGS_ENDPOINTS.get) {
      return {
        ok: true,
        value: {
          enabled: true, type: 'socks5h', host: 'proxy.example', port: '1080',
          anonymous: true, username: '', password: '',
        },
      };
    }
    return {
      ok: true,
      value: {
        enabled: true,
        proxy: 'socks5h://proxy.example:1080',
        ms: 12,
        results: [{ id: 'telegram', url: 'https://api.telegram.org/', ok: true, status: 200, ms: 7 }],
      },
    };
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(ProxySettings, { rpcCall }));
  });
  await flush();
  t.after(() => act(() => renderer.unmount()));

  const check = renderer.root.findAllByType('button')
    .find((node) => textOf(node) === 'Check proxy' || textOf(node) === '检查代理');
  assert.ok(check, 'the check button exists');
  assert.equal(check.props.disabled, false, 'a filled form can be checked');

  await act(async () => { await check.props.onClick(); });
  await flush();

  assert.ok(calls.includes(PROXY_SETTINGS_ENDPOINTS.check), 'the check endpoint was called');
  assert.match(textOf(renderer.root), /telegram · HTTP 200 · 7 ms/);
});

test('the check button is disabled while the form cannot describe a proxy', async (t) => {
  const rpcCall = async () => ({
    ok: true,
    value: {
      enabled: true, type: 'socks5h', host: '', port: '1080',
      anonymous: true, username: '', password: '',
    },
  });
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(ProxySettings, { rpcCall }));
  });
  await flush();
  t.after(() => act(() => renderer.unmount()));

  const check = renderer.root.findAllByType('button')
    .find((node) => textOf(node) === 'Check proxy' || textOf(node) === '检查代理');
  assert.equal(check.props.disabled, true, 'no host means nothing to check');
});

test('reconnect-all reports how many bots came back', async (t) => {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return { ok: true, value: { results: [], reconnected: 2, failed: 1 } };
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(ReconnectAllButton, { rpcCall }));
  });
  t.after(() => act(() => renderer.unmount()));

  const button = renderer.root.findByType('button');
  await act(async () => { await button.props.onClick(); });
  await flush();

  assert.equal(calls[0].endpoint, OPS_ENDPOINTS.reconnectAll);
  assert.deepEqual(calls[0].payload, {});
  assert.match(textOf(renderer.root), /2.*1/);
});

function expectId(root, suffix) {
  const input = root.findAll((node) => typeof node.props?.id === 'string' && node.props.id.endsWith(suffix))[0];
  return input?.props.id;
}
