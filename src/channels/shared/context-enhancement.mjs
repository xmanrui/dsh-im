// Shared by the Host and settings UI; keep this module browser-compatible.
export const CONTEXT_ENHANCEMENT_FIELDS = Object.freeze([
  'channel', 'conversationType', 'senderId', 'senderName', 'conversationTitle',
  'chatId', 'threadId', 'botId',
]);

export const CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH = 8_000;
export const CONTEXT_GROUP_GUIDANCE_EXAMPLE = `仅依据当前消息的 <dsh_im_source> 中实际提供的字段理解来源；没有提供的字段不要猜测或补全。
当前消息来自群聊，请使用严肃、克制、简洁的表达方式。`;
export const CONTEXT_DIRECT_GUIDANCE_EXAMPLE = `仅依据当前消息的 <dsh_im_source> 中实际提供的字段理解来源；没有提供的字段不要猜测或补全。
当前消息来自私聊，可以使用更轻松、幽默、详细的表达方式。`;

// Kept for integrations that imported the original combined example.
export const CONTEXT_GUIDANCE_EXAMPLE = `仅依据当前消息的 <dsh_im_source> 中实际提供的字段理解来源；没有提供的字段不要猜测或补全。
conversationType是群聊时回复严肃一点，conversationType是私聊时回复一定要幽默搞笑，像周星驰的电影一样搞笑`;

// Kept as an alias for integrations that imported the original template name.
export const DEFAULT_CONTEXT_GUIDANCE = CONTEXT_GUIDANCE_EXAMPLE;

export const DEFAULT_CONTEXT_ENHANCEMENT_CONFIG = Object.freeze({
  group: Object.freeze({
    enabled: false,
    fields: Object.freeze(['senderId']),
    guidance: '',
  }),
  direct: Object.freeze({
    enabled: false,
    fields: Object.freeze(['senderId']),
    guidance: '',
  }),
});

const CONFIG_KEYS = ['group', 'direct'];
const SCOPE_KEYS = ['enabled', 'fields', 'guidance'];
const LEGACY_CONFIG_KEYS = ['groupEnabled', 'directEnabled', 'fields', 'guidance'];
const CHANNELS = new Set([
  'wecom', 'weixin', 'feishu', 'dingtalk', 'qq',
  'slack', 'telegram', 'discord', 'whatsapp',
]);
const SOURCE_LIMITS = {
  channel: 16, conversationType: 6, senderId: 256, senderName: 256,
  conversationTitle: 256, chatId: 256, threadId: 256, botId: 128,
};
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function invalidConfig(message) {
  const error = new TypeError(message);
  error.code = 'context-enhancement-invalid';
  return error;
}

function hasExactKeys(input, keys) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input))
    && Reflect.ownKeys(input).length === keys.length
    && keys.every((key) => Object.hasOwn(input, key));
}

function validateContextEnhancementScope(input) {
  if (!hasExactKeys(input, SCOPE_KEYS)) {
    throw invalidConfig('请提交完整的上下文增强设置。');
  }
  const { enabled, fields, guidance } = input;
  if (typeof enabled !== 'boolean') {
    throw invalidConfig('群聊和私聊开关必须是布尔值。');
  }
  if (!Array.isArray(fields) || ![...fields].every((field) => CONTEXT_ENHANCEMENT_FIELDS.includes(field))) {
    throw invalidConfig('来源字段只能选择已定义的八个字段。');
  }
  if (typeof guidance !== 'string' || guidance.length > CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH) {
    throw invalidConfig(`增强提示词不得超过 ${CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH} 个字符。`);
  }
  return Object.freeze({
    enabled,
    fields: Object.freeze(CONTEXT_ENHANCEMENT_FIELDS.filter((field) => fields.includes(field))),
    guidance: guidance.trim() ? guidance : '',
  });
}

