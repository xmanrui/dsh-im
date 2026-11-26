import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { XiaoAILogin, XiaoAIDevice, checkedAuth } from '../../plugin-src/client/channels/xiaoai/index.js';

test('login keeps authId across polling and renders SMS verification then device selection', async () => {
  const authId = '12345678-1234-1234-1234-123456789abc';
  let polls = 0;
  const rpcCall = async (method, payload) => {
    if (method === 'auth.begin') return { ok: true, value: { authId, state: 'connecting', devices: [] } };
    if (method === 'auth.status') { assert.equal(payload.authId, authId); polls++; return { ok: true, value: { authId, state: 'verification-required', method: 'Phone', devices: [] } }; }
    if (method === 'auth.submit') return { ok: true, value: { authId, state: 'ready', devices: [{ deviceId: 'mock-device', name: '模拟 LX01', hardware: 'LX01' }] } };
    if (method === 'auth.cancel') return { ok: true, value: { cancelled: true } };
    throw new Error('Unexpected test RPC');
  };
  let tree;
  try {
    await act(async () => { tree = renderer.create(React.createElement(XiaoAILogin, { rpcCall, refresh: async () => {}, onCancel() {} })); });
    await act(async () => {
      tree.root.findAllByType('input')[0].props.onChange({ target: { value: 'mock-account' } });
      tree.root.findAllByType('input')[1].props.onChange({ target: { value: 'mock-password' } });
    });
    await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    assert.ok(JSON.stringify(tree.toJSON()).includes('正在连接小米'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
    assert.ok(polls > 0);
    assert.ok(JSON.stringify(tree.toJSON()).includes('短信验证码'));
    assert.equal(tree.root.findByType('input').props.autoComplete, 'one-time-code');
    await act(async () => { tree.root.findByType('input').props.onChange({ target: { value: '123456' } }); });
    await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    assert.ok(JSON.stringify(tree.toJSON()).includes('模拟 LX01'));
    assert.throws(() => checkedAuth({}), /认证状态响应不完整/);
  } finally { await act(async () => tree?.unmount()); }
});

test('connected device card consumes the native IM bot envelope without identity crashes', async () => {
  let tree;
  try {
    await act(async () => { tree = renderer.create(React.createElement(XiaoAIDevice, {
      bot: { botId: 'xiaoai_' + 'a'.repeat(24), bot: { name: '已连接 LX01', idMasked: 'test•••' },
        connected: true, state: 'connected', health: { summary: '小米云连接运行正常' },
        xiaoai: { device: { hardware: 'LX01' } }, workspace: '/approved/workspace', model: null, agentPreset: '' },
      rpcCall: async () => ({ ok: true, value: {} }), refresh: async () => {},
    })); });
    assert.ok(JSON.stringify(tree.toJSON()).includes('已连接 LX01'));
  } finally { await act(async () => tree?.unmount()); }
});

test('device card saves a new trigger prefix through the management RPC', async () => {
  const botId = 'xiaoai_' + 'b'.repeat(24);
  const calls = [];
  const rpcCall = async (method, payload) => { calls.push([method, payload]); return { ok: true, value: {} }; };
  let tree;
  try {
    await act(async () => { tree = renderer.create(React.createElement(XiaoAIDevice, {
      bot: { botId, bot: { name: '已连接 LX01', idMasked: 'test•••' },
        connected: true, state: 'connected', health: { summary: '小米云连接运行正常' },
        xiaoai: { device: { hardware: 'LX01', keyword: '旧前缀' } }, workspace: '/approved/workspace', model: null, agentPreset: '' },
      rpcCall, refresh: async () => {},
    })); });
    const input = tree.root.findAllByType('input').find(node => node.props['aria-label'] === '修改触发前缀');
    assert.ok(input);
    assert.ok(JSON.stringify(tree.toJSON()).includes('dim-botGeneralRow'));
    await act(async () => { input.props.onChange({ target: { value: '新前缀' } }); });
    const form = tree.root.findByType('form');
    const save = tree.root.findAllByType('button').find(node => node.children.includes('保存'));
    assert.ok(save);
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
    assert.deepEqual(calls[0], ['device.keyword.set', { botId, keyword: '新前缀' }]);
  } finally { await act(async () => tree?.unmount()); }
});

test('device card distinguishes configured model support from audible playback and shows safe failure codes', async () => {
  let tree;
  try {
    await act(async () => { tree = renderer.create(React.createElement(XiaoAIDevice, {
      bot: { botId: 'xiaoai_' + 'c'.repeat(24), bot: { name: 'OH2' }, connected: true,
        health: { summary: '小米云连接运行正常' }, workspace: '/approved/workspace', model: null, agentPreset: '',
        xiaoai: { device: { hardware: 'OH2' }, capabilities: { tts: 'configured' },
          lastDelivery: { status: 'failed', transport: 'miot', modelProfile: 'OH2', providerCode: -704042011 } } },
      rpcCall: async () => ({ ok: true, value: { sent: true } }), refresh: async () => {},
    })); });
    const text = JSON.stringify(tree.toJSON());
    assert.ok(text.includes('实际发声请通过测试播报确认'));
    assert.ok(text.includes('接口拒绝')); assert.ok(text.includes('-704042011'));
    await act(async () => { tree.root.findAllByType('button').find(n => n.children.includes('测试播报')).props.onClick(); });
    assert.ok(JSON.stringify(tree.toJSON()).includes('小米云已接受测试播报，请确认音箱是否发声'));
  } finally { await act(async () => tree?.unmount()); }
});

test('one login selects and binds two speakers in a single batch using the native login form', async () => {
  const authId='12345678-1234-1234-1234-123456789abc';
  const devices=[{deviceId:'one',name:'卧室音箱',hardware:'LX01'},{deviceId:'two',name:'客厅音箱',hardware:'LX01'}];
  const calls=[];let closed=false;let tree;
  const rpcCall=async(method,payload)=>{
    calls.push([method,payload]);
    if(method==='auth.begin'||method==='auth.status')return {ok:true,value:{authId,state:'ready',devices}};
    if(method==='devices.bind')return {ok:true,value:{results:devices.map(d=>({deviceId:d.deviceId,bound:true,connected:true})),status:{bots:[]}}};
    if(method==='auth.cancel')return {ok:true,value:{cancelled:true}};
    throw new Error('Unexpected mocked RPC');
  };
  try {
    await act(async()=>{tree=renderer.create(React.createElement(XiaoAILogin,{rpcCall,refresh:async()=>{},onCancel:()=>{closed=true;}}));});
    await act(async()=>{
      const inputs=tree.root.findAllByType('input');inputs[0].props.onChange({target:{value:'mock-account'}});inputs[1].props.onChange({target:{value:'mock-password'}});
    });
    await act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});});
    const boxes=tree.root.findAllByType('input').filter(n=>n.props.type==='checkbox');assert.equal(boxes.length,2);
    await act(async()=>{for(const box of boxes)box.props.onChange({target:{checked:true}});});
    await act(async()=>{tree.root.findAllByType('button').find(n=>n.children.includes('接入所选音箱（2）')).props.onClick();});
    const binding=calls.find(([name])=>name==='devices.bind')[1];assert.deepEqual(binding.deviceIds,['one','two']);
    assert.equal(Object.hasOwn(binding,'password'),false);assert.equal(closed,true);
  } finally {await act(async()=>tree?.unmount());}
});
