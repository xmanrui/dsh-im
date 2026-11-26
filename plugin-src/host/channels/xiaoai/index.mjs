import { createProductionController } from './production.mjs';
import { installXiaoAIRpc } from './rpc.mjs';
export async function apply(ctx, config = {}) {
  if (config.controller) return installXiaoAIRpc(ctx, config.controller, config.rpcAuthority);
  const production = await createProductionController(ctx, config, config.internals ?? {});
  const unregister = config.deliveryService && production.deliveryAdapter
    ? config.deliveryService.registerAdapter(production.deliveryAdapter) : undefined;
  const dispose = installXiaoAIRpc(ctx, production.controller, config.rpcAuthority);
  ctx.effect(() => async () => { await unregister?.(); await production.close(); }, 'dsh-im: close XiaoAI sidecars');
  return dispose;
}
