// Persona: the bot's own character, rendered once per Session as prompt context.
//
// A persona is stored data, never code: the operator writes a card, the channel
// renders it into guidance text, and the Host materializes that text as dynamic
// prompt context (see `im-persona.mjs`). Keeping the render here, in a module
// with no Node built-ins, lets the Host bundle and the Web settings form share
// one definition of "what a persona may say".
//
// Field set follows the two community standards this project borrows from:
// SillyTavern Character Card V2/V3 (`personality`, `mes_example`,
// `post_history_instructions`) and AstrBot's Persona row (`system_prompt` plus
// `begin_dialogs`). The split that matters is the one LangBot states for the
// same-named bot: rules and voice are separate fields, and a short card beats a
// long one -- a long rule stack makes every line read like a template.

/** Every field one persona may carry; the settings validator uses this list. */
export const PERSONA_FIELDS = Object.freeze([
  'name', 'nickname', 'identity', 'personality', 'speakingStyle',
  'likes', 'taboos', 'exampleDialogues', 'styleRules',
]);

/** Per-field character bounds. `0` means "unbounded but still a string". */
export const PERSONA_LIMITS = Object.freeze({
  name: 32,
  nickname: 32,
  identity: 400,
  personality: 600,
  speakingStyle: 400,
  likes: 400,
  taboos: 400,
  styleRules: 1200,
  exampleDialogues: 2400,
  exampleDialoguesMaxEntries: 8,
  exampleDialogueMaxChars: 300,
});

/** One rendered persona may not exceed this; the Host prompt context is bounded too. */
export const PERSONA_GUIDANCE_MAX_LENGTH = 6_000;

/**
 * The shipped character: 大肥鱼, the WeChat group bot this repository runs.
 *
 * Written to the three-part shape the LangBot article recommends -- who it is,
 * what it is bad at, where it stops -- plus two example exchanges, because an
 * example calibrates length and tone far better than an adjective does.
 */
export const DEFAULT_PERSONA = Object.freeze({
  name: '大肥鱼',
  nickname: '肥鱼',
  identity: '群里的一只闲鱼，常年泡在这个微信群里。不是客服，不是助手，是群友。',
  personality: '嘴贫但心不坏，爱接梗，偶尔认死理。别人认真求助时会先给答案再接一句玩笑；'
    + '自己不懂就直说不懂，不装懂，也不写「作为一个AI」。',
  speakingStyle: '短句为主，一般一到三句就说完；口语，少用书面连接词；'
    + '不用「首先/其次/综上/总而言之」这类报告腔；该用标点用标点，不堆感叹号。',
  likes: '群友聊吃的、聊数码、聊隔壁群的八卦；被叫「肥鱼」会应。',
  taboos: '不评价群友的长相和家里的事；不主动打听隐私；不接黄腔；'
    + '不在群里发长段落刷屏。',
  styleRules: '一次回复只讲一件事；能一句话说清就不写两句；'
    + '不主动总结对方说的话；不追问「还有什么可以帮您」；'
    + '不确定的事说不确定，不编细节。',
  exampleDialogues: Object.freeze([
    Object.freeze({ user: '@大肥鱼 今天好热啊', bot: '热得我都不想动了，你今天出门了吗' }),
    Object.freeze({ user: '@大肥鱼 这个报错咋整', bot: '把报错那几行发我看看，光看这句我猜不出来' }),
  ]),
});

/**
 * Tag literals the prompt protocol reserves.
 *
 * A persona card is operator-authored text that lands in the same prompt
 * assembly as the injected-context blocks. If a card could carry
 * `<dsh_im_source>` verbatim, the Host splitter would have to decide whether the
 * operator wrote configuration or the channel did -- and a card is never
 * configuration. The opening bracket is therefore rewritten to its fullwidth
 * twin: it reads identically to a human and cannot be parsed as our grammar.
 */
const RESERVED_TAG_PATTERN = /<(\/?)\s*dsh_im_([a-z_]+)/giu;

/**
 * Neutralize anything in operator text that could act as protocol.
 *
 * Two classes are rewritten, both invisible to a reader: C0/C1 control
 * characters (a NUL or an ESC in a card is always a mistake, and some renderers
 * act on them), and the reserved tag literals above. Ordinary angle brackets,
 * quotes and emoji pass through untouched -- a character is allowed to write
 * "<3" or a blockquote if it wants to.
 */
function sanitizeOperatorText(value) {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ')
    .replace(RESERVED_TAG_PATTERN, (_match, slash, name) => (slash ? '‹/' : '‹') + 'dsh_im_' + name);
}

/** Bounds one optional string field, treating anything non-string as absent. */
function optionalText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = sanitizeOperatorText(value).trim();
  if (!trimmed) return '';
  return max > 0 && trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Read one example dialogue.
 *
 * Accepts either the stored object shape `{user, bot}` or the plain-text shape
 * `"user: ... / bot: ..."` that operators paste from a character card, because
 * refusing the second shape would force a UI conversion step nobody asked for.
 *
 * @param value - one entry of `exampleDialogues`.
 * @returns `{user, bot}`, or null when the entry carries no usable pair.
 */
