import { AirumoConfigStore } from '../../../../src/channels/airumo/config-store.mjs';
import { AirumoHarnessClient } from '../../../../src/channels/airumo/harness-client.mjs';
import { AirumoController } from '../../../../src/channels/airumo/controller.mjs';
import { AirumoRuntime } from '../../../../src/channels/airumo/runtime.mjs';
import { AirumoStateStore } from '../../../../src/channels/airumo/state-store.mjs';
import { createTokenProductionController } from '../shared/production.mjs';
import { createTokenBotRpcHandler } from '../shared/rpc.mjs';
import { installProductionChannel } from '../shared/startup.mjs';

/** A request may remove only its own queued input or cancel its exact live turn. */
export function cancelAirumoPrompt(ctx, handle) {
  const agents = ctx.get?.('agents');
  const agent = agents?.get(handle.sessionId);
  if (!agent) return;
  for (const input of [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]) {
    if (input.source?.rpcId === handle.promptRpcId) agent.inbox.remove(input.id);
  }
  let open = null;
  let own = false;
  for (const e of agent.session.snapshotEvents()) {
    if (e.type === 'turn/start') {
      open = e.data.turn;
      own = false;
    }
    if (e.type === 'user/message' && e.data.source?.rpcId === handle.promptRpcId) own = true;
    if (e.type === 'turn/end' && e.data.turn === open) {
      open = null;
      own = false;
    }
  }
  if (open !== null && own && agent.status === 'running')
    agent.cancel({ kind: 'user' }, { keepInbox: true });
}

export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'airumo',
    ConfigStore: AirumoConfigStore,
    StateStore: AirumoStateStore,
    HarnessClient: AirumoHarnessClient,
    Controller: AirumoController,
    Runtime: AirumoRuntime,
    runtimeOptions: () => ({
      cancelExecution: (handle) => cancelAirumoPrompt(ctx, handle),
    }),
  });
}

export const name = 'dsh-im-airumo-host';
export const inject = ['connection', 'credentials', 'typertGateway'];
export async function apply(ctx, config = {}) {
  return installProductionChannel(ctx, config, {
    channel: 'airumo',
    rpcChannel: '/airumo',
    createProduction: () => createProductionController(ctx, config, config.internals ?? {}),
    createHandler: (controller) => createTokenBotRpcHandler(controller, { channel: 'AIRumo' }),
  });
}
