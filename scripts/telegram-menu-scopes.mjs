/**
 * Scoped Telegram command-menu bookkeeping for the live acceptance script.
 *
 * The bot registers commands per BotCommandScope (see
 * src/channels/telegram/telegram-runtime.mjs). An acceptance script that saved,
 * polled and restored only the default scope would (a) never see the menu the
 * plugin now writes into `all_private_chats`, and (b) restore an old default
 * list that the plugin had already cleared. Both the save and the restore must
 * therefore cover all three scopes.
 *
 * The helpers are pure wrappers around a `callTelegram(method, payload)`
 * function so they can be unit-tested without any network access.
 */
import { TELEGRAM_COMMAND_MENU_SCOPES } from '../src/channels/telegram/telegram-runtime.mjs';

export const DEFAULT_COMMAND_SCOPE = null;
export const PRIVATE_COMMAND_SCOPE = TELEGRAM_COMMAND_MENU_SCOPES.private;
export const GROUP_COMMAND_SCOPE = TELEGRAM_COMMAND_MENU_SCOPES.group;

/** Every scope the plugin may write, in registration order. */
export const VERIFY_COMMAND_SCOPES = Object.freeze([
  Object.freeze({ name: 'default', scope: DEFAULT_COMMAND_SCOPE }),
  Object.freeze({ name: 'private', scope: PRIVATE_COMMAND_SCOPE }),
  Object.freeze({ name: 'group', scope: GROUP_COMMAND_SCOPE }),
]);

export function commandPayloadFor(scope) {
  return scope ? { scope } : {};
}

/** Snapshot every scope the plugin can touch, so the original state can be restored. */
export async function saveScopedMenus(callTelegram) {
  const saved = new Map();
  for (const { name, scope } of VERIFY_COMMAND_SCOPES) {
    saved.set(name, await callTelegram('getMyCommands', commandPayloadFor(scope)));
  }
  return saved;
}

/**
 * Restore a snapshot. Scoped lists go first and the default scope goes last:
 * if a restore fails midway, a leftover scoped menu still wins over a partially
 * restored default scope, which is the safer failure direction.
 */
export async function restoreScopedMenus(callTelegram, saved) {
  for (const { name, scope } of [...VERIFY_COMMAND_SCOPES].reverse()) {
    const commands = saved.get(name) ?? [];
    if (commands.length > 0) {
      await callTelegram('setMyCommands', {
        commands,
        ...commandPayloadFor(scope),
      });
    } else {
      await callTelegram('deleteMyCommands', commandPayloadFor(scope));
    }
  }
}
