import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

import {
  getImHostLanguage,
  normalizeImHostLanguage,
  onImHostLanguageChange,
  setImHostLanguage,
  t,
  translateImHostText,
} from '../../../src/channels/shared/i18n.mjs';
import { EN } from '../../../src/channels/shared/i18n-en.mjs';
import { RU } from '../../../src/channels/shared/i18n-ru.mjs';
import { parseSessionListArgument } from '../../../src/channels/shared/workspace-command.mjs';
import { parseStringAt } from './i18n-source-literal.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcChannelsDir = join(here, '..', '..', '..', 'src', 'channels');

after(() => {
  setImHostLanguage('zh');
});

test('normalizeImHostLanguage resolves every interface-language tag to one dictionary', () => {
  const cases = [
    // Chinese is the identity language: its literals are their own translation.
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['ZH-cn', 'zh'],
    ['zh_TW', 'zh'],
    ['chinese', 'zh'],
    [' CHINESE ', 'zh'],
    // Russian has its own dictionary, which falls back to English.
    ['ru', 'ru'],
    ['RU', 'ru'],
    ['ru-RU', 'ru'],
    ['russian', 'ru'],
    // Everything else must never surface Chinese, so it resolves to English.
    ['en', 'en'],
    ['en-US', 'en'],
    ['english', 'en'],
    ['de', 'en'],
    ['de-DE', 'en'],
    ['', 'en'],
    ['   ', 'en'],
    [undefined, 'en'],
    [null, 'en'],
    [42, 'en'],
    [{ language: 'zh' }, 'en'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(
      normalizeImHostLanguage(value),
      expected,
      `expected ${JSON.stringify(value) ?? String(value)} to resolve to ${expected}`,
    );
  }
});

test('normalizeImHostLanguage judges a tag without changing the active language', () => {
  setImHostLanguage('zh');
  assert.equal(normalizeImHostLanguage('en-GB'), 'en');
  assert.equal(normalizeImHostLanguage('ru-RU'), 'ru');
  assert.equal(normalizeImHostLanguage('zh-CN'), 'zh');
  assert.equal(normalizeImHostLanguage(undefined), 'en');
  assert.equal(getImHostLanguage(), 'zh');
});

test('Chinese is the identity language for every key t() receives', () => {
  setImHostLanguage('zh');
  assert.equal(getImHostLanguage(), 'zh');
  assert.equal(t('连接成功'), '连接成功');
  assert.equal(t('共 {count} 个机器人', { count: 3 }), '共 3 个机器人');
  assert.equal(t('未收录的中文'), '未收录的中文');
});

test('setImHostLanguage switches between the three dictionaries', () => {
  setImHostLanguage('zh');
  for (const value of ['en', 'EN', 'en-US', ' english ']) {
    setImHostLanguage(value);
    assert.equal(getImHostLanguage(), 'en', `expected ${value} to select English`);
  }
  for (const value of ['ru', 'RU', 'ru-RU', ' russian ']) {
    setImHostLanguage(value);
    assert.equal(getImHostLanguage(), 'ru', `expected ${value} to select Russian`);
  }
  for (const value of ['zh', 'zh-CN', 'chinese']) {
    setImHostLanguage(value);
    assert.equal(getImHostLanguage(), 'zh', `expected ${value} to select Chinese`);
  }
  // An unrecognized tag is English, never Chinese: a reader who asked for some
  // other language must not be answered in the one language we keep untranslated.
  for (const value of [undefined, null, '', 'fr', 'de', 'enabled', 42]) {
    setImHostLanguage(value);
    assert.equal(getImHostLanguage(), 'en', `expected ${value} to select English`);
  }
});

test('subscribers are notified only when the resolved host language changes', () => {
  setImHostLanguage('zh');
  const seen = [];
  const stop = onImHostLanguageChange((next, previous) => seen.push([next, previous]));
  try {
    setImHostLanguage('en');
    // Different spellings of the same resolved language must stay silent.
    setImHostLanguage('en-US');
    setImHostLanguage(' english ');
    // An unrecognized tag resolves to English, which is no change from English.
    setImHostLanguage('de');
    setImHostLanguage('ru');
    setImHostLanguage('ru-RU');
    setImHostLanguage('zh');
  } finally {
    stop();
  }
  setImHostLanguage('en');
  assert.deepEqual(seen, [['en', 'zh'], ['ru', 'en'], ['zh', 'ru']]);
});

test('a failing subscriber cannot block later subscribers or the language switch', () => {
  setImHostLanguage('zh');
  const seen = [];
  const stopFirst = onImHostLanguageChange(() => {
    throw new Error('subscriber failure');
  });
  const stopSecond = onImHostLanguageChange((next) => seen.push(next));
  try {
    setImHostLanguage('en');
  } finally {
    stopFirst();
    stopSecond();
  }
  assert.deepEqual(seen, ['en']);
  assert.equal(getImHostLanguage(), 'en');
});

test('onImHostLanguageChange rejects non-subscribers and disposes idempotently', () => {
  for (const value of [undefined, null, 'en', {}]) {
    assert.throws(() => onImHostLanguageChange(value), TypeError);
  }
  setImHostLanguage('zh');
  let calls = 0;
  const stop = onImHostLanguageChange(() => { calls += 1; });
  stop();
  stop();
  setImHostLanguage('en');
  assert.equal(calls, 0);
});

test('t() translates known keys and fills placeholders in English mode', () => {
  setImHostLanguage('en');
  const [key] = Object.keys(EN);
  if (key) {
    assert.equal(t(key), EN[key]);
  }
  assert.equal(t('未收录的中文'), '未收录的中文');
  assert.equal(t('{value} 测试', { value: 'x' }), EN['{value} 测试'] ?? 'x 测试');
  assert.equal(
    t('示例：先发 /models，再发 /model 2 [推理等级ID]'),
    'Example: send /models first, then /model 2 [reasoning effort ID]',
  );
  assert.equal(
    t('卡片已结束，请查看后续消息。'),
    'This card has ended. Please check the next message.',
  );
  // Text a reader sees before any model output, so an untranslated literal
  // here is the first thing that looks broken (see issue #185).
  assert.equal(t('正在处理…'), 'Processing…');
  // Terminal status rewritten over a rejected Telegram placeholder: the last
  // thing a reader sees on a degraded reply.
  assert.equal(t('回复已发送。'), 'The reply was sent.');
  assert.equal(t('回复发送结果未能确认。'), 'The reply delivery result could not be confirmed.');
  assert.equal(t('消息发送失败，请稍后重试。'), 'The message could not be sent. Try again later.');
  assert.equal(
    t('工具调用「{name}」未成功，请检查工具配置或稍后重试。', { name: 'search' }),
    'Tool call "search" did not succeed. Check the tool configuration or try again later.',
  );
  assert.equal(t(42), 42);
});

test('t() translates host text through the Russian dictionary', () => {
  setImHostLanguage('ru');
  // The first line a reader sees before any model output: with a Russian GUI
  // this used to arrive as raw Chinese (正在处理…).
  assert.equal(t('正在处理…'), 'Обрабатываю…');
  assert.equal(t('处理完成。'), 'Обработка завершена.');
  assert.equal(t('已停止。'), 'Остановлено.');
  assert.equal(t('回复已发送。'), 'Ответ отправлен.');
  assert.equal(
    t('卡片已结束，请查看后续消息。'),
    'Карточка завершена, смотрите следующее сообщение.',
  );
  assert.equal(
    t(
      '已进入批量输入模式，最多可发送 {limit} 条文字。\n完成后发送 /send，取消请发送 /cancel。',
      { limit: 10 },
    ),
    'Пакетный ввод начат. Можно отправить до 10 текстовых сообщений.\n'
    + 'По завершении отправьте /send, для отмены — /cancel.',
  );
  // A key neither dictionary carries still renders as the Chinese literal, and
  // that is the identity path, not a fallback failure.
  assert.equal(t('未收录的中文'), '未收录的中文');
  assert.equal(t(42), 42);
});

test('a Russian key missing from the dictionary falls back to English, never to Chinese', () => {
  const key = '回复已发送。';
  assert.ok(Object.hasOwn(RU, key), 'sanity: the shipped Russian dictionary carries this key');
  // The shipped dictionary has no gaps, so the gap is exercised against the
  // real lookup with a stripped Russian overlay rather than by shipping a hole.
  const russianGap = { ru: {}, en: EN };
  assert.equal(translateImHostText(key, 'ru', russianGap), 'The reply was sent.');
  assert.notEqual(translateImHostText(key, 'ru', russianGap), key);
  // A key the English dictionary does not carry either stays as the Chinese
  // identity text; that is the only way Chinese can reach a Russian reader.
  assert.equal(translateImHostText('未收录的中文', 'ru', russianGap), '未收录的中文');
  // The production chain answers from Russian, and Chinese stays identity.
  assert.equal(translateImHostText(key, 'ru'), RU[key]);
  assert.equal(translateImHostText(key, 'zh'), key);
  assert.equal(translateImHostText('未收录的中文', 'zh'), '未收录的中文');
});

test('invalid session list limits return translated usage including the conversation workspace rule', () => {
  for (const [language, prefix, workspaceRule] of [
    ['en', 'Usage:', 'Without a workspace argument'],
    ['ru', 'Использование:', 'Без аргумента рабочей области'],
  ]) {
    setImHostLanguage(language);
    const { error } = parseSessionListArgument('--limit abc');
    assert.ok(error.startsWith(prefix));
    assert.ok(error.includes(workspaceRule));
    assert.doesNotMatch(error, /[\u4e00-\u9fff]/u);
  }
});

test('every English dictionary entry is a non-empty translation of a Chinese key', () => {
  const placeholders = (text) => [...new Set(
    [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]),
  )].sort();
  for (const [key, value] of Object.entries(EN)) {
    assert.ok(/[\u4e00-\u9fff（）]/.test(key), `dictionary key is not a Chinese source string: ${key}`);
    assert.ok(typeof value === 'string' && value.trim().length > 0, `empty translation for: ${key}`);
    assert.deepEqual(placeholders(value), placeholders(key), `placeholder mismatch for: ${key}`);
  }
});

