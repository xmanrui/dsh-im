import { createHash } from 'node:crypto';

/**
 * 投递账号指纹 —— 主动投递链路上「发出去的这条消息，还是当初核对过的那同一个账号吗」的答案。
 *
 * 为什么必须有它：`delivery-service.mjs:582` 用 `account.account.fingerprint !== expectedFingerprint`
 * 判断账号有没有被换过（换过就抛 account-changed）。这不是可选项 —— 指纹对不上时，
 * 一条本该发给 A 的消息会发给 B，所以判据是硬性的，不允许各渠道自己编一个形态。
 *
 * 为什么用身份字段派生而不是「连接成功就返回一个常量」：常量会让所有账号指纹相同，
 * 于是「换绑账号」这个动作在指纹面上不可见 —— 判据还在，但已经失去意义。
 * 这里挑的是各渠道**改绑时必然变化**的身份字段（如 appId / clientId / corpId / botId），
 * 避开了 token 这类会轮换、会过期的凭据（用 token 会导致正常轮换被误判成换绑）。
 *
 * @param {string} provider 渠道名（参与哈希，避免跨渠道撞值）
 * @param {Record<string, unknown>} identity 该渠道的身份字段（undefined 会被跳过）
 * @returns {string} 64 位十六进制，与 delivery-service 的指纹格式一致
 */
export function deliveryAccountFingerprint(provider, identity) {
  // 键排序后再序列化：同一个账号在不同时刻（对象属性插入顺序不同）必须得到同一个指纹，
  // 否则指纹会随「谁先读到哪个字段」变化，制造 account-changed 假阳性。
  const entries = Object.entries(identity ?? {})
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([key, value]) => [key, value.trim()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ provider, identity: entries })).digest('hex');
}

/**
 * 组装 describeDeliveryAccount 的返回值。
 *
 * 三件事在这里定死，各渠道不再各写一遍：
 * 1. `version` 必须是 1（delivery-service 用 `account?.version !== 1` 直接拒绝其它版本）；
 * 2. `capabilities` 只收本渠道**真的兑现得了**的项，未兑现的显式不写；
 * 3. `connected` 反映运行时是否就绪 —— 它不影响能力判定，但影响使用者对「现在能不能发」的判断。
 *
 * @param {object} input
 * @param {string} input.channel
 * @param {string} input.botId
 * @param {string} input.fingerprint
 * @param {boolean} input.connected
 * @param {string[]} input.capabilities
 * @param {object} [input.accountName] 可选展示信息
 * @returns {object}
 */
export function deliveryAccountView({ channel, botId, fingerprint, connected, capabilities, accountName }) {
  return Object.freeze({
    version: 1,
    botId,
    channel,
    account: Object.freeze({
      fingerprint,
      ...(typeof accountName === 'string' && accountName.trim() ? { name: accountName.trim() } : {}),
    }),
    connected: connected === true,
    capabilities: Object.freeze([...capabilities]),
  });
}
