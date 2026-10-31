// Coverage guard for host-side translations.
//
// Chinese literals in the source are the identity language, so a string nobody
// translated still renders as Chinese and no test notices. i18n.test.mjs checks
// the dictionaries against each other, which cannot see a source string that is
// missing from all of them. This test closes that gap: it reads the host source,
// collects every literal actually handed to the translator, and requires each
// discovered dictionary to carry it. A missing translation therefore fails the
// build instead of reaching a reader as untranslated text.
//
// The language list is discovered from the dictionary modules themselves, never
// hardcoded: `i18n-<lang>.mjs` next to the translator, or an `i18n-<lang>/`
// directory of per-area modules merged by that same `i18n-<lang>.mjs`. Dropping
// in a new language is enough to have it checked here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { parseStringAt } from './i18n-source-literal.mjs';
import { SHARED_COMMAND_CATALOG } from '../../../src/channels/shared/command-catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const sourceRoot = join(repoRoot, 'src');
const sharedDir = join(sourceRoot, 'channels', 'shared');

// The translator module documents its own API with a `t('…')` example in a
// comment, so it is not a caller and is left out of the scan.
const TRANSLATOR_MODULE = 'i18n.mjs';

const DICTIONARY_ENTRY = /^i18n-([a-z]{2,8}(?:-[a-z0-9]+)*)(\.mjs)?$/u;

