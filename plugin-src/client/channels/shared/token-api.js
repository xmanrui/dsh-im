import { normalizeAgentPresetCatalog, normalizeAgentPresetId, SET_AGENT_PRESET_ENDPOINT } from '../../agent-preset.js';
import { normalizeLastMessageError } from '../../last-message-error.js';
import { normalizeAccessPolicy } from '../../../../src/channels/shared/access-policy.mjs';
import { normalizeContextEnhancementConfig } from '../../../../src/channels/shared/context-enhancement.mjs';
import { normalizeInboundRetention } from '../../../../src/channels/shared/inbound-retention.mjs';

const ACCOUNT_STATES = new Set(['connected', 'connecting', 'offline', 'error']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback, max = 240) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function id(value) {
  const result = text(value, '', 128);
  return /^[a-z\d_-]+$/i.test(result) ? result : undefined;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

export const TOKEN_BOT_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  bindCredentials: 'bot.bind-credentials',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  setWorkspace: 'bot.workspace.set',
  setAgentPreset: SET_AGENT_PRESET_ENDPOINT,
  setContextEnhancement: 'bot.context-enhancement.set',
  setAccessPolicy: 'bot.access-policy.set',
  setInboundRetention: 'bot.inbound-retention.set',
  clearInboundAttachments: 'bot.inbound-attachments.clear',
});

export function createTokenChannelApi(channel, connectionSummary, {
  normalizeBotExtension = () => ({}),
} = {}) {
  const unwrapRpcResult = (result) => {
    if (!isRecord(result) || typeof result.ok !== 'boolean') {
      throw new Error(`${channel} 服务返回了无法识别的响应`);
    }
    if (!result.ok) {
      const error = new Error(text(result.error?.message, `${channel} 操作失败`));
      error.code = text(result.error?.code, `${channel.toUpperCase()}_RPC_ERROR`, 80);
      throw error;
    }
    return result.value;
  };

  const normalizeBot = (value) => {
    if (!isRecord(value) || !id(value.botId)) return undefined;
    const connected = value.connected === true;
    const state = ACCOUNT_STATES.has(value.state) ? value.state : 'offline';
    const extension = normalizeBotExtension(value);
    return {
      botId: id(value.botId),
      connected,
      state: connected ? 'connected' : state,
      workspace: text(value.workspace, '', 4_096),
      agentPreset: normalizeAgentPresetId(value.agentPreset),
      contextEnhancement: normalizeContextEnhancementConfig(value.contextEnhancement),
      inboundRetention: normalizeInboundRetention(value.inboundRetention) ?? 'turn',
      ...(Object.hasOwn(value, 'accessPolicy')
        ? { accessPolicy: normalizeAccessPolicy(value.accessPolicy) }
        : {}),
      bot: {
        name: text(value.bot?.name, `${channel}机器人`, 100),
        username: text(value.bot?.username, '', 100),
        idMasked: text(value.bot?.idMasked, '机器人标识已安全保存', 140),
      },
      health: {
        summary: text(
          value.health?.summary,
          connected ? `${channel}${connectionSummary}运行正常` : `${channel}连接尚未就绪`,
        ),
        lastCheckedAt: timestamp(value.health?.lastCheckedAt),
      },
      lastMessageError: normalizeLastMessageError(value.lastMessageError),
      error: isRecord(value.error) ? {
        code: text(value.error.code, `${channel.toUpperCase()}_ACCOUNT_ERROR`, 80),
        message: text(value.error.message, `${channel}连接尚未就绪`),
      } : null,
      ...(isRecord(extension) ? extension : {}),
    };
  };

  const normalizeSnapshot = (value) => {
    const source = isRecord(value?.snapshot) ? value.snapshot : value;
    if (!isRecord(source) || !Array.isArray(source.bots)) {
      throw new Error(`${channel} 服务没有返回有效的机器人列表`);
    }
    const bots = source.bots.map(normalizeBot).filter(Boolean);
    return {
      revision: Number.isSafeInteger(source.revision) ? source.revision : 0,
      bots,
      totals: { configured: bots.length, connected: bots.filter((bot) => bot.connected).length },
      agentPresetCatalog: normalizeAgentPresetCatalog(source.agentPresetCatalog),
    };
  };

  const presentError = (error) => ({
    code: text(error?.code, `${channel.toUpperCase()}_ERROR`, 80),
    message: text(error?.message, `${channel}操作失败，请稍后重试`),
  });

  return Object.freeze({ unwrapRpcResult, normalizeSnapshot, presentError });
}
