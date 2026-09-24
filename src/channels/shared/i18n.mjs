// Host-side i18n for dsh-im. Mirrors the conventions of the settings-UI
// translator in plugin-src/client/i18n.js: dictionary keys are the exact
// Chinese source literals, and Chinese (zh) is the identity default, so
// untranslated or unrecognized text always falls back to the original
// Chinese output unchanged.
//
// The English dictionary lives in ./i18n-en.mjs to keep this module small.

import { EN } from './i18n-en.mjs';

let language = 'zh';

const listeners = new Set();

// Accepts 'en', 'en-US', 'english' (any case) as English; anything else
// (including undefined and unrecognized values) selects Chinese. Pure: use it
// to judge a candidate tag without switching the active language.
export function normalizeImHostLanguage(lang) {
  const normalized = typeof lang === 'string' ? lang.trim().toLowerCase() : '';
  return normalized === 'english' || /^en(?:[-_].*)?$/u.test(normalized) ? 'en' : 'zh';
}

/**
 * Select the language of every host-side message. Subscribers registered
 * through onImHostLanguageChange are notified only when the resolved language
 * actually changes, so re-applying the same selection in a different spelling
 * (or an unrecognized tag that keeps falling back to Chinese) is free.
 */
export function setImHostLanguage(lang) {
  const next = normalizeImHostLanguage(lang);
  if (next === language) return language;
  const previous = language;
  language = next;
  // Snapshot first: a subscriber may unsubscribe (or subscribe) while running.
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue;
    try {
      listener(next, previous);
    } catch {
      // Each subscriber owns its own diagnostics; one that fails must not
      // strand the rest, nor abandon a language switch that already happened.
    }
  }
  return language;
}

export function getImHostLanguage() {
  return language;
}

/**
 * Observe committed changes to the host message language. Platform-side
 * surfaces that were localized once at connect time (the Telegram command
 * menu, for example) re-synchronize from here instead of waiting for a
 * reconnect. Subscribers must not throw; the disposer is idempotent.
 */
export function onImHostLanguageChange(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('onImHostLanguageChange requires a listener function');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Translate a user-facing Chinese literal. In zh mode (the default) this is
// the identity function. Optional `params` fills `{name}` placeholders in
// both the Chinese key and its translation, e.g.
//   t('共 {count} 个机器人', { count: 3 })
export function t(text, params) {
  if (typeof text !== 'string') return text;
  const translated = language === 'en' ? EN[text] ?? text : text;
  if (params == null) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
