export { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../src/channels/shared/inbound-access.mjs';

function scope(users = []) {
  return {
    mode: 'allowlist',
    open: {
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [],
    },
    allowlist: {
      users: users.map(({ id, canExecuteCommands = false }) => ({
        id,
        canExecuteCommands,
      })),
    },
  };
}

export function directAccessPolicy({
  users = [],
  privilegedIds = [],
} = {}) {
  const privileged = new Set(privilegedIds);
  const settings = {
    direct: scope(users),
    group: scope(),
  };
  return {
    getSettings: () => settings,
    isPrivileged: (senderIds) => (
      (Array.isArray(senderIds) ? senderIds : [senderIds])
        .some((senderId) => privileged.has(senderId))
    ),
  };
}
