import { t } from '../../../../src/channels/shared/i18n.mjs';
import { createTokenBotRpcHandler } from '../shared/rpc.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
export const XIAOAI_RPC_CHANNEL = '/xiaoai';
const ID = /^xiaoai_[a-f0-9]{24}$/;
const AUTH = /^[a-f0-9-]{36}$/;
function valid(payload, fields) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).every(k => fields.includes(k));
}
// Controller validation/state messages are already user-facing Chinese; never
// expose raw provider text or anything that looks like a credential.
function publicMessage(error) {
  const message = error?.message;
  if (typeof message !== 'string' || message.length > 200) return null;
  if (error?.expose === true) return message;
  if (!/^[\u3400-\u9fff]/u.test(message)) return null;
  if (/(token|password|secret|passToken|micoapi|serviceToken)/i.test(message)) return null;
  return message;
}
export function createXiaoAIRpcHandler(controller) {
  const common = createTokenBotRpcHandler(controller, { channel: 'XiaoAI' });
  const auth = controller.authentication ?? controller;
  return async (endpoint, payload = {}, signal) => {
    try {
      let value;
      if (endpoint === 'auth.begin') {
        if (!valid(payload, ['account', 'password'])) throw new TypeError('Invalid login fields');
        value = await auth.beginAuth(payload);
      } else if (['auth.status', 'auth.submit', 'auth.cancel'].includes(endpoint)) {
        if (!valid(payload, endpoint === 'auth.submit' ? ['authId', 'code'] : ['authId']) || !AUTH.test(payload.authId)) throw new TypeError('Invalid login session');
        value = endpoint === 'auth.status' ? await auth.authStatus(payload.authId)
          : endpoint === 'auth.submit' ? await auth.submitAuth(payload.authId, payload.code) : await auth.cancelAuth(payload.authId);
      } else if (endpoint === 'device.bind') {
        if (!valid(payload, ['authId', 'deviceId', 'keyword']) || !AUTH.test(payload.authId)) throw new TypeError('Invalid device binding');
        value = await auth.bindDevice(payload);
      } else if (endpoint === 'devices.bind') {
        if (!valid(payload, ['authId', 'deviceIds', 'keyword']) || !AUTH.test(payload.authId)) throw new TypeError('Invalid devices binding');
        value = await auth.bindDevices(payload);
      } else if (endpoint === 'device.keyword.set') {
        if (!valid(payload, ['botId', 'keyword']) || !ID.test(payload.botId) || typeof payload.keyword !== 'string') throw new TypeError('Invalid device prefix');
        value = await controller.setKeyword(payload.botId, payload.keyword);
      } else if (endpoint === 'device.test') {
        if (!valid(payload, ['botId']) || !ID.test(payload.botId)) throw new TypeError('Invalid device');
        value = await controller.sendConnectionTest(payload.botId);
      } else if (endpoint === 'device.receipts.review') {
        if (!valid(payload, ['botId']) || !ID.test(payload.botId)) throw new TypeError('Invalid device');
        value = await controller.reviewReceipts(payload.botId);
      } else if (['device.sessions', 'device.session.set', 'device.stop', 'device.speech.stop'].includes(endpoint)) {
        if (!valid(payload, endpoint === 'device.session.set' ? ['botId', 'sessionId'] : ['botId']) || !ID.test(payload.botId)) throw new TypeError('Invalid device');
        if (endpoint === 'device.session.set' && payload.sessionId !== null && typeof payload.sessionId !== 'string') throw new TypeError('Invalid session');
        value = endpoint === 'device.sessions' ? await controller.deviceSessions(payload.botId)
          : endpoint === 'device.speech.stop' ? await controller.stopSpeech(payload.botId)
          : endpoint === 'device.stop' ? await controller.stopDevice(payload.botId)
          : await controller.bindSession(payload.botId, payload.sessionId);
      } else if (endpoint === 'bot.bind-credentials') {
        return { ok: false, error: { code: 'use-device-binding', message: t('请先在频道页面登录并选择设备。') } };
      } else return common(endpoint, payload, signal);
      return { ok: true, value };
    } catch (error) {
      const message = publicMessage(error);
      if (message) return { ok: false, error: { code: 'xiaoai-operation-failed', message } };
      return { ok: false, error: { code: 'xiaoai-operation-failed', message: t('操作未完成，请检查登录状态、设备和当前会话后重试。') } };
    }
  };
}
export function installXiaoAIRpc(ctx, controller, authority) {
  return registerManagementRpc(ctx, XIAOAI_RPC_CHANNEL, createXiaoAIRpcHandler(controller), { authority: resolveRpcAuthority(authority) });
}
