/**
 * Whether each reply should carry the model that produced it.
 *
 * The switch is global rather than per conversation: an operator who wants the
 * model named wants it named everywhere the bot answers, and per-conversation
 * state would have to be threaded through every channel's delivery path just to
 * answer a question nobody asked locally.
 *
 * Off by default. Appending a line to every reply makes ordinary answers
 * longer, and the model is already one `/model` away — so this is opt-in for
 * people who are watching routing or comparing models across channels.
 */
let includeModel = false;
const listeners = new Set();

/** Resolve a user-supplied on/off argument. Returns null when unrecognized. */
export function normalizeModelInfoSetting(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', '开', '开启'].includes(token)) return true;
  if (['off', 'false', '0', 'no', '关', '关闭'].includes(token)) return false;
  return null;
}

/** Turn the model attribution on or off. Returns the applied value. */
export function setReplyModelAttribution(next) {
  const resolved = normalizeModelInfoSetting(next);
  if (resolved === null || resolved === includeModel) return includeModel;
  const previous = includeModel;
  includeModel = resolved;
  // Snapshot first: a subscriber may unsubscribe while running.
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue;
    try {
      listener(includeModel, previous);
    } catch {
      // One subscriber's diagnostics must not strand the rest, nor abandon a
      // switch that already happened.
    }
  }
  return includeModel;
}

export function replyModelAttributionEnabled() {
  return includeModel;
}

/** Observe changes. The disposer is idempotent; listeners must not throw. */
export function onReplyModelAttributionChange(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('onReplyModelAttributionChange requires a listener function');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The line appended to a reply, or null when attribution is off or the model is
 * unknown. Kept deliberately quiet: it is metadata, not part of the answer.
 */
export function modelAttributionLine(modelId) {
  if (!includeModel) return null;
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  return `_模型：${modelId.trim()}_`;
}
