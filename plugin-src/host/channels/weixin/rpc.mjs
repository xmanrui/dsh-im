import QRCode from 'qrcode';
import { SET_CONTEXT_ENHANCEMENT_ENDPOINT, validContextEnhancementPayload } from '../shared/context-enhancement-rpc.mjs';
import { SET_ACCESS_POLICY_ENDPOINT, validAccessPolicyPayload } from '../shared/access-policy-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import {
  publicWorkspaceError,
  SET_WORKSPACE_ENDPOINT,
  validWorkspacePayload,
} from '../shared/workspace-rpc.mjs';
import {
  SET_AGENT_PRESET_ENDPOINT,
  validAgentPresetPayload,
} from '../shared/agent-preset-rpc.mjs';
import {
  MODEL_CATALOG_ENDPOINT,
  publicDefaultModelError,
  SET_DEFAULT_MODEL_ENDPOINT,
  validDefaultModelPayload,
} from '../shared/default-model-rpc.mjs';
import {
  connectionTestTargetUnavailable,
  publicConnectionTestResult,
} from '../../../../src/channels/shared/connection-test.mjs';

export const WEIXIN_RPC_CHANNEL = '/weixin';
export const WEIXIN_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  beginProvisioning: 'provision.begin',
  pollProvisioning: 'provision.poll',
  submitVerification: 'provision.verify',
  cancelProvisioning: 'provision.cancel',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  setWorkspace: SET_WORKSPACE_ENDPOINT,
  setAgentPreset: SET_AGENT_PRESET_ENDPOINT,
  setDefaultModel: SET_DEFAULT_MODEL_ENDPOINT,
  modelCatalog: MODEL_CATALOG_ENDPOINT,
  setContextEnhancement: SET_CONTEXT_ENHANCEMENT_ENDPOINT,
  setAccessPolicy: SET_ACCESS_POLICY_ENDPOINT,
});
export const WEIXIN_RPC_ENDPOINTS = Object.freeze(Object.values(WEIXIN_ENDPOINTS));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function payloadFailure(endpoint, payload) {
  if (!isRecord(payload)) return 'Payload must be an object.';
  if (endpoint === WEIXIN_ENDPOINTS.status) {
    return exactKeys(payload, []) ? null : 'connection.status does not accept fields.';
  }
  if (endpoint === WEIXIN_ENDPOINTS.beginProvisioning) {
    return exactKeys(payload, ['locale']) && (payload.locale === undefined || payload.locale === 'zh-CN')
      ? null
      : 'provision.begin received unsupported fields.';
  }
  if ([WEIXIN_ENDPOINTS.pollProvisioning, WEIXIN_ENDPOINTS.cancelProvisioning].includes(endpoint)) {
    return exactKeys(payload, ['attemptId']) && validId(payload.attemptId)
      ? null
      : `${endpoint} requires an attemptId.`;
  }
  if (endpoint === WEIXIN_ENDPOINTS.submitVerification) {
    return exactKeys(payload, ['attemptId', 'verifyCode'])
      && validId(payload.attemptId)
      && typeof payload.verifyCode === 'string'
      && /^\d{4,8}$/.test(payload.verifyCode)
      ? null
      : 'provision.verify requires an attemptId and a 4-to-8-digit code.';
  }
  if (endpoint === WEIXIN_ENDPOINTS.reconnectBot) {
    return exactKeys(payload, ['botId', 'sendTest'])
      && validId(payload.botId)
      && (payload.sendTest === undefined || payload.sendTest === true)
      ? null
      : 'bot.reconnect requires a botId and optional sendTest=true.';
  }
  if (endpoint === WEIXIN_ENDPOINTS.deleteBot) {
    return exactKeys(payload, ['botId', 'confirm']) && validId(payload.botId) && payload.confirm === true
      ? null
      : 'bot.delete requires a botId and confirm=true.';
  }
  if (endpoint === WEIXIN_ENDPOINTS.setWorkspace) {
    return validWorkspacePayload(payload)
      ? null : '请输入工作区绝对路径。';
  }
  if (endpoint === WEIXIN_ENDPOINTS.setAgentPreset) {
    return validAgentPresetPayload(payload)
      ? null : '请选择 Agent Preset。';
  }
  if (endpoint === WEIXIN_ENDPOINTS.setDefaultModel) {
    return validDefaultModelPayload(payload)
      ? null : '请提交有效的默认模型设置。';
  }
  if (endpoint === WEIXIN_ENDPOINTS.modelCatalog) {
    return exactKeys(payload, []) ? null : 'bot.model.catalog does not accept fields.';
  }
  if (endpoint === WEIXIN_ENDPOINTS.setContextEnhancement) {
    return validContextEnhancementPayload(payload)
      ? null : '请提交有效的上下文增强设置。';
  }
  if (endpoint === WEIXIN_ENDPOINTS.setAccessPolicy) {
    return validAccessPolicyPayload(payload)
      ? null : '请提交有效的访问设置。';
  }
  return 'Unknown Weixin endpoint.';
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message } };
}

function cancelled() {
  return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } };
}

function internalFailure() {
  return {
    ok: false,
    error: { code: 'weixin-operation-failed', message: '微信操作失败，请稍后重试。' },
  };
}

