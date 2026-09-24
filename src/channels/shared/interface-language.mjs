// Resolution policy for the DSH interface language that dsh-im's bot messages
// follow.
//
// The host message language (./i18n.mjs) is a two-value switch: English, or
// Chinese as the always-available fallback. The DSH interface language is a
// BCP 47-style tag that a language pack may extend beyond the shipped zh/en
// pair, so a tag is carried verbatim through resolution and persistence and is
// collapsed to a dictionary language only where it reaches setImHostLanguage().

/** Tag shape accepted by DSH's own locale preference (@deepseek-ai/dsh-client-locale). */
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/**
 * Resolution layers, highest precedence first.
 *
 * - `config`: the plugin's own `language` option (or `DSH_IM_LANGUAGE`). An
 *   operator who pinned a language in the Host composition keeps it, whatever
 *   any individual browser reads the interface in.
 * - `settings`: the explicit selection in DSH's Language row, read from the
 *   Host user-settings document. This is the setting users mean by "DSH is set
 *   to English".
 * - `mirror`: the last effective interface locale reported by the settings UI.
 *   DSH stores nothing when the interface language came from the browser's
 *   language list, so without this layer a reader who never opened the
 *   Language row would still be answered in Chinese.
 */
export const HOST_LANGUAGE_SOURCES = Object.freeze(['config', 'settings', 'mirror']);

/**
 * Normalize one interface-language tag. Surrounding whitespace is trimmed;
 * anything that is not a BCP 47-style tag returns null so a malformed layer is
 * skipped rather than silently overriding the layers below it.
 */
export function normalizeInterfaceLanguageTag(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return LANGUAGE_TAG.test(trimmed) ? trimmed : null;
}

/**
 * Pick the winning interface-language tag across the layers, in
 * HOST_LANGUAGE_SOURCES order. Returns `{ tag: null, source: 'default' }` when
 * no layer names a usable tag, which keeps Chinese as the shipped default.
 */
export function resolveHostLanguageTag(layers = {}) {
  for (const source of HOST_LANGUAGE_SOURCES) {
    const tag = normalizeInterfaceLanguageTag(layers[source]);
    if (tag !== null) return { tag, source };
  }
  return { tag: null, source: 'default' };
}