function normalizeExample(value) {
  const max = PERSONA_LIMITS.exampleDialogueMaxChars;
  let user = '';
  let bot = '';
  if (typeof value === 'string') {
    // "user: X" then "bot: Y", each possibly on its own line.
    const lines = value.split(/\r?\n/);
    for (const line of lines) {
      const match = /^\s*(?:user|{{user}}|对方|群友|用户)\s*[:：]\s*(.*)$/i.exec(line);
      const other = /^\s*(?:bot|char|{{char}}|我|机器人)\s*[:：]\s*(.*)$/i.exec(line);
      if (match && !user) user = match[1];
      else if (other && !bot) bot = other[1];
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    user = optionalText(value.user ?? value.human, max);
    bot = optionalText(value.bot ?? value.char ?? value.assistant, max);
  }
  user = optionalText(user, max);
  bot = optionalText(bot, max);
  // Half an exchange teaches nothing about turn-taking, so both halves are required.
  return user && bot ? { user, bot } : null;
}

/** Normalize the example list: bounded count, bounded length, no duplicates. */
function normalizeExamples(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const normalized = normalizeExample(entry);
    if (!normalized) continue;
    const key = normalized.user + '\u0000' + normalized.bot;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze(normalized));
    if (out.length >= PERSONA_LIMITS.exampleDialoguesMaxEntries) break;
  }
  return Object.freeze(out);
}

/**
 * Normalize any stored or submitted persona into the canonical shape.
 *
 * Never throws: a damaged persona must degrade to "the fields that survived",
 * because a channel reads this on every prompt and an exception there would
 * cost the user their message. Validation that must reject bad input lives in
 * `validatePersona`, which the settings path calls.
 *
 * @param value - stored persona JSON, a partial card, or nothing.
 * @returns a frozen persona; an unusable input yields the shipped default.
 */
export function normalizePersona(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_PERSONA;
  }
  const persona = {
    name: optionalText(value.name, PERSONA_LIMITS.name) || DEFAULT_PERSONA.name,
    nickname: optionalText(value.nickname, PERSONA_LIMITS.nickname),
    identity: optionalText(value.identity, PERSONA_LIMITS.identity),
    personality: optionalText(value.personality, PERSONA_LIMITS.personality),
    speakingStyle: optionalText(value.speakingStyle, PERSONA_LIMITS.speakingStyle),
    likes: optionalText(value.likes, PERSONA_LIMITS.likes),
    taboos: optionalText(value.taboos, PERSONA_LIMITS.taboos),
    styleRules: optionalText(value.styleRules, PERSONA_LIMITS.styleRules),
    exampleDialogues: normalizeExamples(value.exampleDialogues),
  };
  // An all-empty card other than the name is still a card: it renders as the
  // name alone, which is exactly what "not configured yet" should look like.
  return Object.freeze(persona);
}

/** Reject a submitted persona the settings form could not have produced. */
export function validatePersona(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new TypeError('请提交完整的人设设置。'), { code: 'persona-invalid' });
  }
  for (const key of Object.keys(input)) {
    if (!PERSONA_FIELDS.includes(key)) {
      throw Object.assign(new TypeError(`不认识的人设字段：${key}`), { code: 'persona-invalid' });
    }
  }
  const persona = normalizePersona(input);
  if (!persona.name) {
    throw Object.assign(new TypeError('人设必须有名字。'), { code: 'persona-invalid' });
  }
  return persona;
}

/**
 * Render one persona into the guidance text a Session carries.
 *
 * Order matters and is deliberate: identity and voice first (the model reads
 * downward and weights the opening hardest), then the hard limits, then the
 * examples last, because the material closest to the user's message is what
 * imitates best. Empty fields are omitted rather than emitted as empty labels --
 * a heading with nothing under it teaches the model to pad.
 *
 * @param persona - a normalized persona.
 * @param options.maxChars - hard cap on the rendered text.
 * @returns the guidance text, or '' when the persona has nothing to say.
 */
export function renderPersonaGuidance(persona, { maxChars = PERSONA_GUIDANCE_MAX_LENGTH } = {}) {
  const card = persona === DEFAULT_PERSONA ? persona : normalizePersona(persona);
  const lines = [];
  const name = card.name || DEFAULT_PERSONA.name;
  lines.push(`## 你是谁`);
  // "You are X (they call you Y)" -- the nickname is what group members type.
  lines.push(card.nickname && card.nickname !== name
    ? `你是${name}，群里的人叫你「${card.nickname}」。`
    : `你是${name}。`);
  if (card.identity) lines.push(card.identity);
  if (card.personality) {
    lines.push('');
    lines.push('## 你的性格');
    lines.push(card.personality);
  }
  if (card.speakingStyle) {
    lines.push('');
    lines.push('## 你怎么说话');
    lines.push(card.speakingStyle);
  }
  if (card.likes) {
    lines.push('');
    lines.push('## 你喜欢聊的');
    lines.push(card.likes);
  }
  if (card.taboos) {
    lines.push('');
    lines.push('## 你不碰的');
    lines.push(card.taboos);
  }
  if (card.styleRules) {
    lines.push('');
    lines.push('## 硬规矩');
    lines.push(card.styleRules);
  }
  if (card.exampleDialogues.length > 0) {
    lines.push('');
    lines.push('## 你平时怎么回（照这个长度和口气，不要照抄内容）');
    for (const exchange of card.exampleDialogues) {
      lines.push(`群友：${exchange.user}`);
      lines.push(`你：${exchange.bot}`);
    }
  }
  const text = lines.join('\n').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  // Cut on a line boundary so a truncated render never ends mid-sentence.
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd();
}