// Parse `[ 'a', 'b' ].join('\n')` at `start`; the source builds multi-line usage
// texts this way, and the translator receives the joined result as its key.
//
// `end` is the position just past the closing paren of the call, never just past
// the separator literal: stopping at the separator leaves the `)` to be read as
// the end of the initializer, so `].join('\n') + '…'` passes as the plain joined
// array while the translator actually receives the concatenation.
function parseArrayJoin(source, start) {
  if (source[start] !== '[') return null;
  const parts = [];
  let i = start + 1;
  for (;;) {
    while (i < source.length && /[\s,]/u.test(source[i])) i += 1;
    if (source[i] === ']') {
      i += 1;
      break;
    }
    const part = parseStringAt(source, i);
    if (!part) return null;
    parts.push(part.value);
    i = part.end;
  }
  i = skipTrivia(source, i);
  const tail = /^\.join\(\s*/u.exec(source.slice(i, i + 16));
  if (!tail) return null;
  i += tail[0].length;
  // `join()` with no argument joins on a comma, the same as the default.
  const separator = parseStringAt(source, i) ?? { value: ',', end: i };
  const closing = skipTrivia(source, separator.end);
  if (source[closing] !== ')') return null;
  return { value: parts.join(separator.value), end: closing + 1 };
}

// Skip whitespace and comments between two tokens, so a trailing `// note` or a
// line break before the `;` does not hide the rest of an initializer.
function skipTrivia(source, index) {
  let i = index;
  for (;;) {
    while (i < source.length && /\s/u.test(source[i])) i += 1;
    if (source[i] === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    return i;
  }
}

// The characters that may legally follow a COMPLETE initializer: the statement
// terminator, the next declarator, the end of an enclosing block, and the end of
// the file. A `+`, a `.` or a `?` here means the literal read so far is only a
// fragment of a longer expression and is not the runtime key.
//
// `)` is deliberately absent: it is a legal end for `const X = ('a')` and for
// `const X = ('a') + tail` alike, and the scan cannot tell the two apart, so a
// parenthesized initializer is reported unresolved rather than guessed.
const INITIALIZER_END = new Set([';', ',', '}', null]);

// Parse a whole initializer at `start`, or return null when its value is not
// statically known. `'…'` and `[ '…', … ].join('…')` are the two supported
// forms; anything else — a concatenation, a template with `${…}`, a call, a
// conditional — resolves to nothing rather than to its first fragment.
function parseInitializer(source, start) {
  const parsed = parseStringAt(source, start) ?? parseArrayJoin(source, start);
  if (!parsed) return null;
  const next = skipTrivia(source, parsed.end);
  return INITIALIZER_END.has(next < source.length ? source[next] : null) ? parsed : null;
}

const DECLARATION = /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/gu;

// String constants the source passes to the translator by name, such as
// `t(PRESET_USAGE)`. Without them those calls are invisible and a stale key can
// keep every reader on Chinese; see the usage texts below.
//
// The table is per module on purpose. Keying constants by identifier alone makes
// two unrelated files that happen to reuse a name — `PENDING_RESTART_NOTICE`
// lives in both the QQ bridge and the text harness bridge — overwrite each other,
// and the loser's call site is then compared against the winner's string, so an
// untranslated string passes. A name declared twice inside one module is
// shadowed for the same reason and stays unresolved.
function moduleConstants(source) {
  const constants = new Map();
  for (const match of source.matchAll(DECLARATION)) {
    const name = match[1];
    const existing = constants.get(name);
    if (existing) {
      existing.unique = false;
      continue;
    }
    // A wrapped initializer puts the value on the line below the `=`.
    const parsed = parseInitializer(source, skipTrivia(source, match.index + match[0].length));
    constants.set(name, {
      line: lineAt(source, match.index),
      unique: true,
      value: parsed ? parsed.value : null,
    });
  }
  return constants;
}

// Named imports of a module, so a `t(NAME)` whose NAME the file imports reaches
// the module that declares it instead of being skipped. Only the import
// statement the file really has is followed: a default or namespace import, and
// a package specifier, stay unresolved.
const IMPORT = /(?:^|\n)[ \t]*import\s+(?:type\s+)?([^;]*?)\s*from\s*(['"])([^'"]+)\2/gu;

function importBindings(source) {
  const bindings = new Map();
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[3];
    if (!specifier.startsWith('.')) continue;
    const clause = match[1].trim();
    if (!clause.startsWith('{')) continue;
    const list = clause.slice(1, clause.lastIndexOf('}'));
    for (const item of list.split(',')) {
      const named = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(item.trim());
      if (named) bindings.set(named[2] ?? named[1], { specifier, name: named[1] });
    }
  }
  return bindings;
}

// The label of the module a relative specifier points at, resolved textually
// because the scan already holds every source it is allowed to read.
function resolveSpecifier(label, specifier) {
  const segments = label.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

// What a call site at `start` hands the translator: either the string itself or
// the reason it cannot be read statically. A module constant wins over an import
// of the same name, which is what the language itself does.
function resolveArgument(source, start, { label, constants, imports }, modules) {
  const literal = parseStringAt(source, start);
  if (literal) return { value: literal.value };
  const name = /^([A-Za-z_$][\w$]*)\s*([[(.]?)/u.exec(source.slice(start, start + 64));
  if (!name) return { reason: 'argument is neither a string literal nor an identifier' };
  // `t(LABELS[issue])` or `t(message.trim())` reads a value out of a binding that
  // the declaration table knows nothing about, so it is not a constant reference.
  if (name[2] !== '') {
    return { reason: `${name[1]} is read through an expression, not passed by name` };
  }
  const constant = constants.get(name[1]);
  if (constant) {
    if (!constant.unique) return { reason: `${name[1]} is declared more than once in this module` };
    if (constant.value === null) {
      const reason = `${name[1]} declared at line ${constant.line}`
        + ' has an initializer whose value is not a single static string';
      return { reason };
    }
    return { value: constant.value, from: name[1] };
  }
  const imported = imports.get(name[1]);
  if (!imported) return { reason: `${name[1]} is neither declared nor imported in this module` };
  const targetLabel = resolveSpecifier(label, imported.specifier);
  const target = modules.get(targetLabel);
  if (!target) {
    return {
      reason: `${name[1]} is imported from ${imported.specifier}, which is outside the scanned sources`,
    };
  }
  const declaration = target.constants.get(imported.name);
  if (!declaration) {
    return {
      reason: `${imported.name} is imported from ${imported.specifier},`
        + ' which does not declare it as a module constant',
    };
  }
  if (!declaration.unique) {
    return { reason: `${imported.name} is declared more than once in ${imported.specifier}` };
  }
  if (declaration.value === null) {
    return {
      reason: `${imported.name} in ${imported.specifier}`
        + ' has an initializer whose value is not a single static string',
    };
  }
  return { value: declaration.value, from: name[1] };
}

function walkSource(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // Dictionary areas hold translations, not source strings to translate.
      if (DICTIONARY_ENTRY.test(entry)) continue;
      walkSource(path, files);
    } else if (
      /\.(?:mjs|js)$/u.test(entry)
      && entry !== TRANSLATOR_MODULE
      && !DICTIONARY_ENTRY.test(entry)
    ) {
      files.push(path);
    }
  }
  return files;
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

// Every literal the host source hands to t(), keyed by the string itself and
// grouped with the call sites that pass it: the report names the file that
// introduced the string, and one forgotten translation is one line even when
// seven call sites share it.
//
// `sources` holds `{ label, source }` pairs rather than paths so the regression
// tests below can feed it small synthetic modules.
function scanSources(sources) {
  const strings = new Map();
  const add = (key, where) => {
    if (!/[\u4e00-\u9fff]/u.test(key)) return;
    const sites = strings.get(key) ?? [];
    sites.push(where);
    strings.set(key, sites);
  };
  // A call whose argument cannot be resolved is dynamic for this scan; one line
  // per file/position so a repeated pattern does not drown the report, but never
  // a guessed value that would make coverage look better than it is.
  const diagnostics = new Map();
  const report = (where, reason) => {
    if (!diagnostics.has(where)) diagnostics.set(where, reason);
  };
  const call = /\bt\(\s*/gu;
  // Every module is parsed before any call site is resolved, because a constant
  // may be declared below the call that uses it and may be imported from a file
  // the walk reaches later.
  const modules = new Map();
  for (const { label, source } of sources) {
    modules.set(label, { label, constants: moduleConstants(source), imports: importBindings(source) });
  }
  for (const { label, source } of sources) {
    // Constants are resolved per module: a binding declared here, or imported by
    // the import statement here, is the only one this file can see.
    const module = modules.get(label);
    for (const match of source.matchAll(call)) {
      const where = `${label}:${lineAt(source, match.index)}`;
      const resolved = resolveArgument(source, match.index + match[0].length, module, modules);
      if (resolved.value === undefined) {
        report(where, resolved.reason);
        continue;
      }
      add(resolved.value, resolved.from ? `${where} (${resolved.from})` : where);
    }
  }
  return { strings, diagnostics };
}

function collectSourceStrings() {
  return scanSources(
    walkSource(sourceRoot).map((file) => ({
      label: relative(repoRoot, file).split(sep).join('/'),
      source: readFileSync(file, 'utf8'),
    })),
  );
}

// Every language that ships a dictionary today, discovered from the files
// themselves. Both layouts are supported: `i18n-<lang>.mjs` merging its
// per-area modules, and — for a language that ships areas only — the
// `i18n-<lang>/` directory merged here.
function dictionaryEntries() {
  const languages = new Map();
  for (const entry of readdirSync(sharedDir)) {
    const match = DICTIONARY_ENTRY.exec(entry);
    if (!match) continue;
    const record = languages.get(match[1]) ?? {};
    if (match[2]) record.module = entry;
    else record.directory = entry;
    languages.set(match[1], record);
  }
  return [...languages].sort(([left], [right]) => left.localeCompare(right));
}

async function loadDictionary(sharedDirPath, { module, directory }) {
  if (module) {
    const loaded = await import(pathToFileURL(join(sharedDirPath, module)).href);
    const entries = Object.values(loaded).find(
      (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    );
    assert.ok(entries, `${module} exports no dictionary object`);
    return entries;
  }
  const merged = {};
  const areas = readdirSync(join(sharedDirPath, directory)).filter((file) => /\.mjs$/u.test(file));
  for (const area of areas.sort()) {
    const loaded = await import(pathToFileURL(join(sharedDirPath, directory, area)).href);
    Object.assign(merged, loaded.default);
  }
  return merged;
}

async function discoverDictionaries() {
  const dictionaries = [];
  for (const [language, layout] of dictionaryEntries()) {
    dictionaries.push({ language, entries: await loadDictionary(sharedDir, layout) });
  }
  return dictionaries;
}

const { strings, diagnostics } = collectSourceStrings();
const dictionaries = await discoverDictionaries();
const referenced = new Set(strings.keys());

// One readable line per untranslated string: where it came from, and how many
// call sites pass it.
function describe(key) {
  const sites = strings.get(key);
  const alsoUsed = sites.length > 1 ? ` (+${sites.length - 1} more call site(s))` : '';
  return `${sites[0]}${alsoUsed}  ${JSON.stringify(key)}`;
}

test('the scan finds the translator dictionaries and the strings they translate', () => {
  // A scan that quietly finds nothing would make every check below vacuous, so
  // the inputs are asserted first: one dictionary per shipped language, and a
  // source corpus with the Chinese strings in it.
  assert.ok(dictionaries.length > 0, 'no i18n-<lang> dictionary next to the translator');
  for (const { language, entries } of dictionaries) {
    assert.ok(Object.keys(entries).length > 0, `i18n-${language} dictionary is empty`);
  }
  assert.ok(strings.size > 0, 'no Chinese source string passed to t() was found in src');
  // Calls the file scan cannot resolve, each with its location and the reason, so
  // a skipped string is visible instead of silently missing from the check.
  if (diagnostics.size > 0) {
    const lines = [...diagnostics].map(([where, reason]) => `  ${where}  ${reason}`);
    console.warn(
      `[i18n] ${diagnostics.size} t() argument(s) not resolved by the file scan:\n`
      + lines.join('\n'),
    );
  }
});

test('every Chinese source string passed to t() has an entry in each dictionary', () => {
  const missing = {};
  for (const { language, entries } of dictionaries) {
    missing[language] = [...strings.keys()]
      .filter((key) => !Object.hasOwn(entries, key))
      .map(describe);
  }
  const summary = dictionaries
    .map(({ language }) => `${language}: ${missing[language].length} missing`)
    .join(', ');
  assert.deepEqual(
    missing,
    Object.fromEntries(dictionaries.map(({ language }) => [language, []])),
    `untranslated source strings (${summary}) — add each key to src/channels/shared/i18n-<lang>/`,
  );
});

test('dictionary entries no source string references are reported, not failed', () => {
  // TODO: turn this into a failing check once the pre-existing orphans are gone.
  // Several hundred keys are already unreferenced: these dictionaries are shared
  // with the client-side settings UI (plugin-src/client imports them), some are
  // reached through arguments this file scan cannot resolve, and some outlived
  // the feature that used them. Failing today would block every unrelated
  // change, so the warning only surfaces them; a key whose source string was
  // just deleted is the case a contributor can act on.
  for (const { language, entries } of dictionaries) {
    const orphans = Object.keys(entries).filter((key) => !referenced.has(key));
    if (orphans.length === 0) continue;
    const sample = orphans.slice(0, 25).map((key) => JSON.stringify(key));
    const rest = orphans.length > sample.length ? `, …${orphans.length - sample.length} more` : '';
    console.warn(
      `[i18n] i18n-${language}: ${orphans.length} entr${orphans.length === 1 ? 'y' : 'ies'}`
      + ` no source string references: ${sample.join(', ')}${rest}`,
    );
  }
});

test('every shared-d (session navigation) dictionary key is referenced by source or the catalog', async () => {
  // The merged dictionaries still carry hundreds of client-side settings keys
  // the t()-scanner cannot see, so the orphan warning above cannot fail. The
  // session-navigation area is small and host-only: an unused key here is dead
  // and must be removed, otherwise it comes back. Catalog descriptions/help are
  // reached through translate(line) at menu-build time, not t('literal'), so
  // they are allowed explicitly.
  const catalogKeys = new Set();
  for (const item of SHARED_COMMAND_CATALOG) {
    catalogKeys.add(item.description);
    for (const line of item.help) catalogKeys.add(line);
  }
  for (const directory of ['i18n-en', 'i18n-ru']) {
    const loaded = await import(pathToFileURL(join(sharedDir, directory, 'shared-d.mjs')).href);
    const orphans = Object.keys(loaded.default)
      .filter((key) => !referenced.has(key) && !catalogKeys.has(key));
    assert.deepEqual(orphans, [], `${directory}/shared-d.mjs has unreferenced keys`);
  }
});

// The scanner is fed synthetic modules from here on: a defect in the scan is
// only caught by a case that would make the guard pass a string it should
// report, and the real tree does not contain one any more.

test('physical template line endings yield the runtime key without hiding missing translations', () => {
  const known = '已进入批量输入模式，最多可发送 {limit} 条文字。\n完成后发送 /send，取消请发送 /cancel。';
  const missing = '审查探针：第一行\n审查探针：确实缺失';
  for (const eol of ['\n', '\r\n', '\r']) {
    const scan = scanSources([{
      label: 'src/channels/shared/newlines.mjs',
      source: `const NOTICE = \`${known.replaceAll('\n', eol)}\`;\nsend(t(NOTICE), t(\`${missing.replaceAll('\n', eol)}\`));\n`,
    }]);
    assert.deepEqual([...scan.strings.keys()], [known, missing]);
    assert.equal(scan.diagnostics.size, 0);
    for (const { entries } of dictionaries) {
      assert.deepEqual(
        [...scan.strings.keys()].filter((key) => !Object.hasOwn(entries, key)),
        [missing],
      );
    }
  }
});

test('line continuations disappear in quoted and template keys, but escaped CRLF stays distinct', () => {
  for (const quote of ["'", '"', '`']) {
    for (const eol of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
      const scan = scanSources([{
        label: 'src/channels/shared/continuation.mjs',
        source: `const NOTICE = ${quote}审查探针：甲\\${eol}乙${quote};\nsend(t(NOTICE));`,
      }]);
      assert.deepEqual([...scan.strings.keys()], ['审查探针：甲乙']);
      assert.equal(scan.diagnostics.size, 0);
    }
  }
  const scan = scanSources([{
    label: 'src/channels/shared/escaped.mjs',
    source: "send(t('审查探针：甲\\r\\n乙'), t(`审查探针：甲\\r\\n乙`));",
  }]);
  assert.deepEqual([...scan.strings.keys()], ['审查探针：甲\r\n乙']);
  // Only physical template CR/CRLF is cooked to LF, not explicit escapes or
  // the Unicode line/paragraph separators that JavaScript preserves verbatim.
  assert.equal(parseStringAt('`甲\u2028乙\u2029丙`', 0)?.value, '甲\u2028乙\u2029丙');
  assert.equal(parseStringAt("'甲\r乙'", 0), null);
  assert.equal(parseStringAt("'甲\n乙'", 0), null);
  assert.equal(parseStringAt('`甲${suffix}`', 0), null);
});

test('a constant used in two modules resolves to the string of the module that uses it', () => {
  // A table keyed by identifier alone lets the last module of the walk win, so
  // the other module's call site is compared against a string it never passes.
  const scan = scanSources([
    {
      label: 'src/channels/qq/qq-bridge.mjs',
      source: ["const NOTICE = '排队中的消息被中断。';", 'send(t(NOTICE));', ''].join('\n'),
    },
    {
      label: 'src/channels/shared/text-harness-bridge.mjs',
      source: ["const NOTICE = '測試缺失的字串';", 'send(t(NOTICE));', ''].join('\n'),
    },
  ]);
  assert.deepEqual(
    [...scan.strings.keys()].sort(),
    ['測試缺失的字串', '排队中的消息被中断。'].sort(),
  );
  assert.deepEqual(
    scan.strings.get('排队中的消息被中断。'),
    ['src/channels/qq/qq-bridge.mjs:2 (NOTICE)'],
  );
  assert.deepEqual(scan.strings.get('測試缺失的字串'), [
    'src/channels/shared/text-harness-bridge.mjs:2 (NOTICE)',
  ]);
  // The point of the split: an untranslated string of one module still reaches
  // the coverage comparison instead of hiding behind the other module's value.
  assert.equal(scan.diagnostics.size, 0);
});

test('a binding declared twice inside one module is reported unresolved', () => {
  const scan = scanSources([{
    label: 'src/channels/shared/twice.mjs',
    source: [
      "const NOTICE = '第一条';",
      'function a() {',
      "  const NOTICE = '第二条';",
      '  return NOTICE;',
      '}',
      'run(t(NOTICE));',
      '',
    ].join('\n'),
  }]);
  assert.deepEqual([...scan.strings.keys()], []);
  assert.deepEqual([...scan.diagnostics], [
    ['src/channels/shared/twice.mjs:6', 'NOTICE is declared more than once in this module'],
  ]);
});

test('a concatenated initializer is reported unresolved, not read as its first fragment', () => {
  // `'用法：' + suffix` is not the key the translator receives; accepting the
  // first literal would compare a fragment that is never looked up at runtime.
  const scan = scanSources([{
    label: 'src/channels/shared/workspace-command.mjs',
    source: [
      "const SESSION_BIND_USAGE = '用法：/session ' + SUFFIX;",
      'run(t(SESSION_BIND_USAGE));',
      '',
    ].join('\n'),
  }]);
  assert.deepEqual([...scan.strings.keys()], []);
  assert.deepEqual([...scan.diagnostics], [[
    'src/channels/shared/workspace-command.mjs:2',
    'SESSION_BIND_USAGE declared at line 1'
      + ' has an initializer whose value is not a single static string',
  ]]);
});

test('other expressions in an initializer are reported unresolved as well', () => {
  // Template substitution, a call and a conditional are the same class of defect
  // as a concatenation: the value read from the first literal is not the key.
  const scan = scanSources([{
    label: 'src/channels/shared/expressions.mjs',
    source: [
      'const TEMPLATED = `前缀 ${suffix}`;',
      "const CALLED = '重复'.repeat(2);",
      "const CONDITIONAL = flag ? '甲' : '乙';",
      'run(t(TEMPLATED), t(CALLED), t(CONDITIONAL));',
      '',
    ].join('\n'),
  }]);
  assert.deepEqual([...scan.strings.keys()], []);
  assert.deepEqual([...scan.diagnostics.keys()], ['src/channels/shared/expressions.mjs:4']);
  assert.match(
    scan.diagnostics.get('src/channels/shared/expressions.mjs:4'),
    /TEMPLATED declared at line 1/u,
  );
});

test('the supported initializer forms still resolve to their whole value', () => {
  // The stricter parse must not throw away the two forms the source relies on.
  const scan = scanSources([{
    label: 'src/channels/shared/forms.mjs',
    source: [
      "const USAGE = '用法：/session Session ID';",
      'const MULTILINE = [',
      "  '第一行',",
      "  '第二行',",
      "].join('\\n');",
      "const PLAIN = [ '甲', '乙' ].join();",
      'run(t(USAGE), t(MULTILINE), t(PLAIN));',
      '',
    ].join('\n'),
  }]);
  assert.deepEqual(
    [...scan.strings.keys()].sort(),
    ['用法：/session Session ID', '第一行\n第二行', '甲,乙'].sort(),
  );
  assert.equal(scan.diagnostics.size, 0);
});

test('an imported constant is resolved through the module that declares it', () => {
  // Following the import keeps the strings of shared constants inside the check:
  // scoping alone would silently drop them from coverage.
  const scan = scanSources([
    {
      label: 'src/channels/shared/inbound-access.mjs',
      source: "export const COMMAND_PERMISSION_DENIED_MESSAGE = '你没有执行命令的权限。';\n",
    },
    {
      label: 'src/channels/qq/qq-bridge.mjs',
      source: [
        "import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../shared/inbound-access.mjs';",
        'send(t(COMMAND_PERMISSION_DENIED_MESSAGE));',
        '',
      ].join('\n'),
    },
  ]);
  assert.deepEqual([...scan.strings.keys()], ['你没有执行命令的权限。']);
  assert.equal(scan.diagnostics.size, 0);
});

test('an imported constant declared more than once is reported unresolved', () => {
  const scan = scanSources([
    {
      label: 'src/channels/shared/ambiguous.mjs',
      source: [
        "export const LABEL = '甲';",
        'export function f() {',
        "  const LABEL = '乙';",
        '  return LABEL;',
        '}',
        '',
      ].join('\n'),
    },
    {
      label: 'src/channels/qq/qq-bridge.mjs',
      source: "import { LABEL } from '../shared/ambiguous.mjs';\nsend(t(LABEL));\n",
    },
  ]);
  assert.deepEqual([...scan.strings.keys()], []);
  assert.deepEqual([...scan.diagnostics], [
    ['src/channels/qq/qq-bridge.mjs:2', 'LABEL is declared more than once in ../shared/ambiguous.mjs'],
  ]);
});

test('a join with a trailing operator is reported unresolved, not read as its array', () => {
  // `].join('\n') + '…'` sends the translator the concatenation, so the array
  // text is not the key. Reading the call's closing paren as the end of the
  // initializer hides the `+` and makes the guard check a key nobody looks up.
  const scan = scanSources([{
    label: 'src/channels/shared/workspace-command.mjs',
    source: [
      'const SESSION_LIST_USAGE = [',
      "  '用法：',",
      "  '/sessionlist  列出当前工作区会话',",
      "].join('\\n') + '（审查探针）';",
      'run(t(SESSION_LIST_USAGE));',
      '',
    ].join('\n'),
  }]);
  // No string at all: the array text must not be demanded as a translation.
  assert.deepEqual([...scan.strings.keys()], []);
  assert.deepEqual([...scan.diagnostics], [[
    'src/channels/shared/workspace-command.mjs:5',
    'SESSION_LIST_USAGE declared at line 1'
      + ' has an initializer whose value is not a single static string',
  ]]);
});

test('the same array join without a trailing operator still asks for a translation', () => {
  // The mirror of the case above: removing only the `+ '…'` tail must bring the
  // joined text back into the check, so the fix cannot be a blanket rejection.
  const key = '审查探针：第一行\n审查探针：第二行';
  const scan = scanSources([{
    label: 'src/channels/shared/probe.mjs',
    source: [
      'const PROBE = [',
      "  '审查探针：第一行',",
      "  '审查探针：第二行',",
      "].join('\\n');",
      'run(t(PROBE));',
      '',
    ].join('\n'),
  }]);
  assert.deepEqual([...scan.strings.keys()], [key]);
  assert.equal(scan.diagnostics.size, 0);
  // A key no dictionary carries has to be reported as missing rather than
  // silently skipped, which is what the coverage comparison below does with it.
  const carried = dictionaries.filter(({ entries }) => Object.hasOwn(entries, key));
  assert.deepEqual(carried, []);
});

test('only a declaration terminator ends an initializer', () => {
  // Asserted on the parser because the valid forms cannot reach this check with a
  // stray `)` next: the join call consumes its own paren, and `('甲')` starts with
  // a paren, which is not parsed at all. A future early `end` would let an
  // operator tail through as a value, and this is the assertion that fails then.
  assert.equal(parseInitializer("'甲') + suffix", 0), null);
  assert.equal(parseInitializer("'甲' + suffix", 0), null);
  assert.equal(parseInitializer("'甲'.trim()", 0), null);
  assert.equal(parseInitializer("'甲' ? '乙' : '丙'", 0), null);
  assert.equal(parseInitializer("['甲', '乙'].join('\\n') + suffix", 0), null);
  assert.equal(parseInitializer("'甲'", 0)?.value, '甲');
  assert.equal(parseInitializer("'甲';", 0)?.value, '甲');
  assert.equal(parseInitializer("['甲'].join('\\n');", 0)?.value, '甲');
});
