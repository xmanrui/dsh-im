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
  { key: 'text', label: '文本', patterns: [/sendText\(|sendMessage\(|sendEvent\(|im\.v1\.message\.create\(/u] },
  { key: 'image', label: '图片', patterns: [/sendImage\(|sendPhoto\(|uploadMedia\(/u] },
  { key: 'file', label: '文件', patterns: [/sendFile\(|sendDocument\(|sendAttachment\(/u] },
  { key: 'voice', label: '语音', patterns: [/sendVoice\(|sendAudio\(|transcribeIncoming\(|telegramVoiceSource\(/u] },
  { key: 'quote', label: '引用回复', patterns: [/replyToMessageId|replyReference|quoteReply|repliedMessage/u] },
  { key: 'group', label: '群聊', patterns: [/sendGroupMessage\(|groupRoom|openConversationId|roomId|chatId/u] },
  { key: 'stream', label: '流式/编辑', patterns: [/editMessage\(|updateMessage\(|sendRichMessageDraft\(|liveCot|streamingCard/u] },
  { key: 'card', label: '卡片/按钮', patterns: [/sendInteractionCard\(|sendCard\(|interactiveCard|cardAction/u] },
  { key: 'markdown', label: '富文本', patterns: [/renderMarkdown|richText|markdownReply|markdownTo/u] },
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

/** Render the matrix as a Markdown table with a one-line legend. */
export function renderMatrix(channels) {
  const header = ['渠道', ...CAPABILITIES.map((capability) => capability.label), '源码字节'];
  const separator = header.map(() => '---');
  const rows = channels.map((channel) => [
    '\`' + channel.channel + '\`',
    ...CAPABILITIES.map((capability) => (channel.supported[capability.key] ? '✅' : '—')),
    String(channel.files),
  ]);
  const legend = [
    '> 本表由 `scripts/channel-capability-matrix.mjs` 从 `src/channels/*/` 源码生成，',
    '> 不手写、可复跑：`node scripts/channel-capability-matrix.mjs`。',
    '> ✅ = 该渠道目录内存在承载此能力的实现文件；— = 未找到实现，属于明确降级（ADR-0001）。',
    '> 「源码字节」是参与检测的 `.mjs` 内容总字节数，用于说明证据面大小，不是渠道权重。',
  ];
  return [
    BLOCK_START,
    ...legend,
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

async function main() {
  const channels = await collectChannelMatrix();
  const block = renderMatrix(channels);

  if (process.argv.includes('--write')) {
    const document = await readFile(readmePath, 'utf8');
    const { document: next, replaced } = replaceBlock(document, block);
    if (!replaced) {
      console.error('README.md has no ' + BLOCK_START + ' / ' + BLOCK_END + ' fence');
      process.exitCode = 1;
      return;
    }
    if (next !== document) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(readmePath, next);
      console.log('CAPABILITY_MATRIX_WRITTEN ' + channels.length + ' channels');
    } else {
      console.log('CAPABILITY_MATRIX_UNCHANGED ' + channels.length + ' channels');
    }
    return;
  }

  if (process.argv.includes('--check')) {
    const document = await readFile(readmePath, 'utf8');
    const { document: next, replaced } = replaceBlock(document, block);
    if (!replaced || next !== document) {
      console.error('CAPABILITY_MATRIX_STALE: run node scripts/channel-capability-matrix.mjs --write');
      process.exitCode = 1;
      return;
    }
    console.log('CAPABILITY_MATRIX_OK ' + channels.length + ' channels');
    return;
  }

  console.log(block);
}

// Windows-safe "is this the entry module" check: comparing URL strings fails
// because argv[1] arrives as a drive path (D:\\...), not a file:// URL.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
