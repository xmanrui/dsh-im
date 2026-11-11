export { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../src/channels/shared/inbound-access.mjs';
import { accessPolicyProvider } from '../../plugin-src/host/channels/shared/access-policy-production.mjs';

function scope(users = [], { nonAllowlistedAllowedCommands } = {}) {
  const allowlist = {
    users: users.map(({ id, canExecuteCommands = false, allowedCommands }) => ({
      id,
      canExecuteCommands,
      ...(Array.isArray(allowedCommands) ? { allowedCommands: [...allowedCommands] } : {}),
    })),
  };
  if (Array.isArray(nonAllowlistedAllowedCommands)) {
    allowlist.nonAllowlistedAllowedCommands = [...nonAllowlistedAllowedCommands];
  }
  return {
    mode: 'allowlist',
    open: {
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [],
    },
    allowlist,
  };
}

export function directAccessPolicy({
  users = [],
  privilegedIds = [],
  nonAllowlistedAllowedCommands,
} = {}) {
  const privileged = new Set(privilegedIds);
  const settings = {
    direct: scope(users, { nonAllowlistedAllowedCommands }),
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

// Exercise the actual Host owner extraction in channel bridge tests, instead
// of assuming that production supplies the fixture's privileged sender set.
export function configuredAccessPolicy({ channel, config, users = [] }) {
  const settings = { direct: scope(users), group: scope() };
  return accessPolicyProvider({ accessPolicyFor: () => settings }, 'configured_bot', { channel, config });
}
