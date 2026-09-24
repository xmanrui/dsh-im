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
} from '../../../src/channels/shared/i18n.mjs';
import { EN } from '../../../src/channels/shared/i18n-en.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcChannelsDir = join(here, '..', '..', '..', 'src', 'channels');

after(() => {
  setImHostLanguage('zh');
});

test('host language defaults to Chinese and t() is the identity function', () => {
  setImHostLanguage(undefined);
  assert.equal(getImHostLanguage(), 'zh');
  assert.equal(t('连接成功'), '连接成功');
  assert.equal(t('共 {count} 个机器人', { count: 3 }), '共 3 个机器人');
});

test('setImHostLanguage accepts English spellings and falls back to Chinese', () => {
  for (const value of ['en', 'EN', 'en-US', ' english ']) {
    setImHostLanguage(value);
    assert.equal(getImHostLanguage(), 'en', `expected ${value} to select English`);
  }
  for (const value of [undefined, null, '', 'zh', 'zh-CN', 'fr', 'enabled', 42]) {
    setImHostLanguage(value);
    assert.equal(getImHostLanguage(), 'zh', `expected ${value} to select Chinese`);
  }
});

test('normalizeImHostLanguage resolves a tag without changing the active language', () => {
  setImHostLanguage('zh');
  assert.equal(normalizeImHostLanguage('en-GB'), 'en');
  assert.equal(normalizeImHostLanguage('zh-CN'), 'zh');
  assert.equal(normalizeImHostLanguage(undefined), 'zh');
  assert.equal(getImHostLanguage(), 'zh');
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
    // An unrecognized tag falls back to Chinese, which is a real change.
    setImHostLanguage('fr');
  } finally {
    stop();
  }
  setImHostLanguage('en');
  assert.deepEqual(seen, [['en', 'zh'], ['zh', 'en']]);
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
    t('Thread 创建结果暂时无法确认。若已创建，请在对应 Thread 中重试；若未创建，请稍后重新 @机器人。'),
    'The Thread creation result cannot be confirmed yet. If the Thread was created,'
    + ' retry inside it; if it was not, mention the bot again shortly.',
  );
  assert.equal(
    t('工具调用「{name}」未成功，请检查工具配置或稍后重试。', { name: 'search' }),
    'Tool call "search" did not succeed. Check the tool configuration or try again later.',
  );
  assert.equal(t(42), 42);
});

test('every English dictionary entry is a non-empty translation of a Chinese key', () => {
  for (const [key, value] of Object.entries(EN)) {
    assert.ok(/[一-鿿（）]/.test(key), `dictionary key is not a Chinese source string: ${key}`);
    assert.ok(typeof value === 'string' && value.trim().length > 0, `empty translation for: ${key}`);
    const placeholders = (text) => [...new Set(
      [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]),
    )].sort();
    assert.deepEqual(
      placeholders(value),
      placeholders(key),
      `placeholder mismatch for: ${key}`,
    );
  }
});

test('English dictionary source files do not define duplicate keys', async () => {
  const dictionaryDir = join(srcChannelsDir, 'shared', 'i18n-en');
  const seen = new Map();
  const duplicates = [];
  const files = readdirSync(dictionaryDir)
    .filter((file) => file.endsWith('.mjs'))
    .sort();
  for (const file of files) {
    const { default: entries } = await import(pathToFileURL(join(dictionaryDir, file)).href);
    for (const key of Object.keys(entries)) {
      if (seen.has(key)) duplicates.push(`${key}: ${seen.get(key)}, ${file}`);
      else seen.set(key, file);
    }
  }
  assert.deepEqual(duplicates, []);
});

test('every literal t() key in src/channels has an English dictionary entry', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'i18n-en') walk(path);
      } else if (entry.endsWith('.mjs') && entry !== 'i18n.mjs' && entry !== 'i18n-en.mjs') {
        files.push(path);
      }
    }
  };
  walk(srcChannelsDir);

  const keyPattern = /\bt\(\s*(['`])((?:[^\\`'"$]|\$(?!\{)|\\.)*)\1/g;
  // Decode the escapes a real string literal would apply, so keys written as
  // `...\n...` in source compare against the runtime dictionary key (newline).
  const decodeLiteral = (raw) => {
    let out = '';
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] !== '\\' || i + 1 >= raw.length) {
        out += raw[i];
        continue;
      }
      const next = raw[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else out += next; // \', \", \\, \` and anything else keep the char
      i += 1;
    }
    return out;
  };
  const missing = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(keyPattern)) {
      const key = decodeLiteral(match[2]);
      if (!/[一-鿿]/.test(key)) continue;
      if (!Object.hasOwn(EN, key)) {
        missing.push(`${file}: ${match[2]}`);
      }
    }
  }
  assert.deepEqual(missing, [], 't() keys missing from the English dictionary');
});
