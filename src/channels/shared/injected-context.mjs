// Pair one injected context prefix with the user message that carried it.
//
// The prompt RPC carries no message source, so a channel encodes its source
// block (and optional guidance) as a leading text part of the user prompt.
// `installInjectedContext` splits that prefix back out at `agent/pre-step` --
// after the Agent inbox claimed the message but before anything is committed --
// and enters the message as the untouched user text plus plugin-sourced
// context messages. Pairing is decided by message identity, never by inbox
// position, so concurrent prompts cannot swap their contexts.
//
// Keep this module free of Node built-ins: the Host bundle imports it.

import {
  INJECTED_CONTEXT_SEPARATOR,
  INJECTED_CONTEXT_TAGS,
} from './context-enhancement.mjs';

/** Source plugin name recorded on every split-out context message. */
export const INJECTED_CONTEXT_PLUGIN = 'dsh-im';

/** Bound for a `notice` summary, mirroring the Host's context-summary bound. */
export const CONTEXT_SUMMARY_MAX_LENGTH = 120;

let fallbackIdCounter = 0;

/** Mint one message identity; prefer a UUID so resumed logs never collide. */
function defaultNewId() {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  fallbackIdCounter += 1;
  return `dsh-im-context-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

/**
 * One-line account of a source block, for the collapsed transcript row.
 * @param body - the block's JSON body, exactly as the producer wrote it.
 * @returns a bounded human summary, or null when nothing readable is present.
 */
function sourceSummary(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const summary = [
    parsed.channel,
    parsed.conversationType,
    parsed.senderName ?? parsed.senderId,
    parsed.conversationTitle,
  ]
    .filter((field) => typeof field === 'string' && field.trim().length > 0)
    .join(' \u00b7 ');
  if (!summary) return null;
  return summary.length > CONTEXT_SUMMARY_MAX_LENGTH
    ? summary.slice(0, CONTEXT_SUMMARY_MAX_LENGTH)
    : summary;
}

/**
 * Read one leading injected-context prefix off a text part.
 *
 * The producer emits `<dsh_im_source>` (whose JSON body escapes angle brackets)
 * optionally followed by `<dsh_im_source_guidance>`, joined by one blank line.
 * Anything that does not parse as that exact shape is left alone, so ordinary
 * user text stays verbatim even when it mentions the tags.
 *
 * @param text - one text part's exact value.
 * @returns the parsed blocks and the remaining user text, or null when the text
 *   does not begin with a well-formed prefix.
 */
export function splitInjectedContextPrefix(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const { sourceOpen, sourceClose, guidanceOpen, guidanceClose } = INJECTED_CONTEXT_TAGS;
  const blocks = [];
  let cursor = 0;
  if (text.startsWith(sourceOpen)) {
    const end = text.indexOf(sourceClose, sourceOpen.length);
    if (end === -1) return null;
    const summary = sourceSummary(text.slice(sourceOpen.length, end));
    // A body that is not our JSON is user text that happens to use the tag.
    if (summary === null) return null;
    blocks.push({ form: 'notice', text: text.slice(0, end + sourceClose.length), summary });
    cursor = end + sourceClose.length;
    if (text.startsWith(INJECTED_CONTEXT_SEPARATOR, cursor)) {
      cursor += INJECTED_CONTEXT_SEPARATOR.length;
    }
  }
  if (text.startsWith(guidanceOpen, cursor)) {
    const end = text.indexOf(guidanceClose, cursor + guidanceOpen.length);
    // The producer always writes its closing tag on a line of its own.
    if (end === -1 || text[end - 1] !== '\n') return null;
    blocks.push({
      form: 'instructions',
      text: text.slice(cursor, end + guidanceClose.length),
      summary: null,
    });
    cursor = end + guidanceClose.length;
    if (text.startsWith(INJECTED_CONTEXT_SEPARATOR, cursor)) {
      cursor += INJECTED_CONTEXT_SEPARATOR.length;
    }
  }
  if (blocks.length === 0) return null;
  return { blocks, rest: text.slice(cursor) };
}

/**
 * Build the plugin-sourced context message for one parsed block.
 * @param block - one parsed prefix block.
 * @param newId - identity factory for the new message.
 * @param plugin - source plugin name recorded on it.
 * @returns one identified user-role context message.
 */
function contextMessage(block, newId, plugin) {
  const source = block.form === 'notice' && typeof block.summary === 'string'
    ? { kind: 'plugin', plugin, form: 'notice', summary: block.summary }
    : { kind: 'plugin', plugin, form: block.form };
  return {
    id: newId(),
    role: 'user',
    content: [{ type: 'text', text: block.text }],
    source,
  };
}

/**
 * Read the injected prefix carried by one claimed user message.
 * @param message - a message claimed from the Agent inbox.
 * @returns that message's content, the remaining user text, and the parsed
 *   blocks, or null when the message carries no injected prefix.
 */
function claimedInjectedContext(message) {
  if (message === null || typeof message !== 'object') return null;
  const source = message.source;
  // Only a prompt that travelled through the prompt RPC carries the prefix;
  // the same gate keeps plugin-authored messages out of the rewrite.
  if (source === null || typeof source !== 'object' || source.kind !== 'user'
    || typeof source.rpcId !== 'string' || source.rpcId.length === 0) return null;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (first === null || typeof first !== 'object'
    || first.type !== 'text' || typeof first.text !== 'string') return null;
  const split = splitInjectedContextPrefix(first.text);
  if (split === null || split.blocks.length === 0) return null;
  return { content, rest: split.rest, blocks: split.blocks };
}

/**
 * Rewrite the messages entering one step so every injected prefix becomes its
 * own plugin-sourced context message beside the user text it described.
 *
 * Every other message is returned untouched and in place, so a plugin that
 * matches claimed messages by identity still sees the ones it owns.
 *
 * @param messages - the messages the Agent is about to commit for this step.
 * @param options.newId - identity factory for the added context messages.
 * @param options.plugin - source plugin name recorded on them.
 * @returns a new array when at least one message was split, otherwise null.
 */
export function rewriteInjectedContextMessages(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const newId = typeof options.newId === 'function' ? options.newId : defaultNewId;
  const plugin = typeof options.plugin === 'string' && options.plugin
    ? options.plugin
    : INJECTED_CONTEXT_PLUGIN;
  let changed = false;
  const rewritten = [];
  for (const message of messages) {
    const claimed = claimedInjectedContext(message);
    if (claimed === null) {
      rewritten.push(message);
      continue;
    }
    const { content, rest, blocks } = claimed;
    const userContent = rest.length > 0
      ? [{ type: 'text', text: rest }, ...content.slice(1)]
      : content.slice(1);
    // A user message with no content left is never committed; leaving the
    // original message alone keeps the prompt valid instead of dropping it.
    if (userContent.length === 0) {
      rewritten.push(message);
      continue;
    }
    changed = true;
    rewritten.push({ ...message, content: userContent });
    for (const block of blocks) rewritten.push(contextMessage(block, newId, plugin));
  }
  return changed ? rewritten : null;
}
