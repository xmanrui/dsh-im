import { t } from './i18n.mjs';

/**
 * How much of a turn a chat channel shows while it runs.
 *
 * One enum drives both decisions a turn makes — which stream to open and which
 * progress updates reach the reader — so a channel never ends up with a
 * "thinking stream" whose frames are then thrown away (or a placeholder that
 * still receives per-line frames).
 *
 *   - `minimal`  one placeholder, no step detail; the answer is the message.
 *   - `standard` one placeholder, rewritten in place with a compact line about
 *                the latest tool, and collapsed into a one-line receipt when the
 *                turn ends. This is the default: a long turn costs one message.
 *   - `full`     the thinking stream: every 💭 line, every 🔧 call and the
 *                answer are separate messages, for a reader who wants the whole
 *                chain.
 *
 * The levels are channel-agnostic on purpose: a channel that cannot carry a
 * keyboard or an editable placeholder simply falls back to its text path.
 */
export const PRESENTATION_LEVELS = Object.freeze(['minimal', 'standard', 'full']);

/** A phone chat is a conversation, not a log: one message per turn by default. */
export const DEFAULT_PRESENTATION_LEVEL = 'standard';

const MINIMAL_LABEL = '极简';
const STANDARD_LABEL = '标准';
const FULL_LABEL = '全面';

const LABELS = Object.freeze({
  minimal: MINIMAL_LABEL,
  standard: STANDARD_LABEL,
  full: FULL_LABEL,
});

/**
 * Chat input for `/display`. Kept apart from {@link normalizePresentationLevel}
 * because a stored value must never be guessed from a user's phrase, while a
 * typed one should accept the level's own Chinese name.
 */
const INPUT_ALIASES = new Map([
  ['极简', 'minimal'], ['精简', 'minimal'], ['minimal', 'minimal'], ['min', 'minimal'],
  ['标准', 'standard'], ['默认', 'standard'], ['standard', 'standard'], ['std', 'standard'],
  ['全面', 'full'], ['完整', 'full'], ['full', 'full'], ['verbose', 'full'], ['all', 'full'],
]);

/** Normalize a stored level; an unknown value falls back instead of throwing. */
export function normalizePresentationLevel(value, fallback = DEFAULT_PRESENTATION_LEVEL) {
  if (typeof value !== 'string') return fallback;
  const key = value.trim().toLowerCase();
  return PRESENTATION_LEVELS.includes(key) ? key : fallback;
}

/**
 * The level a bot config means.
 *
 * `presentationLevel` wins. Without one, the older boolean keeps its meaning —
 * `thinkingTraces: true` is a reader who asked for the whole chain — while an
 * absent field now means `standard`, because the per-line default is exactly
 * the flood this setting exists to stop.
 */
export function presentationLevelFromConfig(config) {
  const stored = normalizePresentationLevel(config?.presentationLevel, null);
  if (stored) return stored;
  return config?.thinkingTraces === true ? 'full' : DEFAULT_PRESENTATION_LEVEL;
}

/** Map `/display <word>` to a level; null when the word is not a level. */
export function parsePresentationLevelInput(value) {
  if (typeof value !== 'string') return null;
  return INPUT_ALIASES.get(value.trim().toLowerCase()) ?? null;
}

/** Localized level name, for cards and receipts. */
export function presentationLevelLabel(level) {
  const name = LABELS[normalizePresentationLevel(level)];
  return t(name);
}

const TOOL_SUMMARY_LIMIT = 40;
/** Same fields the per-line trace prefers, most specific first. */
const TOOL_ARGUMENT_KEYS = Object.freeze([
  'command', 'pattern', 'query', 'url', 'file_path', 'path', 'text', 'prompt', 'message', 'description',
]);
const TOOL_ICON = Object.freeze({ running: '🔧', ok: '✅', error: '⚠️' });

/**
 * Cut a string on a character boundary.
 *
 * A code point is one grapheme for this purpose: slicing UTF-16 units can split
 * a surrogate pair and render a replacement character — a visible glitch in a
 * line the reader watches update live.
 */
