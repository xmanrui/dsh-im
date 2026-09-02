import QRCode from 'qrcode';
import {
  connectionTestTargetUnavailable,
  publicConnectionTestResult,
} from '../../../../src/channels/shared/connection-test.mjs';
import { SET_CONTEXT_ENHANCEMENT_ENDPOINT, validContextEnhancementPayload } from '../shared/context-enhancement-rpc.mjs';
import {
  CLEAR_INBOUND_ATTACHMENTS_ENDPOINT,
  SET_INBOUND_RETENTION_ENDPOINT,
  validClearInboundAttachmentsPayload,
  validInboundRetentionPayload,
} from '../shared/inbound-retention-rpc.mjs';
import { SET_ACCESS_POLICY_ENDPOINT, validAccessPolicyPayload } from '../shared/access-policy-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { publicWorkspaceError, SET_WORKSPACE_ENDPOINT, validWorkspacePayload } from '../shared/workspace-rpc.mjs';
import { SET_AGENT_PRESET_ENDPOINT, validAgentPresetPayload } from '../shared/agent-preset-rpc.mjs';

export const QQ_RPC_CHANNEL = '/qq';
export const QQ_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  beginProvisioning: 'provision.begin',
  pollProvisioning: 'provision.poll',
  cancelProvisioning: 'provision.cancel',
  bindCredentials: 'bot.bind-credentials',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  setWorkspace: SET_WORKSPACE_ENDPOINT,
  setAgentPreset: SET_AGENT_PRESET_ENDPOINT,
  setContextEnhancement: SET_CONTEXT_ENHANCEMENT_ENDPOINT,
  setInboundRetention: SET_INBOUND_RETENTION_ENDPOINT,
  clearInboundAttachments: CLEAR_INBOUND_ATTACHMENTS_ENDPOINT,
  setAccessPolicy: SET_ACCESS_POLICY_ENDPOINT,
});
export const QQ_RPC_ENDPOINTS = Object.freeze(Object.values(QQ_ENDPOINTS));

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'appSecret', 'app_secret', 'secretRef', 'ownerUserOpenid', 'userOpenid', 'verificationUrl',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validCredential(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function payloadFailure(endpoint, payload) {
  if (!isRecord(payload)) return 'Payload must be an object.';
  if (endpoint === QQ_ENDPOINTS.status) return exactKeys(payload, []) ? null : 'connection.status does not accept fields.';
  if (endpoint === QQ_ENDPOINTS.beginProvisioning) {
    return exactKeys(payload, ['locale']) && (payload.locale === undefined || payload.locale === 'zh-CN')
      ? null : 'provision.begin received unsupported fields.';
  }
  if ([QQ_ENDPOINTS.pollProvisioning, QQ_ENDPOINTS.cancelProvisioning].includes(endpoint)) {
    return exactKeys(payload, ['attemptId']) && validId(payload.attemptId)
      ? null : `${endpoint} requires an attemptId.`;
  }
  if (endpoint === QQ_ENDPOINTS.bindCredentials) {
    return exactKeys(payload, ['appId', 'appSecret'])
      && validCredential(payload.appId, 256)
      && validCredential(payload.appSecret, 1024)
      ? null : 'bot.bind-credentials requires AppID and AppSecret.';
  }
  if (endpoint === QQ_ENDPOINTS.reconnectBot) {
    return exactKeys(payload, ['botId', 'sendTest'])
      && validId(payload.botId)
      && (payload.sendTest === undefined || payload.sendTest === true)
      ? null : 'bot.reconnect requires a botId and accepts only sendTest=true.';
  }
  if (endpoint === QQ_ENDPOINTS.deleteBot) {
    return exactKeys(payload, ['botId', 'confirm']) && validId(payload.botId) && payload.confirm === true
      ? null : 'bot.delete requires a botId and confirm=true.';
  }
  if (endpoint === QQ_ENDPOINTS.setWorkspace) {
    return validWorkspacePayload(payload)
      ? null : '请输入工作区绝对路径。';
  }
  if (endpoint === QQ_ENDPOINTS.setAgentPreset) {
    return validAgentPresetPayload(payload)
      ? null : '请选择 Agent Preset。';
  }
  if (endpoint === QQ_ENDPOINTS.setContextEnhancement) {
    return validContextEnhancementPayload(payload)
      ? null : '请提交有效的上下文增强设置。';
  }
  if (endpoint === QQ_ENDPOINTS.setInboundRetention) {
    return validInboundRetentionPayload(payload)
      ? null : '请提交有效的附件保留设置。';
  }
  if (endpoint === QQ_ENDPOINTS.clearInboundAttachments) {
    return validClearInboundAttachmentsPayload(payload)
      ? null : 'qq.inbound-attachments.clear requires a botId.';
  }
  if (endpoint === QQ_ENDPOINTS.setAccessPolicy) {
    return validAccessPolicyPayload(payload)
      ? null : '请提交有效的访问设置。';
  }
  return 'Unknown QQ endpoint.';
  }

function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic);
  if (!isRecord(value)) return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (!FORBIDDEN_PUBLIC_KEYS.has(key)) safe[key] = sanitizePublic(child);
  }
  return safe;
}

async function qrDataUrl(value) {
  return QRCode.toDataURL(value, {
    type: 'image/png', errorCorrectionLevel: 'M', margin: 2, width: 320,
  });
}

async function withEncodedQr(value, encodeQr) {
  if (!value || typeof value.verificationUrl !== 'string') return sanitizePublic(value);
  return sanitizePublic({ ...value, qrCodeDataUrl: await encodeQr(value.verificationUrl) });
}

