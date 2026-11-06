import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlanCommand, runGoalCommand, isPlanCommand, isGoalCommand } from '../../../src/channels/shared/plan-goal-command.mjs';
import { isSharedLocalCommand } from '../../../src/channels/shared/command-permission.mjs';
const state = { sessionFor: () => 'session-1' };

test('delegates legacy Host commands using the bound session', async () => {
  const calls = [];
  const harness = { async executeCommand(...args) { calls.push(args); return { result: { kind: 'success', text: 'ok' } }; } };
  const result = await runPlanCommand('/plan off', harness, state, 'p2p:user');
  assert.equal(result.message, 'ok');
  assert.deepEqual(calls[0].slice(0, 2), ['session-1', '/plan off']);
});

test('unknown and unavailable Host commands return explicit notices', async () => {
  const missing = await runGoalCommand('/goal', { executeCommand: async () => undefined }, state, 'p2p:user');
  assert.match(missing.message, /当前 Host 未注册 \/goal 命令/);
  const unsupported = await runGoalCommand('/goal', {}, state, 'p2p:user');
  assert.match(unsupported.message, /暂不支持/);
});

test('no session never dispatches a Host command', async () => {
  let calls = 0;
  const result = await runPlanCommand('/plan', { executeCommand: async () => { calls++; } }, { sessionFor: () => null }, 'p2p:user');
  assert.equal(calls, 0);
  assert.match(result.message, /请先发送一条消息/);
});

test('errors are mapped and unrelated slash words remain prompts', async () => {
  const result = await runGoalCommand('/goal', { executeCommand: async () => { throw Object.assign(new Error('internal'), { code: 'agent-busy' }); } }, state, 'p2p:user');
  assert.match(result.message, /正在生成回复/);
  for (const text of ['/planx', '/goals', 'explain /plan']) {
    assert.equal(isPlanCommand(text), false);
    assert.equal(isGoalCommand(text), false);
  }
});

test('merging #509 keeps reset protection alongside plan and goal', () => {
  for (const text of ['/reset', '/plan', '/goal pause']) assert.equal(isSharedLocalCommand(text), true);
  assert.equal(isSharedLocalCommand('/plan', { hasImages: true }), false);
});
