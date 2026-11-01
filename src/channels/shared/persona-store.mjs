// Persona storage: one JSON file per bot, next to its state file.
//
// Deliberately its own file rather than a field in the workspace document. The
// workspace document is versioned and migrated as a whole, so adding a key there
// means a migration every channel must survive; a persona is read once per
// prompt and written when an operator edits it, which is exactly what a small
// sidecar file is good at. Losing or corrupting it costs the character, never
// the account -- the caller falls back to "no persona".

import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_PERSONA, normalizePersona, validatePersona } from './persona.mjs';

/** One stored file shape; a future schema change bumps `version` and migrates here. */
const PERSONA_DOCUMENT_VERSION = 1;

/**
 * Read one bot's persona file.
 *
 * A missing file is not an error: it means the operator never set a persona, and
 * the answer is `null` so the caller can decide what (if anything) to render.
 * A corrupt file is also not fatal -- a character must not cost a bot its
 * replies -- but it is reported through `onError` so the operator can see it.
 *
 * @param path - absolute path of the persona file.
 * @param options.onError - called once with a corrupt-file diagnostic.
 * @returns `{ persona, raw }`, or null when the file does not exist.
 */
export async function loadPersonaFile(path, { onError } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // ENOENT is the normal "never configured" case, not a failure.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    onError?.(`persona.json 不是合法 JSON，已按无人设处理：${error?.message ?? error}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    onError?.('persona.json 顶层必须是对象，已按无人设处理。');
    return null;
  }
  // A document envelope keeps room for migrations without touching the card.
  const card = parsed.persona ?? parsed;
  return { persona: normalizePersona(card), raw: parsed };
}

/**
 * Write one bot's persona atomically.
 *
 * Written to a temporary name and renamed into place, so a crash mid-write can
 * never leave a half-card that the next prompt would render as garbage.
 *
 * @param path - absolute path of the persona file.
 * @param persona - the card to store; validated before anything is written.
 * @returns the normalized persona that was written.
 */
export async function savePersonaFile(path, persona) {
  const normalized = validatePersona(persona);
  const document = { version: PERSONA_DOCUMENT_VERSION, persona: normalized };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    // A failed write must not leave the temporary file behind.
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return normalized;
}

/**
 * Open one bot's persona as a live provider.
 *
 * The card is read once at open time and cached, because the prompt path reads
 * it synchronously. `refresh()` and `save()` are the two ways it changes: an
 * operator edit calls refresh (or writes through save), and a save updates the
 * cache in the same step that updates the file so the next reply already uses
 * the new card.
 *
 * A missing file is the normal "not configured" state and yields a provider
 * whose `get()` answers null; only a genuine I/O failure rejects, and the caller
 * is expected to fall back to no persona rather than fail the channel.
 *
 * @param path - absolute path of the persona file.
 * @param options.onError - called with a corrupt-file diagnostic.
 * @returns a frozen provider `{ path, get, refresh, save }`.
 */
export async function openPersonaProvider(path, { onError } = {}) {
  let card = null;
  const read = async () => {
    const loaded = await loadPersonaFile(path, { onError });
    // A file that disappeared turns the character off again, rather than
    // silently keeping the card from a configuration that no longer exists.
    card = loaded?.persona ?? null;
    return card;
  };
  await read();
  return Object.freeze({
    path,
    get: () => card,
    refresh: read,
    save: async (persona) => {
      card = await savePersonaFile(path, persona);
      return card;
    },
  });
}

/**
 * Read a bot's persona, writing the shipped card the first time.
 *
 * "Not configured" and "deliberately blank" are different states, and only the
 * operator can tell them apart. This helper makes the first one impossible: a
 * bot that has never been configured answers as the character the package ships,
 * and the file it wrote is then the thing an operator edits. A bot whose file
 * exists is never overwritten, so an emptied card stays empty.
 *
 * @param path - absolute path of the persona file.
 * @param options.onError - called with a corrupt-file diagnostic.
 * @returns the provider, seeded on first open.
 */
export async function openSeededPersonaProvider(path, { onError } = {}) {
  const provider = await openPersonaProvider(path, { onError });
  if (provider.get() === null) {
    try {
      await provider.save(DEFAULT_PERSONA);
    } catch (error) {
      // A read-only data directory must not stop the bot from answering; it just
      // answers without a card until somebody fixes the permissions.
      onError?.(`人设文件无法写入，本次按无人设处理：${error?.message ?? error}`);
    }
  }
  return provider;
}

/**
 * Does this account file exist, without creating it?
 *
 * Used by the settings surface to tell "an operator wrote a card" from "the
 * shipped default is in force", which is the difference between "nothing to do"
 * and "this is a first-run prompt". Never writes, so asking is free.
 *
 * @param path - absolute path of the persona file.
 * @returns whether a card has been written for this account.
 */
export async function personaFileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