test('every English dictionary key has a Russian counterpart and vice versa', () => {
  const englishOnly = Object.keys(EN).filter((key) => !Object.hasOwn(RU, key));
  const russianOnly = Object.keys(RU).filter((key) => !Object.hasOwn(EN, key));
  assert.deepEqual(englishOnly, [], 'English keys without a Russian entry');
  assert.deepEqual(russianOnly, [], 'Russian entries without an English key');
});

test('every Russian dictionary entry is a non-empty translation of its Chinese key', () => {
  const placeholders = (text) => [...new Set(
    [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]),
  )].sort();
  for (const [key, value] of Object.entries(RU)) {
    assert.ok(/[\u4e00-\u9fff（）]/.test(key), `dictionary key is not a Chinese source string: ${key}`);
    assert.ok(typeof value === 'string' && value.trim().length > 0, `empty translation for: ${key}`);
    assert.deepEqual(placeholders(value), placeholders(key), `placeholder mismatch for: ${key}`);
  }
});

test('dictionary source files do not define duplicate keys', async () => {
  for (const dictionary of ['i18n-en', 'i18n-ru']) {
    const dictionaryDir = join(srcChannelsDir, 'shared', dictionary);
    const seen = new Map();
    const duplicates = [];
    const files = readdirSync(dictionaryDir)
      .filter((file) => file.endsWith('.mjs'))
      .sort();
    for (const file of files) {
      const { default: entries } = await import(pathToFileURL(join(dictionaryDir, file)).href);
      for (const key of Object.keys(entries)) {
        if (seen.has(key)) duplicates.push(`${dictionary}/${key}: ${seen.get(key)}, ${file}`);
        else seen.set(key, file);
      }
    }
    assert.deepEqual(duplicates, [], `${dictionary} defines duplicate keys`);
  }
});

