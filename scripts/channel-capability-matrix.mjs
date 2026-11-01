#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Renders the channel capability matrix from the source tree.
 *
 * Why this exists: the README states capabilities per channel in prose, and
 * nothing kept that prose true. Three separate release notes had to say "the
 * README promised X but the channel only does Y", because a hand-written table
 * has no owner and no gate. This script derives the matrix from files that
 * actually implement each capability, so the table cannot drift silently: a
 * capability that stops being implemented disappears from the table, and CI
 * fails while the committed table still claims it.
 *
 * The mapping is deliberately file-level, not semantic. It answers one question
 * - "does any file of this channel implement a call that carries this capability?"
 * - because that is the granularity at which the repository itself claims
 * support. Whether the platform honours the call is checked by each channel's
 * own tests and by the live verification recorded in docs/benchmark.
 *
 * Usage:
 *   node scripts/channel-capability-matrix.mjs            # print Markdown
 *   node scripts/channel-capability-matrix.mjs --write    # rewrite the README block
 *   node scripts/channel-capability-matrix.mjs --check    # fail when the README is stale
 */

const root = resolve(import.meta.dirname, '..');
const channelsDirectory = resolve(root, 'src/channels');
const readmePath = resolve(root, 'README.md');

/** Marker lines that fence the generated block inside README.md. */
export const BLOCK_START = '<!-- channel-capability-matrix:start -->';
export const BLOCK_END = '<!-- channel-capability-matrix:end -->';

/**
 * Capability columns, each with the file-level evidence that proves it.
 *
 * Order matters: it is the column order in the rendered table, arranged from
 * inbound to outbound, matching how the README describes a channel.
 */
