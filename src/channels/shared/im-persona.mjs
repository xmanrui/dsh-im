// Session-keyed persona guidance: the character text a conversation answers as.
//
// Same shape as `im-source-guidance.mjs`, and for the same reason. The prompt
// RPC carries no message source and no configuration, so a channel publishes
// the persona it has in force when it dispatches a prompt; the Host registers
// one dynamic prompt context that renders whatever this registry holds for the
// Session being assembled. Publishing out of band (rather than writing the card
// into the user prompt) keeps the card out of the transcript and lets the Host
// re-snapshot it only when it changes.
//
// The registry is module-level because one process owns exactly one. It holds
// rendered text, never the persona object: rendering is bounded and pure, and a
// Session must keep the exact text it was started with even if the operator
// edits the card mid-conversation.

/** Prompt-context name the Host materializes persona guidance under. */
export const IM_PERSONA_CONTEXT = 'dsh-im:persona';

/**
 * Contexts are joined in ascending order. This one precedes the source
 * guidance (125) because a character is read before an instruction: the model
 * should already know who it is by the time it reads how to treat a group.
 */
export const IM_PERSONA_ORDER = 120;

/** Bound for one session persona; the rendered card is capped well below this. */
const PERSONA_MAX_LENGTH = 8_000;

/** Bound on retained sessions, so an abandoned conversation cannot grow it. */
const MAX_SESSIONS = 1_024;

class ImPersonaRegistry {
  #bySession = new Map();

  /**
   * Publish the persona in force for one session.
   *
   * An empty string clears the entry, so a conversation that turns the persona
   * off stops contributing a snapshot instead of keeping the last one alive.
   *
   * @param sessionId - the Session the prompt was dispatched to.
   * @param guidance - the rendered persona text, or empty when none applies.
   */
  publish(sessionId, guidance) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const text = typeof guidance === 'string' ? guidance.slice(0, PERSONA_MAX_LENGTH) : '';
    // Delete first so the re-inserted key is the most recently used one.
    this.#bySession.delete(sessionId);
    if (!text.trim()) return;
    this.#bySession.set(sessionId, text);
    while (this.#bySession.size > MAX_SESSIONS) {
      this.#bySession.delete(this.#bySession.keys().next().value);
    }
  }

  /**
   * @param sessionId - a Session id, or anything else.
   * @returns the persona in force for that session, or undefined.
   */
  get(sessionId) {
    return typeof sessionId === 'string' ? this.#bySession.get(sessionId) : undefined;
  }

  /**
   * Drop one session persona.
   * @param sessionId - the Session leaving the registry.
   */
  forget(sessionId) {
    if (typeof sessionId === 'string') this.#bySession.delete(sessionId);
  }

  /** @returns how many sessions currently carry a persona. */
  get size() {
    return this.#bySession.size;
  }
}

export const imPersona = new ImPersonaRegistry();
