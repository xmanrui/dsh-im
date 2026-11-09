// QQ 审批卡片：把审批渲染成图片 + 批准/拒绝按钮。
// 纯文本审批会把整个参数 JSON 铺满屏幕（prompt 动辄几千字），
// 图片只占一个缩略图，按钮省掉打字。

import { t } from '../shared/i18n.mjs';
import { renderTextImages } from '../shared/text-image.mjs';

const ARGUMENT_PREVIEW_LIMIT = 6;
const VALUE_PREVIEW_CHARS = 72;
const APPROVAL_ACCENT = '#b4534b';

/**
 * 参数 JSON 拆成可读的 key: value 行。
 * 审批要判断的是"改了什么对象"，不是逐字读完 prompt，所以长值截断。
 */
function summarizeArguments(toolCall) {
  const raw = toolCall?.arguments;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return raw.trim().split('\n').slice(0, ARGUMENT_PREVIEW_LIMIT).map((line) =>
      (line.length > VALUE_PREVIEW_CHARS ? `${line.slice(0, VALUE_PREVIEW_CHARS)}…` : line));
  }
  const keys = Object.keys(parsed);
  const lines = keys.slice(0, ARGUMENT_PREVIEW_LIMIT).map((key) => {
    const value = parsed[key];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
    return `${key}: ${flat.length > VALUE_PREVIEW_CHARS ? `${flat.slice(0, VALUE_PREVIEW_CHARS)}…` : flat}`;
  });
  if (keys.length > ARGUMENT_PREVIEW_LIMIT) lines.push(t('…另有 {count} 个参数', { count: keys.length - ARGUMENT_PREVIEW_LIMIT }));
  return lines;
}

/** 卡片正文：工具、原因、参数摘要，其余细节交给 Web 端。 */
export function approvalCardText(pending) {
  const payload = pending?.interaction?.payload ?? {};
  const toolName = String(pending?.toolCall?.name ?? payload.toolName ?? '');
  const lines = [t('🔐 需要审批'), '', t('工具：{tool}', { tool: toolName })];
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (reason) lines.push(t('原因：{reason}', { reason }));
  lines.push('', t('操作参数：'));
  const summary = summarizeArguments(pending?.toolCall);
  if (summary.length === 0) lines.push(t('（无参数）'));
  else lines.push(...summary);
  return lines.join('\n');
}

function keyboardButton(id, label, data, style) {
  return {
    id,
    render_data: { label, visited_label: t('已处理'), style },
    action: {
      type: 2,
      permission: { type: 2 },
      data,
      enter: true,
      unsupport_tips: t('请回复「批准」或「拒绝」。'),
    },
  };
}

/** 批准 / 拒绝按钮：点击等同于用户回复对应文字，复用既有审批协议。 */
export function approvalKeyboard() {
  return {
    content: {
      rows: [{
        buttons: [
          keyboardButton('approve', t('✅ 批准'), '批准', 1),
          keyboardButton('reject', t('❌ 拒绝'), '拒绝', 2),
        ],
      }],
    },
  };
}

/**
 * 发送审批卡片。图片失败时回退到带按钮的文本，按钮始终在。
 * 返回是否成功发出（图片或文本）。
 */
export async function sendApprovalCard(bot, target, pending, { logger } = {}) {
  const keyboard = approvalKeyboard();
  const cardText = approvalCardText(pending);
  if (typeof bot?.sendImage === 'function' && typeof bot?.send === 'function') {
    try {
      const { images } = await renderTextImages(cardText, {
        maxImages: 1,
        accent: APPROVAL_ACCENT,
        titleFirst: true,
      });
      if (images.length > 0) {
        await bot.sendImage(target, { buffer: images[0] });
        await bot.send({
          target,
          msgType: 2,
          markdown: { content: t('请选择：') },
          keyboard,
        });
        return true;
      }
    } catch (error) {
      logger?.warn?.('[dsh-im:qq] approval card failed; falling back to text:', error);
    }
  }
  if (typeof bot?.send === 'function') {
    await bot.send({
      target,
      msgType: 2,
      markdown: { content: cardText.replace(/[\\`*_{}\[\]()<>#|!]/gu, '\\$&') },
      keyboard,
    });
    return true;
  }
  // 连按钮都发不出去时，必须把回复方式写回正文，否则用户无从下手
  await bot.sendText(target, `${cardText}\n\n${t('请精准回复「批准」或「拒绝」（也支持：同意 / 不同意 / yes / no）。')}`);
  return true;
}
