// Host-only half of conversation-directory isolation: it touches the
// filesystem and the bot workspace scope, so it must never reach the browser
// bundle. The naming and settings rules live in ./conversation-directory.mjs.

import { mkdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import {
  conversationDirectoryName,
  DEFAULT_CONVERSATION_DIRECTORY_SETTINGS,
  isConversationDirectoryPath,
} from './conversation-directory.mjs';

/**
 * Directory preparation never throws for an environmental failure: a message
 * that cannot be isolated must still reach the Harness, and the caller needs a
 * reason to show the user instead of a stack trace.
 *
 * @typedef {object} ConversationDirectoryPreparation
 * @property {boolean} enabled        Whether isolation is configured for this bot.
 * @property {boolean} prepared       Whether a directory is in force for this conversation.
 * @property {boolean} [reused]       The recorded directory was kept.
 * @property {boolean} [created]      A new directory was minted.
 * @property {boolean} [degraded]     Isolation was requested but could not be applied.
 * @property {string | null} [directory] Absolute directory now in force.
 * @property {string | null} [base]   Base workspace the directory sits below.
 * @property {string | null} [reason] Degradation code, suitable for
 *   `conversationDirectoryFailureReason`.
 */

function readSettings(harness) {
  if (typeof harness?.conversationDirectorySettings !== 'function') return null;
  try {
    const value = harness.conversationDirectorySettings();
    return value && typeof value === 'object'
      ? { ...DEFAULT_CONVERSATION_DIRECTORY_SETTINGS, ...value }
      : null;
  } catch {
    // An out-of-scope bot reports `workspace-bot-not-found`; treating that as
    // "isolation unavailable" keeps the caller on its existing path.
    return null;
  }
}

function readRecord(harness, key) {
  if (typeof harness?.sessionDirectory !== 'function') return null;
  try {
    const record = harness.sessionDirectory(key);
    return record && typeof record.directory === 'string' ? record : null;
  } catch {
    return null;
  }
}

function currentBase(harness, key) {
  if (typeof harness?.currentConversationWorkspace !== 'function') return null;
  try {
    const value = harness.currentConversationWorkspace(key);
    return typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
  } catch {
    return null;
  }
}

async function switchTo(harness, key, { base, directory, strategy }) {
  await harness.switchConversationSessionDirectory(key, { base, directory, strategy });
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pick the directory a new `per-session` Session will own. The name carries a
 * millisecond stamp, which two resets can share; an existing sibling is never
 * adopted, because owning a fresh directory is the whole point of the strategy.
 */
async function freeSessionDirectory(base, name) {
  let directory = join(base, name);
  for (let attempt = 2; attempt < 1_000; attempt += 1) {
    if (!(await directoryExists(directory))) return directory;
    directory = join(base, `${name}-${attempt}`);
  }
  throw new Error('unable to derive a free conversation directory');
}

/**
 * Whether a persisted record still matches the settings in force today.
 *
 * A record is what made a prefix change look inert: the first isolated message
 * stores the directory it minted, and every later message reuses that record
 * verbatim, so renaming the prefix appeared to do nothing until the bot was
 * removed — removal was the only path that cleared the records. Checking the
 * derived name (or, for `per-session`, the prefix) turns a settings change into
 * a stale record, which the caller then re-mints below the same base.
 *
 * `per-conversation` names are deterministic, so compare the exact segment: a
 * prefix test alone would let `ws-…` satisfy a `w-` prefix. `per-session` names
 * carry a timestamp that cannot be recomputed, so only the prefix is checkable.
 *
 * @param {object | null} record Persisted session directory record.
 * @param {string} key Conversation key the record belongs to.
 * @param {{ strategy: string, prefix: string }} settings Settings in force.
 * @returns {boolean} True when the record may be reused as-is.
 */
function recordMatchesSettings(record, key, settings) {
  if (!record) return false;
  if ((record.strategy ?? settings.strategy) !== settings.strategy) return false;
  if (settings.strategy === 'per-session') {
    return isConversationDirectoryPath(record.directory, { prefix: settings.prefix });
  }
  try {
    return basename(record.directory) === conversationDirectoryName(key, settings);
  } catch {
    // A prefix that leaves no room for a name invalidates the record rather
    // than crashing preparation; minting fails later with a readable reason.
    return false;
  }
}

/**
 * Ensure the conversation's own directory exists and is in force, then let the
 * caller create a Session in it.
 *
 * Runs inside the caller's session binding lock: the directory must be in force
 * before `createSession` resolves the workspace, and two concurrent first
 * messages must not each mint one.
 *
 * @param {object} options Preparation options.
 * @param {object} options.harness Bot workspace scope exposing
 *   `conversationDirectorySettings`, `sessionDirectory`,
 *   `currentConversationWorkspace` and `switchConversationSessionDirectory`.
 * @param {string} options.key Conversation key.
 * @param {boolean} [options.fresh] True when the user asked for a new Session
 *   (`/new`), which is the only case that mints a second `per-session` directory.
 * @param {object} [options.logger] Logger for degraded paths.
 * @returns {Promise<ConversationDirectoryPreparation>} Preparation outcome.
 */
export async function ensureConversationDirectory({ harness, key, fresh = false, logger } = {}) {
  const settings = readSettings(harness);
  if (!settings?.enabled) return { enabled: false, prepared: false };
  if (typeof key !== 'string' || !key) {
    return { enabled: true, prepared: false, degraded: true, reason: 'invalid-key' };
  }
  if (typeof harness?.switchConversationSessionDirectory !== 'function') {
    return { enabled: true, prepared: false, degraded: true, reason: 'unsupported-harness' };
  }

  const record = readRecord(harness, key);
  // `per-session` mints a directory per Session; every other combination keeps
  // the recorded one, which is what makes `/new` idempotent for the default
  // `per-conversation` strategy. A record whose name no longer matches the
  // prefix or strategy in force is stale: fall through and re-mint below the
  // same base so a settings change takes effect on the next message without
  // removing the bot. The old directory is left on disk untouched.
  const reuseRecord = record
    && recordMatchesSettings(record, key, settings)
    && !(fresh && settings.strategy === 'per-session');

  if (reuseRecord) {
    try {
      // Heal a directory removed outside the plugin before reusing the record.
      await mkdir(record.directory, { recursive: true });
      if (currentBase(harness, key) !== record.directory) {
        await switchTo(harness, key, {
          base: record.base ?? record.directory,
          directory: record.directory,
          strategy: record.strategy ?? settings.strategy,
        });
      }
      return {
        enabled: true,
        prepared: true,
        reused: true,
        directory: record.directory,
        base: record.base ?? record.directory,
        reason: null,
      };
    } catch (error) {
      logger?.warn?.('[dsh-im] unable to reapply the conversation directory:', error?.message ?? error);
      return {
        enabled: true,
        prepared: false,
        degraded: true,
        reason: currentBase(harness, key) ? 'switch-failed' : 'base-unavailable',
      };
    }
  }

  // The recorded base outlives the override it was stored with: after `/new`
  // the conversation already points at a directory, and deriving the base from
  // it again would nest a directory inside its own predecessor.
  const base = record?.base ?? currentBase(harness, key);
  if (!base) {
    return { enabled: true, prepared: false, degraded: true, reason: 'base-unavailable' };
  }
  let directory;
  try {
    const name = conversationDirectoryName(key, {
      prefix: settings.prefix,
      strategy: settings.strategy,
    });
    directory = settings.strategy === 'per-session'
      ? await freeSessionDirectory(base, name)
      : join(base, name);
    await mkdir(directory, { recursive: true });
  } catch (error) {
    logger?.warn?.('[dsh-im] unable to create the conversation directory:', error?.message ?? error);
    return { enabled: true, prepared: false, degraded: true, reason: 'create-failed', base };
  }
  try {
    await switchTo(harness, key, { base, directory, strategy: settings.strategy });
  } catch (error) {
    logger?.warn?.('[dsh-im] unable to switch to the conversation directory:', error?.message ?? error);
    return { enabled: true, prepared: false, degraded: true, reason: 'switch-failed', base };
  }
  return { enabled: true, prepared: true, created: true, directory, base, reason: null };
}
