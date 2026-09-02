// English translations (dingtalk area). Keys are exact Chinese literals passed to t().
export default {
  // Bot chat replies and card text (dingtalk-bridge.mjs, dingtalk-card-stream.mjs,
  // dingtalk-api.mjs)
  '已连接 DeepSeek Harness，正在思考…': 'Connected to DeepSeek Harness, thinking…',

  '钉钉机器人已连接 DeepSeek Harness。': 'The DingTalk bot is connected to DeepSeek Harness.',




  '钉钉未能换取图片下载地址，请重新发送；若持续失败，请检查机器人的“企业内机器人发送消息权限”。': 'DingTalk could not provide the image download address. Please resend; if it keeps failing, check the bot\'s "Send messages as an internal robot" permission.',
  '钉钉没有返回图片下载地址，请重新发送。': 'DingTalk did not return an image download address. Please resend.',
  '钉钉返回的图片临时地址无法读取，请重新发送。': 'The temporary image address returned by DingTalk could not be read. Please resend.',
  '结果文件「{name}」发送结果未能确认，请先检查聊天内是否已收到，不要立即重试。': 'Delivery of the result file "{name}" could not be confirmed. Please check whether it already arrived in the chat before retrying.',
  '结果文件「{name}」已生成，但钉钉应用或机器人缺少文件消息权限。请开通应用 qyapi_base 权限，并确认机器人具备文件消息发送能力。': 'Result file "{name}" was generated, but the DingTalk app or bot lacks file message permission. Enable the app\'s qyapi_base permission and make sure the bot can send file messages.',
  '结果文件「{name}」超过当前钉钉机器人可发送的文件大小，未发送。': 'Result file "{name}" exceeds the file size limit of the current DingTalk bot and was not sent.',
  '结果文件「{name}」暂时被钉钉限流，未能发送，请稍后重试。': 'Result file "{name}" was rate-limited by DingTalk and could not be sent. Please try again later.',
  '结果文件「{name}」已生成，但钉钉拒绝了该文件消息，请检查文件类型和机器人文件消息配置。': 'Result file "{name}" was generated, but DingTalk rejected the file message. Check the file type and the bot\'s file message configuration.',

  '结果文件「{name}」已生成，但暂时未能通过钉钉发送，请稍后重试。': 'Result file "{name}" was generated but could not be sent via DingTalk right now. Please try again later.',
  '结果文件已生成。': 'The result file has been generated.',
  '钉钉机器人与 DeepSeek Harness 连接正常。': 'The DingTalk bot is connected to DeepSeek Harness normally.',



  // Host-side status and error text (dingtalk-bridge.mjs, dingtalk-runtime.mjs,
  // dingtalk-controller.mjs, config-store.mjs, state-store.mjs)
  '钉钉命令处理失败。': 'Failed to process the DingTalk command.',
  '钉钉消息没有安全的回复地址。': 'The DingTalk message has no safe reply address.',
  '钉钉审批处理失败。': 'Failed to process the DingTalk approval.',
  '钉钉消息处理失败。': 'Failed to process the DingTalk message.',
  '钉钉消息格式无效。': 'Invalid DingTalk message format.',
  '钉钉交互问题发送失败。': 'Failed to send the DingTalk interaction question.',
  '钉钉用户': 'DingTalk user',
  '钉钉机器人': 'DingTalk bot',
  '身份已隐藏': 'Identity hidden',
  '钉钉机器人凭据缺失，请移除后重新扫码。': 'The DingTalk bot credentials are missing. Remove the bot and scan the QR code again.',
  '钉钉连接未就绪，请稍后重试。': 'The DingTalk connection is not ready. Please try again later.',
  '钉钉连接仍未就绪，请稍后重试。': 'The DingTalk connection is still not ready. Please try again later.',
  '扫码接入已取消。': 'QR code setup has been cancelled.',
  '无法生成钉钉二维码，请稍后重试。': 'Could not generate the DingTalk QR code. Please try again later.',
  '二维码已过期，请重新生成。': 'The QR code has expired. Generate a new one.',
  '钉钉已接入，但消息连接暂未就绪，请稍后重试。': 'DingTalk is connected, but the message connection is not ready yet. Please try again later.',
  '钉钉未完成机器人授权，请重新扫码。': 'DingTalk did not complete the bot authorization. Please scan the QR code again.',
  '钉钉授权状态暂时不可用，正在重试。': 'The DingTalk authorization status is temporarily unavailable. Retrying.',
  '钉钉已授权，但无法安全保存接入配置。': 'DingTalk authorization succeeded, but the configuration could not be saved safely.',
  '钉钉授权查询暂时失败，正在重试。': 'The DingTalk authorization query failed temporarily. Retrying.',
  '钉钉机器人（{clientId}）': 'DingTalk bot ({clientId})',
  '钉钉 Stream 消息连接运行正常': 'The DingTalk Stream message connection is running normally',
  '钉钉消息连接当前离线': 'The DingTalk message connection is currently offline',

  // Deferred-turn terminal copy (deferred-delivery.mjs)
  '任务已结束，但没有可发送的文本结果。': 'The task ended, but there is no text result to send.',
  '任务失败：{detail}': 'Task failed: {detail}',
  '任务失败：模型运行出错。': 'Task failed: the model run encountered an error.',
  '任务已达到回复长度上限并结束。': 'The task ended after reaching the reply length limit.',
  '任务被安全策略拦截。': 'The task was blocked by the security policy.',
  '任务已停止。': 'Task stopped.',
  '任务已中止。': 'Task aborted.',
  '任务已结束。': 'Task ended.',
  // Deferred-turn bridge notices (dingtalk-bridge.mjs, constants passed via t())
  '当前会话仍有任务在后台运行，完成后会推送结果；发送 /stop 可停止任务。':
    'This session still has a task running in the background. The result will be pushed when it completes; send /stop to stop it.',
};
