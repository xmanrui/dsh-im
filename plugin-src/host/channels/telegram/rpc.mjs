import { registerManagementRpc } from '../../../management-rpc.mjs';
import {
  TOKEN_BOT_ENDPOINTS,
  createTokenBotRpcHandler,
} from '../shared/rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';

export const TELEGRAM_RPC_CHANNEL = '/telegram';
export const TELEGRAM_ENDPOINTS = TOKEN_BOT_ENDPOINTS;
export const TELEGRAM_RPC_ENDPOINTS = Object.freeze(Object.values(TELEGRAM_ENDPOINTS));

export function createTelegramRpcHandler(controller) {
  return createTokenBotRpcHandler(controller, { channel: 'Telegram' });
}

export function installTelegramRpc(ctx, controller, authority) {
  return registerManagementRpc(ctx,
    TELEGRAM_RPC_CHANNEL,
    createTelegramRpcHandler(controller),
    { authority: resolveRpcAuthority(authority) },
  );
}
