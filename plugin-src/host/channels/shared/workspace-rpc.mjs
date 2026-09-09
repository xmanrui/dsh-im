import { isAbsolute } from 'node:path';

export const SET_WORKSPACE_ENDPOINT = 'bot.workspace.set';
export const SET_ISOLATE_WORKSPACE_ENDPOINT = 'bot.workspace.isolate.set';
export const SET_ISOLATE_GUIDANCE_ENDPOINT = 'bot.guidance.isolate.set';

export function validWorkspacePayload(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.keys(payload).every((key) => ['botId', 'workspace'].includes(key))
    && typeof payload.botId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)
    && typeof payload.workspace === 'string'
    && payload.workspace.length <= 4_096
    && isAbsolute(payload.workspace.trim());
}

export function publicWorkspaceError(error) {
  if (![
    'workspace-not-absolute',
    'workspace-not-found',
    'workspace-not-directory',
    'workspace-bot-not-found',
    'agent-preset-invalid',
    'agent-preset-unavailable',
    'model-selection-invalid',
    'model-selection-unavailable',
    'model-reasoning-unavailable',
    'context-enhancement-invalid',
  ].includes(error?.code)) return null;
  return { code: error.code, message: error.message };
}

export function validIsolateWorkspacePayload(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.keys(payload).every((key) => ['botId', 'isolateConversationWorkspace'].includes(key))
    && typeof payload.botId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)
    && typeof payload.isolateConversationWorkspace === 'boolean';
}

export function validIsolateGuidancePayload(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.keys(payload).every((key) => ['botId', 'isolateConversationGuidance'].includes(key))
    && typeof payload.botId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)
    && typeof payload.isolateConversationGuidance === 'boolean';
}