async function publicStatus(status, encodeQr) {
  const value = structuredClone(status);
  if (value?.provisioning) value.provisioning = await withEncodedQr(value.provisioning, encodeQr);
  return sanitizePublic(value);
}

export function createQqRpcHandler(controller, { encodeQr = qrDataUrl } = {}) {
  for (const method of ['status', 'startProvisioning', 'registrationStatus', 'cancelProvisioning', 'bindCredentials', 'reconnectBot', 'deleteBot']) {
    if (typeof controller?.[method] !== 'function') throw new TypeError(`A complete QQ controller is required (${method})`);
  }
  const qrCache = new Map();
  const cachedEncode = (url) => {
    let encoded = qrCache.get(url);
    if (!encoded) {
      if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
      encoded = Promise.resolve().then(() => encodeQr(url));
      qrCache.set(url, encoded);
    }
    return encoded;
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } };
    if (!QQ_RPC_ENDPOINTS.includes(endpoint)) return { ok: false, error: { code: 'bad-request', message: 'Unknown QQ endpoint.' } };
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return { ok: false, error: { code: 'bad-request', message: invalid } };
    try {
      let value;
      if (endpoint === QQ_ENDPOINTS.status) value = await publicStatus(await controller.status(), cachedEncode);
      else if (endpoint === QQ_ENDPOINTS.beginProvisioning) value = await withEncodedQr(await controller.startProvisioning(), cachedEncode);
      else if (endpoint === QQ_ENDPOINTS.pollProvisioning) {
        const current = await controller.registrationStatus(payload.attemptId);
        if (!current) return { ok: false, error: { code: 'bad-request', message: 'The provisioning attempt no longer exists.' } };
        value = await withEncodedQr(current, cachedEncode);
      } else if (endpoint === QQ_ENDPOINTS.cancelProvisioning) {
        value = sanitizePublic(await controller.cancelProvisioning(payload.attemptId));
      } else if (endpoint === QQ_ENDPOINTS.bindCredentials) {
        value = await publicStatus(await controller.bindCredentials(payload), cachedEncode);
      } else if (endpoint === QQ_ENDPOINTS.reconnectBot) {
        const snapshot = await controller.reconnectBot(payload.botId);
        if (signal?.aborted) {
          return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } };
        }
        let testMessage;
        if (payload.sendTest === true) {
          const connected = snapshot?.bots?.some(
            (bot) => bot?.botId === payload.botId && bot?.connected === true,
          ) === true;
          if (!connected || typeof controller.sendConnectionTest !== 'function') {
            testMessage = publicConnectionTestResult(
              connectionTestTargetUnavailable('QQ机器人'),
            );
          } else {
            let testError = null;
            try {
              await controller.sendConnectionTest(payload.botId);
            } catch (error) {
              testError = error;
            }
            testMessage = publicConnectionTestResult(testError);
          }
        }
        value = await publicStatus({
          ...snapshot,
          ...(testMessage ? { testMessage } : {}),
        }, cachedEncode);
      } else if (endpoint === QQ_ENDPOINTS.setWorkspace) {
        if (typeof controller.updateWorkspace !== 'function') throw new Error('Workspace update is unavailable');
        value = await publicStatus(
          await controller.updateWorkspace(payload.botId, payload.workspace),
          cachedEncode,
        );
      } else if (endpoint === QQ_ENDPOINTS.setContextEnhancement) {
        if (typeof controller.updateContextEnhancement !== 'function') throw new Error('Context enhancement update is unavailable');
        value = await controller.updateContextEnhancement(
          payload.botId, payload.config, (status) => publicStatus(status, cachedEncode),
        );
      } else if (endpoint === QQ_ENDPOINTS.setInboundRetention) {
        if (typeof controller.updateInboundRetention !== 'function') throw new Error('Inbound retention update is unavailable');
        value = await controller.updateInboundRetention(payload.botId, payload.retention);
      } else if (endpoint === QQ_ENDPOINTS.clearInboundAttachments) {
        if (typeof controller.clearInboundAttachments !== 'function') throw new Error('Attachment cleanup is unavailable');
        value = await controller.clearInboundAttachments(payload.botId);
      } else if (endpoint === QQ_ENDPOINTS.setAccessPolicy) {
        if (typeof controller.updateAccessPolicy !== 'function') throw new Error('Access policy update is unavailable');
        value = await controller.updateAccessPolicy(
          payload.botId, payload.policy, (status) => publicStatus(status, cachedEncode),
        );
      } else if (endpoint === QQ_ENDPOINTS.setAgentPreset) {
        if (typeof controller.updateAgentPreset !== 'function') throw new Error('Agent preset update is unavailable');
        value = await publicStatus(
          await controller.updateAgentPreset(payload.botId, payload.agentPreset),
          cachedEncode,
        );
      } else {
        value = await publicStatus(await controller.deleteBot(payload.botId), cachedEncode);
      }
      return signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: true, value };
    } catch (error) {
      const workspaceError = publicWorkspaceError(error);
      return signal?.aborted
        ? { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } }
        : { ok: false, error: workspaceError
          ?? { code: 'qq-operation-failed', message: 'QQ 操作失败，请稍后重试。' } };
    }
  };
}

export function installQqRpc(ctx, controller, options, authority) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== 'function') {
    throw new TypeError('DSH Host Connection RPC is required');
  }
  return ctx.connection.rpc.handle(
    QQ_RPC_CHANNEL,
    createQqRpcHandler(controller, options),
    { authority: resolveRpcAuthority(authority) },
  );
}
