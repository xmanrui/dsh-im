/**
 * 内置 dsh_im_push_media 工具 — 把本地文件主动推送到已保存的 IM 投递目标。
 *
 * 与 dsh_im_return_file 的区别：后者只在本轮有 IM 投递消费者时可用（即真实
 * IM 入站 turn），本工具直接走主动投递服务，定时任务等没有会话来源的调用方
 * 也能把图片/文件发到手机。
 */

export const PUSH_MEDIA_TOOL_NAME = 'dsh_im_push_media';

const DESCRIPTION = 'Send a local file (image, video, or generic file) to a saved IM '
  + 'delivery target without needing an active IM conversation turn. Use this from '
  + "scheduled/unattended runs to push a generated report or image to the user's phone. "
  + 'Requires botId and targetId from the saved delivery targets (Settings → IM 机器人 → '
  + '复制调用参数), and an absolute path to a readable file. The send result is reported '
  + 'as structured output; a failed delivery throws with the channel error code.';

export function installPushMediaTool(ctx, service, { logger } = {}) {
  if (typeof ctx?.tools?.register !== 'function') {
    logger?.warn?.('[dsh-im] tools service unavailable, dsh_im_push_media not registered');
    return;
  }
  if (typeof service?.sendMedia !== 'function') {
    logger?.warn?.('[dsh-im] delivery service has no sendMedia, dsh_im_push_media not registered');
    return;
  }
  ctx.tools.register({
    name: PUSH_MEDIA_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        botId: {
          type: 'string',
          description: 'Bot ID of the configured IM bot, copied from the delivery target settings.',
        },
        targetId: {
          type: 'string',
          description: 'Saved delivery target ID, e.g. tgt_7fac8f78eeeae510.',
        },
        path: {
          type: 'string',
          description: 'Absolute path of an existing local file to send.',
        },
        text: {
          type: 'string',
          description: 'Optional text sent before the file.',
        },
      },
      required: ['botId', 'targetId', 'path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean' },
          fileName: { type: 'string' },
          size: { type: 'number' },
        },
        required: ['sent', 'fileName', 'size'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已推送 ${value.fileName}（${value.size} 字节）到 IM 目标。`,
      }],
    },
    async execute(args) {
      const botId = typeof args?.botId === 'string' ? args.botId.trim() : '';
      const targetId = typeof args?.targetId === 'string' ? args.targetId.trim() : '';
      const filePath = typeof args?.path === 'string' ? args.path : '';
      if (!botId) throw new Error('dsh_im_push_media: botId 必填');
      if (!targetId) throw new Error('dsh_im_push_media: targetId 必填');
      if (!filePath.trim()) throw new Error('dsh_im_push_media: path 必填');
      const text = typeof args?.text === 'string' ? args.text : undefined;
      const result = await service.sendMedia(botId, targetId, { path: filePath }, { text });
      return {
        sent: true,
        fileName: result.fileName,
        size: result.size,
      };
    },
  });
}
