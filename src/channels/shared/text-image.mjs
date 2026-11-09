// 通用文本渲染器：把 Markdown 或结构化文本渲染成等宽长图。
// 审批卡片、长消息、报告都走这里，避免各渠道各写一套排版。
// 渲染不是必需路径：sharp 缺失、字体找不到、排版失败一律返回空数组，调用方回退文本。

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULTS = Object.freeze({
  width: 760,
  paddingX: 36,
  paddingY: 32,
  fontSize: 26,
  lineHeight: 42,
  headingSize: 30,
  headingLineHeight: 48,
  ruleLineHeight: 34,
  maxHeight: 5_000,
  maxImages: 3,
  background: '#ffffff',
  bodyColor: '#2d333b',
  headingColor: '#111827',
  ruleColor: '#d8dee4',
  accent: '#4a6d8c',
});

const HEADING_LINE = /^(?:={3,}.*={3,}|【.*】|#{1,6}\s+.*)$/u;
const RULE_LINE = /^-{3,}$/u;
/** 断行时优先落在这类字符之后，避免把英文单词或数字从中间劈开。 */
const BREAK_AFTER = new Set([...' \t，。、；：！？,.;:!?)]）】」』']);
/** 全角与 emoji 都占两列；等宽网格靠它算换行位置。 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{1F000}-\u{1F02F}]|[\u{2600}-\u{27BF}]/u;

let sharpPromise;
function loadSharp() {
  sharpPromise ??= import('sharp').then((module) => module.default).catch(() => null);
  return sharpPromise;
}

/**
 * sharp 内置的 libvips 走 fontconfig，Guix 上没有 /etc/fonts/fonts.conf，
 * 不指定 FONTCONFIG_FILE 时 Pango 找不到任何字体，渲染出来是空白图。
 * 只在宿主进程没显式配置时补一个默认值。
 */
function ensureFontconfig() {
  if (process.env.FONTCONFIG_FILE) return true;
  const candidates = [
    join(homedir(), '.guix-home/profile/etc/fonts/fonts.conf'),
    '/etc/fonts/fonts.conf',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.env.FONTCONFIG_FILE = candidate;
      return true;
    }
  }
  return false;
}

function classify(raw) {
  const stripped = raw.trim();
  if (RULE_LINE.test(stripped)) return 'rule';
  if (HEADING_LINE.test(stripped)) return 'heading';
  return 'body';
}

