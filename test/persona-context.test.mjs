import assert from 'node:assert/strict';
import test from 'node:test';

import { IM_PERSONA_CONTEXT, IM_PERSONA_ORDER, imPersona } from '../src/channels/shared/im-persona.mjs';
import {
  installPersonaContext,
  withPersonaAuthority,
} from '../plugin-src/host/persona-context.mjs';

test('注册表按会话保存人设文本，空串等于撤销', () => {
  const registry = new (imPersona.constructor)();
  registry.publish('s1', '你是大肥鱼');
  assert.equal(registry.get('s1'), '你是大肥鱼');
  registry.publish('s1', '   ');
  assert.equal(registry.get('s1'), undefined);
  assert.equal(registry.get(undefined), undefined);
});

test('注册表有会话上限，最久未用的一条先被挤掉', () => {
  const registry = new (imPersona.constructor)();
  for (let index = 0; index < 1100; index += 1) registry.publish(`s${index}`, `p${index}`);
  assert.ok(registry.size <= 1024);
  // The oldest entries went first; the newest is still there.
  assert.equal(registry.get('s0'), undefined);
  assert.equal(registry.get('s1099'), 'p1099');
});

test('withPersonaAuthority 追加权威声明，空输入答空串', () => {
  const text = withPersonaAuthority('## 你是谁\n你是大肥鱼。', 'zh');
  assert.ok(text.startsWith('## 你是谁'));
  assert.match(text, /不要跳出角色/u);
  assert.equal(withPersonaAuthority('', 'zh'), '');
  assert.equal(withPersonaAuthority(undefined, 'zh'), '');
});

test('withPersonaAuthority 按界面语言选措辞', () => {
  assert.match(withPersonaAuthority('x', 'en'), /stay in it/u);
});

test('Host 安装器注册 persona 提示上下文，顺序先于来源指引', () => {
  const contexts = [];
  const published = new Map([['s1', '你是大肥鱼']]);
  const registry = { get: (id) => published.get(id), forget: (id) => published.delete(id) };
  installPersonaContext({
    systemPrompt: {
      context: (definition) => { contexts.push(definition); return () => {}; },
    },
    on: () => () => {},
  }, { registry });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, IM_PERSONA_CONTEXT);
  assert.equal(contexts[0].order, IM_PERSONA_ORDER);
  assert.ok(contexts[0].order < 125, '人设必须排在来源指引之前');
  assert.match(contexts[0].text({ agent: { session: { id: 's1' } } }), /你是大肥鱼/u);
  assert.equal(contexts[0].text({ agent: { session: { id: 'other' } } }), '');
  assert.equal(contexts[0].text(undefined), '');
});

test('Host 安装器通过 ctx.inject 等待 systemPrompt 服务', () => {
  const injected = [];
  const contexts = [];
  installPersonaContext({
    inject: (services, callback) => {
      injected.push(services);
      callback({ systemPrompt: { context: (definition) => { contexts.push(definition); return () => {}; } } });
    },
    on: () => () => {},
  }, { registry: { get: () => undefined, forget: () => {} } });
  assert.deepEqual(injected, [['systemPrompt']]);
  assert.equal(contexts.length, 1);
});

test('Agent 释放时清掉该会话的人设', () => {
  const sent = new Map();
  let disposed;
  installPersonaContext({
    systemPrompt: { context: () => () => {} },
    on: (name, listener) => {
      if (name === 'agent/disposed') disposed = listener;
      return () => {};
    },
  }, { registry: { get: () => undefined, forget: (id) => sent.set(id, true) } });
  disposed({ agent: { session: { id: 's1' } } });
  assert.equal(sent.get('s1'), true);
});

test('没有 on() 的上下文返回 null，不炸插件激活', () => {
  assert.equal(installPersonaContext(undefined), null);
  assert.equal(installPersonaContext({}), null);
});
