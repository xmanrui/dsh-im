// Persona pairing for the Host: register one dynamic prompt context that renders
// whatever character the dispatching channel published for this Session.
//
// Structurally identical to the source-guidance context registered alongside it,
// and deliberately separate: guidance answers "how should I treat this chat",
// persona answers "who am I". They change at different speeds (a persona is
// edited rarely, guidance follows the filtering settings) so they occupy their
// own snapshot instead of invalidating each other.

import { getImHostLanguage } from '../../src/channels/shared/i18n.mjs';
import {
  IM_PERSONA_CONTEXT,
  IM_PERSONA_ORDER,
  imPersona,
} from '../../src/channels/shared/im-persona.mjs';

/**
 * Read the language the persona reminder is written in.
 *
 * The card itself is stored in whatever language the operator wrote it; only the
 * wrapper sentence is localized, because it is ours rather than the character's.
 *
 * @returns `'zh'` or `'en'`; an unreadable language setting falls back to English.
 */
function hostLanguage() {
  try {
    return getImHostLanguage() === 'en' ? 'en' : 'zh';
  } catch {
    return 'en';
  }
}

/** One-line statement of the block's authority, in the interface language. */
const AUTHORITY_NOTE = Object.freeze({
  zh: '以上是你的设定。按这个设定说话，不要跳出角色；但你仍然要对事实负责：不知道就说不知道，不编造细节。',
  en: 'The text above is who you are. Speak as that character and stay in it, but stay truthful: if you do not know something, say so instead of inventing detail.',
});

/**
 * Wrap one rendered persona with its authority statement.
 *
 * The note is appended rather than prepended so the first thing the model reads
 * is the character, not a rule about the character.
 *
 * @param text - the rendered persona, or an empty string.
 * @param language - interface language for the note.
 * @returns the text to register, or '' when there is no persona.
 */
export function withPersonaAuthority(text, language = hostLanguage()) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const note = AUTHORITY_NOTE[language] ?? AUTHORITY_NOTE.en;
  return `${text.trim()}\n\n${note}`;
}

/**
 * Register the persona prompt context and its session lifecycle hooks.
 *
 * @param ctx - owning Host context.
 * @param options.registry - persona registry; tests inject their own.
 * @returns a disposer, or null when the context cannot inject prompt contexts.
 */
export function installPersonaContext(ctx, { registry = imPersona } = {}) {
  if (typeof ctx?.on !== 'function') return null;
  // Registered against the prompt service rather than called immediately: the
  // service may not exist yet when a plugin activates, and the registration has
  // to happen exactly once.
  const start = (promptCtx) => {
    if (typeof promptCtx?.systemPrompt?.context !== 'function') return null;
    return promptCtx.systemPrompt.context({
      name: IM_PERSONA_CONTEXT,
      order: IM_PERSONA_ORDER,
      // Read at assembly time, so an operator's edit reaches the next turn
      // without restarting the Host or recreating the Session.
      text: (assembly) => withPersonaAuthority(registry.get(assembly?.agent?.session?.id) ?? ''),
    });
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], start);
  } else {
    start(ctx);
  }
  // A disposed Session must not keep its character in memory.
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id;
    if (typeof sessionId === 'string') registry.forget(sessionId);
  }, { global: true });
  return () => {
    disposeDisposed?.();
  };
}