function literalKeys(source) {
  const keys = [];
  for (const match of source.matchAll(/\bt\(\s*/gu)) {
    const literal = parseStringAt(source, match.index + match[0].length);
    if (literal) keys.push(literal.value);
  }
  return keys;
}

test('literal key coverage treats physical LF and CRLF alike and still detects missing keys', () => {
  const known = '已进入批量输入模式，最多可发送 {limit} 条文字。\n完成后发送 /send，取消请发送 /cancel。';
  const missing = '审查探针：第一行\n审查探针：确实缺失';
  for (const eol of ['\n', '\r\n', '\r']) {
    const keys = literalKeys(`t(\`${known.replaceAll('\n', eol)}\`);\nt(\`${missing.replaceAll('\n', eol)}\`);`);
    assert.deepEqual(keys, [known, missing]);
    for (const entries of [EN, RU]) {
      assert.deepEqual(keys.filter((key) => !Object.hasOwn(entries, key)), [missing]);
    }
  }
});

test('literal key coverage does not normalize explicit CRLF escapes into a translated LF key', () => {
  const lf = '已进入批量输入模式，最多可发送 {limit} 条文字。\n完成后发送 /send，取消请发送 /cancel。';
  const crlf = lf.replaceAll('\n', '\r\n');
  const keys = literalKeys(`t(\`${lf.replaceAll('\n', '\\r\\n')}\`);`);
  assert.deepEqual(keys, [crlf]);
  for (const entries of [EN, RU]) {
    assert.ok(Object.hasOwn(entries, lf));
    assert.deepEqual(keys.filter((key) => !Object.hasOwn(entries, key)), [crlf]);
  }
});

test('every literal t() key in src/channels has an English and a Russian entry', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'i18n-en' && entry !== 'i18n-ru') walk(path);
      } else if (
        entry.endsWith('.mjs')
        && entry !== 'i18n.mjs'
        && entry !== 'i18n-en.mjs'
        && entry !== 'i18n-ru.mjs'
      ) {
        files.push(path);
      }
    }
  };
  walk(srcChannelsDir);

  const missingEnglish = [];
  const missingRussian = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const key of literalKeys(source)) {
      if (!/[\u4e00-\u9fff]/.test(key)) continue;
      if (!Object.hasOwn(EN, key)) missingEnglish.push(`${file}: ${key}`);
      if (!Object.hasOwn(RU, key)) missingRussian.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missingEnglish, [], 't() keys missing from the English dictionary');
  assert.deepEqual(missingRussian, [], 't() keys missing from the Russian dictionary');
});
