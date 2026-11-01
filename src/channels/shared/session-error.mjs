/**
 * Commands run against the bound Session, and an archived Session refuses every
 * command with the same code. A command failure message that says "try again" is
 * worse than useless here: retrying can never succeed until the Session is restored,
 * so the exit (/new, or restoring it in DSH) has to be named instead.
 */
export const SESSION_ARCHIVED_COMMAND_MESSAGE = '当前会话已在 DSH 中归档，这条命令无法执行。请发送 /new 创建新会话后重试，或联系管理员在 DSH 中取消归档。';

export function isSessionArchived(code) {
  return code === 'session-archived';
}

export function isSessionNotFound(code) {
  return code === 'session-not-found' || code === 'session/not-found';
}

// Older Hosts report corrupt logs as generic internal errors. Only recognize
// storage/format signatures on Session RPCs, never arbitrary internal failures.
export function isSessionLogCorrupt(error) {
  return ['internal', 'gateway/internal'].includes(error?.code)
    && ['session.history', 'session.prompt'].includes(error?.method)
    && /stored log is corrupt|stored session "[^"\n]+" is corrupt|SessionFormatError:/u.test(error?.message ?? '');
}