async function qrDataUrl(value) {
  return QRCode.toDataURL(value, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  });
}

async function withEncodedQr(value, encodeQr) {
  if (!value || !value.verificationUrl) return value;
  return {
    ...value,
    qrCodeDataUrl: await encodeQr(value.verificationUrl),
  };
}

async function publicStatus(status, encodeQr) {
  const safe = structuredClone(status);
  if (safe.provisioning) safe.provisioning = await withEncodedQr(safe.provisioning, encodeQr);
  return safe;
}

function assertController(controller) {
  if (!controller
    || typeof controller.status !== 'function'
    || typeof controller.startProvisioning !== 'function'
    || typeof controller.registrationStatus !== 'function'
    || typeof controller.submitVerification !== 'function'
    || typeof controller.cancelProvisioning !== 'function'
    || typeof controller.reconnectBot !== 'function'
    || typeof controller.deleteBot !== 'function') {
    throw new TypeError('A complete Weixin controller is required');
  }
}

export function createWeixinRpcHandler(controller, { encodeQr = qrDataUrl } = {}) {
  assertController(controller);
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
    if (signal?.aborted) return cancelled();
    if (!WEIXIN_RPC_ENDPOINTS.includes(endpoint)) return badRequest('Unknown Weixin endpoint.');
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return badRequest(invalid);

    try {
      let value;
      if (endpoint === WEIXIN_ENDPOINTS.status) {
        value = await publicStatus(await controller.status(), cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.beginProvisioning) {
        const started = await controller.startProvisioning();
        if (signal?.aborted) {
          await controller.cancelProvisioning(started.attemptId);
          return cancelled();
        }
        value = await withEncodedQr(started, cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.pollProvisioning) {
        const current = await controller.registrationStatus(payload.attemptId);
        if (!current) return badRequest('The provisioning attempt no longer exists.');
        value = await withEncodedQr(current, cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.submitVerification) {
        value = await withEncodedQr(
          await controller.submitVerification(payload.attemptId, payload.verifyCode),
          cachedEncode,
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.cancelProvisioning) {
        value = await controller.cancelProvisioning(payload.attemptId);
        if (!value) return badRequest('The provisioning attempt no longer exists.');
      } else if (endpoint === WEIXIN_ENDPOINTS.reconnectBot) {
        const snapshot = await controller.reconnectBot(payload.botId);
        if (signal?.aborted) return cancelled();
        let testMessage;
        if (payload.sendTest === true) {
          const connected = snapshot?.bots?.some(
            (bot) => bot?.botId === payload.botId && bot?.connected === true,
          );
          if (!connected || typeof controller.sendConnectionTest !== 'function') {
            testMessage = publicConnectionTestResult(
              connectionTestTargetUnavailable('微信机器人'),
            );
          } else {
            try {
              await controller.sendConnectionTest(payload.botId);
              testMessage = publicConnectionTestResult();
            } catch (error) {
              testMessage = publicConnectionTestResult(error);
            }
          }
        }
        value = await publicStatus({ ...snapshot, ...(testMessage ? { testMessage } : {}) }, cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.setWorkspace) {
        if (typeof controller.updateWorkspace !== 'function') throw new Error('Workspace update is unavailable');
        value = await publicStatus(
          await controller.updateWorkspace(payload.botId, payload.workspace),
          cachedEncode,
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.setContextEnhancement) {
        if (typeof controller.updateContextEnhancement !== 'function') throw new Error('Context enhancement update is unavailable');
        value = await controller.updateContextEnhancement(
          payload.botId, payload.config, (status) => publicStatus(status, cachedEncode),
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.setAccessPolicy) {
        if (typeof controller.updateAccessPolicy !== 'function') throw new Error('Access policy update is unavailable');
        value = await controller.updateAccessPolicy(
          payload.botId, payload.policy, (status) => publicStatus(status, cachedEncode),
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.setAgentPreset) {
        if (typeof controller.updateAgentPreset !== 'function') throw new Error('Agent preset update is unavailable');
        value = await publicStatus(
          await controller.updateAgentPreset(payload.botId, payload.agentPreset),
          cachedEncode,
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.setDefaultModel) {
        if (typeof controller.updateDefaultModel !== 'function') throw new Error('Default model update is unavailable');
        value = await publicStatus(
          await controller.updateDefaultModel(payload.botId, payload.model),
          cachedEncode,
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.modelCatalog) {
        if (typeof controller.listModelCatalog !== 'function') throw new Error('Model catalog is unavailable');
        value = await controller.listModelCatalog();
      } else {
        value = await publicStatus(await controller.deleteBot(payload.botId), cachedEncode);
      }
      return signal?.aborted ? cancelled() : { ok: true, value };
    } catch (error) {
      const workspaceError = publicWorkspaceError(error) ?? publicDefaultModelError(error);
      return signal?.aborted ? cancelled() : workspaceError
        ? { ok: false, error: workspaceError }
        : internalFailure();
    }
  };
}

export function installWeixinRpc(ctx, controller, options, authority) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== 'function') {
    throw new TypeError('DSH Host Connection RPC is required');
  }
  return ctx.connection.rpc.handle(
    WEIXIN_RPC_CHANNEL,
    createWeixinRpcHandler(controller, options),
    { authority: resolveRpcAuthority(authority) },
  );
}
