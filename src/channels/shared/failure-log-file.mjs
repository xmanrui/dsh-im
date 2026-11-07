import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One durable line per failed turn, so the reference id a user quotes back can
 * be looked up after the fact.
 *
 * The console line the bridge already writes carries the same id, but a console
 * line only exists while somebody captures stdout (`dsh` started from a
 * terminal, a log collector). For a desktop app started from the dock there is
 * no captured stream at all, so a `MF-…` id in a chat notice had nothing on disk
 * to match it against — the id was, in practice, untraceable. This module keeps
 * that record next to the other `.dsh-im` state.
 *
 * The file is best-effort by design: a failure to log must never mask the
 * failure being reported to the user, so every filesystem error is swallowed.
 */

const LOG_DIRECTORY = '.dsh-im';
const LOG_NAME = 'failures.jsonl';
/** Keep one previous generation; a chatty week must not grow the file forever. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const TOKEN_SHAPE = /bot\d+:[A-Za-z0-9_-]{20,}/gu;

function resolveDshHome(dshHome) {
  return dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** Absolute path of the failure log for one DSH home. */
export function failureLogPath({ dshHome } = {}) {
  return join(resolveDshHome(dshHome), LOG_DIRECTORY, LOG_NAME);
}

function rotateIfNeeded(file) {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    // Missing file, or a race with another writer: appending still works.
  }
}

/**
 * Append one classified failure to the durable log.
 *
 * @param {object} failure - the object `classifyMessageFailure` returned.
 * @param {object} [options]
 * @param {string|null} [options.channel] - channel key, e.g. `feishu`.
 * @param {string} [options.dshHome] - overrides `DSH_HOME`.
 * @param {object|null} [options.details] - classified diagnostic details.
 * @param {number} [options.at] - event time in epoch milliseconds.
 * @returns {boolean} true when the line reached the file.
 */
export function appendFailureLog(failure, { channel = null, dshHome, details = null, at = Date.now() } = {}) {
  if (!failure || typeof failure !== 'object') return false;
  const referenceId = typeof failure.referenceId === 'string' ? failure.referenceId : '';
  if (!referenceId) return false;
  try {
    const file = failureLogPath({ dshHome });
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    const record = {
      referenceId,
      code: failure.code ?? null,
      reason: failure.reason ?? null,
      channel,
      at: Number.isFinite(failure.at) ? failure.at : at,
      // The provider code is what explains a MODEL_STREAM: STREAM_CLOSED versus
      // MALFORMED_RESPONSE. `details` carries it when classification found it.
      ...(details && typeof details === 'object' ? { details } : {}),
    };
    const line = JSON.stringify(record).replace(TOKEN_SHAPE, 'bot<redacted>');
    appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
