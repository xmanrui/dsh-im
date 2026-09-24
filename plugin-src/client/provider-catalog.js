/**
 * The Lobe-style provider list (issue #247 (h)) needs one status fact per
 * channel to decide which group a card belongs to and which badge it shows.
 *
 * Every channel already answers `connection.status` on its own RPC channel, but
 * each one unwraps and normalizes the payload differently (Feishu returns a bot
 * list, AI Office returns a connector snapshot, the token channels share one
 * normalizer). This module is the single place that knows that mapping, so the
 * settings page never hard-codes per-channel response shapes.
 *
 * The probe is best-effort: a closed or unimplemented channel resolves to
 * `null` and its card simply shows no badge.
 */

import { DINGTALK_ENDPOINTS, normalizeSnapshot as normalizeDingtalk, unwrapRpcResult as unwrapDingtalk } from './channels/dingtalk/api.js';
import { FEISHU_ENDPOINTS, normalizeBotsSnapshot, unwrapRpcResult as unwrapFeishu } from './channels/feishu/api.js';
import { QQ_ENDPOINTS, normalizeSnapshot as normalizeQq, unwrapRpcResult as unwrapQq } from './channels/qq/api.js';
import { WECOM_ENDPOINTS, normalizeSnapshot as normalizeWecom, unwrapRpcResult as unwrapWecom } from './channels/wecom/api.js';
import { WECOM_APP_ENDPOINTS, normalizeSnapshot as normalizeWecomApp, unwrapRpcResult as unwrapWecomApp } from './channels/wecom-app/api.js';
import { WEIXIN_ENDPOINTS, normalizeSnapshot as normalizeWeixin, unwrapRpcResult as unwrapWeixin } from './channels/weixin/api.js';
import { WHATSAPP_ENDPOINTS, normalizeSnapshot as normalizeWhatsapp, unwrapRpcResult as unwrapWhatsapp } from './channels/whatsapp/api.js';
import { normalizeOfficeStatus, OFFICE_RPC_ENDPOINTS, unwrapOfficeRpc } from './channels/office/api.js';
import { discordClientApi, DISCORD_ENDPOINTS } from './channels/discord/api.js';
import { emailClientApi, EMAIL_ENDPOINTS } from './channels/email/api.js';
import { imessageClientApi, IMESSAGE_ENDPOINTS } from './channels/imessage/api.js';
import { matrixClientApi, MATRIX_ENDPOINTS } from './channels/matrix/api.js';
import { slackClientApi, SLACK_ENDPOINTS } from './channels/slack/api.js';
import { telegramClientApi, TELEGRAM_ENDPOINTS } from './channels/telegram/api.js';

/**
 * Read `{ configured, connected }` out of every snapshot dialect.
 * @returns `{ configured, connected }`, or `null` when the payload says nothing.
 */
function readTotals(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  if (snapshot.totals && typeof snapshot.totals === 'object') {
    return {
      configured: Number(snapshot.totals.configured) || 0,
      connected: Number(snapshot.totals.connected) || 0,
    };
  }
  // AI Office reports the two booleans directly instead of a totals block.
  if (typeof snapshot.configured === 'boolean') {
    return {
      configured: snapshot.configured ? 1 : 0,
      connected: snapshot.connected === true ? 1 : 0,
    };
  }
  return null;
}

/**
 * The token channels all share `createTokenChannelApi`, so one entry shape
 * feeds eight channels.
 */
function tokenProbe(endpoints, api) {
  return Object.freeze({
    endpoint: endpoints.status,
    unwrap: api.unwrapRpcResult,
    normalize: api.normalizeSnapshot,
  });
}

/**
 * channel id -> how to ask it for its connection state.
 * Keys mirror the `CHANNELS` ids in `index.js`.
 */
export const PROVIDER_STATUS_PROBES = Object.freeze({
  weixin: Object.freeze({
    endpoint: WEIXIN_ENDPOINTS.status, unwrap: unwrapWeixin, normalize: normalizeWeixin,
  }),
  feishu: Object.freeze({
    endpoint: FEISHU_ENDPOINTS.status, unwrap: unwrapFeishu, normalize: normalizeBotsSnapshot,
  }),
  dingtalk: Object.freeze({
    endpoint: DINGTALK_ENDPOINTS.status, unwrap: unwrapDingtalk, normalize: normalizeDingtalk,
  }),
  wecom: Object.freeze({
    endpoint: WECOM_ENDPOINTS.status, unwrap: unwrapWecom, normalize: normalizeWecom,
  }),
  qq: Object.freeze({
    endpoint: QQ_ENDPOINTS.status, unwrap: unwrapQq, normalize: normalizeQq,
  }),
  slack: tokenProbe(SLACK_ENDPOINTS, slackClientApi),
  telegram: tokenProbe(TELEGRAM_ENDPOINTS, telegramClientApi),
  discord: tokenProbe(DISCORD_ENDPOINTS, discordClientApi),
  whatsapp: Object.freeze({
    endpoint: WHATSAPP_ENDPOINTS.status, unwrap: unwrapWhatsapp, normalize: normalizeWhatsapp,
  }),
  wecomApp: Object.freeze({
    endpoint: WECOM_APP_ENDPOINTS.status,
    unwrap: unwrapWecomApp,
    normalize: normalizeWecomApp,
  }),
  imessage: tokenProbe(IMESSAGE_ENDPOINTS, imessageClientApi),
  email: tokenProbe(EMAIL_ENDPOINTS, emailClientApi),
  matrix: tokenProbe(MATRIX_ENDPOINTS, matrixClientApi),
  office: Object.freeze({
    endpoint: OFFICE_RPC_ENDPOINTS.status,
    unwrap: unwrapOfficeRpc,
    normalize: normalizeOfficeStatus,
  }),
});

/**
 * Ask one channel for its totals.
 * @param rpcCall the channel's `(endpoint, payload, signal) => Promise` bridge.
 * @returns `{ configured, connected }` or `null` (unsupported / closed / not ready).
 */
export async function probeProviderStatus(channel, rpcCall, signal) {
  const probe = PROVIDER_STATUS_PROBES[channel];
  if (!probe || typeof rpcCall !== 'function') return null;
  try {
    const snapshot = probe.normalize(probe.unwrap(await rpcCall(probe.endpoint, {}, signal)));
    return readTotals(snapshot);
  } catch {
    // A channel that is closed, unimplemented, or briefly unreachable simply has
    // no badge; it must never break the provider list.
    return null;
  }
}