function truncateText(text, limit) {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  // Keep `limit` characters and add the ellipsis: this is the shape the tool
  // trace lines already shipped with, so the two rungs stay identical.
  return `${characters.slice(0, limit).join('')}…`;
}

/**
 * A tool argument is shown as one short phrase, never as the tool's payload:
 * the reader needs to recognize the step, not to audit it. Accepts the raw
 * argument value or the JSON string the Harness hands over.
 */
export function summarizeToolArguments(value, { limit = TOOL_SUMMARY_LIMIT } = {}) {
  let record = null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    record = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed;
      else return truncateText(trimmed.replace(/\s+/gu, ' ').trim(), limit);
    } catch {
      return truncateText(trimmed.replace(/\s+/gu, ' ').trim(), limit);
    }
  }
  if (!record) return null;
  for (const key of TOOL_ARGUMENT_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return truncateText(candidate.replace(/\s+/gu, ' ').trim(), limit);
    }
  }
  return null;
}

/**
 * The compact progress line for `standard` mode.
 *
 * It answers "is it still working, on what, and how long has it been" in at
 * most two lines, without keeping a history: the placeholder is rewritten on
 * every update, so the reader watching it sees one moving line instead of a
 * wall of messages.
 */
export function createTurnProgress({ now = Date.now, startedAt } = {}) {
  const start = Number.isFinite(startedAt) ? startedAt : now();
  let steps = 0;
  let failures = 0;
  let last = null;
  // Set once the model stops calling tools and starts writing its answer: the
  // reader then sees the turn is finishing instead of a frozen last tool.
  let writing = false;

  const seconds = () => Math.max(0, Math.round((now() - start) / 1_000));

  const compose = (phase) => {
    const elapsed = seconds();
    if (phase === 'done') {
      if (failures > 0 && steps > 0) {
        // A failed step must not be rounded up to a plain ✅: the receipt is the
        // only trace a `standard` reader keeps.
        return t('⚠️ 完成 · {seconds} 秒 · {steps} 步 · {failed} 步失败', {
          seconds: elapsed, steps, failed: failures,
        });
      }
      return steps > 0
        ? t('✅ 完成 · {seconds} 秒 · {steps} 步', { seconds: elapsed, steps })
        : t('✅ 完成 · {seconds} 秒', { seconds: elapsed });
    }
    if (phase === 'failed') {
      // No channel leaves a failure receipt today; the wording stays here so a
      // future one cannot invent a fourth phrasing.
      return steps > 0
        ? t('⚠️ 已中断 · {seconds} 秒 · {steps} 步', { seconds: elapsed, steps })
        : t('⚠️ 已中断 · {seconds} 秒', { seconds: elapsed });
    }
    const head = steps > 0
      ? t('⏳ 处理中 · {seconds} 秒 · {steps} 步', { seconds: elapsed, steps })
      : t('⏳ 处理中 · {seconds} 秒', { seconds: elapsed });
    if (writing) return `${head}\n${t('✍️ 正在整理回复')}`;
    if (!last) return head;
    const icon = TOOL_ICON[last.state] ?? TOOL_ICON.running;
    const detail = last.summary ? `${icon} ${last.name} → ${last.summary}` : `${icon} ${last.name}`;
    return `${head}\n${detail}`;
  };

  return Object.freeze({
    /** One tool call started: count it and remember it as the latest step. */
    tool(name, argumentsValue) {
      steps += 1;
      const label = typeof name === 'string' && name.trim() ? name.trim() : t('工具');
      last = {
        name: label,
        summary: summarizeToolArguments(argumentsValue),
        state: 'running',
      };
    },
    /** The tools are done; the answer is being written. */
    writing() {
      writing = true;
    },
    /** The latest step's result, so the line stops claiming it is still running. */
    settle({ ok = true } = {}) {
      if (last) last.state = ok ? 'ok' : 'error';
      if (!ok) failures += 1;
    },
    get steps() {
      return steps;
    },
    get failures() {
      return failures;
    },
    /** The line for a turn that is still running. */
    runningText() {
      return compose('running');
    },
    /** The one-line receipt a finished turn leaves behind. */
    doneText() {
      return compose('done');
    },
  });
}