/** Validate the complete atomic save, preserving explicit empty selections/text. */
export function validateContextEnhancementConfig(input) {
  if (!hasExactKeys(input, CONFIG_KEYS)) {
    throw invalidConfig('请提交完整的上下文增强设置。');
  }
  return Object.freeze({
    group: validateContextEnhancementScope(input.group),
    direct: validateContextEnhancementScope(input.direct),
  });
}

function migrateLegacyContextEnhancementConfig(input) {
  if (!hasExactKeys(input, LEGACY_CONFIG_KEYS)) {
    throw invalidConfig('请提交完整的上下文增强设置。');
  }
  return validateContextEnhancementConfig({
    group: {
      enabled: input.groupEnabled,
      fields: input.fields,
      guidance: input.guidance,
    },
    direct: {
      enabled: input.directEnabled,
      fields: input.fields,
      guidance: input.guidance,
    },
  });
}

/** Missing or damaged enhancement settings must never break an existing bot. */
export function normalizeContextEnhancementConfig(input) {
  try {
    return validateContextEnhancementConfig(input);
  } catch {
    try {
      return migrateLegacyContextEnhancementConfig(input);
    } catch {
      return DEFAULT_CONTEXT_ENHANCEMENT_CONFIG;
    }
  }
}

/** Capture before queueing. The off path reads only the applicable switch. */
export function captureContextEnhancement(provider, conversationType) {
  if (conversationType !== 'group' && conversationType !== 'direct') return null;
  try {
    const settings = provider?.getSettings?.();
    const legacyEnabledKey = conversationType === 'group' ? 'groupEnabled' : 'directEnabled';
    const enabled = Object.hasOwn(settings ?? {}, conversationType)
      ? settings?.[conversationType]?.enabled
      : settings?.[legacyEnabledKey];
    if (enabled !== true) return null;
    const config = normalizeContextEnhancementConfig(settings);
    const scope = config[conversationType];
    if (scope.enabled !== true) return null;
    return Object.freeze({ config: scope, botId: provider.botId, conversationType });
  } catch {
    return null;
  }
}

function sourceString(value, field) {
  if (field === 'senderId' && (typeof value === 'bigint' || Number.isFinite(value))) {
    value = String(value);
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(CONTROL_CHARACTERS, '').trim().slice(0, SOURCE_LIMITS[field]);
  if (!normalized || (field === 'channel' && !CHANNELS.has(normalized))) return undefined;
  return normalized;
}

function sourceBlock(snapshot, sourceFactory) {
  const { fields } = snapshot.config;
  const needsSource = fields.some((field) => [
    'channel', 'senderId', 'senderName', 'conversationTitle', 'chatId', 'threadId',
  ].includes(field));
  const source = needsSource ? sourceFactory?.() : null;
  const projected = {};
  for (const field of fields) {
    const value = field === 'botId' || field === 'conversationType'
      ? snapshot[field] : source?.[field];
    const normalized = sourceString(value, field);
    if (normalized !== undefined) projected[field] = normalized;
  }
  if (Object.keys(projected).length === 0) return '';
  const json = JSON.stringify(projected).replace(/[<>&]/g, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
  })[character]);
  return `<dsh_im_source>${json}</dsh_im_source>`;
}

function guidanceBlock(guidance) {
  if (!guidance.trim()) return '';
  const body = guidance.replace(/<\/?dsh_im_source_guidance\b[^>]*(?:>|$)/gi, (tag) => (
    tag.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  ));
  return `<dsh_im_source_guidance>\n${body}\n</dsh_im_source_guidance>`;
}

/** Add one text prefix; never inspect sources, format or copy content when off. */
export function enhanceContextContent(content, snapshot, sourceFactory) {
  if (!snapshot) return content;
  try {
    const blocks = [sourceBlock(snapshot, sourceFactory), guidanceBlock(snapshot.config.guidance)]
      .filter(Boolean);
    if (blocks.length === 0) return content;
    const prefix = blocks.join('\n\n');
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
    return content;
  } catch {
    // Only enhancement errors are isolated; the caller's original flow proceeds.
    return content;
  }
}
