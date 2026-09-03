// English translations (shared-a area). Keys are exact Chinese literals passed to t().
export default {
  '这个问题已在其他客户端处理，无需再次回答。':
    'This question has already been answered from another client; no further reply is needed.',
  '任务已完成。': 'Task completed.',
  '结果文件': 'result file',
  '结果文件「{name}」的发送结果未能确认，请先检查聊天内是否已收到，不要立即重试。':
    'The delivery result of the result file "{name}" could not be confirmed. Please check whether it already arrived in the chat before retrying.',
  '结果文件「{name}」已生成，但 Slack 应用缺少 files:write 权限。请更新 Manifest、重新安装应用并重新连接机器人后重试。':
    'The result file "{name}" was generated, but the Slack app is missing the files:write permission. Please update the Manifest, reinstall the app, reconnect the bot, and try again.',
  '结果文件「{name}」已生成，但机器人缺少 Discord 的 Send Messages、Attach Files 或 Read Message History 权限。':
    'The result file "{name}" was generated, but the bot is missing the Discord Send Messages, Attach Files, or Read Message History permission.',
  '结果文件「{name}」已生成，但 Telegram 不允许机器人在当前聊天发送文档，请检查聊天权限。':
    'The result file "{name}" was generated, but Telegram does not allow the bot to send documents in this chat. Please check the chat permissions.',
  '结果文件「{name}」已生成，但当前机器人没有文件发送权限，请检查渠道权限。':
    'The result file "{name}" was generated, but the bot does not have permission to send files. Please check the channel permissions.',
  '结果文件「{name}」超过当前渠道大小上限，未发送。':
    'The result file "{name}" exceeds the size limit of this channel and was not sent.',
  '结果文件「{name}」为空，未发送。':
    'The result file "{name}" is empty and was not sent.',
  '结果文件「{name}」暂时无法读取或准备发送，请确认文件仍可访问后重试。':
    'The result file "{name}" cannot be read or prepared for sending right now. Please make sure the file is still accessible and try again.',
  '结果文件「{name}」暂时被当前渠道限流，未能发送，请稍后重试。':
    'The result file "{name}" was temporarily rate-limited by this channel and could not be sent. Please try again later.',
  '结果文件「{name}」已生成，但当前渠道拒绝了该文件或文件消息。':
    'The result file "{name}" was generated, but this channel rejected the file or file message.',
  '结果文件「{name}」已生成，但当前渠道暂时未能发送，请稍后重试。':
    'The result file "{name}" was generated, but this channel could not send it right now. Please try again later.',
  '消息处理失败，请稍后重试。': 'Failed to process the message. Please try again later.',
  '卡片已结束，请查看后续消息。': 'This card has ended. Please check the next message.',
  '工具调用「{name}」未成功，请检查工具配置或稍后重试。': 'Tool call "{name}" did not succeed. Check the tool configuration or try again later.',
  '无法连接处理服务，消息尚未提交。请确认 DeepSeek Harness 正在运行后重试。':
    'Could not connect to the processing service, so the message was not submitted. Make sure DeepSeek Harness is running, then try again.',
  '处理服务响应超时，消息尚未开始处理。请稍后重试。':
    'The processing service timed out before the message started. Please try again later.',
  '暂时无法确认任务状态，任务可能已经开始。请先等待或发送 /stop，不要立即重复提交。':
    'The task status could not be confirmed and the task may have started. Wait or send /stop before submitting it again.',
  '消息提交结果未能确认，任务可能已经开始。请先等待或发送 /status 查看状态，不要立即重复提交。':
    'The message submission could not be confirmed and the task may have started. Wait or send /status before submitting it again.',
  '暂时无法读取任务进度，任务可能仍在运行。请先等待或发送 /stop，不要立即重复提交。':
    'Task progress is temporarily unavailable and the task may still be running. Wait or send /stop before submitting it again.',
  '处理服务拒绝了机器人连接。请管理员检查 Harness 地址、代理或访问配置后重试。':
    'The processing service rejected the bot connection. Ask an administrator to check the Harness address, proxy, or access settings.',
  '机器人与 DeepSeek Harness 的接口不兼容。请管理员检查 Harness 地址并更新相关版本。':
    'The bot and DeepSeek Harness use incompatible APIs. Ask an administrator to check the Harness address and update the related components.',
  'DeepSeek Harness 暂时无法完成请求，请稍后重试。':
    'DeepSeek Harness could not complete the request. Please try again later.',
  '等待模型回复超时，任务可能仍在运行。请先等待或发送 /stop，不要立即重复提交。':
    'Waiting for the model reply timed out and the task may still be running. Wait or send /stop before submitting it again.',
  '模型凭据缺失或已失效。请管理员检查模型配置后重试。':
    'The model credentials are missing or invalid. Ask an administrator to check the model settings.',
  '模型额度或余额不足，本次任务未完成。请管理员补充额度或切换模型后重试。':
    'The model quota or balance is insufficient. Ask an administrator to add quota or switch models, then try again.',
  '模型服务正在限流，本次任务未完成。请稍后重试。':
    'The model service is rate-limiting requests. Please try again later.',
  '当前会话内容超过模型上下文上限。请发送 /compact 或 /new 后重试。':
    'This conversation exceeds the model context limit. Send /compact or /new, then try again.',
  '当前模型不存在或暂不可用。请发送 /models 查看并使用 /model 切换模型。':
    'The current model does not exist or is unavailable. Send /models and use /model to switch models.',
  '当前模型不存在或不支持所选配置。请发送 /models，并使用 /model 重新选择。':
    'The current model does not exist or does not support the selected settings. Send /models and use /model to choose again.',
  '当前模型不支持这类内容或所选配置。请调整内容、模型或推理等级后重试。':
    'The current model does not support this content or the selected settings. Adjust the content, model, or reasoning effort and try again.',
  '当前模型不支持所选配置。请切换模型或推理等级后重试。':
    'The current model does not support the selected settings. Switch the model or reasoning effort, then try again.',
  '模型服务响应超时，本次任务未完成。请稍后重试。':
    'The model service timed out and the task did not finish. Please try again later.',
  '暂时无法连接模型服务，本次任务未完成。请稍后重试。':
    'The model service is temporarily unreachable and the task did not finish. Please try again later.',
  '模型服务暂时异常，本次任务未完成。请稍后重试。':
    'The model service is temporarily unavailable and the task did not finish. Please try again later.',
  '模型回复中断或格式异常，本次任务未完成。请重试。':
    'The model reply was interrupted or malformed, so the task did not finish. Please try again.',
  '模型没有返回可显示的内容。请重试；若持续发生，请切换模型。':
    'The model returned no displayable content. Try again, or switch models if this keeps happening.',
  '模型拒绝处理当前内容。请调整问题内容后重试。':
    'The model rejected the current content. Revise the request and try again.',
  '模型达到输出长度上限，但没有生成可显示的结果。请缩小任务范围后重试。':
    'The model reached its output limit without producing a displayable result. Reduce the task scope and try again.',
  '任务正在等待无法在当前渠道完成的操作。请在 DeepSeek Harness 中处理后再试。':
    'The task is waiting for an action that cannot be completed in this channel. Handle it in DeepSeek Harness, then try again.',
  '任务被意外中断，本次未完成。请重试。':
    'The task was unexpectedly interrupted and did not finish. Please try again.',
  '当前会话已不存在。请发送 /new 创建新会话后重试。':
    'The current Session no longer exists. Send /new to create one, then try again.',
  '当前会话仍在处理上一项任务。请等待完成，或发送 /stop 后重试。':
    'The current Session is still processing the previous task. Wait for it to finish, or send /stop before trying again.',
  '工作区或会话状态刚刚发生变化。请重新发送这条消息。':
    'The Workspace or Session state just changed. Please send this message again.',
  '当前工作区不存在或暂不可用。请重新选择工作区后重试。':
    'The current Workspace does not exist or is unavailable. Select another Workspace and try again.',
  '当前 Agent Preset 不存在或暂不可用。请发送 /presetlist 后重新选择。':
    'The current Agent Preset does not exist or is unavailable. Send /presetlist and select another one.',
  '回复已经生成，但机器人没有发送权限。请联系管理员检查渠道权限或重新绑定机器人。':
    'The reply was generated, but the bot cannot send it. Ask an administrator to check channel permissions or reconnect the bot.',
  '回复已经生成，但当前渠道正在限流，暂时无法发送。请稍后重试。':
    'The reply was generated, but this channel is rate-limiting messages. Please try again later.',
  '回复发送结果未能确认。请先检查聊天内是否已经收到，不要立即重复提交。':
    'Reply delivery could not be confirmed. Check whether it already arrived before submitting the task again.',
  '回复已经生成，但当前渠道暂时无法发送。请稍后重试。':
    'The reply was generated, but this channel could not send it. Please try again later.',
  '当前消息包含无法处理的图片或文件。请调整后重新发送。':
    'This message contains an image or file that cannot be processed. Adjust it and send it again.',
  '任务未完成，暂时无法确定原因。请重试；若持续发生，请将参考号提供给管理员。':
    'The task did not finish and the cause could not be determined. Try again; if it persists, give the reference ID to an administrator.',
  '错误码：{code}；参考号：{referenceId}': 'Error code: {code}; reference: {referenceId}',
  '{label}机器人': '{label} bot',
  '目前支持文字和图片消息。': 'Only text and image messages are supported at the moment.',
  '目前支持文字、图片和文件消息。':
    'Only text, image, and file messages are supported at the moment.',
  '目前支持文字、图片、文件和语音转写消息。':
    'Only text, image, file, and voice-transcription messages are supported at the moment.',
  '目前支持文字、图片、文件，以及微信已转成文字的语音消息。':
    'Only text, image, file, and voice messages already transcribed to text by WeChat are supported at the moment.',
  '直接发送文字或图片即可继续当前会话。': 'Send text or an image directly to continue the current session.',
  '直接发送文字、图片或文件即可继续当前会话。':
    'Send text, an image, or a file directly to continue the current session.',
  '直接发送文字、图片、文件或带文字识别结果的语音即可继续当前会话。':
    'Send text, an image, a file, or a voice message already transcribed to text to continue the current session.',
  '{label}机器人已连接 DeepSeek Harness。': 'The {label} bot is connected to DeepSeek Harness.',
  '/new  开启一个全新会话': '/new  Start a brand-new session',
  '/compact  压缩当前会话的较早上下文': '/compact  Compact the earlier context of the current session',
  '/workspace 工作区序号或绝对路径  切换工作区':
    '/workspace <workspace index or absolute path>  Switch workspace',
  '/workspacelist  列出工作区绝对路径': '/workspacelist  List absolute workspace paths',
  '/ws、/wsl、/workspaces  工作区命令别名': '/ws, /wsl, /workspaces  Workspace command aliases',
  '/sessionlist [工作区序号或绝对路径]  列出会话 ID 和标题':
    '/sessionlist [workspace index or absolute path]  List session IDs and titles',
  '/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题':
    '/sessionlist or /sessions [workspace index or absolute path]  List session IDs and titles',
  '/sessionlist --limit N  仅列出当前工作区前 N 个会话':
    '/sessionlist --limit N  List only the first N sessions in the current workspace',
  '/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话':
    '/session <Session ID or workspace index>  Bind this chat to the specified session',
  '/models  按序号列出所有可用模型': '/models  List all available models by index',
  '/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级':
    '/reasoninglist or /reasonings  List reasoning efforts for the current model by index',
  '/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级':
    '/reasoning [index, effort ID, or --default]  Show or switch the current reasoning effort',
  '/model [序号或完整模型ID]  查看或切换当前会话模型':
    '/model [index or full model ID]  Show or switch the model of the current session',
  '/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型':
    '/model [index or full model ID] [reasoning effort ID]  Show or switch the current Session model',
  '示例：先发 /models，再发 /model 2': 'Example: send /models first, then /model 2',
  '示例：先发 /models，再发 /model 2 [推理等级ID]':
    'Example: send /models first, then /model 2 [reasoning effort ID]',
  '/presetlist  按序号列出可用 Agent Preset': '/presetlist  List available Agent Presets by index',
  '/presetlist 或 /presets  按序号列出可用 Agent Preset':
    '/presetlist or /presets  List available Agent Presets by index',
  '/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset':
    '/preset [index or full ID]  Show or set the Agent Preset of this bot',
  '纯数字 ID：/preset id:<ID>': 'Numeric-only ID: /preset id:<ID>',
  '/preset --default  跟随 Host 默认': '/preset --default  Follow the Host default',
  '/stop  停止当前任务': '/stop  Stop the current task',
  '/steer 补充指令  纠偏当前任务': '/steer <additional instruction>  Steer the current task',
  '/status  检查连接状态': '/status  Check the connection status',
  '/version  查看插件版本': '/version  Show the plugin version',
  '/help  显示本帮助': '/help  Show this help',
  '{label}机器人与 DeepSeek Harness 连接正常。':
    'The {label} bot is connected to DeepSeek Harness and working normally.',
  '{label}机器人凭据缺失，请移除后重新接入。':
    '{label} bot credentials are missing. Remove the bot and connect it again.',
  '{label}连接未就绪，插件会自动重试。':
    'The {label} connection is not ready yet. The plugin will retry automatically.',
  '{label}机器人已接入，消息连接暂未就绪。':
    'The {label} bot is connected, but its message connection is not ready yet.',
  '{label}连接仍未就绪，请稍后重试。':
    'The {label} connection is still not ready. Please try again later.',
  '{label}机器人尚未连接': 'The {label} bot is not connected yet',
  '{name}（{id}）': '{name} ({id})',
  '{label}{connectionLabel}运行正常': 'The {label}{connectionLabel} is running normally',
  '{label}连接未就绪，插件会自动重试':
    'The {label} connection is not ready. The plugin will retry automatically',
  '{label}连接当前离线': 'The {label} connection is currently offline',
  '已开启新会话。请发送你的问题。': 'A new session has started. Please send your question.',
  '正在使用{name}…': 'Using {name}…',
  '已停止。': 'Stopped.',
  '请用文字回答当前问题。': 'Please answer the current question with text.',
  '{label}交互问题发送失败。': 'Failed to send the {label} interaction question.',
  '回答提交失败。': 'Failed to submit the answer.',
  '回答提交失败，请重新发送当前问题的答案。':
    'Failed to submit the answer. Please resend your answer to the current question.',
  '检测到这个 Session 中遗留的待回答问题，已安全取消并继续处理你刚才的消息。':
    'A pending question left over in this Session was detected. It has been safely cancelled, and your latest message is being processed.',
};
