const quoteChars = new Set(["'", '"', '`']);

// Decode source escapes, not runtime keys: explicit \r must remain distinct
// from the physical CR/CRLF that JavaScript cooks to LF in template literals.
function decodeLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\' || i + 1 >= raw.length) {
      out += raw[i];
      continue;
    }
    const next = raw[i + 1];
    if (next === '\r') {
      if (raw[i + 2] === '\n') i += 1;
    } else if (next === '\n' || next === '\u2028' || next === '\u2029') {
      // An escaped physical line terminator is a line continuation: no value.
    } else if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else out += next; // \', \", \\, \` and anything else keep the char
    i += 1;
  }
  return out;
}

// Parse a static string or cooked template without evaluating source code.
// Templates with substitutions are dynamic and remain unresolved.
export function parseStringAt(source, start) {
  const quote = source[start];
  if (!quoteChars.has(quote)) return null;
  let raw = '';
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      raw += char;
      if (i + 1 < source.length) raw += source[i + 1];
      if (source[i + 1] === '\r' && source[i + 2] === '\n') {
        raw += '\n';
        i += 1;
      }
      i += 1;
      continue;
    }
    if (char === quote) return { value: decodeLiteral(raw), end: i + 1 };
    if (quote === '`' && char === '$' && source[i + 1] === '{') return null;
    if (char === '\r' || char === '\n') {
      if (quote !== '`') return null;
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      raw += '\n';
    } else {
      raw += char;
    }
  }
  return null;
}
