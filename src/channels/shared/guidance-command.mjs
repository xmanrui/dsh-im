import { CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH } from './context-enhancement.mjs';
import { t } from './i18n.mjs';

const GUIDANCE_COMMAND = /^\/(?:guidance|prompt)(?:\s+([\s\S]+))?$/iu;
const CLEAR_FLAGS = new Set(['--clear', '--default']);
const NONE_FLAGS = new Set(['--none', '--empty']);
const USAGE = [
  '用法：',
  '/guidance  查看当前增强提示词',
  '/guidance 提示词正文  设置增强提示词',
  '/guidance --clear  清除覆盖，跟随默认',
  '/guidance --none  当前聊天不附加增强提示词',
].join('\n');

function commandResult(message) {
  return { handled: true, message, messages: [message] };
}

function conversationTypeFromKey(conversationKey) {
  if (typeof conversationKey === 'string'
    && (conversationKey.startsWith('p2p:') || conversationKey.startsWith('direct:'))) {
    return 'direct';
  }
  return 'group';
}

function scopeLabel(conversationType) {
  return conversationType === 'direct' ? t('私聊') : t('群聊');
}

function preview(guidance) {
  return typeof guidance === 'string' && guidance ? guidance : '';
}

function isolated(harness) {
  return typeof harness?.isolateConversationGuidance === 'function'
    && harness.isolateConversationGuidance() === true;
}

function botGuidance(harness, conversationType) {
  const config = typeof harness?.contextEnhancement === 'function'
    ? harness.contextEnhancement()
    : null;
  const value = config?.[conversationType]?.guidance;
  return typeof value === 'string' ? value : '';
}

function effectiveGuidance(harness, conversationKey, conversationType) {
  if (isolated(harness) && conversationKey
    && typeof harness.conversationGuidance === 'function') {
    const override = harness.conversationGuidance(conversationKey);
    if (override !== undefined && override !== null) {
      return { guidance: typeof override === 'string' ? override : '', overridden: true };
    }
  }
  return { guidance: botGuidance(harness, conversationType), overridden: false };
}

export function isGuidanceCommand(text) {
  return typeof text === 'string' && GUIDANCE_COMMAND.test(text.trim());
}

export async function runGuidanceCommand(text, harness, conversationKey) {
  if (!isGuidanceCommand(text)) return null;
  const remainder = GUIDANCE_COMMAND.exec(text.trim())?.[1] ?? '';
  const trimmed = remainder.trim();
  const conversationType = conversationTypeFromKey(conversationKey);
  const isolate = isolated(harness);

  if (!trimmed) {
    const { guidance, overridden } = effectiveGuidance(harness, conversationKey, conversationType);
    if (!guidance) {
      return commandResult([
        t('当前没有增强提示词。'),
        t(USAGE),
      ].join('\n'));
    }
    if (isolate) {
      return commandResult(overridden
        ? t('当前聊天的增强提示词（本聊天覆盖）：\n{guidance}', { guidance })
        : t('当前聊天的增强提示词（跟随机器人默认）：\n{guidance}', { guidance }));
    }
    return commandResult(t('整台机器人的{scope}增强提示词：\n{guidance}', {
      scope: scopeLabel(conversationType),
      guidance,
    }));
  }

  if (typeof harness?.setConversationGuidance !== 'function') {
    return commandResult(t('当前机器人暂不支持设置增强提示词。'));
  }

  try {
    if (CLEAR_FLAGS.has(trimmed.toLowerCase())) {
      if (isolate) {
        if (typeof harness.clearConversationGuidance === 'function') {
          await harness.clearConversationGuidance(conversationKey);
        }
        return commandResult(t('当前聊天已改回跟随默认增强提示词。'));
      }
      await harness.setConversationGuidance(conversationKey, '', conversationType);
      return commandResult(t('已清除整台机器人的{scope}增强提示词。开启「按聊天隔离提示词」后，/guidance 只影响当前聊天。', {
        scope: scopeLabel(conversationType),
      }));
    }

    const next = NONE_FLAGS.has(trimmed.toLowerCase()) ? '' : remainder.replace(/^\s+/u, '');
    if (next.length > CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH) {
      return commandResult(t('增强提示词不得超过 {max} 个字符。', {
        max: CONTEXT_ENHANCEMENT_GUIDANCE_MAX_LENGTH,
      }));
    }
    await harness.setConversationGuidance(conversationKey, next, conversationType);
    if (isolate) {
      return commandResult(next
        ? t('当前聊天的增强提示词已更新。')
        : t('当前聊天已改为不附加增强提示词。'));
    }
    return commandResult(next
      ? t('已更新整台机器人的{scope}增强提示词。开启「按聊天隔离提示词」后，/guidance 只影响当前聊天。', {
        scope: scopeLabel(conversationType),
      })
      : t('已清除整台机器人的{scope}增强提示词。开启「按聊天隔离提示词」后，/guidance 只影响当前聊天。', {
        scope: scopeLabel(conversationType),
      }));
  } catch (error) {
    if (error?.code === 'workspace-bot-not-found') {
      return commandResult(t('机器人正在移除或已重新接入，无法修改原会话的增强提示词。'));
    }
    if (error?.code === 'context-enhancement-invalid') {
      return commandResult(error.message);
    }
    throw error;
  }
}

export { preview as guidancePreview };
