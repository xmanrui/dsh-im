import { t } from './i18n.mjs';

/**
 * Per-bot default model selections. A selection names the provider and model
 * (plus an optional reasoning effort) that new harness sessions for one bot
 * start with, mirroring how agent presets scope a bot's new sessions.
 */

/** Matches harness provider, model, and reasoning-effort component ids. */
export const MODEL_COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

export function normalizeDefaultModelSelection(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !['provider', 'model', 'reasoningEffort'].includes(key))) {
    return null;
  }
  if (typeof value.provider !== 'string' || !MODEL_COMPONENT_ID.test(value.provider)) return null;
  if (typeof value.model !== 'string' || !MODEL_COMPONENT_ID.test(value.model)) return null;
  if (value.reasoningEffort !== undefined
    && (typeof value.reasoningEffort !== 'string'
      || !MODEL_COMPONENT_ID.test(value.reasoningEffort))) return null;
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  };
}

export function validateDefaultModelSelection(value) {
  if (value == null || value === '') return null;
  const selection = normalizeDefaultModelSelection(value);
  if (!selection) {
    const error = new Error(t('默认模型配置无效。'));
    error.code = 'default-model-invalid';
    throw error;
  }
  return selection;
}

export function sameDefaultModelSelection(left, right) {
  return left?.provider === right?.provider
    && left?.model === right?.model
    && left?.reasoningEffort === right?.reasoningEffort;
}

export function defaultModelSelectionText(selection) {
  if (!selection?.provider || !selection?.model) return '';
  const id = `${selection.provider}/${selection.model}`;
  return selection.reasoningEffort === undefined
    ? id
    : `${id} · reasoningEffort=${selection.reasoningEffort}`;
}

/** Whether a selection resolves to a model inside a normalized catalog. */
export function modelInCatalog(catalog, selection) {
  if (!selection || !catalog || !Array.isArray(catalog.groups)) return false;
  const group = catalog.groups.find((candidate) => candidate?.id === selection.provider);
  return Boolean(group?.models?.some((model) => model?.id === selection.model));
}

export function defaultModelUnavailableError(selection) {
  const error = new Error(t('默认模型不存在或当前不可用：{model}', {
    model: defaultModelSelectionText(selection),
  }));
  error.code = 'default-model-unavailable';
  error.selection = selection;
  return error;
}

export function modelCatalogUnavailableError(cause) {
  const error = new Error(t('暂时无法获取模型列表，请稍后重试。'));
  error.code = 'model-catalog-unavailable';
  if (cause) error.cause = cause;
  return error;
}

/**
 * Wrap a model-catalog loader with a short-lived cache so status-heavy RPC
 * surfaces (settings panels) do not re-query the harness on every request.
 * Failures are never cached.
 */
export function cachedModelCatalog(loader, { ttlMs = 60_000 } = {}) {
  let cached = null;
  let expiresAt = 0;
  let inflight = null;
  return async () => {
    if (cached && expiresAt > Date.now()) return cached;
    if (!inflight) {
      const load = (async () => {
        const value = await loader();
        cached = value;
        expiresAt = Date.now() + ttlMs;
        return value;
      })();
      const settle = () => {
        if (inflight === load) inflight = null;
      };
      load.then(settle, settle);
      inflight = load;
    }
    return inflight;
  };
}
