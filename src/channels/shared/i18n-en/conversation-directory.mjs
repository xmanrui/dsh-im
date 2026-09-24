// English translations for conversation-directory isolation
// (conversation-directory.mjs, conversation-directory-ensure.mjs, new-command.mjs).
// Keys are exact Chinese literals passed to t().
export default {
  // Reasons reported by conversationDirectoryFailureReason().
  '找不到可用的基工作区。': 'No usable base Workspace was found.',
  '无法创建目录（权限或磁盘空间不足）。':
    'The directory could not be created (insufficient permission or disk space).',
  '无法把本对话切换到新目录。': 'This conversation could not be switched to the new directory.',
  '当前 Harness 版本不支持会话目录隔离。':
    'The current Harness version does not support conversation directory isolation.',
  '当前消息缺少可用的会话标识。': 'This message carries no usable conversation identity.',
  '未知原因。': 'Unknown reason.',

  // /new confirmation: the channel keeps its own sentence and only gains this
  // appended line when isolation applies.
  '会话目录：{directory}': 'Conversation directory: {directory}',
  '（会话目录未生效：{reason}；本次仍在原工作区运行）':
    '(The conversation directory is not in effect: {reason}; this Session still runs in the previous Workspace.)',
};
