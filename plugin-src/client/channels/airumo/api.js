import { TOKEN_BOT_ENDPOINTS, createTokenChannelApi } from '../shared/token-api.js';
export const AIRUMO_RPC_CHANNEL = '/airumo';
export const AIRUMO_ENDPOINTS = TOKEN_BOT_ENDPOINTS;
export const airumoClientApi = createTokenChannelApi('AIRumo', ' Bot API 长轮询');
export const unwrapRpcResult = airumoClientApi.unwrapRpcResult;
export const normalizeSnapshot = airumoClientApi.normalizeSnapshot;
export const presentError = airumoClientApi.presentError;