/** Markdown 标记在图片里只会让排版变脏，能剥掉的都剥掉。 */
function stripLine(line) {
  if (line.trim().startsWith('```')) return '';
  return line
    .replace(/^ {0,3}#{1,6}\s+/u, '')
    .replace(/\*\*(.+?)\*\*/gsu, '$1')
    .replace(/__(.+?)__/gsu, '$1')
    .replace(/`([^`\n]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1');
}

function wrapRow(line, columns) {
  if (line === '') return [''];
  const rows = [];
  let remaining = line;
  while (remaining !== '') {
    let width = 0;
    let cut = 0;
    for (const char of remaining) {
      const size = WIDE_CHAR.test(char) ? 2 : 1;
      if (width + size > columns) break;
      width += size;
      cut += char.length;
    }
    if (cut === 0) cut = remaining.codePointAt(0) > 0xFFFF ? 2 : 1;
    if (cut < remaining.length) {
      const window = remaining.slice(0, cut);
      for (let index = window.length - 1; index >= Math.floor(cut * 0.6); index -= 1) {
        if (BREAK_AFTER.has(window[index])) {
          cut = index + 1;
          break;
        }
      }
    }
    rows.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return rows.length > 0 ? rows : [''];
}

function prepareRows(text, options) {
  const columns = Math.floor((options.width - options.paddingX * 2) / (options.fontSize / 2));
  const rows = [];
  let firstLine = true;
  for (const raw of String(text).replace(/\r\n?/gu, '\n').split('\n')) {
    let kind = classify(raw);
    // 卡片类内容（审批、通知）没有 Markdown 标题，首行本身就是标题
    if (options.titleFirst && firstLine && kind === 'body' && raw.trim() !== '') kind = 'heading';
    if (raw.trim() !== '') firstLine = false;
    if (kind === 'rule') {
      rows.push({ kind, text: '' });
      continue;
    }
    let line = stripLine(raw);
    if (kind === 'heading') {
      line = line.trim();
      if (line.startsWith('===') && line.endsWith('===')) line = line.replace(/^=+|=+$/gu, '').trim();
    }
    for (const piece of wrapRow(line, columns)) rows.push({ kind, text: piece });
  }
  return rows;
}

function escapeXml(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function rowHeight(row, options) {
  if (row.kind === 'heading') return options.headingLineHeight;
  if (row.kind === 'rule') return options.ruleLineHeight;
  return options.lineHeight;
}

function layoutHeight(rows, options) {
  let y = options.paddingY;
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'heading' && index > 0) y += 14;
    y += rowHeight(row, options);
  }
  return y + options.paddingY;
}

function buildSvg(rows, options, { page = 1, pages = 1 } = {}) {
  const height = layoutHeight(rows, options);
  const parts = [];
  let y = options.paddingY;
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'heading') {
      if (index > 0) y += 14;
      // 左侧竖色条替代纯加粗：不依赖字体变体，缩略图里也能看出层级
      parts.push(`<rect x="${options.paddingX - 16}" y="${y + 2}" width="4" height="30" rx="2" fill="${options.accent}"/>`);
      parts.push(`<text x="${options.paddingX}" y="${y + 30}" font-size="${options.headingSize}" font-weight="bold" fill="${options.headingColor}">${escapeXml(row.text)}</text>`);
      y += options.headingLineHeight;
    } else if (row.kind === 'rule') {
      y += 14;
      parts.push(`<line x1="${options.paddingX}" y1="${y}" x2="${options.width - options.paddingX}" y2="${y}" stroke="${options.ruleColor}" stroke-width="1"/>`);
      y += 20;
    } else {
      if (row.text !== '') {
        parts.push(`<text x="${options.paddingX}" y="${y + 26}" font-size="${options.fontSize}" fill="${options.bodyColor}">${escapeXml(row.text)}</text>`);
      }
      y += options.lineHeight;
    }
  }
  if (pages > 1) {
    parts.push(`<text x="${options.width - options.paddingX}" y="${height - 10}" font-size="20" text-anchor="end" fill="#9aa4af">${page}/${pages}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="${options.background}"/>`
    + `<g font-family="Sarasa Mono CL, Noto Sans Mono CJK SC, Noto Color Emoji, monospace">${parts.join('')}</g></svg>`;
}

function chunkRows(rows, options) {
  const chunks = [];
  let current = [];
  let height = options.paddingY * 2;
  for (const row of rows) {
    const extra = rowHeight(row, options) + (row.kind === 'heading' && current.length > 0 ? 14 : 0);
    if (current.length > 0 && height + extra > options.maxHeight) {
      chunks.push(current);
      current = [];
      height = options.paddingY * 2;
      current.push(row);
      height += rowHeight(row, options);
      continue;
    }
    current.push(row);
    height += extra;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 把文本渲染成 1..maxImages 张 PNG。
 * @returns {Promise<{ images: Buffer[], omittedRows: number }>}
 */
export async function renderTextImages(text, { signal, ...overrides } = {}) {
  const empty = { images: [], omittedRows: 0 };
  if (typeof text !== 'string' || text.trim() === '') return empty;
  if (!ensureFontconfig()) return empty;
  const sharp = await loadSharp();
  if (!sharp) return empty;

  const options = { ...DEFAULTS, ...overrides };
  const rows = prepareRows(text, options);
  if (rows.length === 0) return empty;
  const chunks = chunkRows(rows, options);

  const images = [];
  const visible = chunks.slice(0, options.maxImages);
  for (const [index, chunk] of visible.entries()) {
    signal?.throwIfAborted();
    const svg = buildSvg(chunk, options, { page: index + 1, pages: visible.length });
    const buffer = await sharp(Buffer.from(svg, 'utf8')).png({ compressionLevel: 9 }).toBuffer();
    images.push(buffer);
  }
  const omittedRows = chunks.slice(options.maxImages).reduce((sum, chunk) => sum + chunk.length, 0);
  return { images, omittedRows };
}
