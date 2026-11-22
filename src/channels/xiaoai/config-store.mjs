import { createHash } from 'node:crypto';
import { TokenBotConfigStore, deriveTokenBotIdentity, maskPlatformId } from '../shared/token-config-store.mjs';
const OPTIONS = { botPrefix: 'xiaoai', tokenRefPrefix: 'DSH_XIAOAI_CREDENTIAL' };
export const XIAOAI_DESCRIPTOR = Object.freeze({ key: 'xiaoai', label: 'XiaoAI', connectionLabel: '小米云连接' });
export const deriveXiaoAIIdentity = (id) => deriveTokenBotIdentity(id, OPTIONS);
export const maskXiaoAIId = (id) => maskPlatformId(id, '小爱音箱');
export function parseCredential(token) {
  let value;
  try { value = JSON.parse(token); } catch { throw new TypeError('Invalid Xiaomi credential'); }
  // `password` is intentionally optional: the per-device credential is backed
  // by the copied passToken and must not retain the account password. Only the
  // short-lived interactive login worker holds it in memory.
  if (!value || ['account', 'accountId', 'deviceId', 'hardware', 'name'].some((key) => typeof value[key] !== 'string' || !value[key])
    || (value.password !== undefined && (typeof value.password !== 'string' || value.password.length > 512))
    || !/^[a-f0-9]{24}$/.test(value.accountId) || !/^[^\s:\u0000-\u001f]{1,256}$/u.test(value.deviceId)
    || value.keyword !== undefined && (typeof value.keyword !== 'string' || !value.keyword.trim() || value.keyword.length > 80 || /[\u0000-\u001f]/u.test(value.keyword))) throw new TypeError('Incomplete Xiaomi device credential');
  return value;
}
export class XiaoAIConfigStore extends TokenBotConfigStore {
  constructor(path) { super(path, { channel: 'XiaoAI', ...OPTIONS }); }
}
