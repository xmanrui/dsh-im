import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { normalizeInterfaceLanguageTag } from './interface-language.mjs';

const DOCUMENT_VERSION = 1;

function invalidTagError() {
  const error = new Error('Invalid DSH interface language tag.');
  error.code = 'interface-language-invalid';
  return error;
}

// Mirrors the atomic settings writes of the inbound attachment TTL store and
// the update service: create a private temporary file, then rename it in.
async function writeSettingsDocument(path, document) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * Durable mirror of the DSH interface language, so bot messages keep following
 * it across Host restarts and before any browser has connected. Only the
 * lowest resolution layer lives here (see ./interface-language.mjs): an
 * unreadable document resolves to "nothing mirrored" rather than pinning a
 * language nobody chose.
 */
export class InterfaceLanguageStore {
  #path;
  #tag = null;
  // Whether the document on disk is known to already say what #tag says. False
  // for a missing or unreadable document, so the next report repairs it.
  #stored = false;

  constructor(path) {
    if (typeof path !== 'string' || !path) {
      throw new TypeError('interface language store path is required');
    }
    this.#path = path;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#tag = null;
      this.#stored = false;
      await this.#removeStaleTemporaries();
      return this;
    }
    const read = this.#readTag(raw);
    this.#tag = read === undefined ? null : read;
    this.#stored = read !== undefined;
    await this.#removeStaleTemporaries();
    return this;
  }

  // Crash leftovers from an interrupted atomic write are unreferenced by
  // anyone; remove them so the settings directory stays clean.
  async #removeStaleTemporaries() {
    const directory = dirname(this.#path);
    const prefix = `${basename(this.#path)}.`;
    try {
      const entries = await readdir(directory);
      await Promise.all(entries
        .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
        .map((name) => unlink(join(directory, name)).catch(() => {})));
    } catch {
      // A missing directory or concurrent removal is fine; cleanup is best-effort.
    }
  }

  // Returns the mirrored tag (null when the document mirrors nothing), or
  // undefined when the document is damaged or from an unknown future version.
  #readTag(raw) {
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) return undefined;
    if (document.version !== DOCUMENT_VERSION) return undefined;
    if (document.interfaceLanguage === undefined) return null;
    return normalizeInterfaceLanguageTag(document.interfaceLanguage) ?? undefined;
  }

  getLanguageTag() {
    return this.#tag;
  }

  /**
   * Record the interface language reported by the settings UI. Passing null
   * clears the mirror, returning resolution to the layers above it. The
   * settings page reports its locale on every mount, so an unchanged value is
   * accepted without rewriting the document.
   */
  async setLanguageTag(value) {
    const tag = value === null || value === undefined
      ? null
      : normalizeInterfaceLanguageTag(value);
    if (tag === null && value !== null && value !== undefined) throw invalidTagError();
    if (tag === this.#tag && this.#stored) return tag;
    await writeSettingsDocument(this.#path, {
      version: DOCUMENT_VERSION,
      ...(tag === null ? {} : { interfaceLanguage: tag }),
    });
    this.#tag = tag;
    this.#stored = true;
    return tag;
  }
}