export const CAPABILITIES = Object.freeze([
  // 每一列的 patterns 必须是「出站/入站能力的实现点」，不是文案里出现过的词。
  // 校准记录（2026-11-02 在本仓 15 个渠道目录上跑对照，见 docs/benchmark 分卷）：
  // - `image_key|imageKey` 会把微信记成支持图片：微信出站载荷没有 image key，故只认发送函数。
  // - `voice|audio` 会把 Discord 记成支持语音：命中处是「Discord 拒绝附件」的错误文案，故只认语音发送/转写函数。
  // - `group|room` 会把 iMessage 记成支持群聊：适配器只做一对一，故要求会话标识或群发送函数。
  // 这里宁可漏（写成 —）也不误报（写成 ✅）：漏掉的会被下游人工复核补，误报会直接变成对外承诺。
  // 文本的出站实现点在各渠道形状不同：sendText / im.v1.message.create / sendEvent(roomId, ...)。
  { key: 'text', label: '文本', labelEn: 'Text', patterns: [/sendText\(|sendMessage\(|sendEvent\(|im\.v1\.message\.create\(/u] },
  { key: 'image', label: '图片', labelEn: 'Image', patterns: [/sendImage\(|sendPhoto\(|uploadMedia\(/u] },
  { key: 'file', label: '文件', labelEn: 'File', patterns: [/sendFile\(|sendDocument\(|sendAttachment\(/u] },
  { key: 'voice', label: '语音', labelEn: 'Voice', patterns: [/sendVoice\(|sendAudio\(|transcribeIncoming\(|telegramVoiceSource\(/u] },
  { key: 'quote', label: '引用回复', labelEn: 'Quote', patterns: [/replyToMessageId|replyReference|quoteReply|repliedMessage/u] },
  { key: 'group', label: '群聊', labelEn: 'Group', patterns: [/sendGroupMessage\(|groupRoom|openConversationId|roomId|chatId/u] },
  { key: 'stream', label: '流式/编辑', labelEn: 'Stream', patterns: [/editMessage\(|updateMessage\(|sendRichMessageDraft\(|liveCot|streamingCard/u] },
  { key: 'card', label: '卡片/按钮', labelEn: 'Card', patterns: [/sendInteractionCard\(|sendCard\(|interactiveCard|cardAction/u] },
  { key: 'markdown', label: '富文本', labelEn: 'Rich text', patterns: [/renderMarkdown|richText|markdownReply|markdownTo/u] },
]);

/**
 * Directory names that are infrastructure, not a user-facing channel.
 * `shared` is the semantic core every channel imports; `office` is an agent
 * delivery transport rather than an IM, and README documents it separately.
 */
const NON_CHANNEL_DIRECTORIES = new Set(['shared']);

/** Read every `.mjs` file of a channel directory, one level deep plus sub-dirs. */
async function readChannelSources(directory) {
  const chunks = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        // tests and vendored fixtures are never capability evidence
        if (entry.name === 'node_modules' || entry.name === 'tests') continue;
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        chunks.push(await readFile(path, 'utf8'));
      }
    }
  };
  await visit(directory);
  return chunks.join('\n');
}

/**
 * Decide, for every channel, which capabilities have implementation evidence.
 *
 * @returns {Promise<Array<{channel: string, supported: Record<string, boolean>, files: number}>>}
 */
export async function collectChannelMatrix() {
  const channels = [];
  for (const entry of await readdir(channelsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || NON_CHANNEL_DIRECTORIES.has(entry.name)) continue;
    const directory = resolve(channelsDirectory, entry.name);
    const source = await readChannelSources(directory);
    const supported = {};
    for (const capability of CAPABILITIES) {
      supported[capability.key] = capability.patterns.some((pattern) => pattern.test(source));
    }
    channels.push({ channel: entry.name, supported, files: source.length });
  }
  channels.sort((left, right) => left.channel.localeCompare(right.channel));
  return channels;
}

/**
 * 对账：注册表声明 vs 源码证据。两个方向都判漂移。
 *
 * - undeclared：源码里有实现证据，声明里却没有。这正是上游 matterbridge 的病
 *   （harmony 实现了 EventUserTyping，却没登记进 UserTypingSupport ⇒ 那段代码
 *   永远不可达，而且没人报错）。漏登记不是「少写一行注释」，是功能死掉。
 * - unbacked：声明说有，代码里已经没有 ⇒ 对外承诺不实（README 写过「支持 X」
 *   而实现没有，本仓已因此返工过好几次）。
 * - unknownKey：声明里用了 CAPABILITIES 之外的键名。拼错的键会被静默忽略，
 *   等于没声明，所以必须判红而不是跳过。
 * - 集合不一致：src/channels 有目录但 host 没注册，或反之。
 *
 * @param {Array<{channel: string, supported: Record<string, boolean>}>} channels
 * @param {ReadonlyArray<object>} registryEntries
 * @returns {string[]} 漂移清单；空数组 = 一致
 */
export function reconcileDeclarations(channels, registryEntries) {
  const problems = [];
  const knownKeys = new Set(CAPABILITIES.map(function (capability) { return capability.key; }));
  // 渠道名口径统一走 deliveryKey 那一层映射：wecomApp（configKey）与 wecom-app
  // （目录名）是同一个渠道的两种写法。判据复用注册表已有的映射，不再造第二份。
  const byName = new Map();
  for (const entry of registryEntries) {
    const name = entry.deliveryKey ?? entry.configKey;
    byName.set(name, entry);
    if (!Array.isArray(entry.capabilities)) {
      problems.push(name + ": registry entry has no capabilities array");
      continue;
    }
    for (const key of entry.capabilities) {
      if (!knownKeys.has(key)) problems.push(name + ": unknown capability key " + key);
    }
  }
  const channelNames = new Set(channels.map(function (row) { return row.channel; }));
  for (const name of byName.keys()) {
    if (!channelNames.has(name)) problems.push(name + ": registered in host but no src/channels directory");
  }
  for (const row of channels) {
    const entry = byName.get(row.channel);
    if (!entry) {
      problems.push(row.channel + ": has a channel directory but no host registry entry");
      continue;
    }
    if (!Array.isArray(entry.capabilities)) continue;
    const declared = new Set(entry.capabilities);
    for (const capability of CAPABILITIES) {
      const evidence = row.supported[capability.key] === true;
      const says = declared.has(capability.key);
      if (evidence && !says) problems.push(row.channel + "." + capability.key + ": implementation evidence but not declared");
      if (says && !evidence) problems.push(row.channel + "." + capability.key + ": declared but no implementation evidence");
    }
  }
  return problems;
}
/** 渲染语言：中文 README 与英文 README 共用同一份数据，只换标签与图例。 */
export const LOCALES = Object.freeze(['zh', 'en']);

/** 两个 README 的渲染文案；改一处即可同时改两种语言。 */
const TEXT = Object.freeze({
  zh: {
    channelLabel: '渠道',
    legend: [
      '> 本表由 `scripts/channel-capability-matrix.mjs` 从 `src/channels/*/` 源码生成，',
      '> 不手写、可复跑：`node scripts/channel-capability-matrix.mjs`。',
      '> ✅ = 该渠道目录内存在承载此能力的实现文件；— = 未找到实现，属于明确降级（ADR-0001）。',
    ],
  },
  en: {
    channelLabel: 'Channel',
    legend: [
      '> This table is generated from `src/channels/*/` by `scripts/channel-capability-matrix.mjs`;',
      '> it is not hand-written: run `node scripts/channel-capability-matrix.mjs` to reproduce it.',
      '> ✅ = the channel directory contains an implementation for this capability;',
      '> — = no implementation found, i.e. an explicit degradation (ADR-0001).',
    ],
  },
});

/**
 * Render the matrix for one locale.
 *
 * 只把「渠道集合 + 能力格」纳入受检契约：源码字节数会随任何一次 src 编辑变动，
 * 放进表里会让 --check 对别的会话的每一次改动恒红，那不是能力漂移。
 *
 * @param {Array} channels Output of collectChannelMatrix().
 * @param {'zh'|'en'} [locale] Label language.
 */
export function renderMatrix(channels, locale = 'zh') {
  const text = TEXT[locale] ?? TEXT.zh;
  const header = [text.channelLabel, ...CAPABILITIES.map((capability) => (
    locale === 'en' ? (capability.labelEn ?? capability.label) : capability.label
  ))];
  const separator = header.map(() => '---');
  const rows = channels.map((channel) => [
    '`' + channel.channel + '`',
    ...CAPABILITIES.map((capability) => (channel.supported[capability.key] ? '✅' : '—')),
  ]);
  return [
    BLOCK_START,
    ...text.legend,
    '',
    table([header, separator, ...rows]),
    BLOCK_END,
  ].join('\n');
}

/** Minimal Markdown table renderer; keeps the script dependency-free. */
function table(rows) {
  return rows.map((cells) => '| ' + cells.join(' | ') + ' |').join('\n');
}

/**
 * Replace the fenced block in a document.
 *
 * @param {string} document Whole README text.
 * @param {string} block Rendered block including its markers.
 * @returns {string} Document with the block replaced, or unchanged with a null marker.
 */
export function replaceBlock(document, block) {
  const start = document.indexOf(BLOCK_START);
  const end = document.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return { document, replaced: false };
  const tail = end + BLOCK_END.length;
  return { document: document.slice(0, start) + block + document.slice(tail), replaced: true };
}

/** README targets: each document carries its own locale of the same data. */
const DOCUMENTS = Object.freeze([
  { path: 'README.md', locale: 'zh' },
  { path: 'README.en.md', locale: 'en' },
]);

async function main() {
  const channels = await collectChannelMatrix();

  if (process.argv.includes('--write')) {
    let changed = 0;
    for (const document of DOCUMENTS) {
      const path = resolve(root, document.path);
      const current = await readFile(path, 'utf8');
      const { document: next, replaced } = replaceBlock(current, renderMatrix(channels, document.locale));
      if (!replaced) {
        console.error(document.path + ' has no ' + BLOCK_START + ' / ' + BLOCK_END + ' fence');
        process.exitCode = 1;
        continue;
      }
      if (next !== current) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path, next);
        changed += 1;
      }
    }
    console.log('CAPABILITY_MATRIX_WRITTEN ' + channels.length + ' channels, ' + changed + ' document(s)');
    return;
  }

  if (process.argv.includes('--check')) {
    const stale = [];
    for (const document of DOCUMENTS) {
      const current = await readFile(resolve(root, document.path), 'utf8');
      const { document: next, replaced } = replaceBlock(current, renderMatrix(channels, document.locale));
      if (!replaced || next !== current) stale.push(document.path);
    }
    if (stale.length > 0) {
      console.error('CAPABILITY_MATRIX_STALE (' + stale.join(', ') + '): run node scripts/channel-capability-matrix.mjs --write');
      process.exitCode = 1;
      return;
    }
    // 第二道判据：README 对得上 ≠ 声明对得上。注册表里的 capabilities 必须与同一
    // 份实测证据双向一致，否则「登记了但代码没有」与「代码有但没登记」都会绿。
    const registryModule = await import("./host-registry-for-gate.mjs");
    const drift = reconcileDeclarations(channels, registryModule.HOST_CHANNELS);
    if (drift.length > 0) {
      console.error("CAPABILITY_MATRIX_DECLARATION_DRIFT " + drift.length + " problem(s): " + drift.join(" | "));
      process.exitCode = 1;
      return;
    }
    // 保留原前缀（旧文档与 grep 仍匹配），只在尾部追加对账读数。
    console.log('CAPABILITY_MATRIX_OK ' + channels.length + ' channels, ' + DOCUMENTS.length + ' document(s), declarations reconciled');
    return;
  }

  // 打印时默认输出中文版；--locale en 输出英文版。
  const localeFlag = process.argv.indexOf('--locale');
  const locale = localeFlag === -1 ? 'zh' : process.argv[localeFlag + 1];
  console.log(renderMatrix(channels, locale === 'en' ? 'en' : 'zh'));
}

// Windows-safe "is this the entry module" check: comparing URL strings fails
// because argv[1] arrives as a drive path (D:\\...), not a file:// URL.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}