/**
 * GFM pipe tables rendered as an aligned fenced code block.
 *
 * Some channels (Discord today) have no table syntax at all: a raw
 * `| a | b |` line reaches the client as plain text, its columns collapse and
 * the result is unreadable on a phone. A fenced code block keeps the client's
 * monospace font, so the same rows stay readable — that is the only native
 * rendering a table-less channel can offer without attaching an image.
 *
 * The conversion is deliberately structural:
 * - tables inside an existing fenced code block are left alone;
 * - block quotes, list items and deeply indented lines are left alone, because
 *   their context is not a standalone table;
 * - inline emphasis/code markers are removed from cells: inside a fence they
 *   would show as literal `**` and backticks instead of formatting;
 * - column widths use East Asian display width (Han, Kana, Hangul, fullwidth
 *   forms and emoji count as two columns), so CJK and ASCII line up.
 */

/** Markdown inline markers that a fenced code block would show literally. */
// `__` is deliberately absent: identifiers such as `foo__bar__baz` are
// common in tables and are not emphasis. `**` and `~~` are unambiguous.
const INLINE_EMPHASIS = /\*\*(.+?)\*\*|~~(.+?)~~/gu;
const INLINE_CODE = /`+/gu;

/** Alignment marker row: `---`, `:---`, `---:` or `:---:`. */
const DELIMITER_CELL = /^:?-+:?$/u;

/** A table is not a table when it starts a quote, a list item or is indented. */
const UNSAFE_TABLE_START = /^\s{0,3}(?:>|[-*+]\s|\d+[.)]\s)/u;
const INDENTED = /^\s{4,}/u;

/** East Asian display width; terminals and clients use two columns for these. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** Width of one code point in monospace columns. */
function codePointWidth(char) {
  const codePoint = char.codePointAt(0);
  // Combining marks and zero-width joiner take no cell of their own.
  if (codePoint === 0x200D || (codePoint >= 0xFE00 && codePoint <= 0xFE0F)) return 0;
  return WIDE.test(char) ? 2 : 1;
}

/** Display width of a whole cell, in monospace columns. */
export function markdownTableDisplayWidth(value) {
  let width = 0;
  for (const char of String(value ?? '')) width += codePointWidth(char);
  return width;
}

function cellText(value) {
  return String(value ?? '')
    .replace(INLINE_EMPHASIS, (match, bold, strike) => bold ?? strike)
    .replace(INLINE_CODE, '')
    .trim();
}

function fenceDelimiter(line) {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  return match ? match[1] : null;
}

function closesFence(line, delimiter) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
  return Boolean(match
    && match[1][0] === delimiter[0]
    && match[1].length >= delimiter.length);
}

/**
 * Split one pipe row into trimmed cells.
 *
 * A pipe inside an inline code span or escaped as `\|` is content, not a
 * separator. Leading/trailing pipes produce the usual empty outer cells, which
 * are dropped so `| a | b |` and `a | b` describe the same row.
 */
export function splitMarkdownTableRow(line) {
  const source = String(line ?? '');
  const cells = [];
  let current = '';
  let codeTicks = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\' && source[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '`') {
      let run = 0;
      while (source[index + run] === '`') run += 1;
      codeTicks = codeTicks === 0 ? run : (codeTicks === run ? 0 : codeTicks);
      current += '`'.repeat(run);
      index += run - 1;
      continue;
    }
    if (char === '|' && codeTicks === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function isDelimiterRow(cells) {
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

function padCell(cell, width) {
  return cell + ' '.repeat(Math.max(0, width - markdownTableDisplayWidth(cell)));
}

/**
 * Render one detected table as fenced rows.
 *
 * Body cells are padded or truncated to the header's column count, which is how
 * GFM reads a ragged row: missing cells are empty and extra cells are ignored.
 */
function renderTable(headerCells, bodyRows) {
  const columns = Math.max(1, headerCells.length);
  const normalize = (cells) => {
    const row = [];
    for (let index = 0; index < columns; index += 1) {
      row.push(cellText(cells[index] ?? ''));
    }
    return row;
  };
  const header = normalize(headerCells);
  const rows = bodyRows.map(normalize);
  const widths = header.map((cell, column) => Math.max(
    1,
    markdownTableDisplayWidth(cell),
    ...rows.map((row) => markdownTableDisplayWidth(row[column])),
  ));
  const line = (cells) => `| ${cells.map((cell, column) => padCell(cell, widths[column])).join(' | ')} |`;
  return [
    '```',
    line(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map(line),
    '```',
  ];
}

/**
 * Replace every standalone GFM pipe table with an aligned fenced code block.
 *
 * Non-table text is returned byte-for-byte; a table that already lives inside a
 * fence is untouched, so calling this twice is safe.
 *
 * @param {string} text Markdown about to be delivered to a table-less channel.
 * @returns {string} The same text with each table rendered as monospace rows.
 */
export function renderPipeTablesAsCode(text) {
  if (typeof text !== 'string' || !text.includes('|')) return text;
  const lines = text.split('\n');
  const output = [];
  let openFence = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (openFence) {
      output.push(line);
      if (closesFence(line, openFence)) openFence = null;
      index += 1;
      continue;
    }
    const fence = fenceDelimiter(line);
    if (fence) {
      output.push(line);
      openFence = fence;
      index += 1;
      continue;
    }
    // A table needs a header row plus a matching alignment row.
    const next = lines[index + 1];
    const convertible = next !== undefined
      && line.includes('|')
      && next.includes('|')
      && !UNSAFE_TABLE_START.test(line)
      && !INDENTED.test(line);
    if (convertible) {
      const header = splitMarkdownTableRow(line);
      const delimiter = splitMarkdownTableRow(next);
      if (header.length > 0 && isDelimiterRow(delimiter) && delimiter.length === header.length) {
        let end = index + 2;
        const rows = [];
        while (end < lines.length
          && lines[end].includes('|')
          && lines[end].trim() !== ''
          && !UNSAFE_TABLE_START.test(lines[end])
          && !INDENTED.test(lines[end])) {
          rows.push(splitMarkdownTableRow(lines[end]));
          end += 1;
        }
        output.push(...renderTable(header, rows));
        index = end;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  return output.join('\n');
}
